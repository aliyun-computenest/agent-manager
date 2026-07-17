#!/bin/bash
# run-cmd.sh - OpenClaw configuration modifier
# Selectively modifies specific blocks in openclaw.json without replacing the entire file.
#
# Usage:
#   run-cmd.sh modify-model   <provider/model>    - Update agents.defaults.model.primary
#   run-cmd.sh modify-channel <channel-json>       - Merge a FULL channel block
#
# NOTE on <channel-json>:
#   The argument must be the complete channel block as openclaw.json expects
#   it (same shape as channel_templates.config_template, with placeholders
#   already resolved), e.g. for DingTalk:
#     {
#       "dingtalk-connector": {
#         "enabled": true,
#         "clientId": "...",
#         "clientSecret": "...",
#         "gatewayToken": "...",
#         "gatewayPassword": "",
#         "separateSessionByConversation": true,
#         "groupSessionScope": "group",
#         "sharedMemoryAcrossConversations": false,
#         "ackText": "任务已接收"
#       }
#     }
#   The top-level key is the plugin package name (e.g. `dingtalk-connector`),
#   NOT the bare channel_type (`dingtalk`). Whatever key(s) are in the
#   incoming JSON will be merged into cfg.channels verbatim, replacing any
#   existing entry under that same key.
#
# Environment variables:
#   OPENCLAW_CONFIG_PATH  - Path to openclaw.json (default: /home/node/.openclaw/openclaw.json)

set -euo pipefail

CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-/home/node/.openclaw/openclaw.json}"

# ---------------------------------------------------------------------------
# modify-model: update agents.defaults.model.primary
# ---------------------------------------------------------------------------
cmd_modify_model() {
    local model_value="$1"

    if [ -z "$model_value" ]; then
        echo "Error: model value is required (format: provider/model)" >&2
        exit 1
    fi

    if [ ! -f "$CONFIG_PATH" ]; then
        echo "Error: config file not found at $CONFIG_PATH" >&2
        exit 1
    fi

    node -e '
        const fs   = require("fs");
        const path = process.argv[1];
        const val  = process.argv[2];

        let cfg;
        try {
            cfg = JSON.parse(fs.readFileSync(path, "utf8"));
        } catch (e) {
            console.error("Failed to parse", path, ":", e.message);
            process.exit(1);
        }

        cfg.agents                     = cfg.agents || {};
        cfg.agents.defaults            = cfg.agents.defaults || {};
        cfg.agents.defaults.model      = cfg.agents.defaults.model || {};
        cfg.agents.defaults.model.primary = val;

        fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
        console.log("Model updated to:", val);
    ' "$CONFIG_PATH" "$model_value"
}

# ---------------------------------------------------------------------------
# modify-channel: merge channel JSON into the channels block
# ---------------------------------------------------------------------------
cmd_modify_channel() {
    local channel_json="$1"

    if [ -z "$channel_json" ]; then
        echo "Error: channel JSON is required" >&2
        exit 1
    fi

    if [ ! -f "$CONFIG_PATH" ]; then
        echo "Error: config file not found at $CONFIG_PATH" >&2
        exit 1
    fi

    # Validate JSON first
    if ! echo "$channel_json" | node -e 'process.stdin.resume();let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{JSON.parse(d)}catch(e){console.error("Invalid channel JSON:",e.message);process.exit(1)}})' 2>/dev/null; then
        echo "Error: provided channel JSON is not valid" >&2
        exit 1
    fi

    # Write channel JSON to a temp file to avoid shell escaping issues
    local tmp_channel
    tmp_channel=$(mktemp /tmp/openclaw-channel-XXXXXX.json)
    echo "$channel_json" > "$tmp_channel"

    node -e '
        const fs   = require("fs");
        const path = process.argv[1];
        const chPath = process.argv[2];

        let cfg;
        try {
            cfg = JSON.parse(fs.readFileSync(path, "utf8"));
        } catch (e) {
            console.error("Failed to parse", path, ":", e.message);
            process.exit(1);
        }

        let channelCfg;
        try {
            channelCfg = JSON.parse(fs.readFileSync(chPath, "utf8"));
        } catch (e) {
            console.error("Failed to parse channel JSON:", e.message);
            process.exit(1);
        }

        cfg.channels = cfg.channels || {};

        // Merge: for each key in the incoming channel config, replace (or add)
        // the corresponding entry in cfg.channels. This way only the target
        // channel block is updated — existing channels remain untouched.
        for (const [key, value] of Object.entries(channelCfg)) {
            cfg.channels[key] = value;
        }

        fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
        console.log("Channel config updated:", Object.keys(channelCfg).join(", "));
    ' "$CONFIG_PATH" "$tmp_channel"

    rm -f "$tmp_channel"
}

# ---------------------------------------------------------------------------
# Main dispatch
# ---------------------------------------------------------------------------
case "${1:-}" in
    modify-model)
        cmd_modify_model "${2:-}"
        ;;
    modify-channel)
        cmd_modify_channel "${2:-}"
        ;;
    help|--help|-h)
        echo "OpenClaw configuration modifier"
        echo ""
        echo "Usage:"
        echo "  run-cmd.sh modify-model   <provider/model>    Update model in agents.defaults.model.primary"
        echo "  run-cmd.sh modify-channel <channel-json>       Merge a COMPLETE channel block (e.g. 'dingtalk-connector': {...})"
        echo "                                                 into cfg.channels. The top-level key must be the"
        echo "                                                 plugin name used by openclaw.json, NOT the bare"
        echo "                                                 channel_type (dingtalk → dingtalk-connector)."

        echo ""
        echo "Environment variables:"
        echo "  OPENCLAW_CONFIG_PATH  Path to openclaw.json (default: /home/node/.openclaw/openclaw.json)"
        ;;
    *)
        echo "Usage: run-cmd.sh {modify-model|modify-channel|help}" >&2
        exit 1
        ;;
esac