/**
 * Agent Instance Management Routes
 * Handles instance CRUD and lifecycle operations
 */

import { Router } from 'express'
import { z } from 'zod'
import { Sandbox } from '@e2b/code-interpreter'
import {
  supabaseAdmin,
  E2B_API_KEY,
  AGENT_GATEWAY_ACCESS_MODE,
  DEPLOY_ENVIRONMENT,
  E2B_HOSTS_IP,
  E2B_NEEDS_HOSTS
} from '../config/index.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { pauseSandbox, resumeSandbox, getSandboxStatus } from '../services/sandbox.js'
import { decryptApiKey, encryptApiKey } from '../utils/crypto.js'
import { getAgentType, runModifyCommand } from '../utils/agent-config.js'
import { getGatewayConfig } from '../services/gateway-config.js'
import { createProviderFromDB } from '../services/providers/index.js'
import { sanitizeConsumerName } from '../services/apig.js'
import { getTodayTokensByUsername, get30DaysTokensByUsername } from '../services/sls.js'
import {
  completeCheckpointRestoreConfigJson,
  createInstanceForUser,
  ProvisionError,
  runBackgroundHealthCheck,
  ensurePrincipalConsumer
} from '../services/instance-provisioner.js'
import {
  AccessError,
  assertInstanceAccess,
  canDeleteInstanceRecord,
  getActiveGroupMemberships,
  isPlatformAdminProfile
} from '../services/principal-access.js'
import {
  CheckpointBackupError,
  listInstanceCheckpointBackups,
  startInstanceCheckpointBackup
} from '../services/checkpoint-backups/index.js'
import {
  resolveCreateInstanceFromBackupOptions,
  resolveRestoreTargetForSourceInstance
} from '../services/instance-restore.js'
import {
  buildInstanceUpgradeInfo,
  getCurrentSandboxImages,
  getRuntimeStatusFromSandbox,
  getUpgradeTargets,
  persistRuntimeStatuses,
  shouldPersistRuntimeStatus
} from '../services/instance-upgrade-info.js'
import {
  buildAgentGatewaySandboxUrl,
  buildE2BUpstreamHost,
  resolveAgentGatewayPort
} from '../services/agent-gateway.js'
import { ensureUserByEmail } from './users.js'
import { defineRoute } from '../openapi/route-helper.js'

import { InstanceSchema } from '../schemas/instance.js'
import { errorResponse, DeleteResponseSchema } from '../schemas/common.js'
import { validate } from '../middleware/validate.js'

const router = Router()
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const AgentAuthType = Object.freeze({
  Auth: 'Auth',
  NoAuth: 'NoAuth'
})

// Track instances with active background health checks to avoid duplicate triggers
const activeHealthChecks = new Set()

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

async function loadInstancePrincipalMaps(instances) {
  const principalIds = [...new Set((instances || [])
    .map(instance => instance.principal_id)
    .filter(Boolean))]

  const principalMap = new Map()
  const groupMap = new Map()

  if (principalIds.length > 0) {
    const { data } = await supabaseAdmin
      .from('principal_profiles')
      .select('principal_id:id, principal_type, email, name')
      .in('id', principalIds)
    for (const profile of data || []) {
      principalMap.set(profile.principal_id, {
        ...profile,
        username: profile.principal_type === 'user' ? profile.name : null
      })
      if (profile.principal_type === 'group') groupMap.set(profile.principal_id, profile)
    }
  }

  return { principalMap, groupMap }
}

function buildInstanceOwnership(instance, principalMap, groupMap, currentPrincipalId, memberships, userProfile) {
  const owningPrincipalId = instance.principal_id
  const ownerPrincipalId = owningPrincipalId
  const principal = principalMap?.get(ownerPrincipalId)
  const owningPrincipal = principalMap?.get(owningPrincipalId)
  const group = owningPrincipal?.principal_type === 'group' ? groupMap?.get(owningPrincipalId) : null
  return {
    principal: ownerPrincipalId
      ? {
          principalId: ownerPrincipalId,
          username: principal?.username || null,
          email: principal?.email || null
        }
      : null,
    group: group
      ? {
          id: group.principal_id,
          name: group.name
        }
      : null,
    actions: {
      canDelete: canDeleteInstanceRecord(instance, currentPrincipalId, memberships, userProfile)
    }
  }
}

function sendInstanceAccessError(res, error) {
  if (error instanceof AccessError) {
    return res.status(error.status).json({ success: false, error: error.message })
  }
  throw error
}

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

const InstanceIdParamsSchema = z.object({
  instanceId: z.string().describe('实例 ID (UUID)'),
})
const BackupParamsSchema = InstanceIdParamsSchema.extend({
  backupId: z.string().min(1).describe('备份点 ID')
})

const ListInstancesQuerySchema = z.object({}).passthrough()
const ListAdminInstancesQuerySchema = z.object({}).passthrough()
const ListInstanceBackupsQuerySchema = z.object({
  limit: z.string().optional()
}).passthrough()
const InstancesOverviewQuerySchema = z.object({
  scope: z.enum(['private', 'group']).optional(),
  groupId: z.string().uuid().optional()
}).passthrough()

const CreateInstanceBody = z.object({
  name: z.string({ required_error: 'name is required' }).min(1, { message: 'name is required' }),
  groupId: z.string().uuid().optional().nullable(),
  backupId: z.string().min(1).optional().nullable()
}).passthrough()

const CreateAdminInstanceBody = z.object({
  userId: z.string().optional(),
  email: z.string().optional(),
  groupId: z.string().uuid().optional().nullable()
}).passthrough().refine(
  v => !!v?.userId || !!v?.email || !!v?.groupId,
  { message: 'userId, email, or groupId is required' }
)

const UpdateInstanceBody = z.object({}).passthrough()
const EmptyBackupBody = z.object({}).passthrough().optional()
const RestoreBackupBody = z.object({
  name: z.string().min(1).optional()
}).passthrough().optional()

const PaginationSchema = z.object({
  page: z.number().int().describe('当前页码'),
  pageSize: z.number().int().describe('每页数量'),
  total: z.number().int().describe('总记录数'),
  totalPages: z.number().int().describe('总页数'),
})

const InstanceWithExtrasSchema = InstanceSchema.extend({
  ai_models: z.object({ id: z.string().uuid(), name: z.string(), provider: z.string() }).nullable(),
  agent_type: z.object({ id: z.string().uuid(), code: z.string(), name: z.string(), sandbox_template_id: z.string().nullable() }).nullable(),
  principal: z.object({
    principalId: z.string().uuid(),
    username: z.string().nullable(),
    email: z.string().nullable()
  }).nullable().optional(),
  group: z.object({
    id: z.string().uuid(),
    name: z.string()
  }).nullable().optional(),
  actions: z.object({
    canDelete: z.boolean()
  }).optional(),
  sandbox_upgrade: z.object({
    CanUpgrade: z.boolean(), Reason: z.string(), AgentTypeId: z.string().nullable(),
    SandboxName: z.string().nullable(), SandboxPhase: z.string().nullable(),
    PodPhase: z.string().nullable(), PodReady: z.boolean(), PodIP: z.string().nullable(),
    BackupReady: z.boolean(), Namespace: z.string(), SandboxSetName: z.string().nullable(),
    CurrentImage: z.string().nullable(), TargetImage: z.string().nullable(), Error: z.string().nullable(),
  }).passthrough().nullable(),
})

const InstanceResponseSchema = z.object({
  success: z.literal(true),
  instance: InstanceWithExtrasSchema,
})

const ListInstancesResponseSchema = z.object({
  success: z.literal(true),
  instances: z.array(InstanceWithExtrasSchema),
  pagination: PaginationSchema,
})

const InstancesOverviewResponseSchema = z.object({
  success: z.literal(true),
  overview: z.object({
    totalInstances: z.number().int().describe('实例总数'),
    privateInstances: z.number().int().describe('个人实例数'),
    groupInstances: z.number().int().describe('当前 scope 下的分组实例数'),
    groupCount: z.number().int().describe('当前用户加入的 active 分组数'),
    todayTokenUsage: z.number().nullable().describe('今日 Token 用量'),
    monthlyTokenUsage: z.number().nullable().describe('本月 Token 用量'),
    effectiveDailyLimit: z.number().describe('每日用量上限'),
    effectiveMonthlyLimit: z.number().describe('每月用量上限'),
    usageUnit: z.string().describe('用量单位'),
    limitUnit: z.string().describe('配额单位'),
    aiGatewayEnabled: z.boolean().describe('AI 网关是否启用'),
    slsEnabled: z.boolean().describe('SLS 日志是否启用'),
  }),
})

const DeleteInstanceResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().describe('操作结果消息'),
  instanceId: z.string().describe('被删除的实例 ID'),
})

const InstanceLifecycleResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().describe('操作结果消息'),
  instanceId: z.string().describe('实例 ID'),
  status: z.string().describe('实例最新状态'),
})

const InstanceChannelSecretResponseSchema = z.object({
  success: z.literal(true),
  channelType: z.string().describe('渠道类型'),
  clientId: z.string().describe('解密后的客户端 ID'),
  clientSecret: z.string().describe('解密后的客户端密钥'),
})

const UpdateInstanceResponseSchema = z.object({
  success: z.literal(true),
  instance: InstanceWithExtrasSchema,
  channelConfig: z.object({
    id: z.string().uuid(), instance_id: z.string().uuid(), channel_type: z.string(),
    client_id: z.string(), config_json: z.object({}).passthrough(),
    is_configured: z.boolean(), created_at: z.string(), updated_at: z.string(),
  }).nullable(),
})

const StartInstanceBackupResponseSchema = z.object({
  success: z.literal(true),
  backupId: z.string()
})

const InstanceBackupItemSchema = z.object({
  backupId: z.string(),
  createdAt: z.string().nullable(),
  status: z.literal('Ready')
})

const InstanceBackupOperationSchema = z.object({
  backupId: z.string(),
  status: z.enum(['Running', 'Failed']),
  startedAt: z.string(),
  message: z.string().nullable()
})

const ListInstanceBackupsResponseSchema = z.object({
  success: z.literal(true),
  latestOperation: InstanceBackupOperationSchema.nullable(),
  items: z.array(InstanceBackupItemSchema)
})

const RestoreInstanceBackupResponseSchema = z.object({
  success: z.literal(true),
  instanceId: z.string(),
  sourceInstanceId: z.string(),
  backupId: z.string(),
  sandboxId: z.string().nullable()
})

// =====================================================
// Routes
// =====================================================

/**
 * Create a new Agent instance with E2B sandbox
 * POST /api/instances
 * Body: { name, agentTypeId, description?, modelId?, configJson?, channelType?, channelClientId?, channelClientSecret?, backupId? }
 */
defineRoute(router, {
  method: 'post',
  path: '/instances',
  operationId: 'createInstance',
  tags: ['Instances'],
  summary: '创建 Agent 实例',
  description: '为当前用户创建新的 Agent 实例，包括启动 E2B 沙箱、配置模型和渠道信息。支持异步模式创建。',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: CreateInstanceBody } } },
  },
  responses: {
    200: {
      description: '创建成功',
      content: { 'application/json': { schema: InstanceResponseSchema } },
    },
    202: {
      description: '已创建实例记录，后台继续从备份恢复 Sandbox',
      content: { 'application/json': { schema: InstanceResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    500: errorResponse,
  },
}, requireAuth, validate({ body: CreateInstanceBody }), async (req, res) => {
  const {
    name,
    agentTypeId = null,
    description = null,
    modelId = null,
    configJson = {},
    channelType = null,
    channelClientId = null,
    channelClientSecret = null,
    modelName: inputModelName = null,
    customVars = null,
    async: asyncMode = false,
    groupId = null,
    selectedSkillSpaceIds = [],
    backupId = null
  } = req.body

  const hasConfigJson = Object.prototype.hasOwnProperty.call(req.body, 'configJson')
  let restoreFromBackup = null
  let effectiveUserId = req.user.id
  let effectiveGroupId = groupId || null
  let effectiveAgentTypeId = agentTypeId
  let effectiveModelId = modelId
  let effectiveConfigJson = configJson
  if (backupId) {
    try {
      const restoreOptions = await resolveCreateInstanceFromBackupOptions({
        actorPrincipalId: req.user.id,
        actorProfile: req.userProfile,
        backupId: String(backupId),
        requestedAgentTypeId: agentTypeId,
        requestedModelId: modelId,
        hasConfigJson,
        configJson
      })
      restoreFromBackup = restoreOptions.restoreFromBackup
      effectiveUserId = restoreOptions.effectiveUserId
      effectiveGroupId = restoreOptions.effectiveGroupId
      effectiveAgentTypeId = restoreOptions.effectiveAgentTypeId
      effectiveModelId = restoreOptions.effectiveModelId
      effectiveConfigJson = restoreOptions.effectiveConfigJson
    } catch (error) {
      if (error instanceof CheckpointBackupError) {
        return sendCheckpointBackupError(res, error)
      }
      return sendInstanceAccessError(res, error)
    }
  }

  // Validate customVars: must be null or a plain object with all string values
  if (customVars !== null && customVars !== undefined) {
    if (typeof customVars !== 'object' || Array.isArray(customVars)) {
      return res.status(400).json({ success: false, error: 'customVars must be a plain object' })
    }
    for (const [key, value] of Object.entries(customVars)) {
      if (typeof value !== 'string') {
        return res.status(400).json({ success: false, error: `customVars["${key}"] must be a string, got ${typeof value}` })
      }
    }
  }

  try {
    const instance = await createInstanceForUser({
      userId: effectiveUserId,
      userProfile: req.userProfile,
      name,
      description,
      inputAgentTypeId: effectiveAgentTypeId,
      inputModelId: effectiveModelId,
      inputModelName,
      configJson: effectiveConfigJson,
      channelType,
      channelClientId,
      channelClientSecret,
      customVars,
      logPrefix: 'POST /api/instances',
      asyncMode: !!asyncMode,
      groupId: effectiveGroupId,
      actorPrincipalId: req.user.id,
      actorProfile: req.userProfile,
      selectedSkillSpaceIds,
      restoreFromBackup
    })

    res.status(restoreFromBackup ? 202 : 200).json({ success: true, instance })
  } catch (error) {
    if (error instanceof CheckpointBackupError) {
      return sendCheckpointBackupError(res, error)
    }
    if (error instanceof ProvisionError) {
      return res.status(error.status).json({ success: false, error: error.message })
    }
    console.error('Create instance error:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

// NOTE: /instances/overview must be declared BEFORE /instances/{instanceId}
// so Express doesn't match "overview" as the instanceId param.
/**
 * Get user overview stats (for user dashboard)
 * GET /api/instances/overview
 * Returns: totalInstances, todayTokenUsage, aiGatewayEnabled
 */
defineRoute(router, {
  method: 'get',
  path: '/instances/overview',
  operationId: 'getInstancesOverview',
  tags: ['Instances'],
  summary: '获取用户概览统计',
  description: '返回当前用户的实例总数、今日和本月 Token 用量、用量配额等仪表盘概览数据。',
  security: [{ bearerAuth: [] }],
  request: {
    query: InstancesOverviewQuerySchema,
  },
  responses: {
    200: {
      description: '成功返回概览数据',
      content: { 'application/json': { schema: InstancesOverviewResponseSchema } },
    },
    401: errorResponse,
    500: errorResponse,
  },
}, requireAuth, validate({ query: InstancesOverviewQuerySchema }), async (req, res) => {
  const userId = req.user.id
  const scope = req.query.scope || 'private'
  const groupId = req.query.groupId || ''

  // Get user profile (for email to derive consumer name)
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('principal_profiles')
    .select('id, principal_type, username:name, email, consumer_id')
    .eq('id', userId)
    .eq('principal_type', 'user')
    .maybeSingle()

  if (profileError) {
    console.error('Failed to get user profile:', profileError)
  }

  const memberships = await getActiveGroupMemberships(userId)
  const groupIds = memberships.map(membership => membership.group_id).filter(isUuid)
  if (scope === 'group' && (!groupId || !groupIds.includes(groupId))) {
    return res.status(403).json({ success: false, error: 'Group access denied' })
  }

  const groupCount = memberships.length

  let privateInstances = 0
  if (scope !== 'group') {
    const { count: privateCountResult, error: privateCountError } = await supabaseAdmin
      .from('agent_instances')
      .select('id', { count: 'exact', head: true })
      .eq('principal_id', userId)

    if (privateCountError) {
      console.error('Failed to count private instances:', privateCountError)
    } else {
      privateInstances = privateCountResult || 0
    }
  }

  let groupInstances = 0
  const groupInstancePrincipalIds = scope === 'group' ? [groupId] : groupIds
  if (groupInstancePrincipalIds.length > 0) {
    const { count: groupCountResult, error: groupCountError } = await supabaseAdmin
      .from('agent_instances')
      .select('id', { count: 'exact', head: true })
      .in('principal_id', groupInstancePrincipalIds)

    if (groupCountError) {
      console.error('Failed to count group instances:', groupCountError)
    } else {
      groupInstances = groupCountResult || 0
    }
  }

  // Get token usage and limits (if user has a gateway provider consumer)
  let todayTokenUsage = null
  let monthlyTokenUsage = null
  let slsEnabled = false
  let effectiveDailyLimit = 0
  let effectiveMonthlyLimit = 0
  let usageUnit = 'token'
  let limitUnit = 'token'

  if (profile) {
    // Find the currently enabled gateway provider that supports stats
    let gatewayProvider = null
    try {
      const { data: enabledConfigs } = await supabaseAdmin
        .from('provider_config')
        .select('name')
        .eq('enabled', true)

      for (const cfg of (enabledConfigs || [])) {
        const provider = await createProviderFromDB(cfg.name)
        if (provider.supportsStats()) {
          gatewayProvider = provider
          break
        }
      }
    } catch (e) {
      console.log('No enabled gateway providers found:', e.message)
    }

    if (gatewayProvider) {
      let targetProfiles = []
      if (scope === 'private') {
        targetProfiles = [profile]
      } else if (scope === 'group') {
        const { data: groupProfile, error: groupProfileError } = await supabaseAdmin
          .from('principal_profiles')
          .select('id, principal_type, name, email, consumer_id')
          .eq('id', groupId)
          .eq('principal_type', 'group')
          .maybeSingle()

        if (groupProfileError) {
          console.error('Failed to get group profile:', groupProfileError)
        }
        if (groupProfile) {
          targetProfiles = [groupProfile]
        }
      }

      const getConsumerName = (principalProfile) => {
        if (!principalProfile?.consumer_id) return ''
        return gatewayProvider.getType() === 'LiteLLM'
          ? principalProfile.consumer_id
          : sanitizeConsumerName(principalProfile.principal_type === 'group' ? principalProfile.name : principalProfile.email)
      }

      const consumers = targetProfiles
        .map(targetProfile => ({ profile: targetProfile, consumerName: getConsumerName(targetProfile) }))
        .filter(target => target.consumerName)

      if (consumers.length > 0) {
        const usageRows = await Promise.all(consumers.map(async target => {
          const [todayData, monthlyData] = await Promise.all([
            gatewayProvider.getUserUsage(target.consumerName, 1),
            gatewayProvider.getUserUsage(target.consumerName, 30)
          ])
          return { todayData, monthlyData }
        }))

        todayTokenUsage = usageRows.reduce((sum, row) => sum + (row.todayData?.value || 0), 0)
        monthlyTokenUsage = usageRows.reduce((sum, row) => sum + (row.monthlyData?.value || 0), 0)
        const firstUsage = usageRows.find(row => row.todayData || row.monthlyData)
        if (firstUsage?.todayData?.unit || firstUsage?.monthlyData?.unit) {
          usageUnit = firstUsage.todayData?.unit || firstUsage.monthlyData?.unit || usageUnit
        }
        slsEnabled = true
      }

      if (targetProfiles.length === 1 && typeof gatewayProvider.getPrincipalLimit === 'function') {
        const limitConfig = await gatewayProvider.getPrincipalLimit(targetProfiles[0].id)
        const effectiveBudgets = limitConfig.effectiveBudgets || []
        const daily = effectiveBudgets.find(l => l.timeRate === 'daily')
        const monthly = effectiveBudgets.find(l => l.timeRate === 'monthly')
        effectiveDailyLimit = daily?.value || 0
        effectiveMonthlyLimit = monthly?.value || 0
        limitUnit = daily?.unit || monthly?.unit || limitUnit
      }
    }
  }

  res.json({
    success: true,
    overview: {
      totalInstances: (privateInstances || 0) + groupInstances,
      privateInstances,
      groupInstances,
      groupCount,
      todayTokenUsage,
      monthlyTokenUsage,
      effectiveDailyLimit,
      effectiveMonthlyLimit,
      usageUnit,
      limitUnit,
      aiGatewayEnabled: true,
      slsEnabled
    }
  })
})

/**
 * List Agent instances (User only - shows only own instances)
 * GET /api/instances
 * Query: { page?, pageSize?, status?, search? }
 */
defineRoute(router, {
  method: 'get',
  path: '/instances',
  operationId: 'listInstances',
  tags: ['Instances'],
  summary: '列出当前用户的实例',
  description: '分页查询当前登录用户拥有的 Agent 实例列表，支持按状态和名称过滤。',
  security: [{ bearerAuth: [] }],
  request: {
    query: ListInstancesQuerySchema,
  },
  responses: {
    200: {
      description: '成功返回实例列表',
      content: { 'application/json': { schema: ListInstancesResponseSchema } },
    },
    401: errorResponse,
    500: errorResponse,
  },
}, requireAuth, validate({ query: ListInstancesQuerySchema }), async (req, res) => {
  const userId = req.user.id
  if (!isUuid(userId)) {
    return res.status(401).json({ success: false, error: 'Invalid user identity' })
  }

  const page = parseInt(req.query.page) || 1
  const pageSize = Math.min(parseInt(req.query.pageSize) || 20, 100)
  const status = req.query.status
  const search = req.query.search || ''
  const scope = typeof req.query.scope === 'string' ? req.query.scope : ''
  const groupId = typeof req.query.groupId === 'string' ? req.query.groupId : ''
  const offset = (page - 1) * pageSize

  if (scope && !['private', 'group'].includes(scope)) {
    return res.status(400).json({ success: false, error: 'Invalid scope' })
  }
  if (groupId && !isUuid(groupId)) {
    return res.status(400).json({ success: false, error: 'Invalid groupId' })
  }

  const memberships = await getActiveGroupMemberships(userId)
  const groupIds = memberships.map(membership => membership.group_id).filter(isUuid)

  let query = supabaseAdmin
    .from('agent_instances')
    .select('*', { count: 'exact' })

  if (groupId || scope === 'group') {
    if (!groupId) {
      return res.json({
        success: true,
        instances: [],
        pagination: { page, pageSize, total: 0, totalPages: 0 }
      })
    }
    if (!groupIds.includes(groupId)) {
      return res.json({
        success: true,
        instances: [],
        pagination: { page, pageSize, total: 0, totalPages: 0 }
      })
    }
    query = query.eq('principal_id', groupId)
  } else {
    query = query.eq('principal_id', userId)
  }

  if (status) query = query.eq('status', status)
  if (search) query = query.ilike('name', `%${search}%`)

  query = query.order('created_at', { ascending: false }).range(offset, offset + pageSize - 1)

  const { data: instances, error, count } = await query

  if (error) throw error

  // Fetch model info and agent type info separately
  let enrichedInstances = instances || []
  if (instances && instances.length > 0) {
    const modelIds = [...new Set(instances.map(i => i.model_id).filter(Boolean))]
    const agentTypeIds = [...new Set(instances.map(i => i.agent_type_id).filter(Boolean))]
    let modelMap = new Map()
    let agentTypeMap = new Map()
    let ownershipMaps = { principalMap: new Map(), groupMap: new Map() }

    const fetchPromises = []
    if (modelIds.length > 0) {
      fetchPromises.push(
        supabaseAdmin.from('ai_models').select('id, name, provider').in('id', modelIds)
          .then(({ data }) => { modelMap = new Map((data || []).map(m => [m.id, m])) })
      )
    }
    if (agentTypeIds.length > 0) {
      fetchPromises.push(
        supabaseAdmin.from('agent_types').select('id, code, name, sandbox_template_id').in('id', agentTypeIds)
          .then(({ data }) => { agentTypeMap = new Map((data || []).map(at => [at.id, at])) })
      )
    }
    fetchPromises.push(
      loadInstancePrincipalMaps(instances).then(result => { ownershipMaps = result })
    )
    await Promise.all(fetchPromises)
    const [upgradeTargets, sandboxImages] = await Promise.all([
      getUpgradeTargets([...agentTypeMap.values()], instances),
      getCurrentSandboxImages(instances, [...agentTypeMap.values()])
    ])
    await persistRuntimeStatuses(instances, sandboxImages)

    enrichedInstances = instances.map(inst => {
      const runtimeStatus = getRuntimeStatusFromSandbox(inst, sandboxImages)
      const calibrated = runtimeStatus !== inst.status ? { ...inst, status: runtimeStatus } : inst
      return {
        ...calibrated,
        ai_models: inst.model_id ? modelMap.get(inst.model_id) || null : null,
        agent_type: inst.agent_type_id ? agentTypeMap.get(inst.agent_type_id) || null : null,
        ...buildInstanceOwnership(
          inst,
          ownershipMaps.principalMap,
          ownershipMaps.groupMap,
          userId,
          memberships,
          req.userProfile
        ),
        sandbox_upgrade: buildInstanceUpgradeInfo(calibrated, upgradeTargets, sandboxImages)
      }
    })
  }

  res.json({
    success: true,
    instances: enrichedInstances,
    pagination: {
      page,
      pageSize,
      total: count || 0,
      totalPages: Math.ceil((count || 0) / pageSize)
    }
  })

})

/**
 * List all Agent instances (Admin only)
 * GET /api/admin/instances
 * Query: { page?, pageSize?, status?, search?, username? }
 */
defineRoute(router, {
  method: 'get',
  path: '/admin/instances',
  operationId: 'listAdminInstances',
  tags: ['Instances (Admin)'],
  summary: '管理员列出所有实例',
  description: '管理员分页查询全部用户的 Agent 实例，支持按状态、名称和用户名过滤。',
  security: [{ bearerAuth: [] }],
  request: {
    query: ListAdminInstancesQuerySchema,
  },
  responses: {
    200: {
      description: '成功返回实例列表',
      content: { 'application/json': { schema: ListInstancesResponseSchema } },
    },
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAuth, validate({ query: ListAdminInstancesQuerySchema }), async (req, res) => {
  const isAdmin = isPlatformAdminProfile(req.userProfile)

  if (!isAdmin) {
    return res.status(403).json({
      success: false,
      error: 'Admin access required'
    })
  }

  const page = parseInt(req.query.page) || 1
  const pageSize = Math.min(parseInt(req.query.pageSize) || 20, 100)
  const status = req.query.status
  const search = req.query.search || ''
  const usernameFilter = req.query.username || ''
  const scope = typeof req.query.scope === 'string' ? req.query.scope : ''
  const groupId = typeof req.query.groupId === 'string' ? req.query.groupId : ''
  const offset = (page - 1) * pageSize

  if (scope && !['private', 'group'].includes(scope)) {
    return res.status(400).json({ success: false, error: 'Invalid scope' })
  }
  if (groupId && !isUuid(groupId)) {
    return res.status(400).json({ success: false, error: 'Invalid groupId' })
  }

  // For admin with username filter, first get matching user principal IDs.
  let userIds = null
  if (usernameFilter && !groupId && scope !== 'group') {
    const { data: profiles } = await supabaseAdmin
      .from('principal_profiles')
      .select('principal_id:id')
      .eq('principal_type', 'user')
      .ilike('name', `%${usernameFilter}%`)

    userIds = (profiles || []).map(p => p.principal_id)
    if (userIds.length === 0) {
      return res.json({
        success: true,
        instances: [],
        pagination: { page, pageSize, total: 0, totalPages: 0 }
      })
    }
  }

  let query = supabaseAdmin
    .from('agent_instances')
    .select('*', { count: 'exact' })

  if (status) query = query.eq('status', status)
  if (search) query = query.ilike('name', `%${search}%`)
  if (userIds) query = query.in('principal_id', userIds)
  if (groupId || scope === 'group') {
    if (!groupId) {
      return res.json({
        success: true,
        instances: [],
        pagination: { page, pageSize, total: 0, totalPages: 0 }
      })
    }
    query = query.eq('principal_id', groupId)
  } else if (scope === 'private') {
    const { data: groups } = await supabaseAdmin
      .from('principal_profiles')
      .select('id')
      .eq('principal_type', 'group')
    const groupPrincipalIds = (groups || []).map(group => group.id).filter(isUuid)
    if (groupPrincipalIds.length > 0) {
      query = query.not('principal_id', 'in', `(${groupPrincipalIds.join(',')})`)
    }
  }

  query = query.order('created_at', { ascending: false }).range(offset, offset + pageSize - 1)

  const { data: instances, error, count } = await query

  if (error) throw error

  // Fetch model info, agent type info, and usernames in parallel
  let finalInstances = instances || []
  if (instances && instances.length > 0) {
    const modelIds = [...new Set(instances.map(i => i.model_id).filter(Boolean))]
    const agentTypeIds = [...new Set(instances.map(i => i.agent_type_id).filter(Boolean))]
    let modelMap = new Map()
    let agentTypeMap = new Map()
    let ownershipMaps = { principalMap: new Map(), groupMap: new Map() }

    const fetchPromises = []
    if (modelIds.length > 0) {
      fetchPromises.push(
        supabaseAdmin.from('ai_models').select('id, name, provider').in('id', modelIds)
          .then(({ data }) => { modelMap = new Map((data || []).map(m => [m.id, m])) })
      )
    }
    if (agentTypeIds.length > 0) {
      fetchPromises.push(
        supabaseAdmin.from('agent_types').select('id, code, name, sandbox_template_id').in('id', agentTypeIds)
          .then(({ data }) => { agentTypeMap = new Map((data || []).map(at => [at.id, at])) })
      )
    }
    fetchPromises.push(
      loadInstancePrincipalMaps(instances).then(result => { ownershipMaps = result })
    )
    await Promise.all(fetchPromises)
    const [upgradeTargets, sandboxImages] = await Promise.all([
      getUpgradeTargets([...agentTypeMap.values()], instances),
      getCurrentSandboxImages(instances, [...agentTypeMap.values()])
    ])
    await persistRuntimeStatuses(instances, sandboxImages)

    finalInstances = instances.map(inst => {
      const runtimeStatus = getRuntimeStatusFromSandbox(inst, sandboxImages)
      const calibrated = runtimeStatus !== inst.status ? { ...inst, status: runtimeStatus } : inst
      return {
        ...calibrated,
        ai_models: inst.model_id ? modelMap.get(inst.model_id) || null : null,
        agent_type: inst.agent_type_id ? agentTypeMap.get(inst.agent_type_id) || null : null,
        username: ownershipMaps.principalMap.get(inst.principal_id)?.username || '未知用户',
        ...buildInstanceOwnership(
          inst,
          ownershipMaps.principalMap,
          ownershipMaps.groupMap,
          req.user.id,
          [],
          req.userProfile
        ),
        sandbox_upgrade: buildInstanceUpgradeInfo(calibrated, upgradeTargets, sandboxImages)
      }
    })
  }

  res.json({
    success: true,
    instances: finalInstances,
    pagination: {
      page,
      pageSize,
      total: count || 0,
      totalPages: Math.ceil((count || 0) / pageSize)
    }
  })

})

/**
 * Create a new Agent instance on behalf of the given user (Admin only).
 * POST /api/admin/instances
 * Body: { userId | email | groupId, name, agentTypeId?, description?, modelId?, modelName?, configJson?, channelType?, channelClientId?, channelClientSecret? }
 */
defineRoute(router, {
  method: 'post',
  path: '/admin/instances',
  operationId: 'createAdminInstance',
  tags: ['Instances (Admin)'],
  summary: '管理员为指定用户创建实例',
  description: '管理员通过 userId 或 email 指定目标用户，为其创建 Agent 实例。若用户不存在则自动创建。',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: CreateAdminInstanceBody } } },
  },
  responses: {
    200: {
      description: '创建成功',
      content: { 'application/json': { schema: InstanceResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: CreateAdminInstanceBody }), async (req, res) => {
  const {
    userId,
    email,
    username,
    name,
    agentTypeId,
    description,
    modelId,
    configJson,
    channelType,
    channelClientId,
    channelClientSecret,
    modelName: inputModelName,
    customVars = null,
    async: asyncMode = false,
    groupId = null,
    selectedSkillSpaceIds = []
  } = req.body

  // Resolve target user profile by userId/email. For group-owned admin creates,
  // the admin is the creator while quota/ownership are scoped to groupId.
  let targetProfile = null
  if (groupId && !userId && !email) {
    targetProfile = req.userProfile
  } else if (userId) {
    const { data } = await supabaseAdmin
      .from('principal_profiles')
      .select('*')
      .eq('id', userId)
      .eq('principal_type', 'user')
      .maybeSingle()
    targetProfile = data
  } else {
    const { data } = await supabaseAdmin
      .from('principal_profiles')
      .select('*')
      .eq('email', email)
      .eq('principal_type', 'user')
      .maybeSingle()
    targetProfile = data
  }

  if (!targetProfile) {
    if (!email) {
      return res.status(404).json({ success: false, error: 'Target user not found' })
    }
    console.log(`[POST /api/admin/instances] auto-creating user for ${email}`)
    try {
      targetProfile = await ensureUserByEmail({ email, username: username || email.split('@')[0] })
    } catch (err) {
      return res.status(500).json({ success: false, error: `自动创建用户失败: ${err.message}` })
    }
  }

  const targetUserId = targetProfile.principal_id || targetProfile.id

  try {
    const instance = await createInstanceForUser({
      userId: targetUserId,
      userProfile: targetProfile,
      name,
      description,
      inputAgentTypeId: agentTypeId,
      inputModelId: modelId,
      inputModelName,
      configJson,
      channelType,
      channelClientId,
      channelClientSecret,
      customVars,
      logPrefix: `POST /api/admin/instances`,
      asyncMode: !!asyncMode,
      groupId,
      actorPrincipalId: req.user.id,
      actorProfile: req.userProfile,
      selectedSkillSpaceIds
    })

    res.json({ success: true, instance })
  } catch (error) {
    if (error instanceof ProvisionError) {
      return res.status(error.status).json({ success: false, error: error.message })
    }
    console.error('Admin create instance error:', error)
    res.status(500).json({ success: false, error: error.message })
  }
})

/**
 * Get Agent instance details
 * GET /api/instances/:instanceId
 */
defineRoute(router, {
  method: 'get',
  path: '/instances/{instanceId}',
  operationId: 'getInstanceById',
  tags: ['Instances'],
  summary: '获取实例详情',
  description: '根据实例 ID 获取完整的实例信息，包括模型、智能体类型、渠道配置、沙箱状态和访问 URL。',
  security: [{ bearerAuth: [] }],
  request: {
    params: InstanceIdParamsSchema,
  },
  responses: {
    200: {
      description: '成功返回实例详情',
      content: { 'application/json': { schema: InstanceResponseSchema } },
    },
    401: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAuth, validate({ params: InstanceIdParamsSchema }), async (req, res) => {
  const { instanceId } = req.params
  let instance
  let memberships
  try {
    const access = await assertInstanceAccess({
      principalId: req.user.id,
      userProfile: req.userProfile,
      instanceId,
      action: 'write'
    })
    instance = access.instance
    memberships = access.memberships
  } catch (error) {
    return sendInstanceAccessError(res, error)
  }

  // Fetch model info separately
  let modelInfo = null
  if (instance.model_id) {
    const { data: model } = await supabaseAdmin
      .from('ai_models')
      .select('id, name, provider')
      .eq('id', instance.model_id)
      .single()
    modelInfo = model
  }

  let agentTypeInfo = null
  if (instance.agent_type_id) {
    const { data: fetchedAgentType } = await supabaseAdmin
      .from('agent_types')
      .select('id, code, name, sandbox_template_id, modify_model_command, modify_channel_command, supports_channels, user_terminal_enabled')
      .eq('id', instance.agent_type_id)
      .single()
    if (fetchedAgentType) {
      agentTypeInfo = {
        ...fetchedAgentType,
        supports_modify_model: !!(fetchedAgentType.modify_model_command && fetchedAgentType.modify_model_command.trim()),
        supports_modify_channel: !!(fetchedAgentType.modify_channel_command && fetchedAgentType.modify_channel_command.trim())
      }
    }
  }

  // Fetch channel configs
  let channelConfigs = []
  try {
    const { data: channels, error: channelError } = await supabaseAdmin
      .from('instance_channel_configs')
      .select('channel_type, client_id, client_secret, is_configured')
      .eq('instance_id', instanceId)

    if (!channelError && channels) {
      // Decrypt and mask sensitive fields for display
      channelConfigs = channels.map(ch => {
        let maskedClientId = ''
        let maskedClientSecret = ''
        try {
          const decryptedId = decryptApiKey(ch.client_id)
          maskedClientId = decryptedId.length > 6
            ? decryptedId.substring(0, 3) + '***' + decryptedId.substring(decryptedId.length - 3)
            : '***'
        } catch (e) {
          maskedClientId = ch.client_id?.substring(0, 3) + '***' || '***'
        }
        try {
          const decryptedSecret = decryptApiKey(ch.client_secret)
          maskedClientSecret = decryptedSecret.length > 6
            ? decryptedSecret.substring(0, 3) + '***' + decryptedSecret.substring(decryptedSecret.length - 3)
            : '***'
        } catch (e) {
          maskedClientSecret = '***'
        }
        return {
          channel_type: ch.channel_type,
          client_id: maskedClientId,
          client_secret: maskedClientSecret,
          is_configured: ch.is_configured
        }
      })
    }
  } catch (e) {
    console.error('Error fetching channel configs:', e)
  }

  // Auto-calibrate sandbox status
  let calibratedStatus = instance.status
  let sandboxStatus = null
  if (instance.sandbox_id && E2B_API_KEY &&
      instance.status !== 'starting' && instance.status !== 'stopping') {
    sandboxStatus = await getSandboxStatus(instance.sandbox_id)

    if (sandboxStatus) {
      let expectedStatus = instance.status
      if (sandboxStatus === 'running') {
        expectedStatus = 'running'
      } else if (sandboxStatus === 'paused' || sandboxStatus === 'not_found') {
        expectedStatus = 'stopped'
      }

      if (expectedStatus !== instance.status) {
        if (shouldPersistRuntimeStatus(instance, expectedStatus)) {
          await supabaseAdmin
            .from('agent_instances')
            .update({ status: expectedStatus, updated_at: new Date().toISOString() })
            .eq('id', instanceId)
          console.log(`🔍 Auto-calibrated instance ${instanceId}: ${instance.status} -> ${expectedStatus}`)
        }
        calibratedStatus = expectedStatus
      }
    }
  }

  const detailUpgradeTargets = agentTypeInfo
    ? await getUpgradeTargets([agentTypeInfo], [{ ...instance, status: calibratedStatus }])
    : new Map()
  const detailSandboxImages = await getCurrentSandboxImages([{ ...instance, status: calibratedStatus }], agentTypeInfo ? [agentTypeInfo] : [])
  const runtimeStatus = getRuntimeStatusFromSandbox({ ...instance, status: calibratedStatus }, detailSandboxImages)
  if (runtimeStatus !== calibratedStatus) {
    if (shouldPersistRuntimeStatus({ ...instance, status: calibratedStatus }, runtimeStatus)) {
      await supabaseAdmin
        .from('agent_instances')
        .update({ status: runtimeStatus, updated_at: new Date().toISOString() })
        .eq('id', instanceId)
        .eq('status', calibratedStatus)
      console.log(`🔍 Auto-calibrated instance ${instanceId} from Kubernetes pod: ${calibratedStatus} -> ${runtimeStatus}`)
    }
    calibratedStatus = runtimeStatus
  }
  const calibratedInstance = { ...instance, status: calibratedStatus }

  // Recovery: if instance is stuck in 'starting', re-trigger background health check
  // Use activeHealthChecks set to avoid duplicate triggers from polling
  if (calibratedStatus === 'starting' && instance.sandbox_id && E2B_API_KEY
      && !activeHealthChecks.has(instanceId)) {
    activeHealthChecks.add(instanceId)
    // Resolve readiness_check config for health check
    let recoveryReadinessCheck = {}
    if (instance.agent_type_id) {
      try {
        const recoveryAgentType = await getAgentType(instance.agent_type_id)
        if (recoveryAgentType?.readiness_check) {
          recoveryReadinessCheck = recoveryAgentType.readiness_check
        }
      } catch (e) {
        console.warn(`Failed to get agent type for recovery health check: ${e.message}`)
      }
    }
    // Fire-and-forget: re-run health check in background, clean up set when done
    runBackgroundHealthCheck({
      instanceId,
      sandboxId: instance.sandbox_id,
      accessToken: instance.token,
      readinessCheck: recoveryReadinessCheck,
      logPrefix: 'GET /api/instances (recovery)'
    }).finally(() => {
      activeHealthChecks.delete(instanceId)
    })
    console.log(`🔄 Recovery health check triggered for starting instance ${instanceId}`)
  }

  const agentPort = await resolveAgentGatewayPort(instance.agent_type_id, 'instance detail port lookup')

  // Construct sandbox access URL (use agent-specific port)
  let sandboxUrl = null
  let agentAuthType = AgentAuthType.NoAuth
  const shouldUseAgentGatewayUrl = AGENT_GATEWAY_ACCESS_MODE !== 'legacy'
  if (instance.sandbox_id && calibratedStatus === 'running') {
    if (shouldUseAgentGatewayUrl) {
      sandboxUrl = buildAgentGatewaySandboxUrl({
        instanceId: instance.id
      })
      if (sandboxUrl) {
        agentAuthType = AgentAuthType.Auth
      }
    }
    if (!sandboxUrl) {
      const host = buildE2BUpstreamHost({
        agentPort,
        sandboxId: instance.sandbox_id
      })
      if (host) {
        sandboxUrl = `https://${host}${instance.token ? `?token=${instance.token}` : ''}`
        agentAuthType = AgentAuthType.NoAuth
      }
    }
  }

  // Generate hosts entries when E2B is on a public network (DNS-resolved at startup).
  // In local-dev, always show hosts so developers can configure /etc/hosts manually.
  // In cloud environments, only show hosts when the resolved E2B IP is public —
  // if it's private the pod can reach E2B directly inside the cluster without hosts.
  let hostsEntries = null
  const shouldShowHosts = agentAuthType === AgentAuthType.NoAuth &&
    (DEPLOY_ENVIRONMENT === 'local-dev' || E2B_NEEDS_HOSTS)
  if (instance.sandbox_id && shouldShowHosts && E2B_HOSTS_IP) {
    const host = buildE2BUpstreamHost({
      agentPort,
      sandboxId: instance.sandbox_id
    })
    hostsEntries = host ? [`${E2B_HOSTS_IP} ${host}`] : null
  }

  const ownershipMaps = await loadInstancePrincipalMaps([instance])
  const sandboxUpgrade = buildInstanceUpgradeInfo(calibratedInstance, detailUpgradeTargets, detailSandboxImages)
  const responseAgentImage = instance.agent_image || sandboxUpgrade.CurrentImage || null
  let responseConfigJson = instance.config_json
  const detailUpdate = {}
  if (!instance.agent_image && responseAgentImage) {
    detailUpdate.agent_image = responseAgentImage
  }
  if (calibratedStatus === 'running') {
    const restoreConfig = completeCheckpointRestoreConfigJson(instance.config_json)
    if (restoreConfig.changed) {
      responseConfigJson = restoreConfig.configJson
      detailUpdate.config_json = restoreConfig.configJson
    }
  }
  if (Object.keys(detailUpdate).length > 0) {
    try {
      await supabaseAdmin
        .from('agent_instances')
        .update({ ...detailUpdate, updated_at: new Date().toISOString() })
        .eq('id', instanceId)
    } catch (error) {
      console.warn(`Failed to persist runtime detail fields for instance ${instanceId}: ${error.message}`)
    }
  }

  res.json({
    success: true,
    instance: {
      ...instance,
      agent_image: responseAgentImage,
      config_json: responseConfigJson,
      ai_models: modelInfo,
      agent_type: agentTypeInfo,
      ...buildInstanceOwnership(
        instance,
        ownershipMaps.principalMap,
        ownershipMaps.groupMap,
        req.user.id,
        memberships,
        req.userProfile
      ),
      status: calibratedStatus,
      sandboxUrl,
      sandboxStatus,
      sandbox_upgrade: sandboxUpgrade,
      instance_channel_configs: channelConfigs,
      hostsEntries
    }
  })

})

/**
 * Start a manual backup for the current instance.
 * POST /api/instances/:instanceId/backups
 */
defineRoute(router, {
  method: 'post',
  path: '/instances/{instanceId}/backups',
  operationId: 'startInstanceBackup',
  tags: ['Instances'],
  summary: '发起实例备份',
  description: '用户为当前有权限的实例发起一次立即备份；用户侧不提交 OOS 参数。',
  security: [{ bearerAuth: [] }],
  request: {
    params: InstanceIdParamsSchema,
    body: { content: { 'application/json': { schema: EmptyBackupBody } } },
  },
  responses: {
    202: {
      description: '备份请求已提交',
      content: { 'application/json': { schema: StartInstanceBackupResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    404: errorResponse,
    409: errorResponse,
    500: errorResponse,
  },
}, requireAuth, validate({ params: InstanceIdParamsSchema, body: EmptyBackupBody }), async (req, res) => {
  const { instanceId } = req.params
  let instance
  try {
    const access = await assertInstanceAccess({
      principalId: req.user.id,
      userProfile: req.userProfile,
      instanceId,
      action: 'read'
    })
    instance = access.instance
  } catch (error) {
    return sendInstanceAccessError(res, error)
  }

  try {
    const result = await startInstanceCheckpointBackup(instance)
    res.status(202).json({
      success: true,
      backupId: result.backupId
    })
  } catch (error) {
    return sendCheckpointBackupError(res, error)
  }
})

/**
 * List restorable backups for an instance.
 * GET /api/instances/:instanceId/backups
 */
defineRoute(router, {
  method: 'get',
  path: '/instances/{instanceId}/backups',
  operationId: 'listInstanceBackups',
  tags: ['Instances'],
  summary: '查询实例可恢复备份点',
  description: '按 instanceId 动态查询 Checkpoint 和 snapshot ConfigMap，只返回可恢复备份点。',
  security: [{ bearerAuth: [] }],
  request: {
    params: InstanceIdParamsSchema,
    query: ListInstanceBackupsQuerySchema,
  },
  responses: {
    200: {
      description: '成功返回可恢复备份点',
      content: { 'application/json': { schema: ListInstanceBackupsResponseSchema } },
    },
    401: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAuth, validate({ params: InstanceIdParamsSchema, query: ListInstanceBackupsQuerySchema }), async (req, res) => {
  const { instanceId } = req.params
  let instance
  try {
    const access = await assertInstanceAccess({
      principalId: req.user.id,
      userProfile: req.userProfile,
      instanceId,
      action: 'read'
    })
    instance = access.instance
  } catch (error) {
    return sendInstanceAccessError(res, error)
  }

  try {
    const limit = Number.parseInt(req.query.limit, 10)
    const items = await listInstanceCheckpointBackups(instance, {
      limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 50
    })
    res.json({ success: true, latestOperation: null, items })
  } catch (error) {
    return sendCheckpointBackupError(res, error)
  }
})

/**
 * Create a new instance from a backup without mutating the source instance.
 * POST /api/instances/:instanceId/backups/:backupId/restore
 */
defineRoute(router, {
  method: 'post',
  path: '/instances/{instanceId}/backups/{backupId}/restore',
  operationId: 'restoreInstanceBackup',
  tags: ['Instances'],
  summary: '从备份创建新实例',
  description: '用户从指定 backupId 创建一个新实例；源实例和源 Sandbox 保持不变。',
  security: [{ bearerAuth: [] }],
  request: {
    params: BackupParamsSchema,
    body: { content: { 'application/json': { schema: RestoreBackupBody } } },
  },
  responses: {
    202: {
      description: '恢复请求已提交',
      content: { 'application/json': { schema: RestoreInstanceBackupResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    404: errorResponse,
    409: errorResponse,
    500: errorResponse,
  },
}, requireAuth, validate({ params: BackupParamsSchema, body: RestoreBackupBody }), async (req, res) => {
  const { instanceId, backupId } = req.params
  let instance
  try {
    const access = await assertInstanceAccess({
      principalId: req.user.id,
      userProfile: req.userProfile,
      instanceId,
      action: 'read'
    })
    instance = access.instance
  } catch (error) {
    return sendInstanceAccessError(res, error)
  }

  try {
    const restoreTargetPrincipal = await resolveRestoreTargetForSourceInstance({
      actorPrincipalId: req.user.id,
      sourceInstance: instance
    })
    const suffix = Date.now().toString(36).slice(-6)
    const requestedName = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    const result = await createInstanceForUser({
      userId: restoreTargetPrincipal.userId,
      userProfile: req.userProfile,
      name: requestedName || `${instance.name || 'instance'}-restore-${suffix}`,
      description: instance.description || null,
      inputAgentTypeId: instance.agent_type_id || null,
      inputModelId: instance.model_id || null,
      configJson: instance.config_json || {},
      logPrefix: 'POST /api/instances/:instanceId/backups/:backupId/restore',
      asyncMode: true,
      groupId: restoreTargetPrincipal.groupId,
      actorPrincipalId: req.user.id,
      actorProfile: req.userProfile,
      restoreFromBackup: {
        backupId,
        sourceInstance: instance
      }
    })
    res.status(202).json({
      success: true,
      instanceId: result.id,
      sourceInstanceId: instance.id,
      backupId,
      sandboxId: result.sandboxId || null
    })
  } catch (error) {
    if (error instanceof ProvisionError) {
      return res.status(error.status).json({ success: false, error: error.message })
    }
    if (error instanceof CheckpointBackupError) {
      return sendCheckpointBackupError(res, error)
    }
    console.error('Create instance from backup error:', error)
    return res.status(500).json({ success: false, error: error.message })
  }
})

/**
 * Delete OpenClaw instance and kill E2B sandbox
 * DELETE /api/instances/:instanceId
 */
defineRoute(router, {
  method: 'delete',
  path: '/instances/{instanceId}',
  operationId: 'deleteInstanceById',
  tags: ['Instances'],
  summary: '删除实例及 E2B Sandbox',
  description: '删除指定实例并终止其关联的 E2B 沙箱进程，从数据库中移除实例记录。',
  security: [{ bearerAuth: [] }],
  request: {
    params: InstanceIdParamsSchema,
  },
  responses: {
    200: {
      description: '删除成功',
      content: { 'application/json': { schema: DeleteInstanceResponseSchema } },
    },
    401: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAuth, validate({ params: InstanceIdParamsSchema }), async (req, res) => {
  const { instanceId } = req.params
  let instance
  try {
    const access = await assertInstanceAccess({
      principalId: req.user.id,
      userProfile: req.userProfile,
      instanceId,
      action: 'delete'
    })
    instance = access.instance
  } catch (error) {
    return sendInstanceAccessError(res, error)
  }

  // Kill E2B sandbox first
  if (instance.sandbox_id && E2B_API_KEY) {
    console.log(`🔪 Killing sandbox: ${instance.sandbox_id}...`)
    try {
      const sandbox = await Sandbox.connect(instance.sandbox_id)
      await sandbox.kill()
      console.log(`🚭 Sandbox killed: ${instance.sandbox_id}`)
    } catch (e) {
      const errorMsg = e.message?.toLowerCase() || ''
      // If sandbox is already gone (not found / not running), proceed with DB deletion
      if (errorMsg.includes('not found') || errorMsg.includes('not running') || errorMsg.includes('already dead')) {
        console.warn(`⚠️  Sandbox ${instance.sandbox_id} already released, proceeding with instance deletion: ${e.message}`)
      } else {
        console.error(`Failed to kill sandbox ${instance.sandbox_id}:`, e.message)
        return res.status(500).json({
          success: false,
          error: `Failed to kill sandbox: ${e.message}`
        })
      }
    }
  }

  // Delete instance from database
  const { error: deleteError } = await supabaseAdmin
    .from('agent_instances')
    .delete()
    .eq('id', instanceId)

  if (deleteError) throw deleteError

  console.log(`✅ Instance deleted: ${instanceId}`)

  res.json({
    success: true,
    message: 'Instance deleted successfully',
    instanceId
  })

})

/**
 * Stop OpenClaw instance (pause E2B sandbox)
 * POST /api/instances/:instanceId/stop
 */
defineRoute(router, {
  method: 'post',
  path: '/instances/{instanceId}/stop',
  operationId: 'stopInstanceById',
  tags: ['Instances'],
  summary: '停止实例(暂停 E2B Sandbox)',
  description: '暂停指定实例的 E2B 沙箱，将实例状态变更为 stopped。若实例已停止则直接返回成功。',
  security: [{ bearerAuth: [] }],
  request: {
    params: InstanceIdParamsSchema,
  },
  responses: {
    200: {
      description: '停止成功',
      content: { 'application/json': { schema: InstanceLifecycleResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAuth, validate({ params: InstanceIdParamsSchema }), async (req, res) => {
  const { instanceId } = req.params
  let instance
  try {
    const access = await assertInstanceAccess({
      principalId: req.user.id,
      userProfile: req.userProfile,
      instanceId,
      action: 'write'
    })
    instance = access.instance
  } catch (error) {
    return sendInstanceAccessError(res, error)
  }

  if (!instance.sandbox_id) {
    return res.status(400).json({ success: false, error: 'Instance has no sandbox' })
  }

  if (instance.status === 'stopped' || instance.status === 'stopping') {
    return res.json({
      success: true,
      message: 'Instance is already stopped or stopping',
      instanceId,
      status: instance.status
    })
  }

  // Update status to 'stopping'
  await supabaseAdmin
    .from('agent_instances')
    .update({ status: 'stopping', updated_at: new Date().toISOString() })
    .eq('id', instanceId)

  // Pause sandbox
  console.log(`⏸️  Pausing sandbox: ${instance.sandbox_id}...`)
  try {
    const connectPromise = Sandbox.connect(instance.sandbox_id)
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Connection timeout')), 30000)
    )
    const sandbox = await Promise.race([connectPromise, timeoutPromise])

    await pauseSandbox(sandbox, instance.sandbox_id)
    console.log(`⏸️  Sandbox paused successfully: ${instance.sandbox_id}`)
  } catch (e) {
    console.error(`Failed to pause sandbox ${instance.sandbox_id}:`, e.message)

    const errorMsg = e.message?.toLowerCase() || ''
    if (!(errorMsg.includes('not found') || errorMsg.includes('not running') || errorMsg.includes('already paused'))) {
      await supabaseAdmin
        .from('agent_instances')
        .update({ status: 'running', updated_at: new Date().toISOString() })
        .eq('id', instanceId)
      return res.status(500).json({
        success: false,
        error: `Failed to pause sandbox: ${e.message}`
      })
    }
  }

  // Update final status
  await supabaseAdmin
    .from('agent_instances')
    .update({ status: 'stopped', updated_at: new Date().toISOString() })
    .eq('id', instanceId)

  console.log(`✅ Instance stopped: ${instanceId}`)

  res.json({
    success: true,
    message: 'Instance stopped successfully',
    instanceId,
    status: 'stopped'
  })

})

/**
 * Start OpenClaw instance (resume E2B sandbox)
 * POST /api/instances/:instanceId/start
 */
defineRoute(router, {
  method: 'post',
  path: '/instances/{instanceId}/start',
  operationId: 'startInstanceById',
  tags: ['Instances'],
  summary: '启动实例(恢复 E2B Sandbox)',
  description: '恢复指定实例的 E2B 沙箱运行，将实例状态变更为 running。若实例已在运行则直接返回成功。',
  security: [{ bearerAuth: [] }],
  request: {
    params: InstanceIdParamsSchema,
  },
  responses: {
    200: {
      description: '启动成功',
      content: { 'application/json': { schema: InstanceLifecycleResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAuth, validate({ params: InstanceIdParamsSchema }), async (req, res) => {
  const { instanceId } = req.params
  let instance
  try {
    const access = await assertInstanceAccess({
      principalId: req.user.id,
      userProfile: req.userProfile,
      instanceId,
      action: 'write'
    })
    instance = access.instance
  } catch (error) {
    return sendInstanceAccessError(res, error)
  }

  if (!instance.sandbox_id) {
    return res.status(400).json({ success: false, error: 'Instance has no sandbox' })
  }

  if (instance.status === 'running' || instance.status === 'starting') {
    return res.json({
      success: true,
      message: 'Instance is already running or starting',
      instanceId,
      status: instance.status
    })
  }

  // Update status to 'starting'
  await supabaseAdmin
    .from('agent_instances')
    .update({ status: 'starting', updated_at: new Date().toISOString() })
    .eq('id', instanceId)

  // Resume sandbox
  console.log(`▶️  Resuming sandbox: ${instance.sandbox_id}...`)
  try {
    const startTime = Date.now()
    const sandbox = await resumeSandbox(instance.sandbox_id, 180000)
    const totalTime = (Date.now() - startTime) / 1000
    console.log(`▶️  Sandbox resumed and connected in ${totalTime.toFixed(2)}s`)

    if (sandbox) {
      const startAgentPort = await resolveAgentGatewayPort(instance.agent_type_id, 'start host verification port lookup')
      try {
        const host = sandbox.getHost(startAgentPort)
        console.log(`▶️  Sandbox verified, host: ${host} (port: ${startAgentPort})`)
      } catch (verifyErr) {
        console.warn(`▶️  Sandbox connected but host verification failed: ${verifyErr.message}`)
      }
    }
  } catch (e) {
    console.error(`Failed to resume sandbox ${instance.sandbox_id}:`, e.message)

    const errorMsg = e.message?.toLowerCase() || ''
    if (!(errorMsg.includes('already running') || errorMsg.includes('not paused'))) {
      await supabaseAdmin
        .from('agent_instances')
        .update({ status: 'stopped', updated_at: new Date().toISOString() })
        .eq('id', instanceId)
      return res.status(500).json({
        success: false,
        error: `Failed to resume sandbox: ${e.message}`
      })
    }
  }

  // Update final status
  await supabaseAdmin
    .from('agent_instances')
    .update({ status: 'running', updated_at: new Date().toISOString() })
    .eq('id', instanceId)

  console.log(`✅ Instance started: ${instanceId}`)

  res.json({
    success: true,
    message: 'Instance started successfully',
    instanceId,
    status: 'running'
  })

})

/**
 * Get decrypted channel credentials for an instance
 * GET /api/instances/:id/channel-secret
 * Returns decrypted client_id and client_secret
 */
defineRoute(router, {
  method: 'get',
  path: '/instances/{instanceId}/channel-secret',
  operationId: 'getInstanceChannelSecret',
  tags: ['Instances'],
  summary: '获取实例渠道解密凭据',
  description: '返回指定实例的渠道配置解密后的 client_id 和 client_secret，用于前端展示或配置同步。',
  security: [{ bearerAuth: [] }],
  request: {
    params: InstanceIdParamsSchema,
  },
  responses: {
    200: {
      description: '成功返回解密凭据',
      content: { 'application/json': { schema: InstanceChannelSecretResponseSchema } },
    },
    401: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAuth, validate({ params: InstanceIdParamsSchema }), async (req, res) => {
  const { instanceId: id } = req.params
  try {
    await assertInstanceAccess({
      principalId: req.user.id,
      userProfile: req.userProfile,
      instanceId: id,
      action: 'read'
    })
  } catch (error) {
    return sendInstanceAccessError(res, error)
  }

  // Fetch encrypted channel config
  const { data: channelConfig, error: channelError } = await supabaseAdmin
    .from('instance_channel_configs')
    .select('channel_type, client_id, client_secret')
    .eq('instance_id', id)
    .single()

  if (channelError || !channelConfig) {
    return res.status(404).json({ success: false, error: 'Channel config not found' })
  }

  // Decrypt and return
  let decryptedClientId = ''
  let decryptedClientSecret = ''
  try {
    decryptedClientId = decryptApiKey(channelConfig.client_id)
  } catch (e) {
    decryptedClientId = channelConfig.client_id || ''
  }
  try {
    decryptedClientSecret = decryptApiKey(channelConfig.client_secret)
  } catch (e) {
    decryptedClientSecret = channelConfig.client_secret || ''
  }

  res.json({
    success: true,
    channelType: channelConfig.channel_type,
    clientId: decryptedClientId,
    clientSecret: decryptedClientSecret
  })
})

/**
 * Update OpenClaw instance (model + channel)
 * PUT /api/instances/:id
 * Body: { name?, modelName?, channelType?, channelClientId?, channelClientSecret? }
 *
 * Model / channel updates are applied INCREMENTALLY by invoking a command
 * script inside the sandbox (e.g. /usr/local/bin/run-cmd.sh), so user
 * customizations to the config file are preserved. The script template
 * must be configured by the admin on the agent_type; otherwise the
 * request is rejected with 400.
 */
defineRoute(router, {
  method: 'put',
  path: '/instances/{instanceId}',
  operationId: 'updateInstanceById',
  tags: ['Instances'],
  summary: '更新实例(模型 + 渠道)',
  description: '增量更新实例的模型或渠道配置。通过在沙箱内执行修改脚本实现，保留用户自定义配置。需要 Agent 类型配置了对应的修改命令。',
  security: [{ bearerAuth: [] }],
  request: {
    params: InstanceIdParamsSchema,
    body: { content: { 'application/json': { schema: UpdateInstanceBody } } },
  },
  responses: {
    200: {
      description: '更新成功',
      content: { 'application/json': { schema: UpdateInstanceResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAuth, validate({ body: UpdateInstanceBody, params: InstanceIdParamsSchema }), async (req, res) => {
  const { instanceId: id } = req.params
  if (Object.prototype.hasOwnProperty.call(req.body, 'groupId')) {
    return res.status(400).json({
      success: false,
      error: 'INSTANCE_GROUP_MOVE_NOT_SUPPORTED',
      message: 'Cannot modify instance group after creation'
    })
  }

  const {
    name,
    modelName,
    channelType,
    channelClientId,
    channelClientSecret
  } = req.body

  // Get current instance
  let instance
  try {
    const access = await assertInstanceAccess({
      principalId: req.user.id,
      userProfile: req.userProfile,
      instanceId: id,
      action: 'write'
    })
    instance = access.instance
  } catch (error) {
    return sendInstanceAccessError(res, error)
  }

  // Load agent type early so we can validate modify commands before DB writes
  let instanceAgentType = null
  if (instance.agent_type_id) {
    try { instanceAgentType = await getAgentType(instance.agent_type_id) } catch (e) { /* ignore */ }
  }
  if (!instanceAgentType) {
    const { data: fallbackType } = await supabaseAdmin
      .from('agent_types').select('*').eq('code', 'openclaw').single()
    instanceAgentType = fallbackType
  }

  const wantsModelChange = !!modelName
  const wantsChannelChange = !!(channelType && channelClientId)

  // Enforce: if user wants to modify model/channel, the agent type must
  // expose a modify command. This is the core of the incremental-modify contract.
  if (wantsModelChange && !(instanceAgentType?.modify_model_command && instanceAgentType.modify_model_command.trim())) {
    return res.status(400).json({
      success: false,
      error: '当前 Agent 未配置模型修改脚本，不允许在平台侧修改模型'
    })
  }
  if (wantsChannelChange && !(instanceAgentType?.modify_channel_command && instanceAgentType.modify_channel_command.trim())) {
    return res.status(400).json({
      success: false,
      error: '当前 Agent 未配置渠道修改脚本，不允许在平台侧修改渠道'
    })
  }

  // Resolve new model info (if requested).
  // NOTE: we intentionally only COMPUTE the new model snapshot here and defer
  // every DB write (agent_instances, instance_channel_configs, status) until
  // AFTER the sandbox modify command has succeeded. Previously the DB was
  // updated before the sandbox command ran, so when the command failed the
  // UI showed the new model/channel while the actual running sandbox still
  // used the old config — a silent state desync.
  let newModelId = instance.model_id
  let newModelName = ''
  let newModelProvider = ''
  const updateData = {}

  if (wantsModelChange) {
    // Determine current provider first so we can scope the lookup and avoid
    // Supabase .single() errors when the same model name exists across
    // multiple providers (e.g. qwen3.6-plus in both bailian and api_gateway).
    let currentProvider = null
    if (instance.model_id) {
      const { data: currentModel } = await supabaseAdmin
        .from('ai_models')
        .select('provider')
        .eq('id', instance.model_id)
        .maybeSingle()
      currentProvider = currentModel?.provider || null
    }

    // Scope by current provider when available to enforce the no-cross-provider
    // switch rule and disambiguate same-name models.
    let modelQuery = supabaseAdmin
      .from('ai_models')
      .select('id, name, provider, model_code')
      .eq('name', modelName)
    if (currentProvider) {
      modelQuery = modelQuery.eq('provider', currentProvider)
    }
    const { data: matches, error: modelQueryError } = await modelQuery
    if (modelQueryError) {
      console.error('Failed to query model:', modelQueryError)
      return res.status(500).json({ success: false, error: '查询模型失败' })
    }
    const modelRows = matches || []

    if (modelRows.length === 0) {
      // Either the model truly doesn't exist, or it only exists under a
      // different provider (cross-provider attempt).
      if (currentProvider) {
        const { data: anyMatch } = await supabaseAdmin
          .from('ai_models')
          .select('provider')
          .eq('name', modelName)
          .limit(1)
          .maybeSingle()
        if (anyMatch?.provider && anyMatch.provider !== currentProvider) {
          return res.status(400).json({
            success: false,
            error: `不允许跨模型提供商切换（当前: ${currentProvider}，目标: ${anyMatch.provider}），如需切换请重新创建实例`
          })
        }
      }
      return res.status(400).json({ success: false, error: `模型 ${modelName} 不存在` })
    }

    if (modelRows.length > 1) {
      return res.status(400).json({
        success: false,
        error: `模型 ${modelName} 存在多条同名记录，请联系管理员清理重复数据`
      })
    }

    const model = modelRows[0]
    newModelId = model.id
    newModelName = model.model_code || model.name
    newModelProvider = model.provider
    // Pre-compute (but do NOT yet persist) the DB snapshot.
    updateData.model_id = model.id
    const baseConfigJson = (instance.config_json && typeof instance.config_json === 'object') ? instance.config_json : {}
    // Keep the legacy snapshot field config_json.model in sync so the UI
    // fallback path (ai_models?.name || config_json?.model) stays consistent
    // when the ai_models join is unavailable.
    updateData.config_json = { ...baseConfigJson, model: model.name }
  }

  if (name) updateData.name = name

  // Pre-compute (but do NOT yet persist) the channel config side-effects.
  // Both the encrypted fields and the existing row lookup are resolved now so
  // the post-sandbox commit block just does a final write.
  let channelUpdate = null
  if (wantsChannelChange) {
    const { data: existingConfig } = await supabaseAdmin
      .from('instance_channel_configs')
      .select('id, client_secret')
      .eq('instance_id', id)
      .single()

    const encryptedClientId = encryptApiKey(channelClientId)
    const finalSecret = (channelClientSecret && channelClientSecret !== '__unchanged__')
      ? encryptApiKey(channelClientSecret)
      : (existingConfig?.client_secret || '')

    channelUpdate = {
      existingConfig,
      encryptedClientId,
      finalSecret,
    }
  }

  // Execute modify commands in the sandbox FIRST. If anything fails, the DB
  // is left in its original state (no agent_instances update, no channel
  // config upsert, no status change) so the UI and the sandbox stay in sync.
  if (instance.sandbox_id && E2B_API_KEY && (wantsModelChange || wantsChannelChange)) {
    try {
      // If only channel changed, still need current model info to populate vars
      if (!newModelName && instance.model_id) {
        const { data: model } = await supabaseAdmin
          .from('ai_models')
          .select('name, provider, model_code')
          .eq('id', instance.model_id)
          .single()
        if (model) {
          newModelName = model.model_code || model.name
          newModelProvider = model.provider
        }
      }

      // Resolve consumer API key
      let consumerApikey = ''
      if (newModelProvider) {
        try {
          const credentialPrincipalId = instance.principal_id
          const { data: credentialProfile } = await supabaseAdmin
            .from('principal_profiles')
            .select('*')
            .eq('id', credentialPrincipalId)
            .maybeSingle()
          const consumerResult = await ensurePrincipalConsumer({
            principalId: credentialPrincipalId,
            principalProfile: credentialProfile || req.userProfile,
            modelProvider: newModelProvider
          })
          consumerApikey = consumerResult.consumerApikey
        } catch (e) {
          console.warn('Failed to resolve consumer API key:', e.message)
        }
      }

      const baseVars = {
        userId: instance.principal_id,
        token: instance.token,
        modelName: newModelName,
        modelProvider: newModelProvider,
        consumerApikey,
        aiGatewayDomain: getGatewayConfig().gatewayDomain
      }

      // 1) Apply model change
      if (wantsModelChange) {
        console.log(`🔄 Running modify-model for instance ${id}`)
        await runModifyCommand(
          instance.sandbox_id,
          instanceAgentType,
          instanceAgentType.modify_model_command,
          baseVars
        )
      }

      // 2) Apply channel change (use plaintext from request, not DB)
      if (wantsChannelChange) {
        const finalChannelClientSecret = (channelClientSecret && channelClientSecret !== '__unchanged__')
          ? channelClientSecret
          : (channelUpdate?.existingConfig?.client_secret
            ? (() => { try { return decryptApiKey(channelUpdate.existingConfig.client_secret) } catch (e) { return '' } })()
            : '')

        console.log(`🔄 Running modify-channel for instance ${id} (type=${channelType})`)
        await runModifyCommand(
          instance.sandbox_id,
          instanceAgentType,
          instanceAgentType.modify_channel_command,
          {
            ...baseVars,
            channelType,
            channelClientId,
            channelClientSecret: finalChannelClientSecret
          }
        )
      }
    } catch (cmdError) {
      console.error('Failed to run modify command (DB left untouched):', cmdError)
      return res.status(500).json({
        success: false,
        error: `配置修改脚本执行失败: ${cmdError.message}`
      })
    }
  }

  // Sandbox side is now in the desired state — commit DB changes.
  updateData.updated_at = new Date().toISOString()

  // Persist basic fields
  const { data: updatedInstance, error: updateError } = await supabaseAdmin
    .from('agent_instances')
    .update(updateData)
    .eq('id', id)
    .select()
    .single()
  if (updateError) throw updateError

  // Persist channel config (if requested)
  let channelConfigData = null
  if (wantsChannelChange && channelUpdate) {
    const { existingConfig, encryptedClientId, finalSecret } = channelUpdate
    if (existingConfig) {
      const { data: updated } = await supabaseAdmin
        .from('instance_channel_configs')
        .update({
          channel_type: channelType,
          client_id: encryptedClientId,
          client_secret: finalSecret,
          config_json: { clientId: encryptedClientId, clientSecret: finalSecret },
          is_configured: true,
          updated_at: new Date().toISOString()
        })
        .eq('id', existingConfig.id)
        .select()
        .single()
      channelConfigData = updated
    } else {
      const { data: created } = await supabaseAdmin
        .from('instance_channel_configs')
        .insert({
          instance_id: id,
          channel_type: channelType,
          client_id: encryptedClientId,
          client_secret: finalSecret,
          config_json: { clientId: encryptedClientId, clientSecret: finalSecret },
          is_configured: true
        })
        .select()
        .single()
      channelConfigData = created
    }
  }

  // Transition to 'starting' so health check can verify service came back up
  if (instance.sandbox_id && E2B_API_KEY && (wantsModelChange || wantsChannelChange)) {
    await supabaseAdmin
      .from('agent_instances')
      .update({ status: 'starting', updated_at: new Date().toISOString() })
      .eq('id', id)
    updatedInstance.status = 'starting'
    console.log(`🔄 Instance ${id} config updated via script, status set to starting`)
  }

  res.json({
    success: true,
    instance: updatedInstance,
    channelConfig: channelConfigData
  })
})

export default router
