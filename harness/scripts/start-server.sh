#!/bin/bash
set -euo pipefail

# Navigate to project root (FIXED — do not modify)
cd "$(dirname "$0")/../.."

# Test-mode environment for Agent Manager. The server reads everything via
# agent-manager/server/config/index.js, which falls back to process.env, so
# exporting here is enough.
export PORT="${PORT:-3001}"
export NODE_ENV="${NODE_ENV:-test}"
export LOG_LEVEL="${LOG_LEVEL:-info}"
export DEPLOY_ENVIRONMENT="${DEPLOY_ENVIRONMENT:-local-dev}"

# These must already be set by setup-env.sh; we don't override them.
: "${SUPABASE_URL:?SUPABASE_URL must be set — run harness/scripts/setup-env.sh first}"
: "${SERVICE_ROLE_KEY:?SERVICE_ROLE_KEY must be set}"
: "${E2B_API_KEY:?E2B_API_KEY must be set}"
: "${API_ENCRYPTION_KEY:?API_ENCRYPTION_KEY must be set}"

HEALTH_CHECK_URL="${HEALTH_CHECK_URL:-http://localhost:${PORT}/api/health}"

# Start the Express backend (mounted as ESM, see agent-manager/server/index.js).
cd agent-manager/server
node index.js > "${LOG_FILE:-/tmp/agent-manager-server.log}" 2>&1 &
SERVER_PID=$!
cd - > /dev/null

# Wait for server readiness (fixed logic)
for i in $(seq 1 30); do
  if curl -s "${HEALTH_CHECK_URL}" > /dev/null 2>&1; then
    echo "✓ Server ready (PID: $SERVER_PID, $HEALTH_CHECK_URL)"
    echo $SERVER_PID > /tmp/agent-manager-server.pid
    exit 0
  fi
  sleep 1
done

echo "✗ Server failed to start within 30s"
echo "  --- tail of ${LOG_FILE:-/tmp/agent-manager-server.log} ---"
tail -n 40 "${LOG_FILE:-/tmp/agent-manager-server.log}" 2>/dev/null || true
kill "$SERVER_PID" 2>/dev/null || true
exit 1
