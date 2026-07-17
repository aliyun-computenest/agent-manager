#!/bin/bash
set -e
ACTION=${1:-enable}
MARKER="/tmp/.observability_disabled"

# QwenPaw's loongsuite agent auto-loads via a Python .pth file (loongsuite-site-bootstrap.pth)
# located in site-packages. Python's site module executes any 'import ...' line in .pth files
# at interpreter startup, regardless of LOONGSUITE_PYTHON_SITE_BOOTSTRAP env var.
# The only reliable way to disable it is to rename the .pth file (Python ignores non-.pth extensions).
find_pth() {
  find /app/venv/lib/python*/site-packages -maxdepth 3 -type f -name 'loongsuite-site-bootstrap.pth' 2>/dev/null
}
find_pth_disabled() {
  find /app/venv/lib/python*/site-packages -maxdepth 3 -type f -name 'loongsuite-site-bootstrap.pth.disabled' 2>/dev/null
}

if [ "$ACTION" = "disable" ]; then
  touch "$MARKER"
  find_pth | while read f; do
    mv "$f" "${f}.disabled" && echo "[toggle] Disabled .pth: $f"
  done
  echo "[toggle] Observability disabled"
elif [ "$ACTION" = "enable" ]; then
  rm -f "$MARKER"
  find_pth_disabled | while read f; do
    orig="${f%.disabled}"
    mv "$f" "$orig" && echo "[toggle] Restored .pth: $orig"
  done
  echo "[toggle] Observability enabled"
else
  echo "[toggle] Usage: toggle-observability.sh enable|disable"
  exit 1
fi

# Restart app process via supervisorctl (or signal fallback)
if command -v supervisorctl &>/dev/null; then
  for sock in /var/run/supervisor.sock /tmp/supervisor.sock /run/supervisor.sock; do
    if [ -S "$sock" ]; then
      supervisorctl -s "unix://$sock" restart app 2>/dev/null && echo "[toggle] app restarted via supervisorctl" && exit 0
    fi
  done
fi

# Fallback: find process on port 8088 and SIGTERM it (autorestart will respawn)
PID=$(lsof -ti:8088 2>/dev/null | head -1)
if [ -n "$PID" ]; then
  kill -TERM "$PID" 2>/dev/null
  echo "[toggle] Process (pid=$PID) signaled to restart"
else
  echo "[toggle] WARNING: Could not find process to restart"
  exit 1
fi
