import { randomUUID } from 'crypto'
import { createKubernetesApi, getSandboxNamespace } from '../kubernetes-api.js'
import { buildCheckpointBackupScheduleWrapperTemplateContent } from './schedule-wrapper.js'
import {
  BACKUP_ID_LABEL,
  BACKUP_KIND_LABEL,
  MANAGED_BY_LABEL,
  SOURCE_INSTANCE_ID_LABEL,
  formatBackupTimestamp,
  getRetentionCount
} from './constants.js'
import {
  buildBackupItem,
  buildSnapshotIndex,
  getSandboxTargetFromInstance,
  isNotFoundError
} from './resources.js'
import {
  limitPage,
  normalizeExecution,
  normalizeRecord
} from './oos-records.js'
import {
  buildCloneSandbox,
  buildRestorePatch,
  buildRestoreSandbox,
  isSandboxBusy
} from './restore-builder.js'
import { getSandboxTemplateAgentImage } from './sandbox-image.js'
import {
  createOosClient,
  getOosErrorMessage,
  resolveCheckpointBackupOosConfig
} from './oos.js'

export class CheckpointBackupError extends Error {
  constructor(message, status = 500, code = 'CHECKPOINT_BACKUP_ERROR') {
    super(message)
    this.name = 'CheckpointBackupError'
    this.status = status
    this.code = code
  }
}

export { getSandboxTargetFromInstance } from './resources.js'

async function getCheckpointBackupOosClient(oosClient = null, { oosRegionId = null } = {}) {
  if (oosClient) return oosClient
  try {
    return await createOosClient({ oosRegionId })
  } catch (error) {
    throw new CheckpointBackupError(`Failed to initialize OOS checkpoint backup client: ${getOosErrorMessage(error)}`, error.httpStatus || 502, 'OOS_UNAVAILABLE')
  }
}

function getClusterApi(_instance, _namespace) {
  return createKubernetesApi()
}

function createBackupId(instanceId, now = new Date()) {
  const prefix = String(instanceId || 'instance').slice(0, 8).toLowerCase()
  const suffix = randomUUID().replace(/-/g, '').slice(0, 8)
  return `ocb-${prefix}-${formatBackupTimestamp(now)}-${suffix}`
}

function createBackupRunId(instanceId) {
  return `manual-${String(instanceId || 'instance').slice(0, 8)}-${Date.now().toString(36)}`
}

function createExecutionBackupRunId(runMode) {
  const prefix = runMode === 'scheduled' ? 'scheduled' : 'admin'
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().replace(/-/g, '').slice(0, 8)}`
}

function createExecutionDescription({ runMode, scope, retentionCount, scheduleExpression }) {
  return [
    'Agent Manager checkpoint backup via ACS::Kubectl',
    `runMode=${runMode}`,
    `scope=${scope}`,
    `retentionCount=${getRetentionCount(retentionCount)}`,
    runMode === 'scheduled' && scheduleExpression ? `cronExpression=${scheduleExpression}` : ''
  ].filter(Boolean).join('; ').slice(0, 1024)
}

function normalizeBackupPrefix(instanceId) {
  return String(instanceId || 'instance')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 16) || 'instance'
}

function createScheduledCheckpointBackupIdPrefix(instanceId) {
  return `ocb-${normalizeBackupPrefix(instanceId)}`
}

function normalizeScheduleExpression(value) {
  const expression = String(value || '').trim()
  const cronMatch = expression.match(/^cron\((.*)\)$/)
  const normalized = cronMatch ? cronMatch[1].trim() : expression
  const parts = normalized.split(/\s+/).filter(Boolean)
  if (parts.length === 7) return parts.slice(0, 6).join(' ')
  return normalized
}

function pruneEmptyParameters(parameters) {
  return Object.fromEntries(Object.entries(parameters).filter(([, value]) => value !== undefined && value !== null))
}

function createPublicTemplateTargets(executionTargets) {
  return executionTargets.map(item => {
    const target = item.target || item
    return {
      namespace: target.namespace || '',
      instanceId: target.instanceId,
      sandboxName: target.sandboxName,
      backupId: target.backupId || '',
      backupIdPrefix: target.backupIdPrefix || target.backupId || `${createScheduledCheckpointBackupIdPrefix(target.instanceId)}-`
    }
  })
}

function createOosExecutionParameters(oosConfig, namespace, {
  runMode = 'immediate',
  scope = 'all',
  retentionCount = 5,
  backupRunId = '',
  backupIdSuffix,
  targets = [],
  rateControl = { Mode: 'Concurrency', MaxErrors: '100%', Concurrency: 5 }
} = {}) {
  return pruneEmptyParameters({
    ClusterId: oosConfig.clusterId,
    RegionId: oosConfig.clusterRegionId,
    Namespace: namespace,
    RunMode: runMode,
    Scope: scope,
    RetentionCount: getRetentionCount(retentionCount),
    BackupRunId: backupRunId,
    ...(backupIdSuffix !== undefined ? { BackupIdSuffix: backupIdSuffix } : {}),
    Targets: createPublicTemplateTargets(targets),
    RateControl: rateControl,
    ...(oosConfig.oosAssumeRole ? { OOSAssumeRole: oosConfig.oosAssumeRole } : {})
  })
}

function createScheduleWrapperParameters(oosConfig, selectedTemplate, templateParameters, {
  scheduleExpression,
  timeZone = 'Asia/Shanghai',
  endDate = '2099-12-31T23:59:59Z'
} = {}) {
  return pruneEmptyParameters({
    timerTrigger: {
      type: 'cron',
      expression: normalizeScheduleExpression(scheduleExpression),
      timeZone: timeZone || 'Asia/Shanghai',
      endDate: endDate || '2099-12-31T23:59:59Z'
    },
    templateName: selectedTemplate.templateName,
    templateParameters,
    ...(oosConfig.oosAssumeRole ? { OOSAssumeRole: oosConfig.oosAssumeRole } : {})
  })
}

function normalizeRunMode(value) {
  if (value === 'immediate' || value === 'scheduled') return value
  throw new CheckpointBackupError('runMode must be immediate or scheduled', 400, 'INVALID_RUN_MODE')
}

function selectCheckpointBackupOosTemplate(oosConfig) {
  return {
    templateName: oosConfig.oosTemplateName,
    templateVersion: oosConfig.oosTemplateVersion
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForSandboxDeleted(api, namespace, sandboxName, {
  timeoutMs = 120000,
  intervalMs = 1000
} = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await api.getSandbox(namespace, sandboxName)
    } catch (error) {
      if (error?.httpStatus === 404 || error?.status === 404 || error?.code === 404) return
      throw error
    }
    await sleep(intervalMs)
  }
  throw new CheckpointBackupError(`Timed out waiting for Sandbox ${sandboxName} to be deleted`, 504, 'K8S_DELETE_TIMEOUT')
}

async function applyRestoreSandbox(api, namespace, sandboxName, sandbox, snapshotTemplate, restoreContext) {
  if (typeof api.deleteSandbox === 'function' && typeof api.createSandbox === 'function') {
    const body = buildRestoreSandbox(sandbox, snapshotTemplate, {
      ...restoreContext,
      namespace,
      sandboxName
    })
    await api.deleteSandbox(namespace, sandboxName)
    await waitForSandboxDeleted(api, namespace, sandboxName)
    await api.createSandbox(namespace, body)
    return
  }

  const patch = buildRestorePatch(sandbox, snapshotTemplate, restoreContext)
  await api.patchSandbox(namespace, sandboxName, patch)
}

async function readCurrentSandbox(instance, namespace, api) {
  const sandboxTarget = getSandboxTargetFromInstance(instance, namespace)
  const { sandboxName } = sandboxTarget
  if (!sandboxName) {
    throw new CheckpointBackupError('Instance has no Sandbox yet', 409, 'SANDBOX_NOT_READY')
  }
  try {
    return {
      namespace: sandboxTarget.namespace,
      sandboxName,
      sandbox: await api.getSandbox(sandboxTarget.namespace, sandboxName)
    }
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new CheckpointBackupError(`Sandbox ${sandboxName} not found`, 409, 'SANDBOX_NOT_READY')
    }
    throw new CheckpointBackupError(`Failed to read Sandbox ${sandboxName}: ${error.message}`, error.httpStatus || 502, 'K8S_UNAVAILABLE')
  }
}

async function listBackupItems(instance, {
  limit = 50,
  namespace = getSandboxNamespace(),
  api = null
} = {}) {
  const sandboxTarget = getSandboxTargetFromInstance(instance, namespace)
  const clusterApi = api || getClusterApi(instance, sandboxTarget.namespace)
  const selector = {
    matchLabels: {
      [MANAGED_BY_LABEL]: 'agent-manager',
      [BACKUP_KIND_LABEL]: 'checkpoint',
      [SOURCE_INSTANCE_ID_LABEL]: instance.id
    }
  }

  let checkpoints
  try {
    checkpoints = await clusterApi.listCheckpoints(sandboxTarget.namespace, selector)
  } catch (error) {
    throw new CheckpointBackupError(`Failed to list checkpoint backups: ${error.message}`, error.httpStatus || 502, 'K8S_UNAVAILABLE')
  }

  let snapshotIndex = null
  try {
    snapshotIndex = await buildSnapshotIndex(instance, clusterApi, sandboxTarget.namespace)
  } catch (error) {
    throw new CheckpointBackupError(`Failed to list checkpoint snapshots: ${error.message}`, error.httpStatus || 502, 'K8S_UNAVAILABLE')
  }

  const items = await Promise.all((checkpoints?.items || []).map(checkpoint =>
    buildBackupItem(checkpoint, clusterApi, sandboxTarget.namespace, snapshotIndex)
  ))

  return items
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, limit)
}

export async function startInstanceCheckpointBackup(instance, {
  namespace = getSandboxNamespace(),
  api = null,
  now = new Date(),
  retentionCount = 5,
  oosClient = null,
  clusterId = null,
  clusterRegionId = null,
  oosRegionId = null,
  oosAssumeRole = null,
  oosTemplateName = null,
  oosTemplateVersion = null
} = {}) {
  const sandboxTarget = getSandboxTargetFromInstance(instance, namespace)
  const clusterApi = api || getClusterApi(instance, sandboxTarget.namespace)
  const { namespace: sandboxNamespace, sandboxName, sandbox } = await readCurrentSandbox(instance, namespace, clusterApi)
  if (isSandboxBusy(sandbox)) {
    throw new CheckpointBackupError('Instance already has a backup or restore in progress', 409, 'BACKUP_IN_PROGRESS')
  }

  const backupId = createBackupId(instance.id, now)
  const backupRunId = createBackupRunId(instance.id)
  const oosConfig = await resolveCheckpointBackupOosConfig({
    clusterId,
    clusterRegionId,
    oosRegionId,
    oosAssumeRole,
    oosTemplateName,
    oosTemplateVersion
  })
  if (!oosConfig.clusterId) {
    throw new CheckpointBackupError('Checkpoint backup clusterId is not configured', 500, 'OOS_CONFIG_MISSING')
  }
  if (!oosConfig.clusterRegionId) {
    throw new CheckpointBackupError('Checkpoint backup cluster region is not configured', 500, 'OOS_CONFIG_MISSING')
  }
  const client = await getCheckpointBackupOosClient(oosClient, { oosRegionId })
  const resolvedOosRegionId = oosRegionId || client.config?.oosRegionId || oosConfig.oosRegionId || null
  const selectedTemplate = selectCheckpointBackupOosTemplate(oosConfig)
  let execution
  try {
    execution = await client.startExecution({
      templateName: selectedTemplate.templateName,
      ...(selectedTemplate.templateVersion ? { templateVersion: selectedTemplate.templateVersion } : {}),
      parameters: createOosExecutionParameters(oosConfig, sandboxNamespace, {
        runMode: 'immediate',
        scope: `instances:${instance.id}`,
        retentionCount,
        backupRunId,
        targets: [{
          namespace: sandboxNamespace,
          instanceId: instance.id,
          sandboxName,
          backupId
        }]
      }),
      description: createExecutionDescription({
        runMode: 'immediate',
        scope: `instances:${instance.id}`,
        retentionCount
      }),
      safetyCheck: 'Skip'
    })
  } catch (error) {
    throw new CheckpointBackupError(`Failed to start OOS checkpoint backup: ${getOosErrorMessage(error)}`, error.httpStatus || 502, 'OOS_UNAVAILABLE')
  }

  return {
    status: 'Submitted',
    sourceInstanceId: instance.id,
    backupId,
    oosExecutionId: execution.executionId,
    oosRegionId: resolvedOosRegionId
  }
}

export async function startCheckpointBackupExecution(instances, {
  namespace = getSandboxNamespace(),
  api = null,
  now = new Date(),
  retentionCount = 5,
  runMode = 'immediate',
  scope = 'all',
  scheduleExpression = '',
  timeZone = 'Asia/Shanghai',
  oosClient = null,
  clusterId = null,
  clusterRegionId = null,
  oosRegionId = null,
  oosAssumeRole = null,
  oosTemplateName = null,
  oosTemplateVersion = null
} = {}) {
  const selectedInstances = Array.isArray(instances) ? instances : []
  const dynamicAll = scope === 'all'
  if (selectedInstances.length === 0 && !dynamicAll) {
    throw new CheckpointBackupError('No backup targets selected', 400, 'NO_BACKUP_TARGETS')
  }

  const normalizedRunMode = normalizeRunMode(runMode)
  if (normalizedRunMode === 'scheduled' && !String(scheduleExpression || '').trim()) {
    throw new CheckpointBackupError('scheduleExpression is required for scheduled execution', 400, 'SCHEDULE_REQUIRED')
  }

  const backupRunId = createExecutionBackupRunId(normalizedRunMode)
  const executionTargets = []
  const skipped = []

  if (!dynamicAll) {
    const inspectedTargets = await Promise.all(selectedInstances.map(async instance => {
      const sandboxTarget = getSandboxTargetFromInstance(instance, namespace)
      const clusterApi = api || getClusterApi(instance, sandboxTarget.namespace)
      try {
        const { namespace: sandboxNamespace, sandboxName, sandbox } = await readCurrentSandbox(instance, namespace, clusterApi)
        return {
          api: clusterApi,
          namespace: sandboxNamespace,
          instance,
          sandboxName,
          sandbox
        }
      } catch (error) {
        return { instance, error }
      }
    }))

    for (const inspected of inspectedTargets) {
      if (inspected.error) {
        const { error, instance } = inspected
        if (error instanceof CheckpointBackupError && error.status === 409) {
          skipped.push({ instanceId: instance?.id || null, reason: error.code })
          continue
        }
        throw error
      }

      if (isSandboxBusy(inspected.sandbox)) {
        skipped.push({ instanceId: inspected.instance.id, reason: 'BUSY' })
        continue
      }
      const backupId = normalizedRunMode === 'immediate' ? createBackupId(inspected.instance.id, now) : null
      executionTargets.push({
        api: inspected.api,
        namespace: inspected.namespace,
        instance: inspected.instance,
        backupId,
        target: {
          namespace: inspected.namespace,
          instanceId: inspected.instance.id,
          sandboxName: inspected.sandboxName,
          ...(backupId ? { backupId } : {})
        }
      })
    }
  }

  if (!dynamicAll && executionTargets.length === 0) {
    throw new CheckpointBackupError('No backup targets are ready', 409, 'NO_READY_BACKUP_TARGETS')
  }
  const executionNamespace = executionTargets[0]?.namespace || namespace

  const oosConfig = await resolveCheckpointBackupOosConfig({
    clusterId,
    clusterRegionId,
    oosRegionId,
    oosAssumeRole,
    oosTemplateName,
    oosTemplateVersion
  })
  if (!oosConfig.clusterId) {
    throw new CheckpointBackupError('Checkpoint backup clusterId is not configured', 500, 'OOS_CONFIG_MISSING')
  }
  if (!oosConfig.clusterRegionId) {
    throw new CheckpointBackupError('Checkpoint backup cluster region is not configured', 500, 'OOS_CONFIG_MISSING')
  }

  const client = await getCheckpointBackupOosClient(oosClient, { oosRegionId })
  const resolvedOosRegionId = oosRegionId || client.config?.oosRegionId || oosConfig.oosRegionId || null
  const selectedTemplate = selectCheckpointBackupOosTemplate(oosConfig)
  let execution
  try {
    const templateParameters = createOosExecutionParameters(oosConfig, executionNamespace, {
      runMode: normalizedRunMode,
      scope,
      retentionCount,
      backupRunId,
      targets: executionTargets
    })
    const startPayload = {
      description: createExecutionDescription({
        runMode: normalizedRunMode,
        scope,
        retentionCount,
        scheduleExpression
      }),
      safetyCheck: 'Skip'
    }
    if (normalizedRunMode === 'scheduled') {
      startPayload.templateContent = buildCheckpointBackupScheduleWrapperTemplateContent()
      startPayload.parameters = createScheduleWrapperParameters(oosConfig, selectedTemplate, templateParameters, {
        scheduleExpression,
        timeZone
      })
    } else {
      startPayload.templateName = selectedTemplate.templateName
      if (selectedTemplate.templateVersion) {
        startPayload.templateVersion = selectedTemplate.templateVersion
      }
      startPayload.parameters = templateParameters
    }
    execution = await client.startExecution(startPayload)
  } catch (error) {
    throw new CheckpointBackupError(`Failed to start OOS checkpoint backup: ${getOosErrorMessage(error)}`, error.httpStatus || 502, 'OOS_UNAVAILABLE')
  }

  return {
    status: 'Submitted',
    runMode: normalizedRunMode,
    scope,
    targetCount: dynamicAll ? 0 : executionTargets.length,
    skippedCount: skipped.length,
    skipped,
    backupIds: executionTargets.map(item => item.backupId).filter(Boolean),
    oosExecutionId: execution.executionId,
    oosRegionId: resolvedOosRegionId
  }
}

export async function cancelCheckpointBackupExecution(executionId, {
  oosClient = null,
  oosRegionId = null
} = {}) {
  if (!executionId || !String(executionId).trim()) {
    throw new CheckpointBackupError('executionId is required', 400, 'INVALID_EXECUTION_ID')
  }
  const client = await getCheckpointBackupOosClient(oosClient, { oosRegionId })
  try {
    await client.cancelExecution({ executionId: String(executionId) })
  } catch (error) {
    throw new CheckpointBackupError(`Failed to cancel OOS checkpoint backup execution: ${getOosErrorMessage(error)}`, error.httpStatus || 502, 'OOS_UNAVAILABLE')
  }
  return {
    status: 'Cancelled',
    executionId: String(executionId)
  }
}

export async function listCheckpointBackupExecutions({
  limit = 20,
  nextToken = '',
  oosClient = null,
  oosRegionId = null
} = {}) {
  const maxResults = limitPage(limit)
  const client = await getCheckpointBackupOosClient(oosClient, { oosRegionId })
  const resolvedOosRegionId = oosRegionId || client.config?.oosRegionId || null
  try {
    const result = await client.listExecutions({ maxResults, nextToken })
    return {
      items: (result.executions || []).map(item => normalizeExecution(item, { oosRegionId: resolvedOosRegionId })).filter(Boolean),
      nextToken: result.nextToken || null
    }
  } catch (error) {
    throw new CheckpointBackupError(`Failed to list OOS checkpoint backup executions: ${getOosErrorMessage(error)}`, error.httpStatus || 502, 'OOS_UNAVAILABLE')
  }
}

export async function getCheckpointBackupExecution(executionId, {
  oosClient = null,
  oosRegionId = null
} = {}) {
  if (!executionId || !String(executionId).trim()) {
    throw new CheckpointBackupError('executionId is required', 400, 'INVALID_EXECUTION_ID')
  }
  const client = await getCheckpointBackupOosClient(oosClient, { oosRegionId })
  const resolvedOosRegionId = oosRegionId || client.config?.oosRegionId || null
  try {
    const result = await client.listExecutions({
      executionId: String(executionId),
      maxResults: 10,
      nextToken: ''
    })
    const execution = (result.executions || [])
      .map(item => normalizeExecution(item, { oosRegionId: resolvedOosRegionId }))
      .find(item => item?.executionId === String(executionId))
    if (!execution) {
      throw new CheckpointBackupError(`Backup execution ${executionId} not found`, 404, 'EXECUTION_NOT_FOUND')
    }
    return execution
  } catch (error) {
    if (error instanceof CheckpointBackupError) throw error
    throw new CheckpointBackupError(`Failed to get OOS checkpoint backup execution: ${getOosErrorMessage(error)}`, error.httpStatus || 502, 'OOS_UNAVAILABLE')
  }
}

export async function listCheckpointBackupExecutionRecords(executionId, {
  limit = 20,
  nextToken = '',
  oosClient = null,
  oosRegionId = null
} = {}) {
  if (!executionId || !String(executionId).trim()) {
    throw new CheckpointBackupError('executionId is required', 400, 'INVALID_EXECUTION_ID')
  }
  const maxResults = limitPage(limit)
  const client = await getCheckpointBackupOosClient(oosClient, { oosRegionId })
  try {
    const result = await client.listTaskExecutions({
      executionId: String(executionId),
      maxResults,
      nextToken
    })
    return {
      items: (result.taskExecutions || []).map(normalizeRecord).filter(Boolean),
      nextToken: result.nextToken || null
    }
  } catch (error) {
    throw new CheckpointBackupError(`Failed to list OOS checkpoint backup execution records: ${getOosErrorMessage(error)}`, error.httpStatus || 502, 'OOS_UNAVAILABLE')
  }
}

export async function listInstanceCheckpointBackups(instance, {
  limit = 50,
  namespace = getSandboxNamespace(),
  api = null
} = {}) {
  const items = await listBackupItems(instance, {
    limit: Number.isInteger(limit) && limit > 0 ? limit : 50,
    namespace,
    api
  })
  return items
    .filter(item => item.status === 'Ready' && item.checkpointId && item.backupId)
    .map(item => ({
      backupId: item.backupId,
      createdAt: item.createdAt,
      status: 'Ready'
    }))
}

async function loadReadyBackupByBackupId(instance, backupId, namespace, api) {
  const selector = {
    matchLabels: {
      [MANAGED_BY_LABEL]: 'agent-manager',
      [BACKUP_KIND_LABEL]: 'checkpoint',
      [SOURCE_INSTANCE_ID_LABEL]: instance.id,
      [BACKUP_ID_LABEL]: backupId
    }
  }

  let checkpoints
  try {
    checkpoints = await api.listCheckpoints(namespace, selector)
  } catch (error) {
    throw new CheckpointBackupError(`Failed to query backup ${backupId}: ${error.message}`, error.httpStatus || 502, 'K8S_UNAVAILABLE')
  }
  const items = checkpoints?.items || []
  if (items.length === 0) {
    throw new CheckpointBackupError(`Backup ${backupId} not found`, 404, 'BACKUP_NOT_FOUND')
  }
  if (items.length > 1) {
    throw new CheckpointBackupError(`Backup ${backupId} matched multiple checkpoints`, 409, 'BACKUP_CONFLICT')
  }

  const backup = await buildBackupItem(items[0], api, namespace)
  if (backup.status !== 'Ready' || !backup.checkpointId || !backup.snapshotTemplate) {
    throw new CheckpointBackupError(`Backup ${backupId} is not restorable`, 409, 'BACKUP_NOT_RESTORABLE')
  }
  return backup
}

export async function restoreInstanceCheckpointBackup(instance, backupId, {
  namespace = getSandboxNamespace(),
  api = null,
  now = new Date()
} = {}) {
  if (!backupId || !String(backupId).trim()) {
    throw new CheckpointBackupError('backupId is required', 400, 'INVALID_BACKUP_ID')
  }
  const sandboxTarget = getSandboxTargetFromInstance(instance, namespace)
  const clusterApi = api || getClusterApi(instance, sandboxTarget.namespace)
  const [{ sandboxName, sandbox }, backup] = await Promise.all([
    readCurrentSandbox(instance, namespace, clusterApi),
    loadReadyBackupByBackupId(instance, String(backupId), sandboxTarget.namespace, clusterApi)
  ])
  if (isSandboxBusy(sandbox)) {
    throw new CheckpointBackupError('Instance already has a backup or restore in progress', 409, 'BACKUP_IN_PROGRESS')
  }

  const requestId = randomUUID()
  const requestedAt = now.toISOString()
  await applyRestoreSandbox(clusterApi, sandboxTarget.namespace, sandboxName, sandbox, backup.snapshotTemplate, {
    checkpointId: backup.checkpointId,
    backupId: String(backupId),
    requestId,
    requestedAt
  })

  return {
    status: 'Submitted',
    instanceId: instance.id,
    backupId: String(backupId),
    requestId
  }
}

export async function createSandboxFromCheckpointBackup(instance, backupId, {
  namespace = getSandboxNamespace(),
  api = null,
  now = new Date(),
  sandboxName,
  newInstanceId,
  newInstanceName,
  principalId,
  userId = null,
  agentType = null,
  metadataLabels = {},
  metadataAnnotations = {}
} = {}) {
  const normalizedBackupId = String(backupId || '').trim()
  if (!normalizedBackupId) {
    throw new CheckpointBackupError('backupId is required', 400, 'INVALID_BACKUP_ID')
  }
  if (!sandboxName || !String(sandboxName).trim()) {
    throw new CheckpointBackupError('sandboxName is required', 400, 'INVALID_SANDBOX_NAME')
  }
  if (!newInstanceId || !String(newInstanceId).trim()) {
    throw new CheckpointBackupError('newInstanceId is required', 400, 'INVALID_INSTANCE_ID')
  }

  const sandboxTarget = getSandboxTargetFromInstance(instance, namespace)
  const sandboxNamespace = sandboxTarget.namespace
  const clusterApi = api || getClusterApi(instance, sandboxNamespace)
  const backup = await loadReadyBackupByBackupId(instance, normalizedBackupId, sandboxNamespace, clusterApi)
  const requestId = randomUUID()
  const requestedAt = now.toISOString()
  const body = buildCloneSandbox(backup.snapshotTemplate, {
    namespace: sandboxNamespace,
    sandboxName: String(sandboxName).trim(),
    checkpointId: backup.checkpointId,
    backupId: normalizedBackupId,
    requestId,
    requestedAt,
    sourceInstanceId: instance.id,
    newInstanceId: String(newInstanceId),
    newInstanceName: newInstanceName || `${instance.name || 'instance'}-restore`,
    principalId: principalId || instance.principal_id,
    userId,
    agentType,
    metadataLabels,
    metadataAnnotations
  })

  try {
    await clusterApi.createSandbox(sandboxNamespace, body)
  } catch (error) {
    throw new CheckpointBackupError(`Failed to create restore Sandbox ${sandboxName}: ${error.message}`, error.httpStatus || 502, 'K8S_UNAVAILABLE')
  }

  return {
    status: 'Submitted',
    sourceInstanceId: instance.id,
    backupId: normalizedBackupId,
    agentImage: getSandboxTemplateAgentImage(backup.snapshotTemplate),
    sandboxName: String(sandboxName).trim(),
    sandboxId: `${sandboxNamespace}--${String(sandboxName).trim()}`,
    requestId
  }
}

export async function restoreClaimedSandboxFromCheckpointBackup(instance, backupId, {
  namespace = getSandboxNamespace(),
  api = null,
  now = new Date(),
  sandboxName
} = {}) {
  const normalizedBackupId = String(backupId || '').trim()
  const normalizedSandboxName = String(sandboxName || '').trim()
  if (!normalizedBackupId) {
    throw new CheckpointBackupError('backupId is required', 400, 'INVALID_BACKUP_ID')
  }
  if (!normalizedSandboxName) {
    throw new CheckpointBackupError('sandboxName is required', 400, 'INVALID_SANDBOX_NAME')
  }

  const sandboxTarget = getSandboxTargetFromInstance(instance, namespace)
  const sandboxNamespace = sandboxTarget.namespace
  const clusterApi = api || getClusterApi(instance, sandboxNamespace)
  const [currentSandbox, backup] = await Promise.all([
    clusterApi.getSandbox(sandboxNamespace, normalizedSandboxName).catch(error => {
      if (isNotFoundError(error)) {
        throw new CheckpointBackupError(`Claimed Sandbox ${normalizedSandboxName} not found`, 409, 'SANDBOX_NOT_READY')
      }
      throw error
    }),
    loadReadyBackupByBackupId(instance, normalizedBackupId, sandboxNamespace, clusterApi)
  ])

  const requestId = randomUUID()
  const requestedAt = now.toISOString()
  await applyRestoreSandbox(clusterApi, sandboxNamespace, normalizedSandboxName, currentSandbox, backup.snapshotTemplate, {
    checkpointId: backup.checkpointId,
    backupId: normalizedBackupId,
    requestId,
    requestedAt
  })

  return {
    status: 'Submitted',
    sourceInstanceId: instance.id,
    backupId: normalizedBackupId,
    agentImage: getSandboxTemplateAgentImage(backup.snapshotTemplate),
    sandboxName: normalizedSandboxName,
    sandboxId: `${sandboxNamespace}--${normalizedSandboxName}`,
    requestId
  }
}
