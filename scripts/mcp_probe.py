#!/usr/bin/env python
"""Talks MCP to a server, directly or through a gateway (lab 87).

    list  URL               which tools the server shows this caller
    call  URL TOOL [JSON]   call one tool with JSON arguments
    read  URL URI           read one resource (e.g. an MCP Apps ui:// view)
    web   URL               plain HTTPS GET, to show whether egress is open

Exit codes: 0 worked, 2 refused or filtered, 3 could not connect (blocked).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"
if os.environ.get("NO_COLOR"):
    GREEN = RED = YELLOW = DIM = RESET = ""


def unreachable(exc: BaseException) -> bool:
    text = f"{type(exc).__name__}: {exc}".lower()
    return any(
        w in text
        for w in ("connect", "timed out", "timeout", "unreachable", "refused", "resolution")
    )


async def cmd_list(url: str) -> int:
    from mcp import Client

    async with Client(url) as client:
        tools = (await client.list_tools()).tools
    print(f"tools this caller can see at {url}:")
    for tool in tools:
        print(f"  {tool.name:<22} {DIM}{(tool.description or '').splitlines()[0]}{RESET}")
        view = ((tool.meta or {}).get("ui") or {}).get("resourceUri")
        if view:
            print(f"  {'':<22} {DIM}view (MCP Apps): {view}{RESET}")
    return 0


async def cmd_read(url: str, uri: str) -> int:
    from mcp import Client

    async with Client(url) as client:
        result = await client.read_resource(uri)
    for item in result.contents:
        text = getattr(item, "text", "") or ""
        print(f"{GREEN}✓ {item.uri}{RESET}  {item.mime_type}  {len(text)} characters")
        print(f"{DIM}{text[:200]}{RESET}")
    return 0


async def cmd_call(url: str, tool: str, args: dict) -> int:
    from mcp import Client

    async with Client(url) as client:
        result = await client.call_tool(tool, args)
    text = " ".join(getattr(c, "text", "") for c in result.content)
    if getattr(result, "is_error", getattr(result, "isError", False)):
        print(f"{RED}✗ {tool} refused:{RESET} {text[:300]}")
        return 2
    print(f"{GREEN}✓ {tool}{RESET} → {text[:300]}")
    return 0


def cmd_web(url: str) -> int:
    import httpx

    try:
        resp = httpx.get(url, timeout=8)
    except httpx.HTTPError as exc:
        print(f"{GREEN}✓ blocked:{RESET} {type(exc).__name__} reaching {url}")
        return 3
    print(f"{YELLOW}! reachable:{RESET} {url} answered HTTP {resp.status_code}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list").add_argument("url")
    call = sub.add_parser("call")
    call.add_argument("url")
    call.add_argument("tool")
    call.add_argument("args", nargs="?", default="{}")
    read = sub.add_parser("read")
    read.add_argument("url")
    read.add_argument("uri")
    sub.add_parser("web").add_argument("url")
    args = parser.parse_args()
    if args.cmd == "web":
        return cmd_web(args.url)
    try:
        if args.cmd == "list":
            return asyncio.run(cmd_list(args.url))
        if args.cmd == "read":
            return asyncio.run(cmd_read(args.url, args.uri))
        return asyncio.run(cmd_call(args.url, args.tool, json.loads(args.args)))
    except BaseException as exc:  # noqa: BLE001 - report every failure as a result
        inner = exc.exceptions[0] if isinstance(exc, BaseExceptionGroup) and exc.exceptions else exc
        if unreachable(inner):
            print(f"{GREEN}✓ blocked:{RESET} cannot reach {args.url} ({type(inner).__name__})")
            return 3
        print(f"{RED}✗ refused:{RESET} {type(inner).__name__}: {str(inner)[:300]}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
