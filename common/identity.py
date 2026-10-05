"""Who is calling, and who is acting for them — identity across an A2A hop.

The mesh (lab 40) already proves *which workload* is on the other end of a
connection: the specialist knows the bytes came from the concierge's service
account. What the mesh cannot tell it is *on whose behalf* the concierge is
asking. That is a property of the request, not the connection, so it has to
ride in the request: a bearer token.

The tempting shortcut is to forward the caller's own token to the next hop.
This module implements that shortcut (``DOWNSTREAM_AUTH=passthrough``) so the
lab can show why it fails, and the fix (``DOWNSTREAM_AUTH=exchange``), an
RFC 8693 token exchange at the lab token service:

    caller token                       exchanged token
    sub   alice                        sub   alice
    aud   ops_concierge                aud   deployment_agent     ← only valid there
    scope release:request              scope release:request …    ← never wider
          release:deploy               act   {sub: ops_concierge} ← who is acting

Three pieces, all opt-in through ``common.config``:

``InboundAuthMiddleware``  verifies the bearer token on ``POST /a2a/<app>``
                           (``AGENT_AUTH=jwt``), returns 401 with a
                           ``WWW-Authenticate`` challenge otherwise, and makes
                           the verified principal visible to the agent's tools.
``downstream_auth_hook``   an httpx request hook for the A2A *client* side that
                           attaches the right token to each downstream call.
``current_principal()``    what a tool reads to learn who asked.

The token travels from the inbound request to the outbound call through a
context variable. a2a-sdk starts the agent run inside the request that carries
the token, and asyncio copies context into every task it creates, so the
value is in scope exactly as long as that request's work is.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

import httpx
import jwt

logger = logging.getLogger(__name__)

TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange"
ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token"


@dataclass(frozen=True)
class Principal:
    """The verified identity behind one A2A request."""

    subject: str
    audience: str
    scopes: tuple[str, ...] = ()
    #: The delegation chain, innermost actor first: ``("ops_concierge",)``
    #: means "the concierge is acting for ``subject``".
    actors: tuple[str, ...] = ()
    claims: dict[str, Any] = field(default_factory=dict, compare=False)

    def has_scope(self, scope: str) -> bool:
        return scope in self.scopes

    def describe(self) -> str:
        if not self.actors:
            return self.subject
        return f"{self.subject} via {' via '.join(self.actors)}"


_CURRENT_TOKEN: ContextVar[str | None] = ContextVar("a2a_inbound_token", default=None)
_CURRENT_PRINCIPAL: ContextVar[Principal | None] = ContextVar("a2a_principal", default=None)


def current_principal() -> Principal | None:
    """The principal of the A2A request this code is running for, if any."""
    return _CURRENT_PRINCIPAL.get()


def current_token() -> str | None:
    return _CURRENT_TOKEN.get()


def _actors_from_claims(claims: dict[str, Any]) -> tuple[str, ...]:
    """Flattens a nested RFC 8693 ``act`` claim into a tuple of subjects."""
    out: list[str] = []
    act = claims.get("act")
    while isinstance(act, dict) and act.get("sub"):
        out.append(str(act["sub"]))
        act = act.get("act")
    return tuple(out)


def principal_from_claims(claims: dict[str, Any]) -> Principal:
    aud = claims.get("aud")
    if isinstance(aud, list):
        aud = aud[0] if aud else ""
    return Principal(
        subject=str(claims.get("sub", "")),
        audience=str(aud or ""),
        scopes=tuple(str(claims.get("scope", "")).split()),
        actors=_actors_from_claims(claims),
        claims=claims,
    )


# --------------------------------------------------------------------- verifier


class JwksVerifier:
    """Verifies ES256 tokens against the token service's JWKS.

    Keys are fetched once and refetched when a token names a ``kid`` we have
    not seen — which is what key rotation looks like from the verifier's side.
    """

    def __init__(self, sts_url: str, *, audience: str, issuer: str | None = None):
        self._jwks_url = f"{sts_url.rstrip('/')}/.well-known/jwks.json"
        self._issuer = issuer or sts_url.rstrip("/")
        self._audience = audience
        self._keys: dict[str, Any] = {}
        self._lock = asyncio.Lock()

    async def _refresh(self) -> None:
        async with httpx.AsyncClient(timeout=5.0) as http:
            resp = await http.get(self._jwks_url)
            resp.raise_for_status()
            jwks = jwt.PyJWKSet.from_dict(resp.json())
        self._keys = {k.key_id: k.key for k in jwks.keys}

    async def _key_for(self, kid: str | None) -> Any:
        if kid not in self._keys:
            async with self._lock:
                if kid not in self._keys:
                    await self._refresh()
        if kid not in self._keys:
            raise jwt.InvalidTokenError(f"unknown signing key {kid!r}")
        return self._keys[kid]

    async def verify(self, token: str) -> Principal:
        header = jwt.get_unverified_header(token)
        key = await self._key_for(header.get("kid"))
        claims = jwt.decode(
            token,
            key,
            algorithms=["ES256"],
            audience=self._audience,
            issuer=self._issuer,
            options={"require": ["exp", "iat", "sub", "aud", "iss"]},
        )
        return principal_from_claims(claims)


# ------------------------------------------------------------- inbound (server)


class InboundAuthMiddleware:
    """Pure-ASGI bearer-token check in front of ``POST /a2a/<app>``.

    The Agent Card stays public (``GET …/.well-known/…``): a client has to be
    able to read the card to learn *how* to authenticate. Everything else on
    the A2A path needs a token whose ``aud`` is this agent.

    Pure ASGI rather than Starlette's ``BaseHTTPMiddleware`` on purpose: the
    latter runs the endpoint in a separate task, and the context variable
    carrying the token would not reach the agent run.
    """

    def __init__(self, app: Any, *, verifier: JwksVerifier, realm: str):
        self.app = app
        self._verifier = verifier
        self._realm = realm

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if (
            scope["type"] != "http"
            or not scope["path"].startswith("/a2a/")
            or "/.well-known/" in scope["path"]
            or scope["method"] in ("GET", "OPTIONS", "HEAD")
        ):
            await self.app(scope, receive, send)
            return

        auth = ""
        for key, value in scope.get("headers") or []:
            if key == b"authorization":
                auth = value.decode("latin-1")
                break
        if not auth.lower().startswith("bearer "):
            await self._deny(send, "invalid_request", "a bearer token is required")
            return
        token = auth[7:].strip()
        try:
            principal = await self._verifier.verify(token)
        except jwt.InvalidAudienceError:
            aud = jwt.decode(token, options={"verify_signature": False}).get("aud")
            await self._deny(
                send,
                "invalid_token",
                f"token audience is {aud!r}, this agent is {self._realm!r}",
            )
            return
        except (jwt.InvalidTokenError, httpx.HTTPError) as exc:
            await self._deny(send, "invalid_token", str(exc))
            return

        logger.info(
            "A2A caller verified: %s scopes=%s", principal.describe(), " ".join(principal.scopes)
        )
        from starlette.authentication import AuthCredentials, SimpleUser

        # a2a-sdk reads these into ServerCallContext; ADK then uses the user name
        # as the session's user_id instead of a placeholder derived from the
        # context id. Sessions — and paused tasks — now belong to a person.
        scope = dict(scope)
        scope["user"] = SimpleUser(principal.subject)
        scope["auth"] = AuthCredentials(list(principal.scopes))
        token_cv = _CURRENT_TOKEN.set(token)
        principal_cv = _CURRENT_PRINCIPAL.set(principal)
        try:
            await self.app(scope, receive, send)
        finally:
            _CURRENT_TOKEN.reset(token_cv)
            _CURRENT_PRINCIPAL.reset(principal_cv)

    async def _deny(self, send: Any, error: str, description: str) -> None:
        logger.info("A2A caller refused (%s): %s", error, description)
        safe = description.replace('"', "'")
        challenge = f'Bearer realm="{self._realm}", error="{error}", error_description="{safe}"'
        body = json.dumps({"error": error, "error_description": description}).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 401,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"www-authenticate", challenge.encode("latin-1", "replace")),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})


def make_scope_guard(required: dict[str, str]):
    """A ``before_tool_callback`` that checks the verified caller's scopes.

    ``required`` maps tool name → scope. With auth off there is no principal and
    the guard stands aside. A refusal uses the same result shape as the OPA
    guard, so ADK skips the tool and the model reports the denial.
    """

    def before_tool_callback(tool: Any, args: dict[str, Any], tool_context: Any) -> dict | None:
        principal = current_principal()
        need = required.get(tool.name)
        if principal is None or need is None or principal.has_scope(need):
            return None
        logger.info("scope guard: DENY %s → %s (needs %s)", principal.describe(), tool.name, need)
        return {
            "error": "denied_by_policy",
            "tool": tool.name,
            "message": f"{principal.describe()} lacks the {need} scope required for {tool.name}",
        }

    return before_tool_callback


# ------------------------------------------------------------ outbound (client)


class TokenExchanger:
    """RFC 8693 client: swaps the caller's token for one aimed at the next hop.

    Results are cached per (subject token, audience) until shortly before they
    expire, so a streaming turn with many requests costs one exchange.
    """

    def __init__(self, sts_url: str, *, client_id: str, client_secret: str):
        self._token_url = f"{sts_url.rstrip('/')}/token"
        self._client_id = client_id
        self._client_secret = client_secret
        self._cache: dict[tuple[str, str], tuple[str, float]] = {}

    async def exchange(self, subject_token: str, audience: str, scope: str | None = None) -> str:
        key = (subject_token, audience)
        hit = self._cache.get(key)
        if hit and hit[1] - 15 > time.time():
            return hit[0]
        form = {
            "grant_type": TOKEN_EXCHANGE_GRANT,
            "subject_token": subject_token,
            "subject_token_type": ACCESS_TOKEN_TYPE,
            "audience": audience,
        }
        if scope:
            form["scope"] = scope
        async with httpx.AsyncClient(timeout=10.0) as http:
            resp = await http.post(
                self._token_url, data=form, auth=(self._client_id, self._client_secret)
            )
        if resp.status_code != 200:
            raise TokenExchangeError(resp.status_code, resp.text)
        body = resp.json()
        token = body["access_token"]
        self._cache[key] = (token, time.time() + float(body.get("expires_in", 60)))
        logger.info(
            "token exchange: %s for aud=%s scope=%s", self._client_id, audience, body.get("scope")
        )
        return token


class TokenExchangeError(RuntimeError):
    def __init__(self, status: int, body: str):
        super().__init__(f"token exchange refused: HTTP {status} {body[:300]}")
        self.status = status
        self.body = body


def make_downstream_auth_hook(mode: str, *, audience: str, exchanger: TokenExchanger | None):
    """Builds the httpx request hook for the A2A client side, or None.

    ``audience`` is the downstream agent's name — what its tokens must say in
    ``aud``. The card fetch goes through the same client; it is public, so a
    token on it is harmless but not needed, and skipping it saves an exchange.
    """
    if mode in ("", "none", "off"):
        return None
    if mode not in ("passthrough", "exchange"):
        raise ValueError(f"DOWNSTREAM_AUTH must be none, passthrough or exchange, got {mode!r}")
    if mode == "exchange" and exchanger is None:
        raise ValueError("DOWNSTREAM_AUTH=exchange needs STS_CLIENT_ID and STS_CLIENT_SECRET")

    async def hook(request: httpx.Request) -> None:
        if request.method == "GET" and "/.well-known/" in request.url.path:
            return
        token = current_token()
        if not token:
            return
        if mode == "passthrough":
            # The anti-pattern, on purpose: the caller's token says
            # aud=ops_concierge. A correct downstream rejects it; a careless one
            # accepts a token that was never meant for it.
            request.headers["Authorization"] = f"Bearer {token}"
            return
        assert exchanger is not None
        request.headers["Authorization"] = f"Bearer {await exchanger.exchange(token, audience)}"

    return hook
