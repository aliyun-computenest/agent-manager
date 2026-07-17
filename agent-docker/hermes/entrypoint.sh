#!/bin/bash
set -e

# Graceful degradation: if ARMS env not set, start without monitoring
if [ -z "$ARMS_LICENSE_KEY" ] || [ -z "$ARMS_ENDPOINT" ]; then
    echo "[entrypoint] WARNING: Missing ARMS_* env, skipping Python agent."
    exec supervisord -n
fi

# Detect Python version from the venv (not hardcoded to 3.13)
# NOTE: Must unset PYTHONPATH to prevent ARMS agent from loading during detection,
# which would contaminate PY_VERSION with agent startup output.
PY_VERSION=$(PYTHONPATH= /opt/hermes/.venv/bin/python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null)
SITE_PACKAGES="/opt/hermes/.venv/lib/python${PY_VERSION}/site-packages"
AUTO_INSTR="${SITE_PACKAGES}/aliyun/opentelemetry/instrumentation/auto_instrumentation"

# Check if observability is disabled via marker file
if [ -f /tmp/.observability_disabled ]; then
    echo "[entrypoint] Observability disabled via marker, skipping Python agent."
    exec supervisord -n
fi

# Set PYTHONPATH for auto-instrumentation (Python agent auto-loads on import)
export PYTHONPATH="${AUTO_INSTR}:${SITE_PACKAGES}"

# Set ARMS env for the Python agent
export ARMS_APP_NAME="${SERVICE_NAME:-hermes}"

# Persist PYTHONPATH and ARMS env so that ANY terminal session inherits them:
# - /etc/profile.d/ → login shells (bash -l)
# - /etc/bash.bashrc → non-login interactive shells (kubectl exec, ACK console)
# - /etc/environment → PAM-level (some SSH/container runtimes)
_ARMS_ENV_SCRIPT="/etc/profile.d/arms-observability.sh"
cat > "$_ARMS_ENV_SCRIPT" << EOF
export PYTHONPATH="${PYTHONPATH}"
export ARMS_APP_NAME="${ARMS_APP_NAME}"
export APSARA_APM_APP_TYPE="${APSARA_APM_APP_TYPE:-app}"
EOF
chmod +r "$_ARMS_ENV_SCRIPT"
# Also source from bashrc for non-login shells (e.g. kubectl exec -it -- bash)
grep -q "arms-observability.sh" /etc/bash.bashrc 2>/dev/null || \
    echo ". $_ARMS_ENV_SCRIPT" >> /etc/bash.bashrc 2>/dev/null || true

# Kill any zombie hermes processes that started before patch
pkill -f 'hermes gateway run' 2>/dev/null || true
pkill -f 'hermes dashboard' 2>/dev/null || true
sleep 1

# Clear bytecode cache to ensure patched source is used
rm -f "${AUTO_INSTR}/__pycache__/_arms_load"*.pyc 2>/dev/null || true

# Patch ARMS agent for xtrace (CMS 2.0) compatibility:
# - Add x-arms-project / x-cms-workspace headers
# - Disable Snappy compression (xtrace doesn't support it)
# - Monkey-patch get_full_trace_url to use ARMS_ENDPOINT
# - Add genai resource attributes
ARMS_LOAD="${AUTO_INSTR}/_arms_load.py"
if [ -f "$ARMS_LOAD" ]; then
    /opt/hermes/.venv/bin/python /usr/local/bin/patch-arms-agent.py "$ARMS_LOAD" || \
        echo "[entrypoint] WARNING: ARMS agent patch failed, continuing without patch"
fi

echo "[entrypoint] Python agent configured: service=${ARMS_APP_NAME}, endpoint=${ARMS_ENDPOINT}, py=${PY_VERSION}"

# Fix ARMS agent log directory permissions for hermes subprocess
chmod -R 777 /home/admin/.opt/.apsara-apm/python/logs/ 2>/dev/null || true

# Fix config.yaml permissions for hermes user
chmod 644 /opt/data/config.yaml 2>/dev/null || true

exec supervisord -n
