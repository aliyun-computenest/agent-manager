/**
 * Agent Type Management Routes
 * Handles CRUD operations for agent types (replaces template.js)
 */

import { Router } from 'express'
import { z } from 'zod'
import { readFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { supabaseAdmin, VITE_OSS_PV_NAME, VITE_SKILLHUB_OSS_PV_NAME } from '../config/index.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'
import { normalizeUpgradeMetadata } from '../services/sandbox-upgrades.js'
import { getApmInstallParameters } from '../services/gateway-config.js'
import { syncObservabilityEnvToSandboxSet } from '../services/observability-env-sync.js'
import { defineRoute } from '../openapi/route-helper.js'
import { AgentTypeSchema } from '../schemas/agent-type.js'
import { errorResponse, DeleteResponseSchema } from '../schemas/common.js'
import { validate } from '../middleware/validate.js'

/**
 * Normalize skill_config entries: ensure each entry carries a concrete pvName.
 * If the caller did not provide pvName (or sent the placeholder), inject the
 * server-side VITE_OSS_PV_NAME env value so the JSON stored in DB is self-contained.
 */
function normalizeSkillConfig(skillConfig) {
  if (!Array.isArray(skillConfig)) return skillConfig
  return skillConfig.map(entry => {
    const hasConcretePvName = entry && entry.pvName && entry.pvName !== '<VITE_OSS_PV_NAME>'
    const defaultPvName = VITE_SKILLHUB_OSS_PV_NAME || VITE_OSS_PV_NAME
    const result = {
      pvName: hasConcretePvName ? entry.pvName : defaultPvName,
      mountPath: entry?.mountPath,
      subPath: entry?.subPath,
      isRequired: entry?.isRequired ?? false
    }
    if (entry?.skillSpaceId) {
      result.skillSpaceId = entry.skillSpaceId
    }
    return result
  })
}

function normalizeTerminalUser(user) {
  const normalized = String(user || 'node').trim() || 'node'
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(normalized)) {
    const error = new Error('terminalUser must be a valid Linux username')
    error.httpStatus = 400
    throw error
  }
  return normalized
}

function defaultSkillPath(user) {
  return user === 'root' ? '/root/.agents/skills' : `/home/${user}/.agents/skills`
}

function normalizeSkillPath(value, terminalUser = 'node') {
  const normalizedUser = normalizeTerminalUser(terminalUser)
  const skillPath = String(value || defaultSkillPath(normalizedUser)).trim()
  const segments = skillPath.split('/')
  if (
    !skillPath.startsWith('/') ||
    skillPath === '/' ||
    skillPath.length > 512 ||
    /[\x00-\x1f\x7f]/.test(skillPath) ||
    segments.some(segment => segment === '.' || segment === '..')
  ) {
    const error = new Error('skillPath must be a valid absolute path')
    error.httpStatus = 400
    throw error
  }
  return skillPath
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const router = Router()

const AgentTypeIdParamsSchema = z.object({
  id: z.string().describe('智能体类型 ID (UUID)'),
})

const CreateAgentTypeBody = z.object({
  code: z.string({ required_error: 'code and name are required' }).min(1, { message: 'code and name are required' }),
  name: z.string({ required_error: 'code and name are required' }).min(1, { message: 'code and name are required' }),
  skillPath: z.string().min(1).max(512).optional().describe('Agent 在线安装 Skill 的绝对路径'),
}).passthrough()

const UpdateAgentTypeBody = z.object({
  skillPath: z.string().min(1).max(512).optional().describe('Agent 在线安装 Skill 的绝对路径'),
}).passthrough()

// Custom variables schema validation
const VALID_CUSTOM_VAR_TYPES = ['text', 'password', 'textarea']
const CUSTOM_VAR_NAME_REGEX = /^[A-Z][A-Z0-9_]*$/

/**
 * Validate observability_env: must be an object with string keys and string values.
 */
function validateObservabilityEnv(observabilityEnv) {
  if (observabilityEnv === null || observabilityEnv === undefined) return null
  if (typeof observabilityEnv !== 'object' || Array.isArray(observabilityEnv)) {
    const err = new Error('observability_env must be a plain object')
    err.httpStatus = 400
    throw err
  }
  for (const [key, value] of Object.entries(observabilityEnv)) {
    if (typeof key !== 'string' || typeof value !== 'string') {
      const err = new Error(`observability_env entries must be string key-value pairs, invalid: "${key}"`)
      err.httpStatus = 400
      throw err
    }
  }
  return observabilityEnv
}

function validateCustomVarsSchema(customVarsSchema) {
  if (customVarsSchema === null || customVarsSchema === undefined) return null
  if (!Array.isArray(customVarsSchema)) {
    const err = new Error('customVarsSchema must be an array')
    err.httpStatus = 400
    throw err
  }
  for (const v of customVarsSchema) {
    if (!v || typeof v !== 'object') {
      const err = new Error('Each item in customVarsSchema must be an object')
      err.httpStatus = 400
      throw err
    }
    if (!v.name || typeof v.name !== 'string' || !CUSTOM_VAR_NAME_REGEX.test(v.name)) {
      const err = new Error(`Invalid custom variable name: "${v.name || ''}". Must match ${CUSTOM_VAR_NAME_REGEX}`)
      err.httpStatus = 400
      throw err
    }
    if (!v.type || !VALID_CUSTOM_VAR_TYPES.includes(v.type)) {
      const err = new Error(`Invalid custom variable type: "${v.type}". Must be one of: ${VALID_CUSTOM_VAR_TYPES.join(', ')}`)
      err.httpStatus = 400
      throw err
    }
    if (v.label !== undefined && typeof v.label !== 'string') {
      const err = new Error(`Custom variable "${v.name}" label must be a string`)
      err.httpStatus = 400
      throw err
    }
  }
  return customVarsSchema
}

const SaveTemplateBody = z.object({ template: z.object({}).passthrough() }).passthrough()

const ListAgentTypesResponseSchema = z.object({
  success: z.literal(true),
  agentTypes: z.array(AgentTypeSchema),
})

const AgentTypeResponseSchema = z.object({
  success: z.literal(true),
  agentType: AgentTypeSchema,
})

const TemplateExampleResponseSchema = z.object({
  success: z.literal(true),
  template: z.object({}).passthrough().describe('示例模板配置对象，结构因智能体类型而异'),
  fileName: z.string().describe('模板文件名'),
})

const GetTemplateResponseSchema = z.object({
  success: z.literal(true),
  exists: z.boolean().describe('模板是否存在'),
  template: z.object({}).passthrough().nullable().describe('模板配置对象，结构因智能体类型而异；不存在时为 null'),
  updatedAt: z.string().optional().describe('最后更新时间'),
})

const SaveTemplateResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().describe('操作结果消息'),
  updatedAt: z.string().describe('更新时间戳'),
})

// =====================================================
// Agent Types APIs
// =====================================================

/**
 * List all agent types
 * GET /api/agent-types
 */
defineRoute(router, {
  method: 'get',
  path: '/agent-types',
  operationId: 'listAgentTypes',
  tags: ['Agent Types'],
  summary: '列出智能体类型(管理员可看到全部，普通用户只看到启用的)',
  description: '根据当前用户角色返回智能体类型列表。管理员可查看全部类型(含禁用)，普通用户仅返回已启用的类型，按 sort_order 升序排列。',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: '成功返回智能体类型列表',
      content: { 'application/json': { schema: ListAgentTypesResponseSchema } },
    },
    401: errorResponse,
    500: errorResponse,
  },
}, requireAuth, async (req, res) => {
  const isAdmin = req.userProfile?.role === 'admin'

  let query = supabaseAdmin
    .from('agent_types')
    .select('*')
    .order('sort_order', { ascending: true })

  if (!isAdmin) {
    query = query.eq('is_enabled', true)
  }

  const { data: agentTypes, error } = await query

  if (error) throw error

  res.json({
    success: true,
    agentTypes: agentTypes || []
  })
})

/**
 * Get a single agent type by ID
 * GET /api/agent-types/:id
 */
defineRoute(router, {
  method: 'get',
  path: '/agent-types/{id}',
  operationId: 'getAgentTypesById',
  tags: ['Agent Types'],
  summary: '获取单个智能体类型详情',
  description: '根据 ID 查询单个智能体类型的完整配置信息，包括沙箱模板、启动命令、渠道支持等详细字段。',
  security: [{ bearerAuth: [] }],
  request: {
    params: AgentTypeIdParamsSchema,
  },
  responses: {
    200: {
      description: '成功返回智能体类型详情',
      content: { 'application/json': { schema: AgentTypeResponseSchema } },
    },
    401: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAuth, validate({ params: AgentTypeIdParamsSchema }), async (req, res) => {
  const { id } = req.params

  const { data: agentType, error } = await supabaseAdmin
    .from('agent_types')
    .select('*')
    .eq('id', id)
    .single()

  if (error || !agentType) {
    return res.status(404).json({ success: false, error: 'Agent type not found' })
  }

  // Auto-fill observability_env for built-in agent types when empty
  const BUILTIN_CODES = ['hermes', 'openclaw', 'qwenpaw']
  const obsEnv = agentType.observability_env
  const isObsEnvEmpty = !obsEnv || (typeof obsEnv === 'object' && Object.keys(obsEnv).length === 0)
  if (isObsEnvEmpty && BUILTIN_CODES.includes(agentType.code)) {
    try {
      const { getApmInstallParameters } = await import('../services/gateway-config.js')
      const apmParams = await getApmInstallParameters()
      if (apmParams) {
        const endpoint = `https://${apmParams.publicDomain}/apm/trace/opentelemetry`
        const envObj = {
          ARMS_ENDPOINT: endpoint,
          ARMS_LICENSE_KEY: apmParams.authToken,
          ARMS_PROJECT: apmParams.project,
          ARMS_WORKSPACE: apmParams.workspace,
          ARMS_REGION_ID: apmParams.regionId || 'cn-hangzhou',
          APSARA_APM_APP_TYPE: 'app',
          OTEL_RESOURCE_ATTRIBUTES: 'acs.arms.service.feature=genai_app'
        }
        await supabaseAdmin.from('agent_types').update({ observability_env: envObj }).eq('id', id)
        agentType.observability_env = envObj
        console.log(`[agent-types] Auto-filled observability_env for ${agentType.code}`)
        // Sync to SandboxSet so new Pods inherit the params
        const templateId = agentType.sandbox_template_id || `agent-manager-${agentType.code}`
        syncObservabilityEnvToSandboxSet(templateId, envObj).catch(err => {
          console.warn(`[agent-types] Failed to sync SandboxSet after auto-fill:`, err.message)
        })
      }
    } catch (e) {
      console.warn(`[agent-types] Failed to auto-fill observability_env for ${agentType.code}:`, e.message)
    }
  }

  res.json({ success: true, agentType })
})

/**
 * Create a new agent type (Admin only)
 * POST /api/agent-types
 */
defineRoute(router, {
  method: 'post',
  path: '/agent-types',
  operationId: 'createAgentType',
  tags: ['Agent Types'],
  summary: '创建智能体类型',
  description: '管理员创建新的智能体类型配置，包括沙箱模板、启动命令、配置模板等。可选从已有智能体类型复制渠道模板。',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: CreateAgentTypeBody } } },
  },
  responses: {
    200: {
      description: '创建成功',
      content: { 'application/json': { schema: AgentTypeResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: CreateAgentTypeBody }), async (req, res) => {
  const {
    code, name, description, icon,
    category = 'custom',
    sandboxTemplateId, sandboxTimeout = 300,
    configTemplate = {},
    configWritePath,
    startupCommand,
    modifyModelCommand,
    modifyChannelCommand,
    readinessCheck = {},
    supportsChannels = false,
    supportsEnvVars = false,
    supportsSkills = true,
    skillPath,
    userTerminalEnabled = false,
    sandboxUser,
    terminalUser = 'node',
    upgradeMetadata = req.body.upgrade_metadata,
    sortOrder = 0,
    templateSourceId,
    skillConfig,
    customVarsSchema,
    observabilityEnv = req.body.observability_env,
    observabilityEnabled = req.body.observability_enabled
  } = req.body

  const { data: agentType, error } = await supabaseAdmin
    .from('agent_types')
    .insert({
      code,
      name,
      description,
      icon: icon || 'bot',
      category,
      sandbox_template_id: sandboxTemplateId,
      sandbox_timeout: sandboxTimeout,
      config_template: configTemplate,
      config_write_path: configWritePath,
      startup_command: startupCommand,
      modify_model_command: modifyModelCommand || null,
      modify_channel_command: modifyChannelCommand || null,
      readiness_check: readinessCheck,
      supports_channels: supportsChannels,
      supports_env_vars: supportsEnvVars,
      supports_skills: supportsSkills,
      skill_path: normalizeSkillPath(skillPath, terminalUser),
      user_terminal_enabled: userTerminalEnabled,
      sandbox_user: sandboxUser || null,
      terminal_user: normalizeTerminalUser(terminalUser),
      ...(upgradeMetadata !== undefined ? { upgrade_metadata: normalizeUpgradeMetadata(upgradeMetadata) } : {}),
      sort_order: sortOrder,
      skill_config: skillConfig ? normalizeSkillConfig(skillConfig) : null,
      custom_vars_schema: validateCustomVarsSchema(customVarsSchema),
      ...(observabilityEnv !== undefined ? { observability_env: validateObservabilityEnv(observabilityEnv) } : {}),
      ...(observabilityEnabled !== undefined ? { observability_enabled: observabilityEnabled } : {})
    })
    .select()
    .single()

  if (error) throw error

  // Copy channel_templates from source agent type if templateSourceId is provided
  if (templateSourceId && agentType) {
    try {
      const { data: sourceChannels } = await supabaseAdmin
        .from('channel_templates')
        .select('channel_type, name, description, config_fields, config_file, config_template, is_enabled')
        .eq('agent_type_id', templateSourceId)

      if (sourceChannels && sourceChannels.length > 0) {
        const channelCopies = sourceChannels.map(ch => ({
          ...ch,
          agent_type_id: agentType.id
        }))
        const { error: chError } = await supabaseAdmin
          .from('channel_templates')
          .insert(channelCopies)
        if (chError) console.error('Copy channel templates warning:', chError.message)
        else console.log(`Copied ${channelCopies.length} channel templates from source ${templateSourceId}`)
      }
    } catch (chErr) {
      console.error('Copy channel templates error:', chErr)
      // Non-fatal: agent type is already created
    }
  }

  res.json({ success: true, agentType })
})

/**
 * Update an agent type (Admin only)
 * PUT /api/agent-types/:id
 */
defineRoute(router, {
  method: 'put',
  path: '/agent-types/{id}',
  operationId: 'updateAgentTypesById',
  tags: ['Agent Types'],
  summary: '更新智能体类型',
  description: '管理员更新指定智能体类型的配置信息，支持部分字段更新，未传的字段保持不变。',
  security: [{ bearerAuth: [] }],
  request: {
    params: AgentTypeIdParamsSchema,
    body: { content: { 'application/json': { schema: UpdateAgentTypeBody } } },
  },
  responses: {
    200: {
      description: '更新成功',
      content: { 'application/json': { schema: AgentTypeResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: UpdateAgentTypeBody, params: AgentTypeIdParamsSchema }), async (req, res) => {
  const { id } = req.params
  const {
    name, description, icon,
    sandboxTemplateId, sandboxTimeout,
    configTemplate,
    configWritePath,
    startupCommand,
    modifyModelCommand,
    modifyChannelCommand,
    readinessCheck,
    supportsChannels,
    supportsEnvVars,
    supportsSkills,
    skillPath,
    userTerminalEnabled,
    sandboxUser,
    terminalUser,
    upgradeMetadata = req.body.upgrade_metadata,
    isEnabled,
    sortOrder,
    skillConfig,
    customVarsSchema,
    observabilityEnv = req.body.observability_env,
    observabilityEnabled = req.body.observability_enabled
  } = req.body

  const updateData = { updated_at: new Date().toISOString() }
  if (name !== undefined) updateData.name = name
  if (description !== undefined) updateData.description = description
  if (icon !== undefined) updateData.icon = icon
  if (sandboxTemplateId !== undefined) updateData.sandbox_template_id = sandboxTemplateId
  if (sandboxTimeout !== undefined) updateData.sandbox_timeout = sandboxTimeout
  if (configTemplate !== undefined) updateData.config_template = configTemplate
  if (configWritePath !== undefined) updateData.config_write_path = configWritePath
  if (startupCommand !== undefined) updateData.startup_command = startupCommand
  if (modifyModelCommand !== undefined) updateData.modify_model_command = modifyModelCommand || null
  if (modifyChannelCommand !== undefined) updateData.modify_channel_command = modifyChannelCommand || null
  if (readinessCheck !== undefined) updateData.readiness_check = readinessCheck
  if (supportsChannels !== undefined) updateData.supports_channels = supportsChannels
  if (supportsEnvVars !== undefined) updateData.supports_env_vars = supportsEnvVars
  if (supportsSkills !== undefined) updateData.supports_skills = supportsSkills
  if (skillPath !== undefined) updateData.skill_path = normalizeSkillPath(skillPath, terminalUser)
  if (userTerminalEnabled !== undefined) updateData.user_terminal_enabled = userTerminalEnabled
  if (sandboxUser !== undefined) updateData.sandbox_user = sandboxUser || null
  if (terminalUser !== undefined) updateData.terminal_user = normalizeTerminalUser(terminalUser)
  if (upgradeMetadata !== undefined) updateData.upgrade_metadata = normalizeUpgradeMetadata(upgradeMetadata)
  if (isEnabled !== undefined) updateData.is_enabled = isEnabled
  if (sortOrder !== undefined) updateData.sort_order = sortOrder
  if (skillConfig !== undefined) {
    // Validate mountPath: must start with '/'
    if (Array.isArray(skillConfig)) {
      for (const entry of skillConfig) {
        if (entry.mountPath && !entry.mountPath.startsWith('/')) {
          const err = new Error(`mountPath must start with '/': ${entry.mountPath}`)
          err.httpStatus = 400
          throw err
        }
      }
    }
    updateData.skill_config = skillConfig ? normalizeSkillConfig(skillConfig) : null
  }
  if (customVarsSchema !== undefined) updateData.custom_vars_schema = validateCustomVarsSchema(customVarsSchema)
  if (observabilityEnv !== undefined) updateData.observability_env = validateObservabilityEnv(observabilityEnv)
  if (observabilityEnabled !== undefined) updateData.observability_enabled = observabilityEnabled

  // 在更新前查询旧的采集开关值，用于对比是否真的发生变更
  let oldObservabilityEnabled = null
  if (observabilityEnabled !== undefined) {
    const { data: current } = await supabaseAdmin
      .from('agent_types')
      .select('observability_enabled')
      .eq('id', id)
      .single()
    oldObservabilityEnabled = current?.observability_enabled
  }

  const { data: agentType, error } = await supabaseAdmin
    .from('agent_types')
    .update(updateData)
    .eq('id', id)
    .select()
    .single()

  if (error) throw error

  // 仅当采集开关值发生变化时，fire-and-forget 批量触发实例 toggle
  if (observabilityEnabled !== undefined && oldObservabilityEnabled !== observabilityEnabled) {
    console.log(`[agent-type-update] observability_enabled changed for type ${id}: ${oldObservabilityEnabled} -> ${observabilityEnabled}, triggering batch toggle`)
    const { executeBatchToggle } = await import('../services/toggle-batch.js')
    executeBatchToggle(id, observabilityEnabled).catch(err => {
      console.warn(`[agent-type-update] Batch toggle failed for type ${id}:`, err.message)
    })
  }

  // Sync observability_env to SandboxSet when params change (fire-and-forget)
  if (observabilityEnv !== undefined && agentType.code) {
    const envObj = observabilityEnv || agentType.observability_env
    const templateId = agentType.sandbox_template_id || `agent-manager-${agentType.code}`
    syncObservabilityEnvToSandboxSet(templateId, envObj).catch(err => {
      console.warn(`[agent-type-update] Failed to sync SandboxSet env:`, err.message)
    })
  }

  res.json({ success: true, agentType })
})

/**
 * Delete an agent type (Admin only, custom types only)
 * DELETE /api/agent-types/:id
 */
defineRoute(router, {
  method: 'delete',
  path: '/agent-types/{id}',
  operationId: 'deleteAgentTypesById',
  tags: ['Agent Types'],
  summary: '删除智能体类型(仅限自定义类型，内置类型不可删除)',
  description: '管理员删除指定的自定义智能体类型。内置类型不可删除，如有实例正在使用该类型也无法删除。',
  security: [{ bearerAuth: [] }],
  request: {
    params: AgentTypeIdParamsSchema,
  },
  responses: {
    200: {
      description: '删除成功',
      content: { 'application/json': { schema: DeleteResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ params: AgentTypeIdParamsSchema }), async (req, res) => {
  const { id } = req.params

  // Check if it's a builtin type
  const { data: agentType, error: fetchError } = await supabaseAdmin
    .from('agent_types')
    .select('code, category')
    .eq('id', id)
    .single()

  if (fetchError || !agentType) {
    return res.status(404).json({ success: false, error: 'Agent type not found' })
  }

  if (agentType.category === 'builtin') {
    return res.status(400).json({ success: false, error: '内置 Agent 配置不能删除' })
  }

  // Check if any instances are using this type
  const { count } = await supabaseAdmin
    .from('agent_instances')
    .select('id', { count: 'exact', head: true })
    .eq('agent_type_id', id)

  if (count > 0) {
    return res.status(400).json({
      success: false,
      error: `该 Agent 配置还有 ${count} 个实例在使用，无法删除`
    })
  }

  const { error } = await supabaseAdmin
    .from('agent_types')
    .delete()
    .eq('id', id)

  if (error) throw error

  res.json({ success: true, message: 'Agent type deleted successfully' })
})

/**
 * Toggle agent type enabled status (Admin only)
 * PATCH /api/agent-types/:id/toggle
 */
defineRoute(router, {
  method: 'patch',
  path: '/agent-types/{id}/toggle',
  operationId: 'toggleAgentTypesByIdToggle',
  tags: ['Agent Types'],
  summary: '切换智能体类型启停状态',
  description: '管理员切换指定智能体类型的启用/禁用状态。启用前会校验必要字段是否已配置。',
  security: [{ bearerAuth: [] }],
  request: {
    params: AgentTypeIdParamsSchema,
  },
  responses: {
    200: {
      description: '切换成功',
      content: { 'application/json': { schema: AgentTypeResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ params: AgentTypeIdParamsSchema }), async (req, res) => {
  const { id } = req.params

  const { data: agentType, error: fetchError } = await supabaseAdmin
    .from('agent_types')
    .select('*')
    .eq('id', id)
    .single()

  if (fetchError || !agentType) {
    return res.status(404).json({ success: false, error: 'Agent type not found' })
  }

  // Validate required fields before enabling
  if (!agentType.is_enabled) {
    const missing = []
    if (!agentType.name) missing.push('名称')
    if (missing.length > 0) {
      return res.status(400).json({ success: false, error: `启用前请先配置: ${missing.join('、')}` })
    }
  }

  const { data: updated, error } = await supabaseAdmin
    .from('agent_types')
    .update({ is_enabled: !agentType.is_enabled, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()

  if (error) throw error

  res.json({ success: true, agentType: updated })
})

// =====================================================
// Legacy template API (backward compatibility)
// Reads/writes openclaw config_template from agent_types
// =====================================================

/**
 * Get example template
 * GET /api/template/example
 */
defineRoute(router, {
  method: 'get',
  path: '/template/example',
  operationId: 'listTemplateExample',
  tags: ['Template (Legacy)'],
  summary: '获取示例模板(Legacy)',
  description: '返回系统内置的 OpenClaw 示例模板文件内容，供管理员参考模板结构。',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: '成功返回示例模板',
      content: { 'application/json': { schema: TemplateExampleResponseSchema } },
    },
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, async (req, res) => {
  const examplePath = join(__dirname, '..', '..', 'data', 'openclaw-template-example.json')

  if (!existsSync(examplePath)) {
    return res.status(404).json({ success: false, error: 'Example template not found' })
  }

  const content = readFileSync(examplePath, 'utf-8')
  const template = JSON.parse(content)

  res.json({
    success: true,
    template,
    fileName: 'openclaw-template-example.json'
  })
})

/**
 * Get OpenClaw template (legacy - reads from agent_types)
 * GET /api/template
 */
defineRoute(router, {
  method: 'get',
  path: '/template',
  operationId: 'listTemplate',
  tags: ['Template (Legacy)'],
  summary: '获取 OpenClaw 模板(旧版)',
  description: '从 agent_types 表中读取 OpenClaw 类型的 config_template 配置，返回模板内容及更新时间。',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: '成功返回模板配置',
      content: { 'application/json': { schema: GetTemplateResponseSchema } },
    },
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, async (req, res) => {
  const { data: agentType, error } = await supabaseAdmin
    .from('agent_types')
    .select('config_template, updated_at')
    .eq('code', 'openclaw')
    .single()

  if (error) throw error

  if (!agentType || !agentType.config_template || Object.keys(agentType.config_template).length === 0) {
    return res.json({ success: true, exists: false, template: null })
  }

  res.json({
    success: true,
    exists: true,
    template: agentType.config_template,
    updatedAt: agentType.updated_at
  })
})

/**
 * Save OpenClaw template (legacy - writes to agent_types)
 * POST /api/template
 */
defineRoute(router, {
  method: 'post',
  path: '/template',
  operationId: 'createTemplate',
  tags: ['Template (Legacy)'],
  summary: '保存 OpenClaw 模板(Legacy，写入 agent_types)',
  description: '将传入的模板对象保存到 agent_types 表的 config_template 字段中，返回更新时间戳。',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: SaveTemplateBody } } },
  },
  responses: {
    200: {
      description: '保存成功',
      content: { 'application/json': { schema: SaveTemplateResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: SaveTemplateBody }), async (req, res) => {
  const { template } = req.body

  const now = new Date().toISOString()

  const { error } = await supabaseAdmin
    .from('agent_types')
    .update({
      config_template: template,
      updated_at: now
    })
    .eq('code', 'openclaw')

  if (error) throw error

  res.json({
    success: true,
    message: 'Template saved successfully',
    updatedAt: now
  })
})

/**
 * Delete OpenClaw template (legacy - resets to empty)
 * DELETE /api/template
 */
defineRoute(router, {
  method: 'delete',
  path: '/template',
  operationId: 'deleteTemplate',
  tags: ['Template (Legacy)'],
  summary: '删除 OpenClaw 模板(Legacy，重置为空)',
  description: '将 agent_types 中 OpenClaw 类型的 config_template 重置为空对象，等效于删除模板配置。',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: '删除成功',
      content: { 'application/json': { schema: DeleteResponseSchema } },
    },
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, async (req, res) => {
  const { error } = await supabaseAdmin
    .from('agent_types')
    .update({ config_template: {}, updated_at: new Date().toISOString() })
    .eq('code', 'openclaw')

  if (error) throw error

  res.json({ success: true, message: 'Template deleted successfully' })
})

// =====================================================
// Observability defaults API
// =====================================================

/**
 * Get ARMS observability default parameters for an agent type
 * GET /api/admin/agent-types/:id/observability-defaults
 */
defineRoute(router, {
  method: 'get',
  path: '/agent-types/{id}/observability-defaults',
  operationId: 'getAgentTypeObservabilityDefaults',
  tags: ['Agent Types'],
  summary: '获取智能体类型可观测性默认参数',
  description: '调用 CMS API 获取 ARMS 默认参数，返回可直接用于 observability_env 的键值对。',
  security: [{ bearerAuth: [] }],
  request: {
    params: AgentTypeIdParamsSchema,
  },
  responses: {
    200: {
      description: '成功返回默认参数',
      content: { 'application/json': { schema: z.object({ success: z.literal(true), defaults: z.record(z.string()) }) } },
    },
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ params: AgentTypeIdParamsSchema }), async (req, res) => {
  const { id } = req.params

  // Fetch agent type to determine code-specific defaults
  const { data: agentType } = await supabaseAdmin
    .from('agent_types')
    .select('code')
    .eq('id', id)
    .single()

  const apmParams = await getApmInstallParameters()
  if (!apmParams) {
    return res.json({ success: false, error: 'ARMS not configured' })
  }

  const endpoint = `https://${apmParams.publicDomain}/apm/trace/opentelemetry`

  // Base params (shared by all agent types)
  const defaults = {
    ARMS_ENDPOINT: endpoint,
    ARMS_LICENSE_KEY: apmParams.authToken,
    ARMS_PROJECT: apmParams.project,
    ARMS_WORKSPACE: apmParams.workspace
  }

  // Agent-type-specific params
  const code = agentType?.code || ''
  if (code === 'hermes') {
    defaults.OTEL_RESOURCE_ATTRIBUTES = 'acs.arms.service.feature=genai_app'
  } else if (code === 'qwenpaw') {
    defaults.OTEL_RESOURCE_ATTRIBUTES = 'acs.arms.service.feature=genai_app,gen_ai.agent.system=qwenpaw'
  }
  // OpenClaw: no extra params needed (plugin handles resource attributes internally)

  res.json({ success: true, defaults })
})

export default router
