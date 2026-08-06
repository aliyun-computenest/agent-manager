export const MANAGED_BY_LABEL = 'agent-manager.io/managed-by'
export const INSTANCE_ID_LABEL = 'agent-manager.io/instance-id'
export const SOURCE_INSTANCE_ID_LABEL = 'agent-manager.io/source-instance-id'
export const SOURCE_SANDBOX_NAME_LABEL = 'agent-manager.io/source-sandbox-name'
export const BACKUP_KIND_LABEL = 'agent-manager.io/backup-kind'
export const BACKUP_ID_LABEL = 'agent-manager.io/backup-id'
export const BACKUP_RUN_ID_LABEL = 'agent-manager.io/backup-run-id'
export const BACKUP_TRIGGER_LABEL = 'agent-manager.io/backup-trigger'
export const BACKUP_SCOPE_ANNOTATION = 'agent-manager.io/backup-scope'
export const PRINCIPAL_ID_ANNOTATION = 'agent-manager.io/principal-id'
export const SNAPSHOT_NAME_ANNOTATION = 'agent-manager.io/spec-snapshot-name'
export const SNAPSHOT_KEY_ANNOTATION = 'agent-manager.io/spec-snapshot-key'
export const SNAPSHOT_KIND_ANNOTATION = 'agent-manager.io/spec-snapshot-kind'
export const RESTORE_FROM_ANNOTATION = 'checkpoint.alibabacloud.com/restore-from'
export const BACKUP_LOCK_ID_ANNOTATION = 'agent-manager.io/backup-lock-id'
export const RESTORE_BACKUP_ID_ANNOTATION = 'agent-manager.io/restore-backup-id'
export const RESTORE_SOURCE_INSTANCE_ID_ANNOTATION = 'agent-manager.io/restore-source-instance-id'
export const RESTORE_REQUEST_ID_ANNOTATION = 'agent-manager.io/restore-request-id'
export const RESTORE_REQUESTED_AT_ANNOTATION = 'agent-manager.io/restore-requested-at'
export const DEFAULT_OOS_ASSUME_ROLE = 'AgentManagerOOSServiceRole'

export function getRetentionCount(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 50) : 5
}

export function formatBackupTimestamp(date) {
  return date.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'z')
    .replace('T', 't')
}
