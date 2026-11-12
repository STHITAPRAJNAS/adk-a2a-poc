"""A fake CD system for lab 91: the thing ``start_deployment`` really calls.

Every earlier lab kept the deployment inside the agent's own process. Real
release agents call a CD system over the network, and that call has the one
failure mode retries cannot fix on their own: **the request worked, the
response was lost.** The caller cannot tell "it never happened" from "it
happened and I did not hear back", so it retries, and the deployment runs
twice.

This server keeps a ledger of deployments in SQLite (``CD_DB``), so the lab
can count them, and supports the ``Idempotency-Key`` request header
(IETF draft-ietf-httpapi-idempotency-key-header; the same header Stripe and
the Agentic Commerce Protocol use):

* first request with a key: create the deployment, remember key → response;
* same key, same body: return the remembered response, create nothing
  (``Idempotent-Replayed: true``);
* same key, different body: ``422``, because a key names one operation.

Without a key, every request creates a deployment.

Fault injection: ``POST /faults {"lose_next": N, "delay_seconds": S}``. The
next N requests are committed to the ledger, then answered only after S
seconds, longer than the caller waits. That is a lost response.

    GET    /deployments[?approval_ticket=…]   the ledger
    POST   /deployments                       start one (optional Idempotency-Key)
    DELETE /deployments                       empty the ledger (lab reset)
    POST   /faults                            lose the next N responses
    GET    /health
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import sqlite3
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

logger = logging.getLogger("servers.cd_server")

_FIELDS = ("service", "version", "environment", "approval_ticket")


class Ledger:
    """Deployments and idempotency keys, in one SQLite file."""

    def __init__(self, path: str):
        self._lock = threading.Lock()
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS deployments (
                id TEXT PRIMARY KEY, service TEXT, version TEXT, environment TEXT,
                approval_ticket TEXT, idempotency_key TEXT, created_at REAL);
            CREATE TABLE IF NOT EXISTS idempotency (
                key TEXT PRIMARY KEY, fingerprint TEXT, response TEXT);
            """
        )
        self._db.commit()

    def start(self, body: dict[str, Any], key: str | None) -> tuple[int, dict, bool]:
        """Returns (status, response body, replayed)."""
        fingerprint = hashlib.sha256(
            json.dumps({f: body.get(f) for f in _FIELDS}, sort_keys=True).encode()
        ).hexdigest()
        with self._lock:
            if key:
                row = self._db.execute(
                    "SELECT fingerprint, response FROM idempotency WHERE key = ?", (key,)
                ).fetchone()
                if row and row[0] != fingerprint:
                    return (
                        422,
                        {
                            "error": "idempotency_key_reused",
                            "message": f"Idempotency-Key {key} was already used for a "
                            "different deployment; a key names one operation.",
                        },
                        False,
                    )
                if row:
                    return 201, json.loads(row[1]), True
            n = self._db.execute("SELECT COUNT(*) FROM deployments").fetchone()[0] + 1
            record = {
                "deployment_id": f"dep-{n:04d}",
                **{f: body.get(f) for f in _FIELDS},
                "idempotency_key": key,
                "created_at": time.time(),
                "status": "started",
            }
            self._db.execute(
                "INSERT INTO deployments VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    record["deployment_id"],
                    record["service"],
                    record["version"],
                    record["environment"],
                    record["approval_ticket"],
                    key,
                    record["created_at"],
                ),
            )
            if key:
                self._db.execute(
                    "INSERT INTO idempotency VALUES (?, ?, ?)",
                    (key, fingerprint, json.dumps(record)),
                )
            self._db.commit()
            return 201, record, False

    def list(self, ticket: str | None = None) -> list[dict[str, Any]]:
        sql = "SELECT id, service, version, environment, approval_ticket, idempotency_key, "
        sql += "created_at FROM deployments"
        args: tuple = ()
        if ticket:
            sql += " WHERE approval_ticket = ?"
            args = (ticket,)
        with self._lock:
            rows = self._db.execute(sql + " ORDER BY created_at", args).fetchall()
        keys = ("deployment_id", "service", "version", "environment", "approval_ticket")
        return [
            {**dict(zip(keys, r[:5], strict=True)), "idempotency_key": r[5], "created_at": r[6]}
            for r in rows
        ]

    def reset(self) -> None:
        with self._lock:
            self._db.executescript("DELETE FROM deployments; DELETE FROM idempotency;")
            self._db.commit()


def build_app(db_path: str | None = None) -> Starlette:
    path = db_path or os.environ.get("CD_DB") or str(Path(tempfile.gettempdir()) / "cd-ledger.db")
    ledger = Ledger(path)
    faults = {"lose_next": 0, "delay_seconds": 6.0}

    async def start(request: Request) -> JSONResponse:
        try:
            body = await request.json()
        except ValueError:
            return JSONResponse({"error": "bad_json"}, status_code=400)
        missing = [f for f in _FIELDS if not body.get(f)]
        if missing:
            return JSONResponse({"error": "missing", "fields": missing}, status_code=400)
        key = request.headers.get("idempotency-key") or None
        status, record, replayed = ledger.start(body, key)
        if status != 201:
            logger.warning("refused: %s", record["message"])
            return JSONResponse(record, status_code=status)
        if replayed:
            logger.info(
                "replayed %s for %s (Idempotency-Key %s): nothing new started",
                record["deployment_id"],
                record["approval_ticket"],
                key,
            )
        else:
            logger.info(
                "STARTED %s: %s %s → %s for %s (Idempotency-Key %s)",
                record["deployment_id"],
                record["service"],
                record["version"],
                record["environment"],
                record["approval_ticket"],
                key or "none",
            )
        if faults["lose_next"] > 0:
            faults["lose_next"] -= 1
            logger.warning(
                "losing the response for %s: answering after %.0fs",
                record["deployment_id"],
                faults["delay_seconds"],
            )
            await asyncio.sleep(faults["delay_seconds"])
        headers = {"Idempotent-Replayed": "true"} if replayed else {}
        return JSONResponse(record, status_code=201, headers=headers)

    async def list_(request: Request) -> JSONResponse:
        ticket = request.query_params.get("approval_ticket")
        return JSONResponse({"deployments": ledger.list(ticket)})

    async def reset(request: Request) -> JSONResponse:
        ledger.reset()
        logger.info("ledger emptied")
        return JSONResponse({"deployments": []})

    async def set_faults(request: Request) -> JSONResponse:
        body = await request.json()
        faults["lose_next"] = int(body.get("lose_next", 0))
        faults["delay_seconds"] = float(body.get("delay_seconds", faults["delay_seconds"]))
        logger.info("faults: %s", faults)
        return JSONResponse(faults)

    async def health(request: Request) -> JSONResponse:
        return JSONResponse({"ok": True})

    return Starlette(
        routes=[
            Route("/deployments", start, methods=["POST"]),
            Route("/deployments", list_, methods=["GET"]),
            Route("/deployments", reset, methods=["DELETE"]),
            Route("/faults", set_faults, methods=["POST"]),
            Route("/health", health),
        ]
    )


def main() -> None:
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(levelname)s:     [%(name)s] %(message)s")
    uvicorn.run(
        build_app(),
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "8420")),
        log_level="warning",
    )


if __name__ == "__main__":
    main()
