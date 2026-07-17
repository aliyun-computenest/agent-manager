#!/bin/sh
set -eu

NAMESPACE="${NAMESPACE:-}"
GATEWAY_SLB_ID="${GATEWAY_SLB_ID:-}"
AGENT_GATEWAY_BUNDLE_URL="${AGENT_GATEWAY_BUNDLE_URL:-}"
PLATFORM_PUBLIC_URL="${PLATFORM_PUBLIC_URL:-}"
DEPLOY_TS="${DEPLOY_TS:-$(date +%s)}"
BUNDLE_DIR="${BUNDLE_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}"

if [ -z "$NAMESPACE" ]; then
  echo "NAMESPACE is required" >&2
  exit 1
fi
if [ -z "$GATEWAY_SLB_ID" ]; then
  echo "GATEWAY_SLB_ID is required" >&2
  exit 1
fi
if [ -z "$AGENT_GATEWAY_BUNDLE_URL" ]; then
  echo "AGENT_GATEWAY_BUNDLE_URL is required" >&2
  exit 1
fi
if ! printf '%s' "$GATEWAY_SLB_ID" | grep -Eq '^lb-[A-Za-z0-9-]+$'; then
  echo "GATEWAY_SLB_ID must be an SLB id such as lb-xxxxxxxx" >&2
  exit 1
fi
if printf '%s' "$AGENT_GATEWAY_BUNDLE_URL" | grep -q '[[:cntrl:]]'; then
  echo "AGENT_GATEWAY_BUNDLE_URL must not contain control characters" >&2
  exit 1
fi
if printf '%s' "$PLATFORM_PUBLIC_URL" | grep -q '[[:cntrl:][:space:]"\\]'; then
  echo "PLATFORM_PUBLIC_URL must not contain control characters, spaces, quotes, or backslashes" >&2
  exit 1
fi
if [ -n "$PLATFORM_PUBLIC_URL" ]; then
  case "$PLATFORM_PUBLIC_URL" in
    http://*|https://*) ;;
    *)
      echo "PLATFORM_PUBLIC_URL must start with http:// or https://" >&2
      exit 1
      ;;
  esac
fi
if ! printf '%s' "$DEPLOY_TS" | grep -Eq '^[A-Za-z0-9_.:-]+$'; then
  echo "DEPLOY_TS contains unsupported characters" >&2
  exit 1
fi

required_files="
openresty.conf.template
agent_gateway_client.js
start-openresty.sh
deployment.yaml
service.yaml
platform-internal-service.yaml
"

for file in $required_files; do
  if [ ! -f "$BUNDLE_DIR/$file" ]; then
    echo "Missing gateway bundle file: $file" >&2
    exit 1
  fi
done

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[\\&|]/\\&/g'
}

AGENT_GATEWAY_BUNDLE_URL_ESCAPED="$(escape_sed_replacement "$AGENT_GATEWAY_BUNDLE_URL")"
PLATFORM_PUBLIC_URL_ESCAPED="$(escape_sed_replacement "$PLATFORM_PUBLIC_URL")"

sed \
  -e "s|__AGENT_GATEWAY_BUNDLE_URL__|$AGENT_GATEWAY_BUNDLE_URL_ESCAPED|g" \
  -e "s|__PLATFORM_PUBLIC_URL__|$PLATFORM_PUBLIC_URL_ESCAPED|g" \
  "$BUNDLE_DIR/deployment.yaml" > "$tmp_dir/deployment.yaml"

sed \
  -e "s|__GATEWAY_SLB_ID__|$GATEWAY_SLB_ID|g" \
  "$BUNDLE_DIR/service.yaml" > "$tmp_dir/service.yaml"

kubectl -n "$NAMESPACE" apply -f "$BUNDLE_DIR/platform-internal-service.yaml"
kubectl -n "$NAMESPACE" apply -f "$tmp_dir/deployment.yaml"
kubectl -n "$NAMESPACE" apply -f "$tmp_dir/service.yaml"

kubectl -n "$NAMESPACE" annotate deployment openclaw-agent-gateway \
  "openclaw.io/deploy-ts=$DEPLOY_TS" \
  --overwrite

echo "Agent gateway bundle applied in namespace $NAMESPACE"
