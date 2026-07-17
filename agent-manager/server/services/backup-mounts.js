const CSI_VOLUME_CONFIG_METADATA_KEY = 'e2b.agents.kruise.io/csi-volume-config'
const DEFAULT_BACKUP_MOUNT_PATH = '/backup'
const DEFAULT_OSS_PV_NAME = 'oss-pv-openclaw-shared'

function normalizeMountPath(value = DEFAULT_BACKUP_MOUNT_PATH) {
  const rawMountPath = String(value || DEFAULT_BACKUP_MOUNT_PATH).trim()
  const mountPath = rawMountPath || DEFAULT_BACKUP_MOUNT_PATH
  return mountPath.startsWith('/') ? mountPath : `/${mountPath}`
}

function normalizePvName(value = DEFAULT_OSS_PV_NAME) {
  return String(value || DEFAULT_OSS_PV_NAME).trim() || DEFAULT_OSS_PV_NAME
}

function normalizePathSegment(value, field) {
  const segment = String(value || '').trim().replace(/^\/+|\/+$/g, '').replace(/\//g, '-')
  if (!segment || segment === '.' || segment === '..') {
    throw new Error(`${field} is required for backup volume subPath`)
  }
  if (segment.includes('..')) {
    throw new Error(`${field} contains invalid path traversal characters`)
  }
  return segment
}

function buildBackupSubPath({ agentTypeId, userId, instanceId }) {
  return `/${[
    'backup',
    normalizePathSegment(agentTypeId, 'agentTypeId'),
    normalizePathSegment(userId, 'userId'),
    normalizePathSegment(instanceId, 'instanceId'),
  ].join('/')}`
}

function buildBackupVolumeConfig({
  pvName = DEFAULT_OSS_PV_NAME,
  mountPath = DEFAULT_BACKUP_MOUNT_PATH,
  agentTypeId,
  userId,
  instanceId,
}) {
  return [{
    pvName: normalizePvName(pvName),
    mountPath: normalizeMountPath(mountPath),
    subPath: buildBackupSubPath({ agentTypeId, userId, instanceId }),
    readOnly: false,
  }]
}

export {
  CSI_VOLUME_CONFIG_METADATA_KEY,
  DEFAULT_BACKUP_MOUNT_PATH,
  DEFAULT_OSS_PV_NAME,
  buildBackupSubPath,
  buildBackupVolumeConfig,
}
