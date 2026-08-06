#!/bin/bash
# run-cmd.sh - Hermes configuration modifier
#
# Selectively modifies Hermes configuration without overwriting user customizations:
#   - Model config lives in /opt/data/config.yaml, only the `model.default` field
#     is touched (provider / base_url / api_key are preserved since the platform
#     forbids cross-provider switches and initializes them on instance creation).
#   - Channel config lives in /opt/data/.env, only the target channel's env vars
#     are upserted.
#
# Usage:
#   run-cmd.sh modify-model   <model_name>
#   run-cmd.sh modify-channel <channel_type> <client_id> <client_secret>
#
# Environment variables (override defaults):
#   HERMES_CONFIG_PATH - Path to config.yaml  (default: /opt/data/config.yaml)
#   HERMES_ENV_PATH    - Path to .env file    (default: /opt/data/.env)
#
# Sensitive values (client_secret) are passed via env vars instead of
# command-line arguments whenever possible.

set -euo pipefail

CONFIG_PATH="${HERMES_CONFIG_PATH:-/opt/data/config.yaml}"
ENV_PATH="${HERMES_ENV_PATH:-/opt/data/.env}"

# ---------------------------------------------------------------------------
# modify-model: update ONLY `model.default` in config.yaml.
# provider / base_url / api_key were set at instance-creation time and must not
# change (cross-provider switch is forbidden by the platform), so they are
# preserved verbatim. If the model block doesn't exist yet, we bail out with a
# clear error instead of guessing provider/base_url.
# ---------------------------------------------------------------------------
cmd_modify_model() {
    local model_name="${1:-}"

    if [ -z "$model_name" ]; then
        echo "Error: model_name is required" >&2
        echo "Usage: run-cmd.sh modify-model <model_name>" >&2
        exit 1
    fi

    if [ ! -f "$CONFIG_PATH" ]; then
        echo "Error: config file not found: $CONFIG_PATH" >&2
        echo "Hermes config.yaml should be initialized at instance creation time." >&2
        exit 1
    fi

    python3 - "$CONFIG_PATH" "$model_name" <<'PY'
import os
import sys

try:
    import yaml
except ImportError:
    print("Error: PyYAML is required. Install via: pip install pyyaml", file=sys.stderr)
    sys.exit(1)

path, model_name = sys.argv[1:3]

try:
    with open(path, "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}
except Exception as e:
    print(f"Failed to parse {path}: {e}", file=sys.stderr)
    sys.exit(1)

if not isinstance(cfg, dict):
    cfg = {}

model_block = cfg.get("model")
if not isinstance(model_block, dict):
    print(
        "Error: config.yaml has no existing `model` block; refusing to create "
        "one because provider/base_url/api_key must come from the platform's "
        "initial provisioning step.",
        file=sys.stderr,
    )
    sys.exit(1)

# Only touch the model name; everything else (provider, base_url, api_key,
# and any extra user fields) stays exactly as-is.
model_block["default"] = model_name
cfg["model"] = model_block

tmp_path = path + ".tmp"
with open(tmp_path, "w", encoding="utf-8") as f:
    yaml.safe_dump(cfg, f, default_flow_style=False, sort_keys=False, allow_unicode=True)

os.replace(tmp_path, path)
print(f"Model updated: default={model_name}")
PY
}

# ---------------------------------------------------------------------------
# modify-channel: upsert channel credentials in /opt/data/.env.
#
# Single-channel mode: only one channel is active at a time, so we write ALL
# channel env vars with the same client_id / client_secret (matching the
# startup_command template). Hermes will only connect to the channel whose
# credentials are actually valid; the other silently fails auth and stays off.
# ---------------------------------------------------------------------------
cmd_modify_channel() {
    local channel_type="${1:-}"
    local client_id="${2:-}"
    local client_secret="${3:-}"

    if [ -z "$channel_type" ] || [ -z "$client_id" ] || [ -z "$client_secret" ]; then
        echo "Error: channel_type, client_id, and client_secret are all required" >&2
        echo "Usage: run-cmd.sh modify-channel <channel_type> <client_id> <client_secret>" >&2
        exit 1
    fi

    # Ensure .env file exists
    mkdir -p "$(dirname "$ENV_PATH")"
    [ -f "$ENV_PATH" ] || touch "$ENV_PATH"

    python3 - "$ENV_PATH" "$client_id" "$client_secret" <<'PY'
import os, re, sys

path, client_id, client_secret = sys.argv[1:4]

# All channel vars to upsert (single-channel: same credentials for all)
UPSERT = {
    "DINGTALK_CLIENT_ID": client_id,
    "DINGTALK_CLIENT_SECRET": client_secret,
    "FEISHU_APP_ID": client_id,
    "FEISHU_APP_SECRET": client_secret,
    "FEISHU_CONNECTION_MODE": "websocket",
    "FEISHU_DOMAIN": "feishu",
}

try:
    with open(path, "r", encoding="utf-8") as f:
        lines = f.readlines()
except FileNotFoundError:
    lines = []

# Remove existing channel lines, then append fresh values
pattern = re.compile(
    r"^\s*(?:export\s+)?(" + "|".join(re.escape(k) for k in UPSERT) + r")\s*="
)
kept = [ln for ln in lines if not pattern.match(ln)]

if kept and not kept[-1].endswith("\n"):
    kept[-1] += "\n"

for k, v in UPSERT.items():
    kept.append(f"{k}={v}\n")

tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    f.writelines(kept)
os.replace(tmp, path)

print(f"Channel updated: all channel vars set (single-channel mode)")
PY
}

# ---------------------------------------------------------------------------
# Main dispatch
# ---------------------------------------------------------------------------
case "${1:-}" in
    modify-model)
        shift
        cmd_modify_model "$@"
        ;;
    modify-channel)
        shift
        cmd_modify_channel "$@"
        ;;
    help|--help|-h)
        cat <<EOF
Hermes configuration modifier

Usage:
  run-cmd.sh modify-model   <model_name>
      Update ONLY `model.default` in config.yaml. provider/base_url/api_key
      are preserved from the initial provisioning and never changed here.

  run-cmd.sh modify-channel <channel_type> <client_id> <client_secret>
      Single-channel mode: upsert ALL channel env vars in .env with the
      given credentials. Only the channel with valid credentials connects.
      Supported channel_type: dingtalk, feishu

Environment variables:
  HERMES_CONFIG_PATH  Path to config.yaml (default: /opt/data/config.yaml)
  HERMES_ENV_PATH     Path to .env file   (default: /opt/data/.env)
EOF
        ;;
    *)
        echo "Usage: run-cmd.sh {modify-model|modify-channel|help}" >&2
        exit 1
        ;;
esac
