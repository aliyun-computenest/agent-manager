/**
 * Observability Routes
 * Handles console embedding URL generation for Alibaba Cloud observability pages
 */

import { Router } from 'express'
import { z } from 'zod'
import { defineRoute } from '../openapi/route-helper.js'
import { validate } from '../middleware/validate.js'
import { errorResponse } from '../schemas/common.js'
import { requireAdmin } from '../middleware/auth.js'
import { generateEmbedUrl } from '../services/cms.js'
import { buildGatewayObservabilityUrl, buildPodObservabilityUrl, buildApmObservabilityUrl, getGatewayConfig, getCmsCredentials, getClusterId, listWorkspaces, queryApmServiceEntity } from '../services/gateway-config.js'

import { supabaseAdmin } from '../config/index.js'
import { checkGatewayIntegrationStatus, ensureGatewayIntegration, checkContainerIntegrationStatus, ensurePodIntegration, getRegionId } from '../services/cms-integration.js'
import { Sandbox } from '@e2b/code-interpreter'

const router = Router()

// --- Schemas ---

const EmbedUrlBodySchema = z.object({
  type: z.enum(['gateway', 'pod', 'apm']),
  targetId: z.string().optional(),
  instanceId: z.string().optional(),
}).passthrough()

const EmbedUrlResponseSchema = z.object({
  success: z.literal(true),
  embedUrl: z.string(),
})

const IntegrationStatusQuerySchema = z.object({
  type: z.enum(['gateway', 'pod']),
})

const IntegrationStatusResponseSchema = z.object({
  success: z.literal(true),
  resources: z.object({}).passthrough(),
  allReady: z.boolean(),
  creating: z.boolean(),
  integrationError: z.string().optional(),
})

const IntegrationBodySchema = z.object({
  type: z.enum(['gateway', 'pod']),
}).passthrough()

const IntegrationAcceptedSchema = z.object({
  status: z.literal('creating'),
  message: z.string(),
})

const IntegrationFailedSchema = z.object({
  status: z.literal('failed'),
  error: z.string(),
  created: z.array(z.object({}).passthrough()),
  skipped: z.array(z.object({}).passthrough()),
})

const AppMonitorStatusParamsSchema = z.object({
  id: z.string().uuid(),
})

const AppMonitorStatusResponseSchema = z.object({
  success: z.literal(true),
  platform: z.object({
    workspaceReady: z.boolean(),
    reason: z.string().nullable(),
  }),
  instance: z.object({
    status: z.enum(['no_params', 'disabled', 'no_entity', 'ready']),
    substatus: z.enum(['awaiting_conversation', 'need_upgrade']).optional(),
    paramsConfigured: z.boolean(),
    collectionEnabled: z.boolean(),
    entityRegistered: z.boolean(),
    entityId: z.string().nullable(),
    reason: z.string(),
  }),
  overallReady: z.boolean(),
  status: z.enum(['no_params', 'disabled', 'no_entity', 'ready']),
  substatus: z.enum(['awaiting_conversation', 'need_upgrade']).optional(),
  message: z.string(),
  agentTypeConfigUrl: z.string().nullable(),
})

// Track in-progress integration tasks (in-memory Map)
// Key: `${type}:${regionId}`, Value: { status: 'creating' | 'completed' | 'failed', result?: object }
const activeIntegrations = new Map()

// --- Routes ---

/**
 * Generate embed URL for observability dashboard
 * POST /api/observability/embed-url
 * Body: { type: "gateway" | "pod" | "apm", targetId?: string, instanceId?: string }
 *   - type="gateway": AI Gateway observability (targetId is optional consumer name filter)
 *   - type="pod": Pod observability (targetId is required instance ID)
 *   - type="apm": APM GenAI Service observability (instanceId is required)
 * Returns: { success: boolean, embedUrl?: string, error?: string }
 */
defineRoute(router, {
  method: 'post',
  path: '/observability/embed-url',
  operationId: 'createObservabilityEmbedUrl',
  tags: ['Observability'],
  summary: '生成可观测性仪表盘嵌入 URL',
  description: '根据类型（gateway/pod/apm）生成阿里云控制台嵌入 URL，用于前端 iframe 展示。',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: EmbedUrlBodySchema } } },
  },
  responses: {
    200: { description: '成功', content: { 'application/json': { schema: EmbedUrlResponseSchema } } },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: EmbedUrlBodySchema }), async (req, res) => {
  const { type, targetId, instanceId } = req.body

  let baseUrl
  let akId, akSecret

  if (type === 'gateway') {
    baseUrl = await buildGatewayObservabilityUrl(targetId || undefined)
    console.log(`📊 AI Gateway observability embed URL built (consumer: ${targetId || 'none'})`)
    const gwConfig = getGatewayConfig()
    akId = gwConfig.aliyunAccessKeyId
    akSecret = gwConfig.aliyunAccessKeySecret
  } else if (type === 'pod') {
    if (!targetId || typeof targetId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'targetId is required when type is "pod"'
      })
    }
    baseUrl = await buildPodObservabilityUrl(targetId)
    const creds = getCmsCredentials()
    akId = creds.accessKeyId
    akSecret = creds.accessKeySecret
  } else {
    // type === 'apm'
    if (!instanceId || typeof instanceId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'instanceId is required when type is "apm"'
      })
    }
    baseUrl = await buildApmObservabilityUrl(instanceId)
    const creds = getCmsCredentials()
    akId = creds.accessKeyId
    akSecret = creds.accessKeySecret
  }

  const result = await generateEmbedUrl(baseUrl, akId, akSecret)

  if (!result.success) {
    return res.status(500).json(result)
  }

  res.json({ success: true, embedUrl: result.embedUrl })
})

/**
 * Check the status of each CMS 2.0 integration resource (read-only, no side effects)
 * GET /api/observability/integration-status?type=gateway|pod
 * Returns: { success: boolean, resources: object, allReady: boolean, creating: boolean, error?: string }
 */
defineRoute(router, {
  method: 'get',
  path: '/observability/integration-status',
  operationId: 'getObservabilityIntegrationStatus',
  tags: ['Observability'],
  summary: '检查 CMS 2.0 集成状态',
  description: '只读检查 CMS 2.0 集成资源的状态，不产生副作用。',
  security: [{ bearerAuth: [] }],
  request: {
    query: IntegrationStatusQuerySchema,
  },
  responses: {
    200: { description: '成功', content: { 'application/json': { schema: IntegrationStatusResponseSchema } } },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ query: IntegrationStatusQuerySchema }), async (req, res) => {
  const type = req.query.type

  const regionId = type === 'gateway'
    ? (getGatewayConfig().regionId || await getRegionId())
    : await getRegionId()

  // Check if an integration task is currently in progress
  const integrationKey = `${type}:${regionId}`
  const active = activeIntegrations.get(integrationKey)
  const creating = active?.status === 'creating' || false

  const integrationError = (active?.status === 'failed') ? active.result?.error : undefined

  if (type === 'gateway') {
    const gatewayId = getGatewayConfig().gatewayId

    if (!gatewayId) {
      return res.status(400).json({
        success: false,
        error: 'Gateway ID not configured',
        resources: {
          workspace: { exists: false, reason: 'Gateway ID not configured' },
          policy: { exists: false, reason: 'Skipped: gateway not configured' },
          addon: { exists: false, reason: 'Skipped: gateway not configured' },
          entity: { exists: false, reason: 'Skipped: gateway not configured' }
        },
        allReady: false,
        creating: false
      })
    }

    const result = await checkGatewayIntegrationStatus({ regionId, gatewayId })
    res.json({ success: true, creating, integrationError, ...result })
  } else {
    const result = await checkContainerIntegrationStatus({ regionId })
    res.json({ success: true, creating, integrationError, ...result })
  }
})

/**
 * Establish CMS 2.0 integration (idempotent: create missing resources, skip existing ones)
 * POST /api/observability/integration
 * Body: { type: "gateway" | "pod" }
 * - 202: Integration started (async), poll integration-status for progress
 * - 400: Validation error
 */
defineRoute(router, {
  method: 'post',
  path: '/observability/integration',
  operationId: 'createObservabilityIntegration',
  tags: ['Observability'],
  summary: '建立 CMS 2.0 集成',
  description: '幂等建立 CMS 2.0 集成（创建缺失资源，跳过已存在的），返回 202 表示异步创建中。',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: IntegrationBodySchema } } },
  },
  responses: {
    202: { description: '集成已启动', content: { 'application/json': { schema: IntegrationAcceptedSchema } } },
    400: { description: '参数错误', content: { 'application/json': { schema: IntegrationFailedSchema } } },
    401: errorResponse,
    403: errorResponse,
    500: { description: '服务器错误', content: { 'application/json': { schema: IntegrationFailedSchema } } },
  },
}, requireAdmin, async (req, res) => {
  try {
    const { type } = req.body || {}

    if (!type || (type !== 'gateway' && type !== 'pod')) {
      return res.status(400).json({
        status: 'failed',
        error: 'type is required and must be "gateway" or "pod"',
        created: [],
        skipped: []
      })
    }

    const regionId = type === 'gateway'
      ? (getGatewayConfig().regionId || await getRegionId())
      : await getRegionId()

    const integrationKey = `${type}:${regionId}`

    // If an integration of the same type is already in progress, return 202
    const active = activeIntegrations.get(integrationKey)
    if (active && active.status === 'creating') {
      return res.status(202).json({ status: 'creating', message: 'Integration already in progress' })
    }

    // If previously completed/failed, clear old record to allow retry
    if (active) {
      activeIntegrations.delete(integrationKey)
    }

    // Mark integration as in-progress
    activeIntegrations.set(integrationKey, { status: 'creating' })

    // Return 202 immediately
    res.status(202).json({ status: 'creating', message: 'Integration started' })

    // Fire-and-forget: run integration in background
    ;(async () => {
      try {
        let result
        if (type === 'gateway') {
          const gwConfig = getGatewayConfig()
          const gatewayId = gwConfig.gatewayId
          if (!gatewayId) {
            activeIntegrations.set(integrationKey, { status: 'failed', result: { status: 'failed', error: 'Gateway ID not configured', created: [], skipped: [] } })
            return
          }
          result = await ensureGatewayIntegration({ regionId, gatewayId })
        } else {
          result = await ensurePodIntegration({ regionId })
        }
        activeIntegrations.set(integrationKey, { status: 'completed', result })
      } catch (err) {
        console.error(`[observability] Background integration failed (${type}):`, err)
        activeIntegrations.set(integrationKey, { status: 'failed', result: { status: 'failed', error: err.message, created: [], skipped: [] } })
      } finally {
        // Auto-cleanup after 5 minutes to prevent memory leaks
        setTimeout(() => activeIntegrations.delete(integrationKey), 5 * 60 * 1000)
      }
    })()
  } catch (error) {
    console.error(`Establish ${req.body?.type || 'unknown'} integration error:`, error)
    if (!res.headersSent) {
      res.status(500).json({ status: 'failed', error: error.message, created: [], skipped: [] })
    }
  }
})



/**
 * Get probe-detection command by agent type code.
 * Returns null when the agent type has no known probe file.
 */
function getProbeCommand(agentTypeCode) {
  switch (agentTypeCode) {
    case 'openclaw':
      return 'ls /home/node/.openclaw/openclaw.json'
    case 'hermes':
      return 'ls /opt/hermes/.venv/lib/python3.*/site-packages/aliyun/opentelemetry/instrumentation/auto_instrumentation/'
    case 'qwenpaw':
      return 'ls /app/venv/lib/python3.*/site-packages/loongsuite-site-bootstrap.pth'
    default:
      return null
  }
}

/**
 * Get APM monitoring status for an instance (with substatus probe detection).
 * GET /api/observability/instances/:id/app-monitor/status
 * Returns: {
 *   success: true,
 *   platform: { workspaceReady, reason },
 *   instance: { status, substatus?, paramsConfigured, collectionEnabled, entityRegistered, entityId, reason },
 *   overallReady: boolean,
 *   // 兼容旧格式（前端迁移后移除）
 *   status: 'no_params'|'disabled'|'no_entity'|'ready',
 *   substatus?: 'awaiting_conversation'|'need_upgrade',
 *   message,
 *   agentTypeConfigUrl
 * }
 */
defineRoute(router, {
  method: 'get',
  path: '/observability/instances/{id}/app-monitor/status',
  operationId: 'getInstanceAppMonitorStatus',
  tags: ['Observability'],
  summary: '获取实例 APM 监控状态',
  description: '检查实例及监控平台的就绪状态，并返回探针检测结果。',
  security: [{ bearerAuth: [] }],
  request: {
    params: AppMonitorStatusParamsSchema,
  },
  responses: {
    200: { description: '成功', content: { 'application/json': { schema: AppMonitorStatusResponseSchema } } },
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ params: AppMonitorStatusParamsSchema }), async (req, res) => {
  try {
    const { id } = req.params

    // 1. Query instance with agent_type info (Agent Type level observability_enabled)
    const { data: instance, error: fetchError } = await supabaseAdmin
      .from('agent_instances')
      .select('id, name, sandbox_id, agent_type_id, agent_type:agent_types(*)')
      .eq('id', id)
      .single()

    if (fetchError || !instance) {
      return res.status(404).json({ success: false, error: '实例不存在' })
    }

    const agentTypeId = instance.agent_type?.id || instance.agent_type_id
    const agentTypeConfigUrl = agentTypeId ? `/admin/agent-types/${agentTypeId}` : null

    // 2. Check observability_env on agent_type
    const obsEnv = instance.agent_type?.observability_env
    const paramsConfigured = !!(obsEnv && Object.keys(obsEnv).length > 0)

    // 3. Check observability_enabled at Agent Type level (default: true if field not yet migrated)
    const collectionEnabled = instance.agent_type?.observability_enabled !== false

    // 4. Check workspace & entity registration
    let workspaceReady = false
    let workspaceReason = null
    let entityRegistered = false
    let entityId = null
    let cmsQueryFailed = false

    try {
      const { accessKeyId: akId, accessKeySecret: akSecret } = getCmsCredentials()
      if (akId && akSecret) {
        const { clusterRegionId } = await getClusterId()
        const workspaces = await listWorkspaces(akId, akSecret, clusterRegionId)
        if (workspaces.length > 0) {
          workspaceReady = true
          // Match by instance id, sandbox_id, pod name (sandbox_id without namespace prefix), and instance name
          const podName = instance.sandbox_id?.includes('--') ? instance.sandbox_id.split('--').slice(1).join('--') : instance.sandbox_id
          const candidates = [id, instance.sandbox_id, podName, instance.name].filter(Boolean)
          const entity = await queryApmServiceEntity(
            akId, akSecret, clusterRegionId,
            workspaces[0].workspaceName, candidates
          )
          if (entity) {
            entityRegistered = true
            entityId = entity.entityId || null
          }
        } else {
          workspaceReason = 'CMS 项目空间不存在，请先创建项目空间。'
        }
      } else {
        workspaceReason = 'CMS 凭证未配置。'
      }
    } catch (err) {
      // CMS API failure/timeout — treat workspace as ready optimistically
      console.warn('[app-monitor/status] CMS query failed, returning optimistic ready:', err.message)
      workspaceReady = true
      cmsQueryFailed = true
    }

    // 5. Determine instance status & substatus
    let status, substatus, message

    if (!paramsConfigured) {
      status = 'no_params'
      substatus = undefined
      message = '该实例的 Agent 类型尚未配置可观测性参数，请先在 Agent 类型管理中配置。'
    } else if (!collectionEnabled) {
      status = 'disabled'
      substatus = undefined
      message = '该 Agent 类型的可观测性采集已关闭，开启后即可上报数据。'
    } else if (entityRegistered || cmsQueryFailed) {
      status = 'ready'
      substatus = undefined
      message = cmsQueryFailed
        ? '可观测性已就绪（监控平台暂时不可查询，数据可能正常上报中）。'
        : '可观测性已就绪，数据正常上报中。'
    } else {
      // No entity found -> probe detection to determine substatus
      status = 'no_entity'
      substatus = 'awaiting_conversation'
      const probeCommand = getProbeCommand(instance.agent_type?.code)
      if (probeCommand && instance.sandbox_id) {
        try {
          const sandbox = await Sandbox.connect(instance.sandbox_id)
          const result = await sandbox.commands.run(probeCommand, {
            user: 'root',
            timeoutMs: 5000
          })
          substatus = result.exitCode === 0 ? 'awaiting_conversation' : 'need_upgrade'
        } catch (probeErr) {
          console.warn(`[app-monitor/status] probe detection failed for instance ${id}, defaulting to awaiting_conversation:`, probeErr.message)
          substatus = 'awaiting_conversation'
        }
      }
      message = substatus === 'need_upgrade'
        ? '尚未在监控平台发现该实例的数据实体，且未检测到探针文件，请升级实例镜像后重试。'
        : '尚未在监控平台发现该实例的数据实体，探针已就绪，发起一次对话后即可上报数据。'
    }

    // 6. Build structured response
    const platform = {
      workspaceReady,
      reason: workspaceReason
    }
    const instanceInfo = {
      status,
      substatus: substatus || undefined,
      paramsConfigured,
      collectionEnabled,
      entityRegistered,
      entityId,
      reason: message
    }
    const overallReady = platform.workspaceReady && status === 'ready'

    return res.json({
      success: true,
      platform,
      instance: instanceInfo,
      overallReady,
      // 兼容旧格式（保留，前端逐步迁移后移除）
      status,
      substatus,
      message,
      agentTypeConfigUrl
    })
  } catch (error) {
    console.error('APM app-monitor status error:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

export default router
