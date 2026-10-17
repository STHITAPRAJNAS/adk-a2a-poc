#!/usr/bin/env bash
# Lab 86 — the release agent buys over AP2; every party checks the mandates and
# refuses what a person did not approve.
set -uo pipefail
. "$(dirname "$0")/lib-probe.sh"

if ! kubectl -n "$NS" get deploy northwind-sales >/dev/null 2>&1; then
  skip "lab 86 not applied (no northwind-sales) — skipping"
  exit 0
fi
need_probe

pay() {
  kubectl -n "$NS" exec a2a-probe -- env NO_COLOR=1 python scripts/ap2_probe.py --code 246810 "$@" 2>&1
}

M=$(env_of deployment-agent AP2_MERCHANT_URL)
[ -n "$M" ] && ok "the release agent has its buying tools (AP2_MERCHANT_URL=$M)" \
  || no "AP2_MERCHANT_URL is not set on deployment-agent (README: before you start, step 2)"
R=$(kubectl -n "$NS" get deploy deployment-agent -o jsonpath='{.spec.replicas}' 2>/dev/null)
[ "${R:-1}" = "1" ] && ok "one release-agent replica (approved limits live in its memory)" \
  || no "deployment-agent has $R replicas; scale it to 1"

OUT=$(pay card)
echo "$OUT" | grep -q "required=True" && ok "the vendor's card requires the AP2 extension" \
  || no "the vendor's card does not require AP2 (or the probe runs the old image)"
pay no-extension >/dev/null && ok "a call without AP2 is refused with -32008" \
  || no "a call without the AP2 header was not refused with -32008"

OUT=$(pay direct); RC=$?
[ $RC -eq 0 ] && echo "$OUT" | grep -q "order ord_" && ok "a purchase approved by a person went through" \
  || { no "the one-off purchase failed:"; echo "$OUT" | tail -4 | sed 's/^/      /'; }

OUT=$(pay autonomous --buys eu,us,eu)
echo "$OUT" | grep -q "2 bought, 1 refused" && ok "within approved limits: 2 bought, the 3rd refused" \
  || { no "delegated buying did not end 2 bought, 1 refused:"; echo "$OUT" | tail -4 | sed 's/^/      /'; }

for attack in "reprice:merchant" "over-limit:credential_provider" "wrong-merchant:merchant" "replay:merchant"; do
  name=${attack%%:*} who=${attack##*:}
  OUT=$(pay attack "$name"); RC=$?
  if [ $RC -eq 0 ] && echo "$OUT" | grep -q "refused by the $who"; then
    ok "attack '$name' refused by the $who"
  else
    no "attack '$name' was not refused by the $who:"; echo "$OUT" | tail -3 | sed 's/^/      /'
  fi
done

OUT=$(kubectl -n "$NS" exec a2a-probe -- env NO_COLOR=1 python scripts/ap2_probe.py agent "show capacity offers" 2>&1)
echo "$OUT" | grep -q "northwind" && ok "the release agent reaches the vendor over A2A" \
  || { no "the release agent did not reach the vendor:"; echo "$OUT" | tail -3 | sed 's/^/      /'; }
exit $FAIL
