#!/usr/bin/env bash
# Lab 92 — code the release agent writes runs in a Job that reaches nothing:
# no token, no network, Pod Security "restricted" enforced on its namespace.
set -uo pipefail
. "$(dirname "$0")/lib-probe.sh"

if ! kubectl get ns agent-code >/dev/null 2>&1; then
  skip "lab 92 not applied (no agent-code namespace) — skipping"
  exit 0
fi
PSA=$(kubectl get ns agent-code -o jsonpath='{.metadata.labels.pod-security\.kubernetes\.io/enforce}' 2>/dev/null)
[ "$PSA" = restricted ] && ok "agent-code enforces Pod Security restricted" \
  || no "Pod Security enforce is '${PSA:-unset}' on agent-code (want restricted)"
kubectl -n agent-code get networkpolicy deny-all >/dev/null 2>&1 \
  && ok "agent-code denies all traffic (NetworkPolicy deny-all)" \
  || no "no deny-all NetworkPolicy in agent-code"

OUT=$(kubectl -n "$NS" exec deploy/deployment-agent -- env NO_COLOR=1 \
        python scripts/code_sandbox_probe.py --executor job 2>&1); RC=$?
case $RC in
  0) ok "agent-written code ran in a Job and reached nothing ($(grep -o 'in [0-9.]*s' <<<"$OUT" | tail -1))" ;;
  7) no "the Job's code reached:"; grep "✗" <<<"$OUT" | grep -v REACHED | sed 's/^ */      /' ;;
  *) no "the job executor failed:"; echo "$OUT" | tail -5 | sed 's/^/      /' ;;
esac
exit $FAIL
