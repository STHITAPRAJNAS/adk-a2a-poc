"""All four AP2 roles in one process, talking HTTP to each other in memory.

Used by the tests and by the agent when ``AP2_MODE=local``: every call still
goes through the real FastAPI apps (JWKS fetches, A2A JSON-RPC, the -32008
extension check), only the network is replaced by an in-memory router.
"""

from __future__ import annotations

from typing import Any

import httpx

from payments import credential_provider, merchant, processor, trusted_surface
from payments.core import TrustStore
from payments.shopper import Shopper

MERCHANT_URL = "http://merchant.ap2.local"
CP_URL = "http://wallet.ap2.local"
PROCESSOR_URL = "http://processor.ap2.local"
TS_URL = "http://approvals.ap2.local"
MERCHANT_A2A_URL = f"{MERCHANT_URL}/a2a/{merchant.APP_NAME}"


class _Router(httpx.BaseTransport):
    def __init__(self) -> None:
        self.apps: dict[str, Any] = {}
        self.log: list[tuple[str, str, int]] = []

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        from fastapi.testclient import TestClient

        app = self.apps.get(request.url.host)
        if app is None:
            raise httpx.ConnectError(f"no service at {request.url.host}", request=request)
        client = app if isinstance(app, TestClient) else TestClient(app)
        self.apps[request.url.host] = client
        path = request.url.raw_path.decode()
        resp = client.request(
            request.method, path, content=request.read(), headers=dict(request.headers)
        )
        self.log.append((request.method, f"{request.url.host}{request.url.path}", resp.status_code))
        return httpx.Response(resp.status_code, headers=resp.headers, content=resp.content)


class LocalMesh:
    def __init__(self, *, approval_code: str | None = None):
        self.router = _Router()
        self.http = httpx.Client(transport=self.router, timeout=30)

        def trust(**urls: str) -> TrustStore:
            return TrustStore(urls, client=self.http)

        self.ts = trusted_surface.TrustedSurface(
            trust=trust(merchant=MERCHANT_URL), approval_code=approval_code
        )
        self.cp = credential_provider.CredentialProvider(
            trust=trust(**{"agent-provider": TS_URL, "processor": PROCESSOR_URL})
        )
        self.processor = processor.Processor(
            trust=trust(**{"agent-provider": TS_URL, "credential-provider": CP_URL}),
            cp_url=CP_URL,
            http=self.http,
        )
        self.merchant = merchant.Merchant(
            trust=trust(**{"agent-provider": TS_URL}), processor_url=PROCESSOR_URL, http=self.http
        )
        for url, app in (
            (MERCHANT_URL, merchant.build_app(self.merchant)),
            (CP_URL, credential_provider.build_app(self.cp)),
            (PROCESSOR_URL, processor.build_app(self.processor)),
            (TS_URL, trusted_surface.build_app(self.ts)),
        ):
            self.router.apps[httpx.URL(url).host] = app

    def shopper(self, **kw: Any) -> Shopper:
        trust = TrustStore(
            {"merchant": MERCHANT_URL, "processor": PROCESSOR_URL, "agent-provider": TS_URL},
            client=self.http,
        )
        return Shopper(
            merchant_url=MERCHANT_A2A_URL,
            credential_provider_url=CP_URL,
            trusted_surface_url=TS_URL,
            trust=trust,
            http=self.http,
            **kw,
        )

    def approve(self, request_id: str, code: str | None = None) -> dict[str, Any]:
        """What the person does on the approval page."""
        resp = self.http.post(
            f"{TS_URL}/requests/{request_id}/approve", json={"code": code or self.ts.approval_code}
        )
        return resp.raise_for_status().json()
