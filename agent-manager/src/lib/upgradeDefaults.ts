type AgentTypeLike = {
  code: string
}

type UpgradeStage = 'pre' | 'post'

const OPENCLAW_DEFAULT_PRE_UPGRADE_COMMAND = `set -euo pipefail

OPENCLAW_HOME="/home/node/.openclaw"
BACKUP_ROOT="/backup"
BACKUP_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
ARCHIVE="$BACKUP_ROOT/openclaw-state-$BACKUP_ID.tgz"
TAR_STATUS=0

log() {
  echo "[openclaw-upgrade][pre] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
}

restart_on_error() {
  status=$?
  if [ "$status" -ne 0 ] && command -v supervisorctl >/dev/null 2>&1; then
    log "backup failed: status=$status; restarting openclaw on old pod"
    supervisorctl start openclaw || supervisorctl restart openclaw || true
  fi
  exit "$status"
}
trap restart_on_error EXIT

log "start backup: home=$OPENCLAW_HOME backupRoot=$BACKUP_ROOT archive=$ARCHIVE"
test -d "$BACKUP_ROOT"
test -d "$OPENCLAW_HOME"
if command -v supervisorctl >/dev/null 2>&1; then
  log "stopping openclaw before archiving"
  supervisorctl stop openclaw || true
fi

log "creating backup archive"
tar --warning=no-file-changed --ignore-failed-read \\
  --exclude='.openclaw/devices' \\
  --exclude='.openclaw/identity/device-auth.json' \\
  -czf "$ARCHIVE" -C "$(dirname "$OPENCLAW_HOME")" "$(basename "$OPENCLAW_HOME")" || TAR_STATUS=$?
if [ "$TAR_STATUS" -ne 0 ] && [ "$TAR_STATUS" -ne 1 ]; then
  log "tar failed: status=$TAR_STATUS"
  exit "$TAR_STATUS"
fi
test -s "$ARCHIVE"
log "backup archive ready: bytes=$(wc -c < "$ARCHIVE")"
trap - EXIT`

const OPENCLAW_DEFAULT_POST_UPGRADE_COMMAND = `set -euo pipefail

OPENCLAW_HOME="/home/node/.openclaw"
BACKUP_ROOT="/backup"
ARCHIVE="$(ls -1t "$BACKUP_ROOT"/openclaw-state-*.tgz 2>/dev/null | head -n 1 || true)"
if [ -z "$ARCHIVE" ] && [ -f "$BACKUP_ROOT/openclaw-state.tgz" ]; then
  ARCHIVE="$BACKUP_ROOT/openclaw-state.tgz"
fi
RESTORE_ROOT=""

log() {
  echo "[openclaw-upgrade][post] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
}

cleanup() {
  if [ -n "$RESTORE_ROOT" ] && [ -d "$RESTORE_ROOT" ]; then
    rm -rf "$RESTORE_ROOT"
  fi
}
trap cleanup EXIT

log "start restore: home=$OPENCLAW_HOME backupRoot=$BACKUP_ROOT archive=\${ARCHIVE:-none}"
test -n "$ARCHIVE"
test -f "$ARCHIVE"

RESTORE_ROOT="$(mktemp -d /home/node/.openclaw-restore.XXXXXX)"
log "extracting archive to $RESTORE_ROOT"
tar -xzf "$ARCHIVE" -C "$RESTORE_ROOT"
RESTORED_HOME="$RESTORE_ROOT/.openclaw"
test -d "$RESTORED_HOME"
test -f "$RESTORED_HOME/openclaw.json"
test -f "$RESTORED_HOME/.env"
log "validated restored config files"

mkdir -p "$(dirname "$OPENCLAW_HOME")"
rm -rf "$OPENCLAW_HOME.before-upgrade"
if [ -d "$OPENCLAW_HOME" ]; then
  log "moving current home to $OPENCLAW_HOME.before-upgrade"
  mv "$OPENCLAW_HOME" "$OPENCLAW_HOME.before-upgrade"
fi
mv "$RESTORED_HOME" "$OPENCLAW_HOME"
chown -R "$(id -u node):$(id -g node)" "$OPENCLAW_HOME"
test -d "$OPENCLAW_HOME"
test -f "$OPENCLAW_HOME/openclaw.json"
test -f "$OPENCLAW_HOME/.env"
log "restore complete: home=$OPENCLAW_HOME"

if command -v supervisorctl >/dev/null 2>&1; then
  log "restarting openclaw"
  supervisorctl restart openclaw || supervisorctl start openclaw
fi
log "post upgrade complete"`

const HERMES_DEFAULT_PRE_UPGRADE_COMMAND = `set -euo pipefail

HERMES_DATA_DIR="/opt/data"
BACKUP_ROOT="/backup"
BACKUP_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
ARCHIVE="$BACKUP_ROOT/hermes-state-$BACKUP_ID.tgz"

test -d "$BACKUP_ROOT"
test -d "$HERMES_DATA_DIR"
test -f "$HERMES_DATA_DIR/config.yaml"
tar -czf "$ARCHIVE" -C "$HERMES_DATA_DIR" .
test -s "$ARCHIVE"`

const HERMES_DEFAULT_POST_UPGRADE_COMMAND = `set -euo pipefail

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
fi`

const QWENPAW_DEFAULT_PRE_UPGRADE_COMMAND = `set -euo pipefail

WORKING_DIR="/app/working"
SECRET_DIR="/app/working.secret"
BACKUP_ROOT="/backup"
BACKUP_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
ARCHIVE="$BACKUP_ROOT/qwenpaw-state-$BACKUP_ID.tgz"

test -d "$BACKUP_ROOT"
test -d "$WORKING_DIR"
test -d "$SECRET_DIR"
# /app/working.backups 是 qwenpaw 运行期生成的临时备份，可重建，不纳入归档。
tar -czf "$ARCHIVE" -C /app working working.secret
test -s "$ARCHIVE"`

const QWENPAW_DEFAULT_POST_UPGRADE_COMMAND = `set -euo pipefail

WORKING_DIR="/app/working"
SECRET_DIR="/app/working.secret"
BACKUP_ROOT="/backup"
ARCHIVE="$(ls -1t "$BACKUP_ROOT"/qwenpaw-state-*.tgz 2>/dev/null | head -n 1 || true)"
if [ -z "$ARCHIVE" ] && [ -f "$BACKUP_ROOT/qwenpaw-state.tgz" ]; then
  ARCHIVE="$BACKUP_ROOT/qwenpaw-state.tgz"
fi

test -n "$ARCHIVE"
test -f "$ARCHIVE"
mkdir -p "$WORKING_DIR" "$SECRET_DIR"
find "$WORKING_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
find "$SECRET_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
tar -xzf "$ARCHIVE" -C /app
test -f "$WORKING_DIR/config.json"
chown -R "$(id -u):$(id -g)" "$WORKING_DIR" "$SECRET_DIR"

# qwenpaw app 由镜像内置 supervisord 托管，run-cmd.sh 做两层兑底重启。
if [ -x /usr/local/bin/run-cmd.sh ]; then
  bash /usr/local/bin/run-cmd.sh restart || true
fi`

export const getDefaultUpgradeCommandText = (agentType: AgentTypeLike, stage: UpgradeStage) => {
  if (agentType.code === 'openclaw') {
    return stage === 'pre' ? OPENCLAW_DEFAULT_PRE_UPGRADE_COMMAND : OPENCLAW_DEFAULT_POST_UPGRADE_COMMAND
  }
  if (agentType.code === 'hermes') {
    return stage === 'pre' ? HERMES_DEFAULT_PRE_UPGRADE_COMMAND : HERMES_DEFAULT_POST_UPGRADE_COMMAND
  }
  if (agentType.code === 'qwenpaw') {
    return stage === 'pre' ? QWENPAW_DEFAULT_PRE_UPGRADE_COMMAND : QWENPAW_DEFAULT_POST_UPGRADE_COMMAND
  }
  return ''
}

export const getDefaultUpgradeTimeoutSeconds = (agentType: AgentTypeLike) => {
  return agentType.code === 'openclaw' ? 300 : 60
}
