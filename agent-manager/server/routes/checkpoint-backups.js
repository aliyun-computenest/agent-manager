import { Router } from 'express'
import { z } from 'zod'
import { env, supabaseAdmin } from '../config/index.js'
import { requireAdmin } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { defineRoute } from '../openapi/route-helper.js'
import { errorResponse } from '../schemas/common.js'
import {
  cancelCheckpointBackupExecution,
  CheckpointBackupError,
  getCheckpointBackupExecution,
  listCheckpointBackupExecutionRecords,
  listCheckpointBackupExecutions,
  startCheckpointBackupExecution
} from '../services/checkpoint-backups/index.js'

const router = Router()

const ExecutionScopeSchema = z.object({
  type: z.enum(['all', 'instances']).describe('备份范围'),
  instanceIds: z.array(z.string().uuid()).optional().describe('部分实例 ID 列表')
}).superRefine((value, ctx) => {
  if (value.type === 'instances' && (!value.instanceIds || value.instanceIds.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['instanceIds'],
      message: 'instanceIds is required when scope.type is instances'
    })
  }
})

const CreateBackupExecutionBody = z.object({
  runMode: z.enum(['immediate', 'scheduled']).describe('执行方式'),
  scope: ExecutionScopeSchema.describe('实例范围'),
  cronExpression: z.string().trim().min(1).optional().describe('周期性重复执行 cron 表达式'),
  retentionCount: z.number().int().min(1).max(50).optional().describe('单实例最多保留备份数')
}).superRefine((value, ctx) => {
  if (value.runMode === 'scheduled' && !value.cronExpression) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cronExpression'],
      message: 'cronExpression is required when runMode is scheduled'
    })
  }
})

const CreateBackupExecutionResponse = z.object({
  success: z.boolean(),
  executionId: z.string(),
  oosRegionId: z.string().nullable().optional(),
  runMode: z.enum(['immediate', 'scheduled']),
  targetCount: z.number(),
  skippedCount: z.number()
})

const ListBackupExecutionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  nextToken: z.string().optional()
})

const BackupExecutionItem = z.object({
  executionId: z.string(),
  oosRegionId: z.string().nullable().optional(),
  runMode: z.enum(['immediate', 'scheduled']),
  scope: z.string(),
  cronExpression: z.string().nullable(),
  retentionCount: z.number(),
  status: z.enum(['Running', 'Success', 'Failed', 'PartialFailed', 'Cancelled']),
  nextRunAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  message: z.string().nullable()
})

const ListBackupExecutionsResponse = z.object({
  success: z.boolean(),
  items: z.array(BackupExecutionItem),
  nextToken: z.string().nullable()
})

const BackupExecutionResponse = z.object({
  success: z.boolean(),
  item: BackupExecutionItem
})

const BackupExecutionRecordItem = z.object({
  status: z.enum(['Running', 'Success', 'Failed', 'PartialFailed', 'Cancelled']),
  startedAt: z.string().nullable(),
  message: z.string()
})

const ListBackupExecutionRecordsResponse = z.object({
  success: z.boolean(),
  items: z.array(BackupExecutionRecordItem),
  nextToken: z.string().nullable()
})

const ExecutionIdParams = z.object({
  executionId: z.string().min(1).describe('OOS execution ID')
})

const EmptyBody = z.object({}).passthrough()

function sendCheckpointBackupError(res, error) {
  if (error instanceof CheckpointBackupError) {
    return res.status(error.status).json({
      success: false,
      error: error.message,
      errorCode: error.code
    })
  }
  throw error
}

function getDefaultTimeZone() {
  const configured = process.env.CHECKPOINT_BACKUP_TIME_ZONE
    || env.CHECKPOINT_BACKUP_TIME_ZONE
    || process.env.OOS_TIME_ZONE
    || env.OOS_TIME_ZONE
    || 'Asia/Shanghai'
  return String(configured || '').trim() || 'Asia/Shanghai'
}

function buildScopeString(scope) {
  if (scope.type === 'all') return 'all'
  const ids = [...new Set(scope.instanceIds || [])]
  return `instances:${ids.join(',')}`
}

async function loadExecutionInstances(scope) {
  if (scope.type === 'all') return []

  let query = supabaseAdmin
    .from('agent_instances')
    .select('id, principal_id, name, status, sandbox_id, agent_image, config_json')
    .not('sandbox_id', 'is', null)

  query = query.in('id', [...new Set(scope.instanceIds || [])])

  const { data, error } = await query
  if (error) {
    throw new CheckpointBackupError(`Failed to query backup targets: ${error.message}`, 500, 'DB_QUERY_FAILED')
  }
  return data || []
}

defineRoute(router, {
  method: 'get',
  path: '/admin/backups/executions',
  operationId: 'listBackupExecutions',
  tags: ['CheckpointBackups'],
  summary: '查询备份执行列表',
  description: '管理员查询平台备份执行列表；返回页面需要的精简字段，OOS 控制台地址由前端根据 executionId 生成。',
  security: [{ bearerAuth: [] }],
  request: {
    query: ListBackupExecutionsQuery,
  },
  responses: {
    200: {
      description: '备份执行列表',
      content: { 'application/json': { schema: ListBackupExecutionsResponse } },
    },
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ query: ListBackupExecutionsQuery }), async (req, res) => {
  try {
    const result = await listCheckpointBackupExecutions({
      limit: req.query.limit,
      nextToken: req.query.nextToken
    })
    res.json({ success: true, ...result })
  } catch (error) {
    return sendCheckpointBackupError(res, error)
  }
})

defineRoute(router, {
  method: 'post',
  path: '/admin/backups/executions',
  operationId: 'createBackupExecution',
  tags: ['CheckpointBackups'],
  summary: '创建备份执行',
  description: '管理员创建立即或周期性备份执行，可选择全部实例或部分实例；后端自动发现 OOS 与 ACK 集群配置。',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: CreateBackupExecutionBody } } },
  },
  responses: {
    201: {
      description: '备份执行已创建',
      content: { 'application/json': { schema: CreateBackupExecutionResponse } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    409: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: CreateBackupExecutionBody }), async (req, res) => {
  const body = req.body
  try {
    const instances = await loadExecutionInstances(body.scope)
    if (instances.length === 0 && body.scope.type !== 'all') {
      return res.status(400).json({
        success: false,
        error: 'No backup targets selected',
        errorCode: 'NO_BACKUP_TARGETS'
      })
    }
    const result = await startCheckpointBackupExecution(instances, {
      runMode: body.runMode,
      scope: buildScopeString(body.scope),
      scheduleExpression: body.cronExpression || '',
      retentionCount: body.retentionCount || 5,
      timeZone: getDefaultTimeZone()
    })
    res.status(201).json({
      success: true,
      executionId: result.oosExecutionId,
      oosRegionId: result.oosRegionId || null,
      runMode: result.runMode,
      targetCount: result.targetCount,
      skippedCount: result.skippedCount
    })
  } catch (error) {
    return sendCheckpointBackupError(res, error)
  }
})

defineRoute(router, {
  method: 'get',
  path: '/admin/backups/executions/{executionId}',
  operationId: 'getBackupExecution',
  tags: ['CheckpointBackups'],
  summary: '查询单个备份执行',
  description: '管理员按 executionId 精确查询单个备份执行；用于详情页避免通过分页列表反查。',
  security: [{ bearerAuth: [] }],
  request: {
    params: ExecutionIdParams,
  },
  responses: {
    200: {
      description: '备份执行详情',
      content: { 'application/json': { schema: BackupExecutionResponse } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ params: ExecutionIdParams }), async (req, res) => {
  try {
    const item = await getCheckpointBackupExecution(req.params.executionId)
    res.json({ success: true, item })
  } catch (error) {
    return sendCheckpointBackupError(res, error)
  }
})

defineRoute(router, {
  method: 'get',
  path: '/admin/backups/executions/{executionId}/records',
  operationId: 'listBackupExecutionRecords',
  tags: ['CheckpointBackups'],
  summary: '查询备份执行记录',
  description: '管理员查询指定备份 execution 下的实际执行记录；返回状态、开始时间和执行信息。',
  security: [{ bearerAuth: [] }],
  request: {
    params: ExecutionIdParams,
    query: ListBackupExecutionsQuery,
  },
  responses: {
    200: {
      description: '备份执行记录',
      content: { 'application/json': { schema: ListBackupExecutionRecordsResponse } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ params: ExecutionIdParams, query: ListBackupExecutionsQuery }), async (req, res) => {
  try {
    const result = await listCheckpointBackupExecutionRecords(req.params.executionId, {
      limit: req.query.limit,
      nextToken: req.query.nextToken
    })
    res.json({ success: true, ...result })
  } catch (error) {
    return sendCheckpointBackupError(res, error)
  }
})

defineRoute(router, {
  method: 'post',
  path: '/admin/backups/executions/{executionId}/cancel',
  operationId: 'cancelBackupExecution',
  tags: ['CheckpointBackups'],
  summary: '取消备份执行',
  description: '管理员取消 OOS 备份 execution 后续触发；已创建的备份点不删除。',
  security: [{ bearerAuth: [] }],
  request: {
    params: ExecutionIdParams,
    body: { content: { 'application/json': { schema: EmptyBody } } },
  },
  responses: {
    204: { description: '取消成功' },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    409: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ params: ExecutionIdParams, body: EmptyBody }), async (req, res) => {
  try {
    await cancelCheckpointBackupExecution(req.params.executionId)
    res.status(204).send()
  } catch (error) {
    return sendCheckpointBackupError(res, error)
  }
})

export default router
