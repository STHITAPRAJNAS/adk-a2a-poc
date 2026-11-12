"""Code sandbox (lab 92): where the code an agent writes actually runs.

An agent with a code executor writes a program and runs it. Which program is
up to the model, and the model reads untrusted text all day (logs, tickets,
web pages). So treat the code as untrusted too, and ask one question of each
executor: **what can that code reach?**

Two ADK executors, as this lab uses them:

``local``  ``UnsafeLocalCodeExecutor``: a subprocess of the agent, in the
           agent's pod. It sees the agent's environment, files, service
           account token and network.
``job``    ``LabJobCodeExecutor`` below: ADK's ``GkeCodeExecutor`` in job
           mode (one Kubernetes Job per run, code mounted from a ConfigMap,
           non-root, read-only root, no service account token), adjusted
           for a laptop cluster and for the namespace this lab locks down.

What the subclass changes, and why:

* ``runtime_class`` is a setting. ADK's job mode always asks for the
  ``gvisor`` RuntimeClass, which kind and Docker Desktop do not have, so the
  pod never starts. Empty means the node's normal runtime (same kernel as
  the node); ``gvisor`` where GKE Sandbox or runsc is installed.
* The pod gets ``seccompProfile: RuntimeDefault``. Without it the pod is
  refused by Pod Security ``restricted``, which the lab's namespace enforces.
* The pod gets the label ``app: agent-code``, which the lab's NetworkPolicy
  selects to deny all traffic, and no service links (no other services'
  addresses in its environment).
* ``activeDeadlineSeconds``: Kubernetes kills a run that takes too long, even
  if the agent that started it has gone.

``ESCAPE_CHECK`` is the code the lab runs: it tries the things a hostile
program would try and prints one JSON line per attempt.
"""

from __future__ import annotations

import os
from typing import Any

#: Stdlib only: it has to run in whatever image the executor uses.
ESCAPE_CHECK = r"""
import json, os, platform, socket, threading

def report(check, escaped, detail):
    print(json.dumps({"check": check, "escaped": escaped, "detail": detail}))

def lookup(host, port):
    # With DNS blocked, getaddrinfo can hang for many seconds and ignores the
    # socket timeout; a daemon thread bounds it without holding up the exit.
    found = {}
    def run():
        try:
            found["addr"] = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)[0][4]
        except OSError as exc:
            found["error"] = type(exc).__name__
    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(3)
    return found.get("addr"), found.get("error", "DNS timed out")

def reach(host, port):
    addr, error = lookup(host, port)
    if addr is None:
        return False, error
    try:
        socket.create_connection(addr[:2], timeout=2).close()
        return True, "connected"
    except OSError as exc:
        return False, type(exc).__name__

words = ("SECRET", "TOKEN", "KEY", "PASSWORD")
secretish = sorted(k for k in os.environ if any(w in k.upper() for w in words))
report("environment", bool(secretish),
       f"{len(os.environ)} variables; secret-looking names: {', '.join(secretish) or 'none'}")

token = "/var/run/secrets/kubernetes.io/serviceaccount/token"
has_token = os.path.exists(token)
report("service account token", has_token,
       "readable: this code can act as the agent's identity" if has_token else "not mounted")

agent_code = "/app/remote_agents/deployment_agent/tools.py"
mine = os.path.exists(agent_code)
report("agent's own files", mine, "readable (/app)" if mine else "not there")

api_host = os.environ.get("KUBERNETES_SERVICE_HOST", "kubernetes.default.svc")
api_port = int(os.environ.get("KUBERNETES_SERVICE_PORT", "443"))
ok, how = reach(api_host, api_port)
report("Kubernetes API", ok, f"{api_host}:{api_port} {how}")

ok, how = reach("ops-concierge.agents.svc.cluster.local", 8000)
report("another agent", ok, f"ops-concierge:8000 {how}")

ok, how = reach("pypi.org", 443)
report("the internet", ok, f"pypi.org:443 {how}")

try:
    with open("/agent-was-here", "w") as f:
        f.write("x")
    os.remove("/agent-was-here")
    report("write outside /tmp", True, "wrote (and removed) /agent-was-here")
except OSError as exc:
    report("write outside /tmp", False, type(exc).__name__)

kernel = platform.release()
report("kernel", None, f"{kernel} (gVisor reports 4.4.0; anything else is the node's own)")
"""

#: A harmless check, the kind of code the agent is meant to write.
ERROR_RATE_CHECK = r"""
requests = [200] * 9870 + [500] * 61 + [503] * 69
errors = sum(1 for s in requests if s >= 500)
rate = errors / len(requests)
print(f"error rate {rate:.2%} over {len(requests)} requests: "
      + ("OK to continue" if rate < 0.02 else "STOP the rollout"))
"""


def _job_executor_class():
    from google.adk.code_executors.gke_code_executor import GkeCodeExecutor
    from kubernetes import client as k8s

    class LabJobCodeExecutor(GkeCodeExecutor):
        """ADK's job mode, runnable on kind and under Pod Security restricted."""

        runtime_class: str = ""

        def _create_job_manifest(self, job_name, configmap_name, invocation_context):
            job = super()._create_job_manifest(job_name, configmap_name, invocation_context)
            pod = job.spec.template.spec
            pod.runtime_class_name = self.runtime_class or None
            if not self.runtime_class:
                pod.tolerations = None
            pod.enable_service_links = False
            pod.security_context = k8s.V1PodSecurityContext(
                run_as_non_root=True,
                seccomp_profile=k8s.V1SeccompProfile(type="RuntimeDefault"),
            )
            job.spec.template.metadata = k8s.V1ObjectMeta(
                labels={"app": "agent-code", "a2a.lab/lab": "92"}
            )
            job.spec.active_deadline_seconds = self.timeout_seconds
            return job

    return LabJobCodeExecutor


def build_executor(kind: str, **overrides: Any):
    """``local`` or ``job``, configured from the CODE_* environment variables."""
    if kind == "local":
        from google.adk.code_executors.unsafe_local_code_executor import (
            UnsafeLocalCodeExecutor,
        )

        return UnsafeLocalCodeExecutor()
    if kind == "job":
        settings = {
            "namespace": os.environ.get("CODE_NAMESPACE", "agent-code"),
            "image": os.environ.get("CODE_IMAGE", "adk-a2a-agent:dev"),
            "runtime_class": os.environ.get("CODE_RUNTIME_CLASS", ""),
            "timeout_seconds": int(os.environ.get("CODE_TIMEOUT_SECONDS", "60")),
            **overrides,
        }
        return _job_executor_class()(**settings)
    raise ValueError(f"unknown executor {kind!r}: use local or job")


def job_manifest_for_tests(**overrides: Any):
    """The Job the ``job`` executor would submit, without a cluster."""
    from types import SimpleNamespace

    cls = _job_executor_class()
    fields = {
        "namespace": "agent-code",
        "image": "adk-a2a-agent:dev",
        "runtime_class": "",
        "timeout_seconds": 60,
        "cpu_requested": "200m",
        "mem_requested": "256Mi",
        "cpu_limit": "500m",
        "mem_limit": "512Mi",
    }
    executor = cls.model_construct(**{**fields, **overrides})
    return executor._create_job_manifest(
        "adk-exec-test", "code-src-adk-exec-test", SimpleNamespace(invocation_id="inv-test")
    )
