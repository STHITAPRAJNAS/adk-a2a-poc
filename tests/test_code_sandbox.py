"""Lab 92: where agent-written code runs, and what it can reach there.

No cluster here, so the Job executor is checked through the manifest it would
submit: it must pass Pod Security "restricted" (which the lab's namespace
enforces), carry the label the lab's NetworkPolicy selects, and leave out the
gVisor RuntimeClass unless asked. ADK's stock manifest is checked too, to pin
down why the subclass exists. The local executor is run for real.
"""

from __future__ import annotations

import os
import subprocess
import sys
from types import SimpleNamespace

import pytest
from kubernetes import client
from test_production import REPO_ROOT

from common.code_sandbox import job_manifest_for_tests


def _pod(manifest) -> dict:
    return client.ApiClient().sanitize_for_serialization(manifest)["spec"]["template"]


def _restricted_violations(template: dict) -> list[str]:
    """The Pod Security 'restricted' rules a code-runner pod could break."""
    spec = template["spec"]
    pod_sc = spec.get("securityContext") or {}
    out = []
    for c in spec["containers"]:
        sc = c.get("securityContext") or {}
        if sc.get("allowPrivilegeEscalation") is not False:
            out.append("allowPrivilegeEscalation")
        if "ALL" not in ((sc.get("capabilities") or {}).get("drop") or []):
            out.append("capabilities")
        if not (sc.get("runAsNonRoot") or pod_sc.get("runAsNonRoot")):
            out.append("runAsNonRoot")
        seccomp = (sc.get("seccompProfile") or pod_sc.get("seccompProfile") or {}).get("type")
        if seccomp not in ("RuntimeDefault", "Localhost"):
            out.append("seccompProfile")
    for v in spec.get("volumes") or []:
        if "hostPath" in v:
            out.append("hostPath")
    return out


def test_job_pod_passes_pod_security_restricted():
    assert _restricted_violations(_pod(job_manifest_for_tests())) == []


def test_stock_adk_job_pod_would_be_refused():
    from google.adk.code_executors.gke_code_executor import GkeCodeExecutor

    stock = GkeCodeExecutor.model_construct(
        namespace="agent-code",
        image="python:3.11-slim",
        timeout_seconds=60,
        cpu_requested="200m",
        mem_requested="256Mi",
        cpu_limit="500m",
        mem_limit="512Mi",
    )._create_job_manifest("j", "cm", SimpleNamespace(invocation_id="i"))
    template = _pod(stock)
    assert _restricted_violations(template) == ["seccompProfile"]
    # ...and it always asks for gVisor, which kind and Docker Desktop lack.
    assert template["spec"]["runtimeClassName"] == "gvisor"


def test_job_pod_is_locked_down():
    manifest = job_manifest_for_tests()
    template = _pod(manifest)
    spec = template["spec"]
    assert template["metadata"]["labels"]["app"] == "agent-code"
    assert spec["automountServiceAccountToken"] is False
    assert spec["enableServiceLinks"] is False
    assert "runtimeClassName" not in spec and "tolerations" not in spec
    assert spec["containers"][0]["securityContext"]["readOnlyRootFilesystem"] is True
    assert manifest.spec.active_deadline_seconds == 60


def test_gvisor_is_one_setting_away():
    spec = _pod(job_manifest_for_tests(runtime_class="gvisor"))["spec"]
    assert spec["runtimeClassName"] == "gvisor"
    assert spec["tolerations"][0]["key"] == "sandbox.gke.io/runtime"


def _probe(*args: str, **env: str) -> tuple[int, str]:
    out = subprocess.run(
        [sys.executable, str(REPO_ROOT / "scripts" / "code_sandbox_probe.py"), *args],
        cwd=REPO_ROOT,
        env={**os.environ, "NO_COLOR": "1", **env},
        capture_output=True,
        text=True,
        timeout=60,
    )
    return out.returncode, out.stdout + out.stderr


def test_local_executor_shares_the_agents_environment():
    code, out = _probe("--executor", "local", LAB92_DEMO_SECRET="placeholder")
    assert code == 7 and "REACHED" in out, out
    assert "LAB92_DEMO_SECRET" in out, out


def test_harmless_check_runs():
    code, out = _probe("--executor", "local", "--code", "check")
    assert code == 0 and "error rate 1.30%" in out, out


@pytest.mark.skipif(bool(os.environ.get("KUBERNETES_SERVICE_HOST")), reason="inside a cluster")
def test_job_executor_without_a_cluster_says_so():
    code, out = _probe("--executor", "job", KUBECONFIG="/nonexistent")
    assert code == 1 and "could not build the job executor" in out, out
