#!/bin/bash
set -e
ACTION=${1:-enable}
CONFIG="/home/node/.openclaw/openclaw.json"
PLUGIN_KEY="opentelemetry-instrumentation-openclaw"

if [ ! -f "$CONFIG" ]; then
  echo "[toggle] Config file not found: $CONFIG"
  exit 1
fi

if [ "$ACTION" = "disable" ]; then
  node -e "
    const fs = require('fs');
    const c = JSON.parse(fs.readFileSync('$CONFIG', 'utf8'));
    if (c.plugins && c.plugins.entries && c.plugins.entries['$PLUGIN_KEY']) {
      c.plugins.entries['$PLUGIN_KEY'].enabled = false;
    }
    fs.writeFileSync('$CONFIG', JSON.stringify(c, null, 2));
  "
  echo "[toggle] Plugin disabled"
elif [ "$ACTION" = "enable" ]; then
  node -e "
    const fs = require('fs');
    const c = JSON.parse(fs.readFileSync('$CONFIG', 'utf8'));
    if (c.plugins && c.plugins.entries && c.plugins.entries['$PLUGIN_KEY']) {
      c.plugins.entries['$PLUGIN_KEY'].enabled = true;
    }
    fs.writeFileSync('$CONFIG', JSON.stringify(c, null, 2));
  "
  echo "[toggle] Plugin enabled"
else
  echo "[toggle] Usage: toggle-observability.sh enable|disable"
  exit 1
fi

# Restart the openclaw gateway process
supervisorctl restart openclaw
echo "[toggle] Process restarted"
