#!/bin/bash
set -euo pipefail

echo "=== Tearing down environment ==="

# Stop the server PID if start-server.sh recorded one.
if [ -f /tmp/agent-manager-server.pid ]; then
  PID=$(cat /tmp/agent-manager-server.pid)
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    sleep 1
    kill -9 "$PID" 2>/dev/null || true
  fi
  rm -f /tmp/agent-manager-server.pid
fi

# Belt and suspenders: kill any stray node processes from this project root.
pkill -f "agent-manager/server/index.js" 2>/dev/null || true
pkill -f "start-server" 2>/dev/null || true

# No docker containers are owned by this harness (all deps are SaaS).
echo "✓ Cleaned up"
