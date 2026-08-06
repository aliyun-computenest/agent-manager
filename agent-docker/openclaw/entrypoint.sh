#!/bin/bash
set -e

CONFIG_FILE="${OPENCLAW_CONFIG_DIR:-/home/node/.openclaw/openclaw.json}"

ENDPOINT="${ARMS_ENDPOINT}"
LICENSE_KEY="${ARMS_LICENSE_KEY}"
PROJECT="${ARMS_PROJECT}"
WORKSPACE="${ARMS_WORKSPACE}"
SERVICE_NAME="${SERVICE_NAME}"

# All 5 parameters are required
if [ -z "$ENDPOINT" ] || [ -z "$LICENSE_KEY" ] || [ -z "$PROJECT" ] || [ -z "$WORKSPACE" ] || [ -z "$SERVICE_NAME" ]; then
    echo "[entrypoint] WARNING: Missing ARMS_* / SERVICE_NAME, skipping openclaw.json generation."
    exec supervisord -n
fi

# FIRST BOOT only: generate openclaw.json from env vars
# Platform writes the complete config on startup, replacing this initial file
if [ ! -f "${CONFIG_FILE}" ]; then
    cat > "${CONFIG_FILE}" <<JSONEOF
{
  "plugins": {
    "allow": ["opentelemetry-instrumentation-openclaw", "diagnostics-otel"],
    "load": { "paths": ["/home/node/.openclaw/extensions/opentelemetry-instrumentation-openclaw"] },
    "entries": {
      "opentelemetry-instrumentation-openclaw": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {
          "endpoint": "${ENDPOINT}",
          "headers": {
            "x-arms-license-key": "${LICENSE_KEY}",
            "x-arms-project": "${PROJECT}",
            "x-cms-workspace": "${WORKSPACE}"
          },
          "serviceName": "${SERVICE_NAME}",
          "resourceAttributes": {
            "acs.arms.service.feature": "genai_app"
          }
        }
      }
    }
  },
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "protocol": "http/protobuf",
      "endpoint": "${ENDPOINT}",
      "headers": {
        "x-arms-license-key": "${LICENSE_KEY}",
        "x-arms-project": "${PROJECT}",
        "x-cms-workspace": "${WORKSPACE}"
      },
      "serviceName": "${SERVICE_NAME}",
      "metrics": true,
      "traces": false,
      "logs": false
    }
  }
}
JSONEOF

    chown node:node "${CONFIG_FILE}" 2>/dev/null || true
    echo "[entrypoint] Generated ${CONFIG_FILE} with SERVICE_NAME=${SERVICE_NAME}"
fi

# Inject rejection-guard so Node.js loads it before any plugin code.
# This prevents unhandled promise rejections in the ArmsTrace plugin from
# crashing the gateway process (Node.js v24 defaults to throw on unhandled).
REJECTION_GUARD="/home/node/.openclaw/extensions/opentelemetry-instrumentation-openclaw/rejection-guard.js"
if [ -f "${REJECTION_GUARD}" ]; then
    export NODE_OPTIONS="--require ${REJECTION_GUARD} ${NODE_OPTIONS:-}"
    echo "[entrypoint] NODE_OPTIONS=${NODE_OPTIONS}"
fi

exec supervisord -n
