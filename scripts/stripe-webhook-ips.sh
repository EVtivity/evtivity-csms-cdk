#!/usr/bin/env bash
# Keep the Stripe webhook allowlist in sync with Stripe without a deploy.
#
# The ALB's web ACL lets requests to /v1/webhooks/stripe skip every other WAF
# rule when they come from an address in the WAF IP set
# evtivity-<env>-stripe-webhooks. This script shows or replaces that set.
#
# Usage:
#   scripts/stripe-webhook-ips.sh <env> list
#   scripts/stripe-webhook-ips.sh <env> diff
#   scripts/stripe-webhook-ips.sh <env> sync
#
# `diff` compares the set with Stripe's published list. `sync` replaces the
# set's contents with that list. Source:
# https://stripe.com/files/ips/ips_webhooks.json (documented at
# https://docs.stripe.com/ips). Stripe announces changes seven days ahead on
# its API announce mailing list. Set AWS_PROFILE for the target account. The
# region comes from config/<env>.local.yaml or config/<env>.yaml, and
# AWS_REGION overrides it.
#
# waf.stripeWebhookIps in lib/config/schema.ts only seeds the set. Changing
# that list replaces the set's contents on the next deploy, so update it too
# when Stripe changes its addresses.
set -euo pipefail

ENV_NAME="${1:-}"
ACTION="${2:-}"
SOURCE_URL="https://stripe.com/files/ips/ips_webhooks.json"

usage() {
  sed -n '9,11p' "$0" | sed 's/^# //'
  exit 1
}

[[ "$ENV_NAME" =~ ^(dev|qa|prod)$ ]] || usage
[[ "$ACTION" =~ ^(list|diff|sync)$ ]] || usage

# Top-level `region:` from the local override first, then the committed config.
config_region() {
  local dir file
  dir="$(cd "$(dirname "$0")/.." && pwd)/config"
  for file in "${dir}/${ENV_NAME}.local.yaml" "${dir}/${ENV_NAME}.yaml"; do
    [ -f "$file" ] || continue
    sed -nE "s/^region:[[:space:]]*['\"]?([a-z0-9-]+)['\"]?.*/\1/p" "$file" | head -n 1
  done | head -n 1
}
REGION="${AWS_REGION:-$(config_region)}"
REGION="${REGION:-us-east-1}"

NAME="evtivity-${ENV_NAME}-stripe-webhooks"
ID=$(aws wafv2 list-ip-sets --scope REGIONAL --region "$REGION" \
  --query "IPSets[?Name=='${NAME}'].Id | [0]" --output text)
if [ -z "$ID" ] || [ "$ID" = "None" ]; then
  echo "IP set ${NAME} not found in ${REGION}. Is the WAF enabled and deployed?" >&2
  exit 1
fi

read_set() {
  aws wafv2 get-ip-set --scope REGIONAL --region "$REGION" --name "$NAME" --id "$ID" --output json
}

CURRENT=$(read_set)
CURRENT_ADDRESSES=$(echo "$CURRENT" |
  python3 -c 'import json,sys; print(json.dumps(sorted(json.load(sys.stdin)["IPSet"]["Addresses"])))')

if [ "$ACTION" = "list" ]; then
  echo "$CURRENT_ADDRESSES" | python3 -c 'import json,sys; [print(a) for a in json.load(sys.stdin)]'
  exit 0
fi

# Stripe publishes bare IPv4 addresses. WAF IP sets take CIDRs, so each becomes a /32.
PUBLISHED=$(curl -fsS "$SOURCE_URL" | python3 -c '
import ipaddress, json, sys
ips = json.load(sys.stdin)["WEBHOOKS"]
if not ips:
    sys.exit("Stripe returned an empty webhook list. Refusing to continue.")
print(json.dumps(sorted(f"{ipaddress.IPv4Address(ip)}/32" for ip in ips)))
')

CHANGES=$(CURRENT_ADDRESSES="$CURRENT_ADDRESSES" PUBLISHED="$PUBLISHED" python3 -c '
import json, os
current = set(json.loads(os.environ["CURRENT_ADDRESSES"]))
published = set(json.loads(os.environ["PUBLISHED"]))
for a in sorted(published - current):
    print(f"+ {a}")
for a in sorted(current - published):
    print(f"- {a}")
')

if [ -z "$CHANGES" ]; then
  echo "${NAME} matches Stripe's published list."
  exit 0
fi
echo "$CHANGES"
[ "$ACTION" = "diff" ] && exit 0

# update-ip-set takes the full list. The lock token rejects the write if
# someone else changed the set since it was read.
LOCK=$(echo "$CURRENT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["LockToken"])')
aws wafv2 update-ip-set --scope REGIONAL --region "$REGION" --name "$NAME" --id "$ID" \
  --lock-token "$LOCK" --addresses "$PUBLISHED" >/dev/null
echo "${NAME} now matches Stripe's published list."
