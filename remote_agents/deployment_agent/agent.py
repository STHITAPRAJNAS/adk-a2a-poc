"""Release-operations agent — the A2A *server* side of the PoC.

Served by ``servers/remote_agent_server.py`` through
``get_fast_api_app(agents_dir=..., a2a=True)``, which mounts:

  * ``/a2a/deployment_agent``                              JSON-RPC endpoint
  * ``/a2a/deployment_agent/.well-known/agent-card.json``  Agent Card
  * ``/dev-ui?app=deployment_agent``                       ADK Dev UI

The Dev UI mount matters: it lets you drive this agent directly, with no A2A in
the picture, so you can tell an agent bug apart from a protocol bug.
"""

from __future__ import annotations

from google.adk.agents import LlmAgent
from google.adk.apps import App, ResumabilityConfig

from common.config import get_settings

from . import tools

_INSTRUCTION = """\
You are the Release Operations agent. You own deployments for a small platform
team and you are addressed by other agents over the A2A protocol, not directly
by an end user. Be terse and factual — your output is consumed by another agent.

Follow this procedure for every release request, and do not skip steps:

1. Call `check_release_readiness` first. If it reports blockers, stop and report
   them. Never work around a blocker.
2. Call `run_compliance_scan`. It takes a while; that is expected. Do not call
   it more than once for the same release.
3. If `check_release_readiness` said `requires_human_approval` is true, call
   `request_change_approval` with an accurate one-line summary and the risk it
   reported. This tool is long-running: it returns `pending_human_approval` and
   the conversation pauses until a human decision arrives. Do NOT treat
   `pending_human_approval` as an approval, and do NOT call the tool again while
   a ticket is pending.
4. Once the approval response arrives:
   - if it is not approved, stop and report that the release was rejected,
     quoting the note if one was given;
   - if it is approved, call `start_deployment` with the approval ticket id.
     This tool is also long-running: it returns a job id immediately and the
     conversation pauses until the job's terminal result arrives.
5. When the deployment result arrives, report the outcome: service, version,
   environment, final status and the approval ticket used.

Never claim a deployment succeeded before you have seen the terminal result of
`start_deployment`.
"""


def build_agent() -> LlmAgent:
    """Constructs the release-operations agent.

    Kept as a factory so tests can build it against a scripted model without
    importing module-level state.
    """
    settings = get_settings()
    if settings.use_fake_llm:
        from common.fake_llm import build_deployment_agent_model

        model = build_deployment_agent_model()
    else:
        model = settings.deployment_agent_model

    return LlmAgent(
        name="deployment_agent",
        model=model,
        description=(
            "Release operations specialist. Checks release readiness, runs compliance "
            "scans, raises human change-approval tickets and drives deployment jobs "
            "for services owned by the platform team."
        ),
        instruction=_INSTRUCTION,
        tools=tools.ALL_TOOLS,
    )


root_agent = build_agent()

#: Exporting an ``App`` rather than a bare agent is what turns on resumability.
#:
#: ``ResumabilityConfig(is_resumable=True)`` makes ADK (a) pause the invocation
#: when a long-running function call is issued instead of unwinding to the root
#: agent, and (b) route an incoming function response back to the agent that
#: issued the matching call. Without it the approval decision would be handed to
#: whichever agent happens to be at the root and the HITL resume would break.
app = App(
    name="deployment_agent",
    root_agent=root_agent,
    resumability_config=ResumabilityConfig(is_resumable=True),
)
