#!/usr/bin/env bash
# Manage who can reach Grafana (grafana.<zone>) without a deploy.
#
# The ALB's web ACL blocks Grafana for any source address outside the WAF IP
# set evtivity-<env>-grafana-allow. This script edits that set. Changes apply
# within seconds.
#
# Usage:
#   scripts/grafana-access.sh <env> list
#   scripts/grafana-access.sh <env> add <cidr|me>
#   scripts/grafana-access.sh <env> remove <cidr|me>
#
# `me` is this machine's public IPv4 address as a /32. Set AWS_PROFILE and
# AWS_REGION (default us-east-1) for the target account.
#
# observability.grafana.allowedCidrs in config/<env>.yaml only seeds the set.
# Changing that list replaces the set's contents on the next deploy.
set -euo pipefail

ENV_NAME="${1:-}"
ACTION="${2:-}"
TARGET="${3:-}"
REGION="${AWS_REGION:-us-east-1}"

usage() {
  sed -n '9,11p' "$0" | sed 's/^# //'
  exit 1
}

[[ "$ENV_NAME" =~ ^(dev|qa|prod)$ ]] || usage
[[ "$ACTION" =~ ^(list|add|remove)$ ]] || usage

NAME="evtivity-${ENV_NAME}-grafana-allow"
ID=$(aws wafv2 list-ip-sets --scope REGIONAL --region "$REGION" \
  --query "IPSets[?Name=='${NAME}'].Id | [0]" --output text)
if [ -z "$ID" ] || [ "$ID" = "None" ]; then
  echo "IP set ${NAME} not found in ${REGION}. Is observability enabled and deployed?" >&2
  exit 1
fi

read_set() {
  aws wafv2 get-ip-set --scope REGIONAL --region "$REGION" --name "$NAME" --id "$ID" --output json
}

if [ "$ACTION" = "list" ]; then
  read_set | python3 -c 'import json,sys; [print(a) for a in json.load(sys.stdin)["IPSet"]["Addresses"]] or None'
  exit 0
fi

[ -n "$TARGET" ] || usage
if [ "$TARGET" = "me" ]; then
  TARGET="$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')/32"
fi
if ! [[ "$TARGET" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$ ]]; then
  echo "Not an IPv4 CIDR: ${TARGET}" >&2
  exit 1
fi

CURRENT=$(read_set)
LOCK=$(echo "$CURRENT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["LockToken"])')
ADDRESSES=$(echo "$CURRENT" | ACTION="$ACTION" TARGET="$TARGET" python3 -c '
import json, os, sys
addresses = json.load(sys.stdin)["IPSet"]["Addresses"]
target = os.environ["TARGET"]
if os.environ["ACTION"] == "add":
    if target not in addresses:
        addresses.append(target)
else:
    addresses = [a for a in addresses if a != target]
print(json.dumps(sorted(addresses)))
')

# update-ip-set takes the full list. The lock token rejects the write if
# someone else changed the set since it was read.
aws wafv2 update-ip-set --scope REGIONAL --region "$REGION" --name "$NAME" --id "$ID" \
  --lock-token "$LOCK" --addresses "$ADDRESSES" >/dev/null
echo "${ACTION}: ${TARGET}"
echo "Grafana allowlist for ${ENV_NAME} is now: ${ADDRESSES}"
