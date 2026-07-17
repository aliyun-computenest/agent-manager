import { createHash } from 'crypto'
import { isDeepStrictEqual } from 'util'

const CLAIMED_LABEL = 'agents.kruise.io/sandbox-claimed'
const POOL_LABEL = 'agents.kruise.io/sandbox-pool'
const UPDATE_OPS_LABEL = 'agents.kruise.io/update-ops'
const UPGRADE_ID_LABEL = 'openclaw.io/upgrade-id'
const ORIGINAL_TARGET_ANNOTATION = 'openclaw.io/original-target'
const REQUIRED_BACKUP_RESTORE_RUNTIMES = ['agent-runtime', 'csi']
const MATCH_EXPRESSION_OPERATORS = new Set(['In', 'NotIn', 'Exists', 'DoesNotExist'])
const FAILED_UPGRADE_REASONS = new Set(['PreUpgradeFailed', 'UpgradePodFailed', 'PostUpgradeFailed'])
const ACTIVE_UPGRADE_REASONS = new Set(['PreUpgrade', 'UpgradePod', 'PostUpgrade'])
const CONTAINER_PATCH_FIELDS = [
  'command',
  'args',
  'env',
  'resources',
  'ports',
  'startupProbe',
  'readinessProbe',
  'livenessProbe',
  'volumeMounts'
]
const POD_PATCH_FIELDS = [
  'volumes',
  'automountServiceAccountToken',
  'enableServiceLinks',
  'hostname'
]
const EMPTY_COMPLETED_HISTORY_GRACE_MS = 30_000
const CONTAINER_PATCH_FIELD_MERGE_KEYS = {
  env: 'name',
  ports: 'containerPort',
  volumeMounts: 'mountPath'
}
const POD_PATCH_FIELD_MERGE_KEYS = {
  volumes: 'name'
}

function validationError(message) {
  const error = new Error(message)
  error.httpStatus = 400
  return error
}

function requireString(value, field) {
  if (!value || typeof value !== 'string') {
    throw validationError(`${field} is required`)
  }
  return value
}

function labelValue(value) {
  return String(value)
    .replace(/[^A-Za-z0-9_.-]/g, '-')
    .slice(0, 63)
    .replace(/^-+|-+$/g, '') || 'unknown'
}

function hashClientToken(token) {
  return createHash('sha256').update(String(token)).digest('hex').slice(0, 32)
}

function hashRequestBody(body) {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

function createUpgradeId(clientToken, scope = '') {
  return `sbu-${hashClientToken(`${scope}:${clientToken}`).slice(0, 12)}`
}

function validateTimeoutSeconds(value) {
  const normalized = value ?? 60
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw validationError('timeoutSeconds must be a positive integer')
  }
  return normalized
}

function validateMaxUnavailable(value) {
  if (Number.isInteger(value) && value > 0) return value
  if (typeof value === 'string' && /^([1-9]\d?|100)%$/.test(value)) return value
  throw validationError('maxUnavailable must be a positive integer or percentage from 1% to 100%')
}

function normalizeLifecycleMode(value = 'Full') {
  if (value === 'Full' || value === 'PostOnly' || value === 'PatchOnly') return value
  throw validationError('lifecycleMode must be Full, PostOnly, or PatchOnly')
}

function normalizeCommand(command, field) {
  if (!Array.isArray(command) || command.length === 0 || command.some(item => typeof item !== 'string' || item.length === 0)) {
    throw validationError(`${field}.command must be a non-empty string array`)
  }
  return command
}

function normalizeUpgradeMetadata(metadata = {}) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw validationError('upgrade_metadata must be an object')
  }

  return {
    timeoutSeconds: validateTimeoutSeconds(metadata.timeoutSeconds),
    preUpgrade: {
      command: normalizeCommand(metadata.preUpgrade?.command, 'preUpgrade')
    },
    postUpgrade: {
      command: normalizeCommand(metadata.postUpgrade?.command, 'postUpgrade')
    }
  }
}

function normalizeUpgradeMetadataForLifecycle(metadata = {}, lifecycleMode = 'Full') {
  const normalizedLifecycleMode = normalizeLifecycleMode(lifecycleMode)
  if (normalizedLifecycleMode === 'PatchOnly') return null
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw validationError('upgrade_metadata must be an object')
  }

  const result = {
    timeoutSeconds: validateTimeoutSeconds(metadata.timeoutSeconds)
  }

  if (normalizedLifecycleMode === 'Full') {
    result.preUpgrade = {
      command: normalizeCommand(metadata.preUpgrade?.command, 'preUpgrade')
    }
  }

  result.postUpgrade = {
    command: normalizeCommand(metadata.postUpgrade?.command, 'postUpgrade')
  }

  return result
}

function normalizeMatchLabels(matchLabels = {}) {
  if (!matchLabels || typeof matchLabels !== 'object' || Array.isArray(matchLabels)) {
    throw validationError('selector.matchLabels must be an object')
  }
  return Object.fromEntries(Object.entries(matchLabels).map(([key, value]) => {
    requireString(key, 'selector.matchLabels key')
    if (typeof value !== 'string') {
      throw validationError(`selector.matchLabels.${key} must be a string`)
    }
    return [key, value]
  }))
}

function normalizeMatchExpressions(matchExpressions = []) {
  if (!Array.isArray(matchExpressions)) {
    throw validationError('selector.matchExpressions must be an array')
  }
  return matchExpressions.map((expression, index) => {
    if (!expression || typeof expression !== 'object' || Array.isArray(expression)) {
      throw validationError(`selector.matchExpressions[${index}] must be an object`)
    }

    const key = requireString(expression.key, `selector.matchExpressions[${index}].key`)
    const operator = requireString(expression.operator, `selector.matchExpressions[${index}].operator`)
    if (!MATCH_EXPRESSION_OPERATORS.has(operator)) {
      throw validationError(`selector.matchExpressions[${index}].operator must be In, NotIn, Exists, or DoesNotExist`)
    }

    if (operator === 'In' || operator === 'NotIn') {
      if (!Array.isArray(expression.values) || expression.values.length === 0 || expression.values.some(value => typeof value !== 'string')) {
        throw validationError(`selector.matchExpressions[${index}].values must be a non-empty string array`)
      }
      return { key, operator, values: expression.values }
    }

    if (expression.values !== undefined && (!Array.isArray(expression.values) || expression.values.length > 0)) {
      throw validationError(`selector.matchExpressions[${index}].values must be empty for ${operator}`)
    }
    return { key, operator }
  })
}

function normalizeSelector(selector = {}) {
  if (!selector || typeof selector !== 'object' || Array.isArray(selector)) {
    throw validationError('selector must be an object')
  }
  const matchExpressions = normalizeMatchExpressions(selector.matchExpressions || [])
  const normalized = {
    matchLabels: normalizeMatchLabels(selector.matchLabels || {}),
  }
  if (matchExpressions.length > 0) {
    normalized.matchExpressions = matchExpressions
  }
  return normalized
}

function normalizeTarget({ target, selector }) {
  if (!target && selector) {
    return {
      type: 'LabelSelector',
      selector: normalizeSelector(selector)
    }
  }

  if (!target) {
    return {
      type: 'LabelSelector',
      selector: normalizeSelector()
    }
  }

  if (target.type === 'SelectedSandboxes') {
    if (!Array.isArray(target.sandboxNames) || target.sandboxNames.length === 0) {
      throw validationError('target.sandboxNames is required')
    }
    return {
      type: 'SelectedSandboxes',
      sandboxNames: [...new Set(target.sandboxNames.map(name => requireString(name, 'sandboxName')))].sort()
    }
  }

  if (target.type === 'LabelSelector') {
    return {
      type: 'LabelSelector',
      selector: normalizeSelector(target.selector)
    }
  }

  throw validationError('target.type must be SelectedSandboxes or LabelSelector')
}

function shouldPatchUpgradeIdLabel(target) {
  return target?.type === 'SelectedSandboxes'
}

function buildOriginalTargetAnnotation(target) {
  return JSON.stringify(normalizeTarget({ target }))
}

function parseOriginalTargetAnnotation(item) {
  const raw = item?.metadata?.annotations?.[ORIGINAL_TARGET_ANNOTATION]
  if (!raw) return null
  try {
    return normalizeTarget({ target: JSON.parse(raw) })
  } catch (_) {
    return null
  }
}

function getTargetSandboxNamesFromAnnotations(item) {
  const raw = item?.metadata?.annotations?.['openclaw.io/target-sandbox-names']
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter(name => typeof name === 'string' && name.length > 0))].sort()
      : []
  } catch (_) {
    return []
  }
}

function removeUpgradeIdLabelFromSelector(selector = {}) {
  const matchLabels = { ...(selector.matchLabels || {}) }
  delete matchLabels[UPGRADE_ID_LABEL]
  return normalizeSelector({
    matchLabels,
    matchExpressions: selector.matchExpressions || []
  })
}

function failedSandboxNames(failedSandboxes = []) {
  return [...new Set((failedSandboxes || [])
    .filter(isFailedUpgradeSandbox)
    .map(item => item.SandboxName)
    .filter(Boolean))]
    .sort()
}

function getRetryTargetFromSandboxUpdateOps(item, failedSandboxes = []) {
  const failedNames = failedSandboxNames(failedSandboxes)
  if (failedNames.length > 0) {
    return {
      type: 'SelectedSandboxes',
      sandboxNames: failedNames
    }
  }

  const originalTarget = parseOriginalTargetAnnotation(item)
  if (originalTarget?.type === 'LabelSelector') {
    return originalTarget
  }

  if (originalTarget?.type === 'SelectedSandboxes') {
    return originalTarget
  }

  const targetType = item?.metadata?.annotations?.['openclaw.io/target-type']
  if (targetType === 'LabelSelector') {
    return {
      type: 'LabelSelector',
      selector: removeUpgradeIdLabelFromSelector(item?.spec?.selector || {})
    }
  }

  const snapshotNames = getTargetSandboxNamesFromAnnotations(item)
  if (snapshotNames.length > 0) {
    return {
      type: 'SelectedSandboxes',
      sandboxNames: snapshotNames
    }
  }

  throw validationError('failed upgrade does not have retryable target information')
}

function hasUpgradeBeforeFailure(failedSandboxes = []) {
  return (failedSandboxes || []).some(item => {
    const text = [
      item?.ConditionType,
      item?.Reason,
      item?.Message
    ].filter(Boolean).join(' ')
    return /pre[-\s]?upgrade|before[-\s]?upgrade|升级前/i.test(text)
  })
}

function getRetryLifecycleMode(item, failedSandboxes = []) {
  const previousMode = item?.metadata?.annotations?.['openclaw.io/lifecycle-mode']
  if (previousMode === 'PatchOnly') return 'PatchOnly'
  if (previousMode === 'PostOnly') return 'PostOnly'
  const statusConditions = (item?.status?.conditions || []).map(condition => ({
    ConditionType: condition?.type,
    Reason: condition?.reason,
    Message: condition?.message
  }))
  return hasUpgradeBeforeFailure([...failedSandboxes, ...statusConditions]) ? 'Full' : 'PostOnly'
}

function buildBaseSelectorFromSandboxSet(sandboxSet) {
  const sandboxSetName = requireString(sandboxSet?.metadata?.name, 'sandboxSet.metadata.name')
  const templateLabels = sandboxSet?.spec?.template?.metadata?.labels || {}
  return {
    matchLabels: {
      ...templateLabels,
      [POOL_LABEL]: sandboxSetName,
      [CLAIMED_LABEL]: 'true'
    }
  }
}

function mergeSelectors(...selectors) {
  const matchLabels = {}
  const matchExpressions = []
  for (const selector of selectors) {
    for (const [key, value] of Object.entries(selector?.matchLabels || {})) {
      if (Object.prototype.hasOwnProperty.call(matchLabels, key) && matchLabels[key] !== value) {
        throw validationError(`selector.matchLabels.${key} conflicts with required selector`)
      }
      matchLabels[key] = value
    }
    matchExpressions.push(...(selector?.matchExpressions || []))
  }
  return normalizeSelector({ matchLabels, matchExpressions })
}

function buildEffectiveSelector({ sandboxSet, target, upgradeId }) {
  const baseSelector = buildBaseSelectorFromSandboxSet(sandboxSet)
  if (!target || target.type === 'LabelSelector') {
    return mergeSelectors(baseSelector, target?.selector)
  }
  return mergeSelectors(baseSelector, {
    matchLabels: {
      [UPGRADE_ID_LABEL]: upgradeId
    }
  })
}

function getPatchContainersFromSandboxSet(sandboxSet) {
  const containers = sandboxSet?.spec?.template?.spec?.containers || []
  return containers.map(container => ({
    name: requireString(container.name, 'container.name'),
    image: requireString(container.image, `container ${container.name}.image`)
  }))
}

function hasOwnProperty(item, field) {
  return Object.prototype.hasOwnProperty.call(item || {}, field)
}

function getSandboxTemplateSpec(sandbox) {
  return sandbox?.spec?.template?.spec || {}
}

function getContainerByName(templateSpec, name) {
  return (templateSpec?.containers || []).find(container => container?.name === name) || null
}

function hasChangedFieldAcrossSandboxes(targetValue, sandboxes, getCurrentValue) {
  if (!Array.isArray(sandboxes) || sandboxes.length === 0) return false
  return sandboxes.some(sandbox => !isDeepStrictEqual(getCurrentValue(sandbox), targetValue))
}

function getSandboxListOptionsForTarget(target) {
  return target?.type === 'LabelSelector' ? { limit: 1 } : {}
}

function getPatchSampleSandboxesForTarget(target, sandboxes = []) {
  const items = Array.isArray(sandboxes) ? sandboxes : []
  return target?.type === 'LabelSelector' ? items.slice(0, 1) : items
}

function getMergeKeyValue(item, mergeKey) {
  if (!item || !hasOwnProperty(item, mergeKey)) return null
  return item[mergeKey]
}

function withStrategicMergeDeleteDirectives(targetValue, sandboxes, getCurrentValue, mergeKey) {
  if (!mergeKey || !Array.isArray(targetValue) || !Array.isArray(sandboxes) || sandboxes.length === 0) {
    return targetValue
  }

  const targetKeys = new Set(targetValue
    .map(item => getMergeKeyValue(item, mergeKey))
    .filter(value => value !== null && value !== undefined)
    .map(value => String(value)))
  const deletedKeys = new Set()
  const deletions = []

  for (const sandbox of sandboxes) {
    const currentValue = getCurrentValue(sandbox)
    if (!Array.isArray(currentValue)) continue
    for (const item of currentValue) {
      const mergeKeyValue = getMergeKeyValue(item, mergeKey)
      if (mergeKeyValue === null || mergeKeyValue === undefined) continue
      const key = String(mergeKeyValue)
      if (targetKeys.has(key) || deletedKeys.has(key)) continue
      deletedKeys.add(key)
      deletions.push({ [mergeKey]: mergeKeyValue, $patch: 'delete' })
    }
  }

  return deletions.length > 0 ? [...targetValue, ...deletions] : targetValue
}

function buildSandboxUpdatePatchFromSandboxSet(sandboxSet, sandboxes = []) {
  const targetSpec = sandboxSet?.spec?.template?.spec || {}
  const targetContainers = targetSpec.containers || []
  const containers = targetContainers.map(targetContainer => {
    const name = requireString(targetContainer.name, 'container.name')
    const patchContainer = {
      name,
      image: requireString(targetContainer.image, `container ${name}.image`)
    }

    for (const field of CONTAINER_PATCH_FIELDS) {
      if (!hasOwnProperty(targetContainer, field)) continue
      const changed = hasChangedFieldAcrossSandboxes(
        targetContainer[field],
        sandboxes,
        sandbox => getContainerByName(getSandboxTemplateSpec(sandbox), name)?.[field]
      )
      if (changed) {
        patchContainer[field] = withStrategicMergeDeleteDirectives(
          targetContainer[field],
          sandboxes,
          sandbox => getContainerByName(getSandboxTemplateSpec(sandbox), name)?.[field],
          CONTAINER_PATCH_FIELD_MERGE_KEYS[field]
        )
      }
    }

    return patchContainer
  })

  const patchSpec = { containers }
  for (const field of POD_PATCH_FIELDS) {
    if (!hasOwnProperty(targetSpec, field)) continue
    const changed = hasChangedFieldAcrossSandboxes(
      targetSpec[field],
      sandboxes,
      sandbox => getSandboxTemplateSpec(sandbox)?.[field]
    )
    if (changed) {
      patchSpec[field] = withStrategicMergeDeleteDirectives(
        targetSpec[field],
        sandboxes,
        sandbox => getSandboxTemplateSpec(sandbox)?.[field],
        POD_PATCH_FIELD_MERGE_KEYS[field]
      )
    }
  }

  return { spec: patchSpec }
}

function getSandboxSetBackupRestoreCapability(sandboxSet) {
  const runtimes = Array.isArray(sandboxSet?.spec?.runtimes) ? sandboxSet.spec.runtimes : []
  const runtimeNames = new Set(runtimes
    .map(runtime => runtime?.name)
    .filter(name => typeof name === 'string' && name.length > 0))
  const missingRuntimes = REQUIRED_BACKUP_RESTORE_RUNTIMES.filter(name => !runtimeNames.has(name))
  const supported = missingRuntimes.length === 0
  return {
    Supported: supported,
    RequiredRuntimes: REQUIRED_BACKUP_RESTORE_RUNTIMES,
    MissingRuntimes: missingRuntimes,
    Message: supported
      ? null
      : `SandboxSet must define spec.runtimes entries named ${missingRuntimes.join(', ')} to support backup and restore`
  }
}

function buildUpgradeLifecycle(upgradeMetadata, lifecycleMode = 'Full') {
  const normalizedLifecycleMode = normalizeLifecycleMode(lifecycleMode)
  if (normalizedLifecycleMode === 'PatchOnly') return null

  const metadata = normalizeUpgradeMetadataForLifecycle(upgradeMetadata, normalizedLifecycleMode)
  const lifecycle = {}
  if (normalizedLifecycleMode === 'Full') {
    lifecycle.preUpgrade = {
      exec: {
        command: metadata.preUpgrade.command
      },
      timeoutSeconds: metadata.timeoutSeconds
    }
  }
  if (normalizedLifecycleMode === 'Full' || normalizedLifecycleMode === 'PostOnly') {
    lifecycle.postUpgrade = {
      exec: {
        command: metadata.postUpgrade.command
      },
      timeoutSeconds: metadata.timeoutSeconds
    }
  }
  return Object.keys(lifecycle).length > 0 ? lifecycle : null
}

function buildSandboxUpdateOps({
  upgradeId,
  namespace,
  agentTypeId,
  sandboxSet,
  selector,
  maxUnavailable,
  clientTokenHash,
  upgradeMetadata,
  lifecycleMode = 'Full',
  sandboxes = []
}) {
  const normalizedLifecycleMode = normalizeLifecycleMode(lifecycleMode)
  const sandboxSetName = requireString(sandboxSet?.metadata?.name, 'sandboxSet.metadata.name')
  const lifecycle = buildUpgradeLifecycle(upgradeMetadata, normalizedLifecycleMode)

  const manifest = {
    apiVersion: 'agents.kruise.io/v1alpha1',
    kind: 'SandboxUpdateOps',
    metadata: {
      name: requireString(upgradeId, 'upgradeId'),
      namespace: requireString(namespace, 'namespace'),
      annotations: {},
      labels: {
        'openclaw.io/agent-type-id': labelValue(requireString(agentTypeId, 'agentTypeId')),
        'openclaw.io/sandbox-set': labelValue(sandboxSetName),
        'openclaw.io/client-token-hash': labelValue(requireString(clientTokenHash, 'clientTokenHash'))
      }
    },
    spec: {
      paused: false,
      selector: normalizeSelector(selector),
      updateStrategy: {
        maxUnavailable: validateMaxUnavailable(maxUnavailable)
      },
      patch: buildSandboxUpdatePatchFromSandboxSet(sandboxSet, sandboxes)
    }
  }

  if (lifecycle) {
    manifest.spec.lifecycle = lifecycle
  }
  return manifest
}

function isFailedUpgradeSandbox(detail) {
  const reason = detail?.Reason || detail?.reason || ''
  const message = detail?.Message || detail?.message || ''
  return FAILED_UPGRADE_REASONS.has(reason)
    || /(^|[^A-Za-z])(?:PreUpgradeFailed|UpgradePodFailed|PostUpgradeFailed)([^A-Za-z]|$)/.test(message)
    || /CrashLoopBackOff|ImagePullBackOff|ErrImagePull|hook execution error|restarting failed container/i.test(message)
    || (detail?.ConditionStatus === 'False' && !ACTIVE_UPGRADE_REASONS.has(reason))
}

function isUpdatingUpgradeSandbox(detail) {
  return detail?.Phase === 'Upgrading' && !isFailedUpgradeSandbox(detail)
}

function isUpdatedUpgradeSandbox(detail) {
  return detail?.Phase === 'Running'
    && detail?.ConditionType === 'Upgrading'
    && detail?.ConditionStatus === 'True'
    && !isFailedUpgradeSandbox(detail)
}

function progressFromStatus(status = {}) {
  return {
    Replicas: status.replicas || 0,
    UpdatedReplicas: status.updatedReplicas || 0,
    UpdatingReplicas: status.updatingReplicas || 0,
    FailedReplicas: status.failedReplicas || 0
  }
}

function readNonNegativeAnnotationInt(item, key) {
  const raw = item?.metadata?.annotations?.[key]
  if (raw === undefined || raw === null || raw === '') return null
  const value = Number.parseInt(raw, 10)
  return Number.isInteger(value) && value >= 0 ? value : null
}

function isRecentCreationTimestamp(value) {
  if (!value) return false
  const createdAt = Date.parse(value)
  if (!Number.isFinite(createdAt)) return false
  return Date.now() - createdAt < EMPTY_COMPLETED_HISTORY_GRACE_MS
}

function progressFromHistoryAnnotations(item, rawPhase, fallback = {}) {
  const hasStatusCounts = (fallback.Replicas || 0) > 0
    || (fallback.UpdatedReplicas || 0) > 0
    || (fallback.UpdatingReplicas || 0) > 0
    || (fallback.FailedReplicas || 0) > 0
  if (hasStatusCounts) return fallback

  const total = readNonNegativeAnnotationInt(item, 'openclaw.io/matched-sandbox-count')
    ?? readNonNegativeAnnotationInt(item, 'openclaw.io/selected-sandbox-count')
    ?? getTargetSandboxNamesFromAnnotations(item).length
  if (!total) return fallback

  if (rawPhase === 'Completed' && isRecentCreationTimestamp(item?.metadata?.creationTimestamp)) {
    return {
      Replicas: total,
      UpdatedReplicas: 0,
      UpdatingReplicas: 0,
      FailedReplicas: 0
    }
  }

  if (rawPhase === 'Completed') {
    return {
      Replicas: total,
      UpdatedReplicas: total,
      UpdatingReplicas: 0,
      FailedReplicas: 0
    }
  }

  return {
    ...fallback,
    Replicas: total
  }
}

function progressFromUpgradeSandboxes(sandboxes = [], fallback = {}) {
  if (!Array.isArray(sandboxes) || sandboxes.length === 0) return fallback
  const updatedSandboxes = sandboxes.filter(isUpdatedUpgradeSandbox)
  const updatingSandboxes = sandboxes.filter(isUpdatingUpgradeSandbox)
  const failedSandboxes = sandboxes.filter(isFailedUpgradeSandbox)
  if (updatedSandboxes.length === 0 && updatingSandboxes.length === 0 && failedSandboxes.length === 0) {
    return fallback
  }
  return {
    Replicas: sandboxes.length,
    UpdatedReplicas: updatedSandboxes.length,
    UpdatingReplicas: updatingSandboxes.length,
    FailedReplicas: failedSandboxes.length
  }
}

function deriveSandboxUpdateOpsPhase(rawPhase, progress) {
  if (progress.FailedReplicas > 0 && progress.UpdatingReplicas === 0) return 'Failed'
  if (progress.Replicas > 0 && progress.UpdatedReplicas === progress.Replicas) return 'Completed'
  if (rawPhase === 'Completed' && progress.Replicas > 0) {
    return progress.UpdatingReplicas > 0 ? 'Updating' : 'Pending'
  }
  return rawPhase || 'Pending'
}

function canRepairSandboxUpdateOps(item, sandboxes = []) {
  const rawPhase = item?.status?.phase || 'Pending'
  const progress = progressFromUpgradeSandboxes(sandboxes, progressFromStatus(item?.status || {}))
  if (rawPhase === 'Failed') return true
  if (rawPhase !== 'Updating') return false
  return progress.FailedReplicas > 0 && progress.UpdatingReplicas === 0
}

function summarizeSandboxUpdateOps(item, sandboxes = []) {
  const status = item?.status || {}
  const rawPhase = status.phase || 'Pending'
  const statusProgress = progressFromStatus(status)
  const annotatedProgress = progressFromHistoryAnnotations(item, rawPhase, statusProgress)
  const progress = progressFromUpgradeSandboxes(sandboxes, annotatedProgress)
  return {
    UpgradeId: item?.metadata?.name,
    Phase: deriveSandboxUpdateOpsPhase(rawPhase, progress),
    RawPhase: rawPhase,
    Progress: progress,
    Retryable: canRepairSandboxUpdateOps(item, sandboxes),
    MaxUnavailable: item?.spec?.updateStrategy?.maxUnavailable,
    CreatedAt: item?.metadata?.creationTimestamp,
    Selector: item?.spec?.selector,
    Conditions: status.conditions || []
  }
}

function getSandboxUpgradeCondition(sandbox) {
  const conditions = sandbox?.status?.conditions || []
  return conditions.find(item => item.type === 'Upgrading')
    || conditions.find(item => item.status === 'False')
    || conditions[conditions.length - 1]
    || null
}

function getUpgradeSandboxes(sandboxes, upgradeId, { allowLabelMismatch = false } = {}) {
  return (sandboxes || [])
    .filter(sandbox => allowLabelMismatch || sandbox?.metadata?.labels?.[UPDATE_OPS_LABEL] === upgradeId)
    .map(sandbox => {
      const condition = getSandboxUpgradeCondition(sandbox)
      return {
        SandboxName: sandbox.metadata.name,
        PodName: sandbox.metadata.name,
        PodIP: sandbox.status?.podInfo?.podIP || sandbox.status?.sandboxIp || null,
        NodeName: sandbox.status?.nodeName || null,
        Phase: sandbox.status?.phase || null,
        ConditionType: condition?.type || null,
        ConditionStatus: condition?.status || null,
        Reason: condition?.reason || sandbox.status?.message || null,
        Message: condition?.message || sandbox.status?.message || '',
        LastTransitionTime: condition?.lastTransitionTime || null,
        CreatedAt: sandbox.metadata.creationTimestamp || null,
        MatchedBySnapshot: sandbox?.metadata?.labels?.[UPDATE_OPS_LABEL] !== upgradeId
      }
    })
}

function getFailedSandboxes(sandboxes, upgradeId) {
  return getUpgradeSandboxes(sandboxes, upgradeId)
    .filter(isFailedUpgradeSandbox)
    .filter(item => item.Reason || item.Message)
}

function getBlockingSandboxUpdateOps(items = []) {
  // Failed ops are intentionally blocking until they are repaired or deleted,
  // because they may leave selected Sandboxes partially labeled or recovered.
  return (items || []).find(item => item?.status?.phase !== 'Completed') || null
}

export {
  CLAIMED_LABEL,
  ORIGINAL_TARGET_ANNOTATION,
  POOL_LABEL,
  UPDATE_OPS_LABEL,
  UPGRADE_ID_LABEL,
  buildBaseSelectorFromSandboxSet,
  buildEffectiveSelector,
  buildOriginalTargetAnnotation,
  buildSandboxUpdateOps,
  buildSandboxUpdatePatchFromSandboxSet,
  buildUpgradeLifecycle,
  canRepairSandboxUpdateOps,
  createUpgradeId,
  getBlockingSandboxUpdateOps,
  getFailedSandboxes,
  getUpgradeSandboxes,
  getPatchContainersFromSandboxSet,
  isFailedUpgradeSandbox,
  getRetryLifecycleMode,
  getRetryTargetFromSandboxUpdateOps,
  getPatchSampleSandboxesForTarget,
  getSandboxListOptionsForTarget,
  getSandboxSetBackupRestoreCapability,
  hashClientToken,
  hashRequestBody,
  labelValue,
  normalizeLifecycleMode,
  normalizeSelector,
  normalizeTarget,
  normalizeUpgradeMetadata,
  normalizeUpgradeMetadataForLifecycle,
  shouldPatchUpgradeIdLabel,
  summarizeSandboxUpdateOps,
  validateMaxUnavailable,
  validateTimeoutSeconds
}
