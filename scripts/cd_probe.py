"""Drive the fake CD system from lab 91 (servers/cd_server.py).

    python scripts/cd_probe.py list URL [--ticket CHG-…]
    python scripts/cd_probe.py lose-next URL [N] [--delay SECONDS]
    python scripts/cd_probe.py reset URL
    python scripts/cd_probe.py deploy URL --ticket CHG-… [--version V] [--key KEY]

Exit codes: 0 fine, 2 the CD system refused, 3 could not reach it,
6 the ledger holds more than one deployment for one approval ticket.
"""

from __future__ import annotations

import argparse
import os
import sys
from collections import Counter

import httpx

_COLOR = sys.stdout.isatty() and not os.environ.get("NO_COLOR")


def _c(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _COLOR else text


def _request(method: str, url: str, **kw) -> httpx.Response:
    try:
        return httpx.request(method, url, timeout=15.0, **kw)
    except httpx.TransportError as exc:
        print(_c("31", f"✗ could not reach the CD system at {url}: {type(exc).__name__}"))
        raise SystemExit(3) from exc


def cmd_list(args: argparse.Namespace) -> int:
    params = {"approval_ticket": args.ticket} if args.ticket else {}
    rows = _request("GET", f"{args.url}/deployments", params=params).json()["deployments"]
    print(f"deployments in the CD ledger: {len(rows)}")
    for r in rows:
        key = r["idempotency_key"] or "(no key)"
        print(
            f"  {r['deployment_id']}  {r['service']} {r['version']} → {r['environment']}"
            f"  ticket {r['approval_ticket']}  key {key}"
        )
    twice = {t: n for t, n in Counter(r["approval_ticket"] for r in rows).items() if n > 1}
    if twice:
        for ticket, n in twice.items():
            print(_c("31", f"\n✗ DEPLOYED {n} TIMES: one approval ({ticket}), {n} deployments"))
        return 6
    if rows:
        print(_c("32", "\n✓ one deployment per approved change"))
    return 0


def cmd_lose_next(args: argparse.Namespace) -> int:
    body = {"lose_next": args.n, "delay_seconds": args.delay}
    _request("POST", f"{args.url}/faults", json=body)
    print(f"the CD system will lose its next {args.n} response(s): start, then answer late")
    return 0


def cmd_reset(args: argparse.Namespace) -> int:
    _request("DELETE", f"{args.url}/deployments")
    print("CD ledger emptied")
    return 0


def cmd_deploy(args: argparse.Namespace) -> int:
    body = {
        "service": args.service,
        "version": args.version,
        "environment": args.environment,
        "approval_ticket": args.ticket,
    }
    headers = {"Idempotency-Key": args.key} if args.key else {}
    resp = _request("POST", f"{args.url}/deployments", json=body, headers=headers)
    data = resp.json()
    if resp.status_code >= 400:
        print(_c("31", f"✗ refused, HTTP {resp.status_code}: {data.get('message', data)}"))
        return 2
    if resp.headers.get("idempotent-replayed") == "true":
        print(_c("32", f"✓ replayed {data['deployment_id']}: the same deployment, nothing new"))
    else:
        print(_c("33", f"started {data['deployment_id']} ({args.service} {args.version})"))
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("list", help="show the ledger; exit 6 on a duplicate")
    s.add_argument("url")
    s.add_argument("--ticket")
    s.set_defaults(fn=cmd_list)
    s = sub.add_parser("lose-next", help="lose the next N responses")
    s.add_argument("url")
    s.add_argument("n", nargs="?", type=int, default=1)
    s.add_argument("--delay", type=float, default=6.0)
    s.set_defaults(fn=cmd_lose_next)
    s = sub.add_parser("reset", help="empty the ledger")
    s.add_argument("url")
    s.set_defaults(fn=cmd_reset)
    s = sub.add_parser("deploy", help="call the CD system directly")
    s.add_argument("url")
    s.add_argument("--ticket", required=True)
    s.add_argument("--service", default="checkout-api")
    s.add_argument("--version", default="2.14.0")
    s.add_argument("--environment", default="production")
    s.add_argument("--key")
    s.set_defaults(fn=cmd_deploy)
    args = p.parse_args()
    args.url = args.url.rstrip("/")
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
