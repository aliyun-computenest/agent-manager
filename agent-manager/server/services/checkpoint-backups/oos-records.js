import { getRetentionCount } from './constants.js'

export function limitPage(limit) {
  const parsed = Number(limit)
  if (!Number.isInteger(parsed) || parsed <= 0) return 20
  return Math.min(Math.max(parsed, 10), 100)
}

function readObjectValue(object, keys) {
  for (const key of keys) {
    if (object && object[key] !== undefined && object[key] !== null) return object[key]
  }
  return null
}

function parseJsonMaybe(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

function parseOosOutputs(value) {
  const outputs = parseJsonMaybe(value)
  if (Array.isArray(outputs)) {
    return Object.fromEntries(outputs.map(item => [item?.Name || item?.name, item?.Value ?? item?.value]).filter(([key]) => key))
  }
  return outputs || {}
}

function parseListMaybe(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function normalizeOosStatus(value) {
  const status = String(value || '').toLowerCase()
  if (['success', 'succeeded', 'finished'].includes(status)) return 'Success'
  if (['cancelled', 'canceled'].includes(status)) return 'Cancelled'
  if (['failed', 'failure'].includes(status)) return 'Failed'
  if (['partialfailed', 'partial_failed', 'partiallyfailed'].includes(status)) return 'PartialFailed'
  return 'Running'
}

function normalizeSuccessfulStatus(status, outputs, message, {
  expectedTargetCount = null,
  requireCheckpointEvidence = false
} = {}) {
  if (status !== 'Success') return status
  const checkpointIds = parseListMaybe(outputs.CheckpointIds || outputs.checkpointIds)
  const successCount = checkpointIds.filter(value => value !== null && value !== undefined && String(value).trim()).length
  if (requireCheckpointEvidence && successCount === 0) return 'Failed'
  if (expectedTargetCount > 0) {
    if (successCount === 0) return 'Failed'
    if (successCount < expectedTargetCount) return 'PartialFailed'
  } else if (checkpointIds.length > 0) {
    if (successCount === 0) return 'Failed'
    if (successCount < checkpointIds.length) return 'PartialFailed'
  }
  if (/\bexecution failed\b|\bfailed to\b|\bfailure\b/i.test(String(message || ''))) {
    return 'PartialFailed'
  }
  return status
}

function getExecutionTargets(parameters) {
  const nestedParameters = parameters.templateParameters || parameters.TemplateParameters || {}
  const targets = parameters.Targets || parameters.targets || nestedParameters.Targets || nestedParameters.targets
  return Array.isArray(targets) ? targets.filter(target => target && typeof target === 'object') : []
}

function formatRecordStatusText(status) {
  if (status === 'Success') return '成功'
  if (status === 'Failed') return '失败'
  if (status === 'Cancelled') return '已取消'
  if (status === 'PartialFailed') return '部分失败'
  return '运行中'
}

function formatRecordTaskName(taskName) {
  const name = String(taskName || '')
  if (name.startsWith('GetSandbox')) return '读取实例状态'
  if (name.startsWith('ApplySnapshot')) return '保存实例配置快照'
  if (name.startsWith('ApplyCheckpoint')) return '创建备份点'
  if (name.startsWith('GetCheckpoint')) return '确认备份点状态'
  if (name.startsWith('ListExpiredBackups')) return '检查过期备份'
  if (name.startsWith('CleanupBackups')) return '清理过期备份'
  if (name.startsWith('DeleteExpiredCheckpoint')) return '清理过期备份点'
  if (name.startsWith('DeleteExpiredSnapshot')) return '清理过期配置快照'
  return name || '执行任务'
}

function buildRecordMessageFromTask(taskExecution, outputs, status) {
  const taskName = readObjectValue(taskExecution, ['TaskName', 'taskName', 'Name', 'name'])
  if (!taskName || String(taskName) === 'TimerTrigger') return null
  const outputDetails = []
  const phase = outputs.Phase || outputs.phase
  const checkpointId = outputs.CheckpointId || outputs.checkpointId
  if (phase) outputDetails.push(`状态 ${phase}`)
  if (checkpointId) outputDetails.push(`Checkpoint ${checkpointId}`)
  const suffix = outputDetails.length ? `，${outputDetails.join('，')}` : ''
  return `${formatRecordTaskName(taskName)}${formatRecordStatusText(status)}${suffix}（${taskName}）`
}

function extractTemplateValue(templateContent, pattern) {
  const match = String(templateContent || '').match(pattern)
  if (!match) return null
  return String(match[1] || '').replace(/^['"]|['"]$/g, '').trim()
}

function normalizeCronExpression(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw.startsWith('cron(')) return raw
  return `cron(${raw} *)`
}

function hasAgentManagerTargetParameters(parameters) {
  return getExecutionTargets(parameters).some(target => target
    && typeof target === 'object'
    && (target.instanceId || target.instance_id)
    && (target.sandboxName || target.sandbox_name)
    && (target.backupIdPrefix || target.backup_id_prefix || target.backupId || target.backup_id))
}

function extractExecutionMetadata(execution) {
  const templateContent = readObjectValue(execution, ['TemplateContent', 'templateContent']) || ''
  const templateName = readObjectValue(execution, ['TemplateName', 'templateName']) || ''
  const description = readObjectValue(execution, ['Description', 'description']) || ''
  const parameters = parseJsonMaybe(readObjectValue(execution, ['Parameters', 'parameters']))
  const templateParameters = parameters.templateParameters || parameters.TemplateParameters || {}
  const timerTrigger = parameters.timerTrigger || parameters.TimerTrigger || {}
  const isScheduleWrapper = Boolean(parameters.templateName || parameters.TemplateName)
    && Boolean(timerTrigger.expression || timerTrigger.Expression)
  const outputs = parseOosOutputs(readObjectValue(execution, ['Outputs', 'outputs']))
  const runMode = parameters.RunMode
    || parameters.runMode
    || templateParameters.RunMode
    || templateParameters.runMode
    || outputs.RunMode
    || outputs.runMode
    || extractTemplateValue(description, /runMode=([^;\n]+)/)
    || extractTemplateValue(templateContent, /agent-manager\.io\/backup-trigger:\s*["']?([^"'\n]+)["']?/)
    || (String(templateName).startsWith('AgentManagerCheckpointBackupScheduled-') ? 'scheduled' : '')
  const scope = parameters.Scope
    || parameters.scope
    || templateParameters.Scope
    || templateParameters.scope
    || outputs.Scope
    || outputs.scope
    || extractTemplateValue(description, /scope=([^;\n]+)/)
    || extractTemplateValue(templateContent, /agent-manager\.io\/backup-scope:\s*["']?([^"'\n]+)["']?/)
  const retention = parameters.RetentionCount
    || parameters.retentionCount
    || templateParameters.RetentionCount
    || templateParameters.retentionCount
    || outputs.RetentionCount
    || outputs.retentionCount
    || extractTemplateValue(description, /retentionCount=([^;\n]+)/)
    || extractTemplateValue(templateContent, /RetentionCount:[\s\S]*?Value:\s*["']?(\d+)["']?/)
  const expression = parameters.CronExpression
    || parameters.cronExpression
    || parameters.ScheduleExpression
    || parameters.scheduleExpression
    || timerTrigger.expression
    || timerTrigger.Expression
    || extractTemplateValue(description, /cronExpression=([^;\n]+)/)
    || extractTemplateValue(templateContent, /Expression:\s*["']?([^"'\n]+)["']?/)

  return {
    isAgentManagerBackup: String(templateContent).includes('Agent Manager checkpoint backup via ACS::Kubectl')
      || String(description).includes('Agent Manager checkpoint backup via ACS::Kubectl')
      || String(templateName).startsWith('AgentManagerCheckpointBackup')
      || String(templateName).startsWith('ACS-CS-CreateAgentManagercheckpointBackup')
      || String(templateName).startsWith('ACS-CN-CreateAgentManagerCheckpointBackup')
      || hasAgentManagerTargetParameters(parameters),
    runMode: runMode === 'scheduled' ? 'scheduled' : 'immediate',
    scope: scope || 'all',
    cronExpression: runMode === 'scheduled' ? normalizeCronExpression(expression) : null,
    retentionCount: getRetentionCount(retention),
    isScheduleWrapper,
    expectedTargetCount: scope === 'all' || isScheduleWrapper ? null : getExecutionTargets(parameters).length,
    message: outputs.Message || outputs.message || readObjectValue(execution, ['StatusMessage', 'statusMessage', 'LastTriggerStatusMessage', 'lastTriggerStatusMessage', 'Message', 'message']) || null,
    outputs
  }
}

export function normalizeExecution(execution, { oosRegionId = null } = {}) {
  const metadata = extractExecutionMetadata(execution)
  if (!metadata.isAgentManagerBackup) return null
  const status = normalizeSuccessfulStatus(
    normalizeOosStatus(readObjectValue(execution, ['Status', 'status', 'ExecutionStatus', 'executionStatus'])),
    metadata.outputs,
    metadata.message,
    {
      expectedTargetCount: metadata.expectedTargetCount,
      requireCheckpointEvidence: !metadata.isScheduleWrapper
    }
  )
  const hasSuccessfulCheckpoint = parseListMaybe(
    metadata.outputs.CheckpointIds || metadata.outputs.checkpointIds
  ).some(value => value !== null && value !== undefined && String(value).trim())
  return {
    executionId: readObjectValue(execution, ['ExecutionId', 'executionId']),
    oosRegionId,
    runMode: metadata.runMode,
    scope: metadata.scope,
    cronExpression: metadata.cronExpression,
    retentionCount: metadata.retentionCount,
    status,
    nextRunAt: readObjectValue(execution, [
      'NextScheduleTime',
      'nextScheduleTime',
      'NextTriggerTime',
      'nextTriggerTime',
      'NextExecutionTime',
      'nextExecutionTime'
    ]) || null,
    startedAt: readObjectValue(execution, ['StartDate', 'startDate', 'StartedAt', 'startedAt', 'CreateDate', 'createDate']) || null,
    message: metadata.message || (
      status === 'Failed' && !metadata.isScheduleWrapper && !hasSuccessfulCheckpoint
        ? 'OOS execution completed without any successful Checkpoint'
        : null
    )
  }
}

export function normalizeRecord(taskExecution) {
  const rawStatus = readObjectValue(taskExecution, ['Status', 'status'])
  if (String(rawStatus || '').toLowerCase() === 'skipped') return null

  const outputs = parseOosOutputs(readObjectValue(taskExecution, ['Outputs', 'outputs']))
  const message = outputs.Message
    || outputs.message
    || readObjectValue(taskExecution, ['StatusMessage', 'statusMessage', 'Message', 'message'])
  const status = normalizeSuccessfulStatus(
    normalizeOosStatus(rawStatus),
    outputs,
    message
  )
  const resolvedMessage = message || buildRecordMessageFromTask(taskExecution, outputs, status)
  if (!resolvedMessage) return null
  return {
    status,
    startedAt: readObjectValue(taskExecution, ['StartDate', 'startDate', 'StartedAt', 'startedAt', 'CreateDate', 'createDate']) || null,
    message: resolvedMessage
  }
}
