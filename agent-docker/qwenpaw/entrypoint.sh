#!/bin/bash
set -e

# Graceful degradation: if ARMS env not set, start without monitoring
if [ -z "$ARMS_LICENSE_KEY" ] || [ -z "$ARMS_ENDPOINT" ]; then
    echo "[entrypoint] WARNING: Missing ARMS_* env, skipping observability plugin."
    exec /entrypoint.sh
fi

SERVICE="${SERVICE_NAME:-qwenpaw}"
PYTHON_PATH="/app/venv/bin/python"
INSTALL_URL="https://arms-apm-cn-hangzhou-pre.oss-cn-hangzhou.aliyuncs.com/qwenpaw-cms-plugin/install.sh"

# Write LoongSuite configuration for GenAI content capture (input/output).
# install.sh normally does this, but we skip it when packages are pre-installed.
# Generate config directly to avoid curl dependency on restricted networks.
LOONGSUITE_CONFIG_DIR="/app/venv/lib/python3.11/site-packages/loongsuite_distro"
LOONGSUITE_CONFIG="$LOONGSUITE_CONFIG_DIR/default_config.json"
if [ ! -f "$LOONGSUITE_CONFIG" ]; then
    echo "[entrypoint] Writing LoongSuite config..."
    mkdir -p "$LOONGSUITE_CONFIG_DIR"
    cat > "$LOONGSUITE_CONFIG" << EOFCFG
{
  "endpoint": "${ARMS_ENDPOINT}/v1/traces",
  "metrics_endpoint": "${ARMS_ENDPOINT}/v1/metrics",
  "protocol": "http/protobuf",
  "headers": "x-arms-license-key=${ARMS_LICENSE_KEY},x-arms-project=${ARMS_PROJECT},x-cms-workspace=${ARMS_WORKSPACE}",
  "service_name": "${SERVICE}",
  "resource_attributes": "acs.arms.service.feature=genai_app,gen_ai.agent.system=qwenpaw"
}
EOFCFG
    echo "[entrypoint] LoongSuite config written to $LOONGSUITE_CONFIG"
fi

# Check if observability is disabled via marker file
if [ -f /tmp/.observability_disabled ]; then
    echo "[entrypoint] Observability disabled via marker, skipping observability plugin."
    exec /entrypoint.sh
fi

# Enable site bootstrap for OpenTelemetry auto-instrumentation
export LOONGSUITE_PYTHON_SITE_BOOTSTRAP=true

# Configure OTEL exporter endpoint (required when loongsuite is pre-installed in image
# and install.sh was skipped — otherwise defaults to localhost:4317 which fails)
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="${ARMS_ENDPOINT}/v1/traces"
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT="${ARMS_ENDPOINT}/v1/metrics"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_TRACES_EXPORTER="otlp"
export OTEL_METRICS_EXPORTER="otlp"
export OTEL_SERVICE_NAME="${SERVICE}"
export OTEL_EXPORTER_OTLP_HEADERS="x-arms-license-key=${ARMS_LICENSE_KEY},x-arms-project=${ARMS_PROJECT},x-cms-workspace=${ARMS_WORKSPACE}"

echo "[entrypoint] QwenPaw observability configured: service=${SERVICE}"
# Hand off to QwenPaw's original entrypoint (generates supervisord.conf from template + starts supervisord)
exec /entrypoint.sh
