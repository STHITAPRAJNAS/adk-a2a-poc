"""Lab 89: a token budget that travels with the request.

Three cases, each with the specialist allowed 100000 tokens and the front door
given less or more:

* plenty: the release parks at the approval gate as usual, both agents log
  what they spent, and the specialist's limit is what the concierge left;
* a budget that runs out mid-release: the specialist stops before its next
  model call and the caller reads why;
* a budget the concierge spends on its own: the specialist refuses the hop
  with JSON-RPC -32012 before doing any work.
"""

from __future__ import annotations

import re

import test_production
from test_production import _specialist_url, probe

#: The two-agent fixture from test_production, reused here.
stack = test_production.stack

SPECIALIST_BUDGET = "100000"


def _spent(log: str, agent: str) -> list[tuple[int, int]]:
    found = re.findall(rf"budget on {agent}: spent (\d+) of (\d+) tokens", log)
    return [(int(a), int(b)) for a, b in found]


def _run(stack, tmp_path, front: str):
    specialist = stack("specialist", 18001, A2A_TOKEN_BUDGET=SPECIALIST_BUDGET)
    concierge = stack("concierge", 18000, A2A_TOKEN_BUDGET=front, **_specialist_url(18001))
    code, out = probe(tmp_path / "s.json", 18000, 18001, "pause")
    return code, out, concierge, specialist


def test_budget_is_carried_to_the_next_hop(stack, tmp_path):
    code, out, concierge, specialist = _run(stack, tmp_path, "100000")
    assert code == 0, out
    [(front_spent, front_limit)] = _spent(concierge.logs(), "ops_concierge")
    [(_, specialist_limit)] = _spent(specialist.logs(), "deployment_agent")
    assert front_limit == 100000
    # The specialist got what the concierge had left, not its own 100000.
    assert specialist_limit == front_limit - front_spent, (front_spent, specialist_limit)


def test_budget_spent_mid_release_stops_the_specialist(stack, tmp_path):
    code, out, _, specialist = _run(stack, tmp_path, "2000")
    assert code == 5 and "BUDGET SPENT mid-release" in out, out
    assert "Budget exhausted: deployment_agent has spent" in out, out
    # It stopped before asking for approval: nothing was left to ask with.
    assert "request_change_approval" not in out, out
    [(spent, limit)] = _spent(specialist.logs(), "deployment_agent")
    assert spent >= limit


def test_no_budget_left_refuses_the_hop(stack, tmp_path):
    code, out, _, specialist = _run(stack, tmp_path, "300")
    assert code == 5 and "BUDGET SPENT before the next hop" in out, out
    assert "-32012" in out and "with no tokens left" in out, out
    assert "refusing a request with no budget left" in specialist.logs()
    assert _spent(specialist.logs(), "deployment_agent") == []
