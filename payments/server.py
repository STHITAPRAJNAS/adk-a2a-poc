"""Run one AP2 role as an HTTP service.

    python -m payments.server merchant             # :8410, A2A at /a2a/northwind_sales
    python -m payments.server credential-provider  # :8411
    python -m payments.server processor            # :8412
    python -m payments.server trusted-surface      # :8413

Each role publishes its public key at /.well-known/jwks.json and finds the
others' keys through the AP2_*_URL variables (its trust list).
"""

from __future__ import annotations

import os
import sys

ROLES = {
    "merchant": ("payments.merchant", 8410),
    "credential-provider": ("payments.credential_provider", 8411),
    "processor": ("payments.processor", 8412),
    "trusted-surface": ("payments.trusted_surface", 8413),
}


def main(argv: list[str]) -> None:
    import importlib

    import uvicorn

    if len(argv) != 1 or argv[0] not in ROLES:
        raise SystemExit(f"usage: python -m payments.server {{{'|'.join(ROLES)}}}")
    module, default_port = ROLES[argv[0]]
    app = importlib.import_module(module).build_app()
    uvicorn.run(
        app,
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", default_port)),
    )


if __name__ == "__main__":
    main(sys.argv[1:])
