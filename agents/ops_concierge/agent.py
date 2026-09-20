"""Ops concierge — the A2A *client* side of the PoC.

This agent holds no deployment logic at all. It owns the conversation with the
human and reaches the release-operations agent across a process boundary through
``RemoteA2aAgent``, which:

  1. fetches ``agent-card.json`` from the remote and validates it (https, or
     http on a loopback host, and same-origin with where the card was fetched);
  2. negotiates a transport from the card's ``supported_interfaces``;
  3. converts ADK events into A2A messages on the way out and back on the way in;
  4. carries the A2A ``task_id``/``context_id`` on ADK event ``custom_metadata``
     so a follow-up turn resumes the *same* remote task instead of opening a new
     one.

Point (4) is what makes human-in-the-loop work across the boundary. When the
remote parks on a long-running function call, ADK ends that A2A task in
``TASK_STATE_INPUT_REQUIRED`` and ships the pending function call back as a
DataPart flagged ``adk_is_long_running``. ``RemoteA2aAgent`` turns it back into a
genuine ADK function call in this session, so the operator can answer it with an
ordinary function response — and ADK routes that response onto the same task.
"""

from __future__ import annotations

from google.adk.agents import LlmAgent
from google.adk.agents.remote_a2a_agent import RemoteA2aAgent
from google.adk.apps import App, ResumabilityConfig

from common.config import get_settings, resolve_model
from common.opa_guard import make_opa_tool_guard

_INSTRUCTION = """\
You are the Ops Concierge. You talk to platform engineers about releases.

You do not perform releases yourself and you have no deployment tools. All
release work — readiness checks, compliance scans, change approvals and
deployments — belongs to `deployment_agent`, which runs as a separate service
and is reached over the A2A protocol.

Rules:
- For any request about releasing, deploying, rolling out, checking readiness,
  compliance scanning or change approval, transfer to `deployment_agent`.
- Never invent a deployment status, an approval decision or a job outcome.
- For anything else (small talk, questions about what you can do), answer
  directly and briefly, and mention that release work is handled by the remote
  release-operations agent.
"""


class TransferableRemoteA2aAgent(RemoteA2aAgent):
    """A ``RemoteA2aAgent`` the runner is willing to resume after a transfer.

    Without this subclass the human-in-the-loop resume is a silent no-op, and
    the reason is worth understanding because it is the sharpest edge in wiring
    A2A into a multi-agent ADK app.

    When a function response arrives, ``Runner._find_agent_to_run`` decides who
    receives it. Its first rule — route the response to the agent that issued
    the matching call — is evaluated against the session *before* the incoming
    message is appended, so on this path the last event is the remote's pending
    function call, not the response, and the rule does not fire. Execution falls
    through to a scan back over the session for the last agent that spoke, which
    is ``deployment_agent`` — but that agent is only accepted if
    ``Runner._is_transferable_across_agent_tree`` says so, and that helper
    rejects outright any agent lacking a ``disallow_transfer_to_parent``
    attribute. ``RemoteA2aAgent`` extends ``BaseAgent``, not ``LlmAgent``, so it
    has no such attribute and is skipped. The scan then reaches
    ``ops_concierge``, the root, which is handed an approval decision for a call
    it never made — while the remote A2A task sits in ``INPUT_REQUIRED``
    forever.

    Declaring the two transfer flags an ``LlmAgent`` would carry makes the
    remote agent visible to that check, so the function response is delivered to
    the ``RemoteA2aAgent``, which forwards it onto the open A2A task.

    ADK's other supported answer to this is ``mode="task"`` on both ends, where
    the remote signals completion with the ``finish_task`` tool and the parent
    coordinator owns the delegation. That contract is heavier — the remote must
    be a task-mode ADK agent and the client must mirror its output schema — so
    this PoC stays on plain ``transfer_to_agent`` delegation, which is the
    shape most existing A2A servers actually expose.
    """

    disallow_transfer_to_parent: bool = False
    disallow_transfer_to_peers: bool = False


def build_remote_deployment_agent() -> TransferableRemoteA2aAgent:
    """Builds the A2A client proxy for the release-operations agent."""
    settings = get_settings()
    return TransferableRemoteA2aAgent(
        name="deployment_agent",
        # The description is what this agent's LLM reads when deciding to
        # delegate, so it has to describe the remote's real capabilities.
        description=(
            "Remote release operations agent, reached over A2A. Checks release "
            "readiness, runs compliance scans, opens human change-approval "
            "tickets and executes deployment jobs. Pauses for human approval "
            "before production releases."
        ),
        agent_card=settings.deployment_agent_card_url,
        # Long-running work parks the remote task; a generous read timeout keeps
        # the streaming connection alive across the compliance scan.
        timeout=900.0,
    )


def build_agent() -> LlmAgent:
    """Constructs the orchestrator with the remote agent as a sub-agent.

    ``sub_agents`` rather than ``AgentTool`` is deliberate. Transferring to the
    remote agent keeps it the agent that spoke last, so the function response
    resolving a pending approval is routed back into the same A2A task. Wrapping
    the remote as a tool would collapse the entire remote exchange into one tool
    call, and a pending long-running call would have nowhere to surface.
    """
    settings = get_settings()
    if settings.use_fake_llm:
        from common.fake_llm import build_orchestrator_model

        model = build_orchestrator_model()
    else:
        model = resolve_model(settings.orchestrator_model)

    return LlmAgent(
        name="ops_concierge",
        model=model,
        description="Front door for platform engineers asking about releases.",
        instruction=_INSTRUCTION,
        sub_agents=[build_remote_deployment_agent()],
        # When OPA_URL is set, every tool call (including transfer_to_agent) is
        # checked against OPA before it runs. None when unset → no-op.
        before_tool_callback=make_opa_tool_guard("ops_concierge"),
    )


root_agent = build_agent()

#: Resumability is mandatory for this PoC, not a nice-to-have.
#:
#: ``ResumabilityConfig(is_resumable=True)`` makes ADK pause the invocation on
#: an unresolved long-running function call instead of unwinding, and keeps the
#: paused branch addressable so a later function response can restart it. With
#: it off, the pending approval would never be offered back to the operator as a
#: function call it can answer.
app = App(
    name="ops_concierge",
    root_agent=root_agent,
    resumability_config=ResumabilityConfig(is_resumable=True),
)
