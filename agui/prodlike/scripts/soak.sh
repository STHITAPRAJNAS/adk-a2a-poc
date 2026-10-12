#!/usr/bin/env bash
# Run the virtual-users load test in the cluster against adk-lb, on whatever
# ag-ui-adk version support-desk runs now, and save the report.
#
#   ./agui/prodlike/scripts/soak.sh                 calm: no failures
#   ./agui/prodlike/scripts/soak.sh --chaos         a random support-desk pod is
#                                                   force-killed every 8 seconds
#   USERS=60 TURNS=8 ./agui/prodlike/scripts/soak.sh
#
# Reports land in agui/prodlike/reports/<version>[-chaos].json. Compare them:
#   python3 agui/prodlike/loadtest/virtual_users.py --compare agui/prodlike/reports/0.8.0.json agui/prodlike/reports/0.9.0.json
set -euo pipefail
cd "$(dirname "$0")/../../.."
NS=agents
USERS="${USERS:-40}"
TURNS="${TURNS:-6}"
CHAOS=0
[ "${1:-}" = "--chaos" ] && CHAOS=1

VERSION=$(kubectl -n "$NS" get deploy support-desk -o jsonpath='{.spec.template.spec.containers[0].image}' | cut -d: -f2)
LABEL="$VERSION"
[ "$CHAOS" = 1 ] && LABEL="$VERSION-chaos"
echo "── $USERS virtual users × $TURNS messages against ag-ui-adk $VERSION$([ "$CHAOS" = 1 ] && echo ', with pods killed')"

kubectl -n "$NS" delete job virtual-users --ignore-not-found --wait=true >/dev/null
sed -e "s/--label=LABEL/--label=$LABEL/" -e "s/--users=USERS/--users=$USERS/" -e "s/--turns=TURNS/--turns=$TURNS/" \
  agui/prodlike/k8s/virtual-users-job.yaml | kubectl apply -f - >/dev/null

job_done() {
  local s f
  s=$(kubectl -n "$NS" get job virtual-users -o jsonpath='{.status.succeeded}' 2>/dev/null || true)
  f=$(kubectl -n "$NS" get job virtual-users -o jsonpath='{.status.failed}' 2>/dev/null || true)
  [ "${s:-0}" != 0 ] || [ "${f:-0}" != 0 ]
}

kubectl -n "$NS" wait --for=condition=Ready pod -l job-name=virtual-users --timeout=120s >/dev/null || true
if [ "$CHAOS" = 1 ]; then
  (
    while ! job_done; do
      sleep 8
      job_done && break
      pod=$(kubectl -n "$NS" get pods -l app=support-desk --field-selector=status.phase=Running -o name | awk 'BEGIN{srand()} {a[NR]=$0} END{if (NR) print a[int(rand()*NR)+1]}')
      if [ -n "$pod" ]; then
        kubectl -n "$NS" delete "$pod" --force --grace-period=0 >/dev/null 2>&1 && echo "   chaos: killed ${pod#pod/}"
      fi
    done
  ) &
  CHAOS_PID=$!
fi

until job_done; do sleep 3; done
[ "$CHAOS" = 1 ] && wait "$CHAOS_PID" 2>/dev/null || true

mkdir -p agui/prodlike/reports
kubectl -n "$NS" logs job/virtual-users | grep -v '^REPORT_JSON '
kubectl -n "$NS" logs job/virtual-users | sed -n 's/^REPORT_JSON //p' > "agui/prodlike/reports/$LABEL.json"
echo
echo "saved agui/prodlike/reports/$LABEL.json"
