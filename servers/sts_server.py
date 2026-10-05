"""Lab token service (default port 8010): a tiny OAuth server for lab 82.

It does two jobs, and only two:

``POST /dev/login``  issues a *user* token, standing in for your identity
                     provider's login. Lab only — there is no password. Turn it
                     off with ``STS_DEV_LOGIN=0``.
``POST /token``      RFC 8693 token exchange. An agent presents the token it was
                     called with, authenticates as itself, and names the agent
                     it wants to call next. It gets back a token for *that*
                     agent, for the same user, with scopes that can only shrink,
                     and an ``act`` claim recording who is acting.

plus the discovery documents a verifier needs (``/.well-known/jwks.json`` and
``/.well-known/openid-configuration``).

The policy is deliberately small and readable — it is the thing the lab asks
you to change:

``USERS``       who exists and what each person may do
``DELEGATION``  which agent may call which agent on a user's behalf, and the
                most it may ask for when it does

Client secrets come from ``STS_CLIENTS`` (``name=secret,name2=secret2``). There
is no default: in the cluster the lab generates one with ``openssl rand``.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import jwt  # noqa: E402
from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402

# Module level, not inside build_app: with postponed annotations FastAPI
# resolves ``request: Request`` against module globals.
from fastapi import FastAPI, Request  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402

from common.config import get_settings, load_env  # noqa: E402
from common.identity import ACCESS_TOKEN_TYPE, TOKEN_EXCHANGE_GRANT  # noqa: E402

logger = logging.getLogger("servers.sts_server")  # not __name__: it is "__main__" under -m

#: Who exists, and the most each person may ever do.
USERS: dict[str, set[str]] = {
    "alice": {"release:request", "release:deploy"},  # release manager
    "bob": {"release:request"},  # can ask, cannot ship
}

#: (acting agent, target agent) → the most the acting agent may obtain for a
#: user at that target. A pair that is not listed cannot be delegated at all.
DELEGATION: dict[tuple[str, str], set[str]] = {
    ("ops_concierge", "deployment_agent"): {"release:request", "release:deploy"},
}

#: Every user token is minted for the front door. The audience is what stops a
#: token for one agent being replayed at another.
FRONT_DOOR = "ops_concierge"

USER_TOKEN_SECONDS = 15 * 60
EXCHANGED_TOKEN_SECONDS = 5 * 60


def _load_or_create_key() -> ec.EllipticCurvePrivateKey:
    path = os.environ.get("STS_SIGNING_KEY_PATH", "").strip()
    if path and Path(path).is_file():
        return serialization.load_pem_private_key(Path(path).read_bytes(), password=None)
    # A fresh key per process. Fine for a lab; it does mean a restart
    # invalidates every token in flight, which lab 82 points out.
    return ec.generate_private_key(ec.SECP256R1())


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _parse_clients(raw: str) -> dict[str, str]:
    clients: dict[str, str] = {}
    for item in raw.split(","):
        if "=" in item:
            name, secret = item.split("=", 1)
            if name.strip() and secret.strip():
                clients[name.strip()] = secret.strip()
    return clients


def build_app() -> Any:
    load_env()
    from servers.hardening import configure_logging

    configure_logging()
    settings = get_settings()
    issuer = settings.sts_url
    key = _load_or_create_key()
    public_der = key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    kid = _b64url(hashlib.sha256(public_der).digest())[:16]
    jwk = jwt.algorithms.ECAlgorithm.to_jwk(key.public_key(), as_dict=True)
    jwk.update({"kid": kid, "use": "sig", "alg": "ES256"})
    clients = _parse_clients(os.environ.get("STS_CLIENTS", ""))
    dev_login = os.environ.get("STS_DEV_LOGIN", "1").strip().lower() not in ("0", "false", "no")

    app = FastAPI(title="lab token service", docs_url=None, redoc_url=None)

    def mint(claims: dict[str, Any], lifetime: int) -> tuple[str, int]:
        now = int(time.time())
        exp = min(now + lifetime, int(claims.pop("_cap_exp", now + lifetime)))
        body = {
            "iss": issuer,
            "iat": now,
            "nbf": now,
            "exp": exp,
            "jti": uuid.uuid4().hex,
            **claims,
        }
        return jwt.encode(body, key, algorithm="ES256", headers={"kid": kid}), exp - now

    def oauth_error(status: int, error: str, description: str, **headers: str) -> JSONResponse:
        logger.info("token service refused: %s — %s", error, description)
        return JSONResponse(
            {"error": error, "error_description": description}, status_code=status, headers=headers
        )

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/.well-known/jwks.json")
    async def jwks() -> dict[str, Any]:
        return {"keys": [jwk]}

    @app.get("/.well-known/openid-configuration")
    async def discovery() -> dict[str, Any]:
        return {
            "issuer": issuer,
            "jwks_uri": f"{issuer}/.well-known/jwks.json",
            "token_endpoint": f"{issuer}/token",
            "grant_types_supported": [TOKEN_EXCHANGE_GRANT],
            "token_endpoint_auth_methods_supported": ["client_secret_basic"],
            "id_token_signing_alg_values_supported": ["ES256"],
        }

    @app.post("/dev/login")
    async def login(request: Request) -> JSONResponse:
        if not dev_login:
            return oauth_error(404, "not_found", "dev login is disabled")
        body = await request.json()
        user = str(body.get("user", "")).strip()
        if user not in USERS:
            return oauth_error(400, "invalid_request", f"unknown user {user!r}; try alice or bob")
        token, ttl = mint(
            {"sub": user, "aud": FRONT_DOOR, "scope": " ".join(sorted(USERS[user]))},
            USER_TOKEN_SECONDS,
        )
        logger.info("dev login: %s (aud=%s)", user, FRONT_DOOR)
        return JSONResponse(
            {
                "access_token": token,
                "token_type": "Bearer",
                "expires_in": ttl,
                "scope": " ".join(sorted(USERS[user])),
            }
        )

    @app.post("/token")
    async def token_exchange(request: Request) -> JSONResponse:
        # 1. Who is asking? The acting agent authenticates as itself.
        auth = request.headers.get("authorization", "")
        client_id = secret = ""
        if auth.lower().startswith("basic "):
            try:
                client_id, _, secret = base64.b64decode(auth[6:]).decode().partition(":")
            except Exception:  # noqa: BLE001 - any decode failure is a bad header
                client_id = secret = ""
        if not client_id or clients.get(client_id) != secret or not secret:
            return oauth_error(
                401,
                "invalid_client",
                "client authentication failed",
                **{"WWW-Authenticate": 'Basic realm="lab-sts"'},
            )

        form = await request.form()
        if form.get("grant_type") != TOKEN_EXCHANGE_GRANT:
            return oauth_error(400, "unsupported_grant_type", "only token exchange is supported")
        if form.get("subject_token_type", ACCESS_TOKEN_TYPE) != ACCESS_TOKEN_TYPE:
            return oauth_error(400, "invalid_request", "subject_token_type must be an access token")

        # 2. Is the token it presents genuine — and was it issued *to* it?
        try:
            subject = jwt.decode(
                str(form.get("subject_token", "")),
                key.public_key(),
                algorithms=["ES256"],
                issuer=issuer,
                options={"verify_aud": False, "require": ["exp", "sub", "aud"]},
            )
        except jwt.InvalidTokenError as exc:
            return oauth_error(400, "invalid_grant", f"subject token rejected: {exc}")
        if subject.get("aud") != client_id:
            # Without this check any agent holding any token could launder it:
            # the classic confused deputy.
            return oauth_error(
                400,
                "invalid_grant",
                f"subject token was issued to {subject.get('aud')!r}, not to {client_id!r}",
            )

        # 3. May this agent call that agent for a user at all?
        target = str(form.get("audience", ""))
        allowed = DELEGATION.get((client_id, target))
        if allowed is None:
            return oauth_error(400, "invalid_target", f"{client_id} may not delegate to {target!r}")

        # 4. Scopes can only shrink: what the user has ∩ what the pair allows,
        #    narrowed further by whatever the agent asked for.
        held = set(str(subject.get("scope", "")).split())
        ceiling = held & allowed
        requested = set(str(form.get("scope", "")).split()) or ceiling
        if not requested <= ceiling:
            return oauth_error(
                400,
                "invalid_scope",
                f"asked for {' '.join(sorted(requested - ceiling))} which "
                f"{subject.get('sub')} does not hold or {client_id} may not delegate",
            )
        if not requested:
            return oauth_error(400, "invalid_scope", "no delegable scope left")

        # 5. Same subject, new audience, and a record of who is acting. A token
        #    that was already delegated nests its chain inside ours.
        act: dict[str, Any] = {"sub": client_id}
        if isinstance(subject.get("act"), dict):
            act["act"] = subject["act"]
        token, ttl = mint(
            {
                "sub": subject["sub"],
                "aud": target,
                "scope": " ".join(sorted(requested)),
                "act": act,
                "_cap_exp": subject["exp"],
            },
            EXCHANGED_TOKEN_SECONDS,
        )
        logger.info(
            "exchange: %s acting for %s → aud=%s scope=%s",
            client_id,
            subject["sub"],
            target,
            " ".join(sorted(requested)),
        )
        return JSONResponse(
            {
                "access_token": token,
                "issued_token_type": ACCESS_TOKEN_TYPE,
                "token_type": "Bearer",
                "expires_in": ttl,
                "scope": " ".join(sorted(requested)),
            }
        )

    return app


app = build_app()


def main() -> None:
    import uvicorn

    host = os.environ.get("STS_HOST", "127.0.0.1")
    port = int(os.environ.get("STS_PORT", "8010"))
    settings = get_settings()
    print(f"Lab token service  issuer {settings.sts_url}  listening on {host}:{port}")
    if not os.environ.get("STS_CLIENTS"):
        print("  STS_CLIENTS is empty: token exchange will refuse every client")
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
