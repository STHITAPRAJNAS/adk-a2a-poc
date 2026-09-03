"""Tests for the A2A Agent Card and how ADK mounts it.

A card that parses but points somewhere the client refuses to call is the most
common way an A2A wiring fails, and it fails at first use rather than at start
up. These tests catch that at build time.
"""

from __future__ import annotations

import json
from urllib.parse import urlparse

import pytest
from google.adk.a2a import _compat

from common.config import DEPLOYMENT_AGENT_APP_NAME, REMOTE_AGENTS_DIR

CARD_PATH = REMOTE_AGENTS_DIR / DEPLOYMENT_AGENT_APP_NAME / "agent.json"


@pytest.fixture(scope="module")
def card_json() -> dict:
    return json.loads(CARD_PATH.read_text())


@pytest.fixture(scope="module")
def card(card_json):
    return _compat.parse_agent_card(card_json)


def test_card_sits_where_get_fast_api_app_looks_for_it():
    """``a2a=True`` only exposes directories that contain an ``agent.json``."""
    assert CARD_PATH.is_file()
    assert (CARD_PATH.parent / "agent.py").is_file()


def test_card_parses_with_the_installed_a2a_sdk(card):
    assert card.name == DEPLOYMENT_AGENT_APP_NAME
    assert card.description


def test_card_advertises_streaming(card):
    assert card.capabilities.streaming is True


def test_card_rpc_url_matches_the_mount_path(card, settings):
    """ADK mounts the RPC endpoint at ``/a2a/<dir>``; the card must say so."""
    urls = _compat.agent_card_rpc_urls(card)
    assert urls == [settings.deployment_agent_rpc_url]


def test_card_url_shares_an_origin_with_the_card_url(card, settings):
    """``RemoteA2aAgent`` rejects a card whose RPC URL is on another origin.

    It also demands https unless the host is loopback, which is why the PoC
    stays on 127.0.0.1 rather than a LAN address.
    """
    rpc = urlparse(_compat.agent_card_rpc_urls(card)[0])
    fetched_from = urlparse(settings.deployment_agent_card_url)
    assert (rpc.scheme, rpc.hostname, rpc.port) == (
        fetched_from.scheme,
        fetched_from.hostname,
        fetched_from.port,
    )
    assert rpc.hostname in ("127.0.0.1", "localhost", "::1"), (
        "plain http is only accepted on a loopback host"
    )


def test_skills_cover_the_agent_s_real_capabilities(card):
    """The consuming LLM routes on these, so they must not be decorative."""
    skills = {skill.id: skill for skill in card.skills}
    assert set(skills) == {
        "release_readiness",
        "compliance_scan",
        "human_change_approval",
        "deployment_execution",
    }
    for skill in skills.values():
        assert skill.description, f"{skill.id} has no description"
        assert list(skill.examples), f"{skill.id} has no examples to route on"


def test_hitl_skill_is_discoverable_as_input_required(card):
    """A caller should be able to tell from the card alone that this agent pauses."""
    skills = {skill.id: skill for skill in card.skills}
    assert "input-required" in list(skills["human_change_approval"].tags)
    assert "input-required" in list(skills["deployment_execution"].tags)


@pytest.mark.asyncio
async def test_card_is_served_over_http(remote_a2a_server, settings):
    import httpx

    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.get(settings.deployment_agent_card_url)
    assert response.status_code == 200
    served = _compat.parse_agent_card(response.json())
    assert served.name == DEPLOYMENT_AGENT_APP_NAME
    assert _compat.agent_card_rpc_urls(served) == [settings.deployment_agent_rpc_url]
