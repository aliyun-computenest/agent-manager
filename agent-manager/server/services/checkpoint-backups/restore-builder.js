import {
  BACKUP_LOCK_ID_ANNOTATION,
  INSTANCE_ID_LABEL,
  MANAGED_BY_LABEL,
  PRINCIPAL_ID_ANNOTATION,
  RESTORE_BACKUP_ID_ANNOTATION,
  RESTORE_FROM_ANNOTATION,
  RESTORE_REQUESTED_AT_ANNOTATION,
  RESTORE_REQUEST_ID_ANNOTATION,
  RESTORE_SOURCE_INSTANCE_ID_ANNOTATION,
  SOURCE_INSTANCE_ID_LABEL
} from './constants.js'

function escapeJsonPointer(value) {
  return String(value).replace(/~/g, '~0').replace(/\//g, '~1')
}

function getAnnotationPatchOp(metadata, key) {
  return Object.prototype.hasOwnProperty.call(metadata?.annotations || {}, key) ? 'replace' : 'add'
}

function mergeContainerRuntimeValues(snapshotContainers, currentContainers) {
  if (!Array.isArray(snapshotContainers)) return snapshotContainers
  const currentItems = Array.isArray(currentContainers) ? currentContainers : []
  const currentByName = new Map(currentItems.filter(item => item?.name).map(item => [item.name, item]))
  return snapshotContainers.map((container) => {
    const current = currentByName.get(container?.name)
    const next = structuredClone(container)
    if (current) {
      if (Array.isArray(next.env) || Array.isArray(current.env)) {
        next.env = structuredClone(current.env || [])
      }
      if (Array.isArray(next.envFrom) || Array.isArray(current.envFrom)) {
        next.envFrom = structuredClone(current.envFrom || [])
      }
    }
    return next
  })
}

function mergeCurrentRuntimeValues(snapshotSpec, currentSpec) {
  const spec = structuredClone(snapshotSpec || {})
  const snapshotPodSpec = spec?.template?.spec
  const currentPodSpec = currentSpec?.template?.spec
  if (!snapshotPodSpec || !currentPodSpec) return spec

  for (const field of ['containers', 'initContainers', 'ephemeralContainers']) {
    if (Array.isArray(snapshotPodSpec[field])) {
      snapshotPodSpec[field] = mergeContainerRuntimeValues(snapshotPodSpec[field], currentPodSpec[field])
    }
  }
  return spec
}

function buildRestoreSpec(snapshotSpec, checkpointId, currentSpec = null) {
  const spec = mergeCurrentRuntimeValues(snapshotSpec, currentSpec)
  spec.template ||= {}
  spec.template.metadata ||= {}
  spec.template.metadata.annotations ||= {}
  spec.template.metadata.annotations[RESTORE_FROM_ANNOTATION] = checkpointId
  return spec
}

function cleanSandboxMetadataForCreate(metadata = {}) {
  const cleaned = structuredClone(metadata || {})
  delete cleaned.creationTimestamp
  delete cleaned.deletionGracePeriodSeconds
  delete cleaned.deletionTimestamp
  delete cleaned.finalizers
  delete cleaned.generateName
  delete cleaned.generation
  delete cleaned.managedFields
  delete cleaned.ownerReferences
  delete cleaned.resourceVersion
  delete cleaned.uid
  return cleaned
}

function stripCloneControllerMetadata(metadata = {}) {
  const cleaned = cleanSandboxMetadataForCreate(metadata)
  const labels = { ...(cleaned.labels || {}) }
  const annotations = { ...(cleaned.annotations || {}) }

  for (const key of Object.keys(labels)) {
    if (key.startsWith('agents.kruise.io/')
      || key.startsWith('sandbox.agents.kruise.io/')
      || key === INSTANCE_ID_LABEL
      || key === SOURCE_INSTANCE_ID_LABEL) {
      delete labels[key]
    }
  }

  for (const key of Object.keys(annotations)) {
    if (key.startsWith('agents.kruise.io/')
      || key.startsWith('sandbox.agents.kruise.io/')
      || key === RESTORE_FROM_ANNOTATION
      || key === RESTORE_BACKUP_ID_ANNOTATION
      || key === RESTORE_SOURCE_INSTANCE_ID_ANNOTATION
      || key === RESTORE_REQUEST_ID_ANNOTATION
      || key === RESTORE_REQUESTED_AT_ANNOTATION
      || key === INSTANCE_ID_LABEL
      || key === PRINCIPAL_ID_ANNOTATION
      || key === 'instanceId'
      || key === 'instanceName'
      || key === 'userId'
      || key === 'agentType') {
      delete annotations[key]
    }
  }

  return {
    ...cleaned,
    labels,
    annotations
  }
}

export function buildCloneSandbox(snapshotTemplate, {
  namespace,
  sandboxName,
  checkpointId,
  backupId,
  requestId,
  requestedAt,
  sourceInstanceId,
  newInstanceId,
  newInstanceName,
  principalId,
  userId,
  agentType = null,
  metadataLabels = {},
  metadataAnnotations = {}
}) {
  const snapshotMetadata = stripCloneControllerMetadata(snapshotTemplate?.metadata || {})
  const annotations = {
    ...(snapshotMetadata.annotations || {}),
    ...metadataAnnotations,
    [INSTANCE_ID_LABEL]: newInstanceId,
    [PRINCIPAL_ID_ANNOTATION]: principalId,
    [RESTORE_BACKUP_ID_ANNOTATION]: backupId,
    [RESTORE_SOURCE_INSTANCE_ID_ANNOTATION]: sourceInstanceId,
    [RESTORE_REQUEST_ID_ANNOTATION]: requestId,
    [RESTORE_REQUESTED_AT_ANNOTATION]: requestedAt,
    instanceId: newInstanceId,
    instanceName: newInstanceName
  }
  if (userId) annotations.userId = userId
  if (agentType?.code) {
    annotations.agentType = agentType.code
    annotations['agent-manager.io/agent-type-code'] = agentType.code
  }
  if (agentType?.id) annotations['agent-manager.io/agent-type-id'] = agentType.id

  const labels = {
    ...(snapshotMetadata.labels || {}),
    ...metadataLabels,
    [MANAGED_BY_LABEL]: 'agent-manager',
    [INSTANCE_ID_LABEL]: newInstanceId,
    [SOURCE_INSTANCE_ID_LABEL]: sourceInstanceId
  }

  const spec = buildRestoreSpec(snapshotTemplate?.spec, checkpointId)
  spec.sandboxName = sandboxName
  spec.template ||= {}
  spec.template.metadata ||= {}
  spec.template.metadata.labels = {
    ...(spec.template.metadata.labels || {}),
    [INSTANCE_ID_LABEL]: newInstanceId,
    [SOURCE_INSTANCE_ID_LABEL]: sourceInstanceId
  }

  return {
    apiVersion: snapshotTemplate?.apiVersion || 'agents.kruise.io/v1alpha1',
    kind: 'Sandbox',
    metadata: {
      ...snapshotMetadata,
      name: sandboxName,
      namespace,
      labels,
      annotations
    },
    spec
  }
}

export function buildRestoreSandbox(currentSandbox, snapshotTemplate, {
  namespace,
  sandboxName,
  checkpointId,
  backupId,
  requestId,
  requestedAt
}) {
  const snapshotMetadata = cleanSandboxMetadataForCreate(snapshotTemplate?.metadata || {})
  const currentMetadata = cleanSandboxMetadataForCreate(currentSandbox?.metadata || {})
  const annotations = {
    ...(snapshotMetadata.annotations || {}),
    ...(currentMetadata.annotations || {}),
    [RESTORE_BACKUP_ID_ANNOTATION]: backupId,
    [RESTORE_REQUEST_ID_ANNOTATION]: requestId,
    [RESTORE_REQUESTED_AT_ANNOTATION]: requestedAt
  }
  delete annotations[RESTORE_FROM_ANNOTATION]

  return {
    apiVersion: snapshotTemplate?.apiVersion || 'agents.kruise.io/v1alpha1',
    kind: 'Sandbox',
    metadata: {
      ...snapshotMetadata,
      ...currentMetadata,
      name: sandboxName,
      namespace,
      labels: {
        ...(snapshotMetadata.labels || {}),
        ...(currentMetadata.labels || {})
      },
      annotations
    },
    spec: buildRestoreSpec(snapshotTemplate?.spec, checkpointId, currentSandbox?.spec)
  }
}

export function isSandboxBusy(sandbox) {
  const annotations = sandbox?.metadata?.annotations || {}
  return Boolean(annotations[BACKUP_LOCK_ID_ANNOTATION])
}

export function buildRestorePatch(currentSandbox, snapshotTemplate, {
  checkpointId,
  backupId,
  requestId,
  requestedAt
}) {
  const patch = []
  const annotations = currentSandbox?.metadata?.annotations || {}
  if (!currentSandbox?.metadata?.annotations) {
    patch.push({ op: 'add', path: '/metadata/annotations', value: {} })
  } else if (Object.prototype.hasOwnProperty.call(annotations, RESTORE_FROM_ANNOTATION)) {
    patch.push({
      op: 'remove',
      path: `/metadata/annotations/${escapeJsonPointer(RESTORE_FROM_ANNOTATION)}`
    })
  }
  for (const [key, value] of Object.entries({
    [RESTORE_BACKUP_ID_ANNOTATION]: backupId,
    [RESTORE_REQUEST_ID_ANNOTATION]: requestId,
    [RESTORE_REQUESTED_AT_ANNOTATION]: requestedAt
  })) {
    patch.push({
      op: getAnnotationPatchOp({ annotations }, key),
      path: `/metadata/annotations/${escapeJsonPointer(key)}`,
      value
    })
  }
  patch.push({
    op: currentSandbox?.spec ? 'replace' : 'add',
    path: '/spec',
    value: buildRestoreSpec(snapshotTemplate.spec, checkpointId, currentSandbox?.spec)
  })
  return patch
}
