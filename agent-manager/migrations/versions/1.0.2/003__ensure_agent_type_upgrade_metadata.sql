-- Ensure Agent Type sandbox upgrade configuration exists on upgraded databases.
-- Some long-lived environments may have stamped older migrations while still
-- missing this feature column, so keep this migration deliberately idempotent.

ALTER TABLE agent_types
  ADD COLUMN IF NOT EXISTS upgrade_metadata JSONB DEFAULT '{}'::jsonb;

ALTER TABLE agent_instances
  ADD COLUMN IF NOT EXISTS backup_enabled BOOLEAN NOT NULL DEFAULT false;

UPDATE agent_types
SET upgrade_metadata = '{}'::jsonb
WHERE upgrade_metadata IS NULL;

ALTER TABLE agent_types
  ALTER COLUMN upgrade_metadata SET DEFAULT '{}'::jsonb;

COMMENT ON COLUMN agent_types.upgrade_metadata IS
  'Agent-level Sandbox upgrade configuration: hook commands, timeoutSeconds, and selector defaults.';

COMMENT ON COLUMN agent_instances.backup_enabled IS
  'Whether this instance was created with backup CSI metadata and can participate in backup-based upgrades.';

WITH default_hooks AS (
  SELECT jsonb_build_object(
    'timeoutSeconds', 60,
    'preUpgrade', jsonb_build_object(
      'command', jsonb_build_array(
        '/bin/bash',
        '-c',
$pre$
set -euo pipefail

OPENCLAW_HOME="/home/node/.openclaw"
BACKUP_ROOT="/backup"
BACKUP_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
ARCHIVE="$BACKUP_ROOT/openclaw-state-$BACKUP_ID.tgz"

test -d "$BACKUP_ROOT"
test -d "$OPENCLAW_HOME"
tar --exclude='.openclaw/devices' \
    --exclude='.openclaw/identity/device-auth.json' \
    -czf "$ARCHIVE" -C "$(dirname "$OPENCLAW_HOME")" "$(basename "$OPENCLAW_HOME")"
test -s "$ARCHIVE"
$pre$
      )
    ),
    'postUpgrade', jsonb_build_object(
      'command', jsonb_build_array(
        '/bin/bash',
        '-c',
$post$
set -euo pipefail

OPENCLAW_HOME="/home/node/.openclaw"
BACKUP_ROOT="/backup"
ARCHIVE="$(ls -1t "$BACKUP_ROOT"/openclaw-state-*.tgz 2>/dev/null | head -n 1 || true)"
if [ -z "$ARCHIVE" ] && [ -f "$BACKUP_ROOT/openclaw-state.tgz" ]; then
  ARCHIVE="$BACKUP_ROOT/openclaw-state.tgz"
fi

test -n "$ARCHIVE"
test -f "$ARCHIVE"
mkdir -p "$(dirname "$OPENCLAW_HOME")"
if [ -d "$OPENCLAW_HOME" ]; then
  rm -rf "$OPENCLAW_HOME.before-upgrade"
  mv "$OPENCLAW_HOME" "$OPENCLAW_HOME.before-upgrade"
fi
tar -xzf "$ARCHIVE" -C "$(dirname "$OPENCLAW_HOME")"
chown -R "$(id -u node):$(id -g node)" "$OPENCLAW_HOME"
test -d "$OPENCLAW_HOME"

supervisorctl restart openclaw
$post$
      )
    )
  ) AS metadata
)
UPDATE agent_types
SET upgrade_metadata = default_hooks.metadata
FROM default_hooks
WHERE code = 'openclaw'
  AND (
    upgrade_metadata IS NULL
    OR upgrade_metadata = '{}'::jsonb
    OR upgrade_metadata #> '{preUpgrade,command}' IS NULL
    OR upgrade_metadata #> '{postUpgrade,command}' IS NULL
    OR upgrade_metadata::text LIKE '%/backup/openclaw-state.tgz%'
    OR upgrade_metadata::text LIKE '%cd /home/node%'
    OR upgrade_metadata::text LIKE '%chown -R node:node%'
    OR upgrade_metadata::text LIKE '%api-upgrade-%'
    OR upgrade_metadata::text LIKE '%/tmp/api-%'
  );

WITH hermes_hooks AS (
  SELECT jsonb_build_object(
    'timeoutSeconds', 60,
    'preUpgrade', jsonb_build_object(
      'command', jsonb_build_array(
        '/bin/bash',
        '-c',
$pre$
set -euo pipefail

HERMES_DATA_DIR="/opt/data"
BACKUP_ROOT="/backup"
BACKUP_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
ARCHIVE="$BACKUP_ROOT/hermes-state-$BACKUP_ID.tgz"

test -d "$BACKUP_ROOT"
test -d "$HERMES_DATA_DIR"
test -f "$HERMES_DATA_DIR/config.yaml"
tar -czf "$ARCHIVE" -C "$HERMES_DATA_DIR" .
test -s "$ARCHIVE"
$pre$
      )
    ),
    'postUpgrade', jsonb_build_object(
      'command', jsonb_build_array(
        '/bin/bash',
        '-c',
$post$
set -euo pipefail

HERMES_DATA_DIR="/opt/data"
BACKUP_ROOT="/backup"
ARCHIVE="$(ls -1t "$BACKUP_ROOT"/hermes-state-*.tgz 2>/dev/null | head -n 1 || true)"
if [ -z "$ARCHIVE" ] && [ -f "$BACKUP_ROOT/hermes-state.tgz" ]; then
  ARCHIVE="$BACKUP_ROOT/hermes-state.tgz"
fi

test -n "$ARCHIVE"
test -f "$ARCHIVE"
mkdir -p "$HERMES_DATA_DIR"
find "$HERMES_DATA_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
tar -xzf "$ARCHIVE" -C "$HERMES_DATA_DIR"
chown -R "$(id -u):$(id -g)" "$HERMES_DATA_DIR"
test -f "$HERMES_DATA_DIR/config.yaml"
if command -v supervisorctl >/dev/null 2>&1; then
  supervisorctl restart hermes || supervisorctl start hermes
fi
$post$
      )
    )
  ) AS metadata
)
UPDATE agent_types
SET upgrade_metadata = hermes_hooks.metadata
FROM hermes_hooks
WHERE code = 'hermes'
  AND (
    upgrade_metadata IS NULL
    OR upgrade_metadata = '{}'::jsonb
    OR upgrade_metadata #> '{preUpgrade,command}' IS NULL
    OR upgrade_metadata #> '{postUpgrade,command}' IS NULL
    OR upgrade_metadata::text LIKE '%/backup/hermes-state.tgz%'
    OR upgrade_metadata::text LIKE '%api-upgrade-%'
    OR upgrade_metadata::text LIKE '%/tmp/api-%'
  );
