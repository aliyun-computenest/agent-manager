#!/bin/bash
set -e
ACTION=${1:-enable}
MARKER="/tmp/.observability_disabled"

# Hermes ARMS Python agent is loaded via PYTHONPATH (auto_instrumentation dir).
# supervisord.conf wraps both [program:hermes] and [program:hermes-dashboard]
# to `exec env -u PYTHONPATH ...` when this marker is present, so restarting
# both programs is enough to physically remove PYTHONPATH from child processes.

if [ "$ACTION" = "disable" ]; then
  touch "$MARKER"
  # Physically remove the auto_instrumentation directory so ARMS agent cannot load
  # even if hermes binary programmatically re-sets PYTHONPATH at runtime.
  INSTR_DIR=$(find /opt/hermes/.venv/lib/python*/site-packages/aliyun/opentelemetry/instrumentation/auto_instrumentation -maxdepth 0 -type d 2>/dev/null | head -1)
  if [ -n "$INSTR_DIR" ] && [ -d "$INSTR_DIR" ]; then
    mv "$INSTR_DIR" "${INSTR_DIR}.disabled"
    echo "[toggle] Moved $INSTR_DIR -> .disabled"
  fi
  echo "[toggle] Observability disabled"
elif [ "$ACTION" = "enable" ]; then
  rm -f "$MARKER"
  # Restore auto_instrumentation directory
  DISABLED_DIR=$(find /opt/hermes/.venv/lib/python*/site-packages/aliyun/opentelemetry/instrumentation/auto_instrumentation.disabled -maxdepth 0 -type d 2>/dev/null | head -1)
  if [ -n "$DISABLED_DIR" ] && [ -d "$DISABLED_DIR" ]; then
    ORIG="${DISABLED_DIR%.disabled}"
    mv "$DISABLED_DIR" "$ORIG"
    echo "[toggle] Restored $ORIG"
  fi
  echo "[toggle] Observability enabled"
else
  echo "[toggle] Usage: toggle-observability.sh enable|disable"
  exit 1
fi

# Kill ALL hermes processes. The hermes binary spawns internal daemon processes
# (double-fork/setsid) that escape supervisor's process group and programmatically
# re-set PYTHONPATH at runtime. We must kill them + remove the instrumentation dir
# so new processes have nothing to load even if PYTHONPATH is re-set.
for pid in $(pgrep -f '/opt/hermes/.venv/bin/hermes' 2>/dev/null); do
  kill -9 "$pid" 2>/dev/null && echo "[toggle] Killed pid=$pid"
done
sleep 3
echo "[toggle] Done. Supervisor will auto-restart hermes processes."
