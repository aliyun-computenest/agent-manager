import { getSandboxNamespace } from '../kubernetes-api.js'
import {
  BACKUP_ID_LABEL,
  BACKUP_KIND_LABEL,
  MANAGED_BY_LABEL,
  SNAPSHOT_KEY_ANNOTATION,
  SNAPSHOT_NAME_ANNOTATION,
  SOURCE_INSTANCE_ID_LABEL
} from './constants.js'

export function getSandboxTargetFromInstance(instance, fallbackNamespace = getSandboxNamespace()) {
  const sandboxId = instance?.sandbox_id
  if (!sandboxId || typeof sandboxId !== 'string') {
    return { namespace: fallbackNamespace, sandboxName: null }
  }
  const separatorIndex = sandboxId.indexOf('--')
  if (separatorIndex > 0) {
    const namespace = sandboxId.slice(0, separatorIndex) || fallbackNamespace
    const sandboxName = sandboxId.slice(separatorIndex + 2)
    return { namespace, sandboxName: sandboxName || null }
  }
  return { namespace: fallbackNamespace, sandboxName: sandboxId }
}

export function isNotFoundError(error) {
  return error?.httpStatus === 404 || error?.status === 404 || error?.code === 404
}

function getConditionStatus(checkpoint, type) {
  const condition = (checkpoint?.status?.conditions || []).find(item =>
    String(item.type || item.Type || '').toLowerCase() === type.toLowerCase()
  )
  return condition?.status || condition?.Status || null
}

function isConditionTrue(checkpoint, type) {
  return String(getConditionStatus(checkpoint, type) || '').toLowerCase() === 'true'
}

function parseSnapshot(configMap, key) {
  const raw = configMap?.data?.[key]
  if (!raw) return { status: 'Missing', template: null }
  try {
    const parsed = JSON.parse(raw)
    if (parsed?.kind !== 'Sandbox' || !parsed?.spec?.template) {
      return { status: 'Corrupt', template: null }
    }
    return { status: 'Ready', template: parsed }
  } catch {
    return { status: 'Corrupt', template: null }
  }
}

function getCheckpointId(checkpoint) {
  return checkpoint?.status?.checkpointId
    || checkpoint?.status?.checkpointID
    || checkpoint?.status?.id
    || null
}

function getBackupId(checkpoint) {
  return checkpoint?.metadata?.labels?.[BACKUP_ID_LABEL]
    || checkpoint?.metadata?.name
    || null
}

function getBaseCheckpointPhase(checkpoint) {
  const phase = String(checkpoint?.status?.phase || checkpoint?.status?.Phase || '').toLowerCase()
  if (phase === 'failed' || isConditionTrue(checkpoint, 'Failed')) return 'Failed'
  if (phase === 'ready' || phase === 'succeeded' || isConditionTrue(checkpoint, 'Ready')) return 'Ready'
  return 'InProgress'
}

function indexConfigMapsByBackupId(configMaps = []) {
  const index = new Map()
  for (const configMap of configMaps) {
    const backupId = configMap?.metadata?.labels?.[BACKUP_ID_LABEL]
    if (backupId && !index.has(backupId)) index.set(backupId, configMap)
  }
  return index
}

export async function buildSnapshotIndex(instance, api, namespace) {
  if (typeof api.listConfigMaps !== 'function') return null
  const selector = {
    matchLabels: {
      [MANAGED_BY_LABEL]: 'agent-manager',
      [BACKUP_KIND_LABEL]: 'spec-snapshot',
      [SOURCE_INSTANCE_ID_LABEL]: instance.id
    }
  }
  const configMaps = await api.listConfigMaps(namespace, selector)
  return indexConfigMapsByBackupId(configMaps?.items || [])
}

export async function buildBackupItem(checkpoint, api, namespace, snapshotIndex = null) {
  const annotations = checkpoint?.metadata?.annotations || {}
  const checkpointId = getCheckpointId(checkpoint)
  const snapshotName = annotations[SNAPSHOT_NAME_ANNOTATION] || ''
  const snapshotKey = annotations[SNAPSHOT_KEY_ANNOTATION] || ''
  let snapshot = { status: 'Missing', template: null }

  if (snapshotName && snapshotKey) {
    try {
      const configMap = snapshotIndex?.get(getBackupId(checkpoint)) || await api.getConfigMap(namespace, snapshotName)
      snapshot = parseSnapshot(configMap, snapshotKey)
    } catch {
      snapshot = { status: 'Missing', template: null }
    }
  }

  let status = getBaseCheckpointPhase(checkpoint)
  if (status === 'Ready') {
    if (snapshot.status === 'Missing') status = 'SnapshotMissing'
    if (snapshot.status === 'Corrupt') status = 'SnapshotCorrupt'
  }

  return {
    backupId: getBackupId(checkpoint),
    checkpointName: checkpoint?.metadata?.name || null,
    snapshotName,
    snapshotKey,
    checkpointId,
    status,
    createdAt: checkpoint?.metadata?.creationTimestamp || null,
    snapshotTemplate: snapshot.template
  }
}
