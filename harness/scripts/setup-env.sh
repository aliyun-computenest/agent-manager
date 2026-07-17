#!/bin/bash
set -euo pipefail
echo "=== Setting up environment ==="

# Agent Manager's external dependencies (Supabase, E2B, Aliyun APIG, K8s) are
# all managed SaaS — there are no docker containers to spin up locally.
# Instead, this script validates that the required env vars are present so
# `make start-server` doesn't fail mid-bootstrap.
#
# Override per-var with your own .env, .env.local, or shell exports.

REQUIRED_VARS=(
  SUPABASE_URL
  SERVICE_ROLE_KEY
  API_ENCRYPTION_KEY
  E2B_API_KEY
  E2B_DOMAIN
)

OPTIONAL_VARS=(
  DATABASE_URL
  AGENT_GATEWAY_URL
  ENABLE_AI_GATEWAY
  DEPLOY_ENVIRONMENT
  OSS_PV_NAME
  VITE_OSS_PV_NAME
  ADMIN_EMAIL
  ADMIN_PASSWORD
)

# Best-effort: source .env if present (does NOT override existing values).
if [ -f "agent-manager/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  . "agent-manager/.env"
  set +a
fi

missing=()
for v in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!v:-}" ]; then
    missing+=("$v")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "✗ Missing required env vars: ${missing[*]}"
  echo
  echo "  See agent-manager/.env.example for the full contract."
  echo "  For local dev, copy it to agent-manager/.env and fill in values."
  exit 1
fi

echo "✓ Required env vars present"
echo "  (optional vars not validated: ${OPTIONAL_VARS[*]})"
echo "✓ Environment ready"
