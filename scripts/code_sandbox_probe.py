"""Run agent-written code through an ADK code executor and report what it reached.

    python scripts/code_sandbox_probe.py --executor local            # in the agent's pod
    python scripts/code_sandbox_probe.py --executor job              # a locked-down Job
    python scripts/code_sandbox_probe.py --executor job --code check # the harmless check

It calls ``execute_code`` exactly as ADK's code-execution step does when an
``LlmAgent(code_executor=...)`` runs a code block the model wrote. The default
code (``escape``) tries what a hostile program would try; see
``common/code_sandbox.py``.

Exit codes: 0 everything was contained (or the check ran), 7 the code reached
something it should not have, 1 the executor failed.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from google.adk.code_executors.code_execution_utils import CodeExecutionInput  # noqa: E402

from common.code_sandbox import ERROR_RATE_CHECK, ESCAPE_CHECK, build_executor  # noqa: E402

_COLOR = sys.stdout.isatty() and not os.environ.get("NO_COLOR")


def _c(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _COLOR else text


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument("--executor", choices=["local", "job"], default="local")
    p.add_argument("--code", choices=["escape", "check"], default="escape")
    p.add_argument("--runtime-class", help="job mode: e.g. gvisor (default: CODE_RUNTIME_CLASS)")
    args = p.parse_args()

    # ADK logs a full traceback when it finds no cluster; the line below says why.
    logging.getLogger("google_adk").setLevel(logging.CRITICAL)
    overrides = {"runtime_class": args.runtime_class} if args.runtime_class else {}
    try:
        executor = build_executor(args.executor, **overrides)
    except Exception as exc:  # noqa: BLE001 - report, do not trace
        print(_c("31", f"✗ could not build the {args.executor} executor: {exc}"))
        return 1
    code = ESCAPE_CHECK if args.code == "escape" else ERROR_RATE_CHECK
    where = (
        "a subprocess of the agent, in its pod"
        if args.executor == "local"
        else (
            f"a Job in namespace {executor.namespace}"
            + (f", runtime class {executor.runtime_class}" if executor.runtime_class else "")
        )
    )
    print(_c("2", f"running agent-written code in {where}"))
    started = time.monotonic()
    ctx = SimpleNamespace(invocation_id=f"lab92-{int(time.time())}")
    result = executor.execute_code(ctx, CodeExecutionInput(code=code))
    took = time.monotonic() - started

    rows = []
    for line in (result.stdout or "").splitlines():
        try:
            rows.append(json.loads(line))
        except ValueError:
            if line.strip():
                print(f"  {line}")
    if args.code == "check":
        ok = not result.stderr and result.exit_code in (0, None)
        print(_c("32" if ok else "31", f"\n{'✓' if ok else '✗'} the check ran in {took:.1f}s"))
        if result.stderr:
            print(result.stderr[-800:])
        return 0 if ok else 1
    if not rows:
        print(_c("31", f"✗ the code produced no report after {took:.1f}s"))
        print((result.stderr or "")[-1200:])
        return 1

    escaped = 0
    print()
    for row in rows:
        if row["escaped"] is None:
            mark, color = "·", "2"
        elif row["escaped"]:
            mark, color = "✗", "31"
            escaped += 1
        else:
            mark, color = "✓", "32"
        print(_c(color, f"  {mark} {row['check']:<24} {row['detail']}"))
    judged = sum(1 for r in rows if r["escaped"] is not None)
    print()
    if escaped:
        print(_c("31", f"✗ REACHED {escaped} of {judged}: this code runs with the agent's access"))
        return 7
    print(_c("32", f"✓ contained: 0 of {judged} reached, in {took:.1f}s"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
