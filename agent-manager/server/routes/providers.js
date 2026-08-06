/**
 * Provider Management Routes
 * Handles AI provider CRUD operations
 * Provider data is stored in provider_config table
 * Credentials are stored in provider_config table (config JSONB, flat format)
 */

import { Router } from 'express'
import { z } from 'zod'
import { supabaseAdmin } from '../config/index.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { encryptApiKey } from '../utils/crypto.js'
import { createProviderFromDB, getAllProviders } from '../services/providers/index.js'
import { loadGatewayConfig } from '../services/gateway-config.js'
import { defineRoute } from '../openapi/route-helper.js'
import { errorResponse, DeleteResponseSchema } from '../schemas/common.js'
import { validate } from '../middleware/validate.js'

const router = Router()

/**
 * Get provider config from provider_config table
 * @param {string} name - Provider name
 */
async function getProviderConfig(name) {
  const { data, error } = await supabaseAdmin
    .from('provider_config')
    .select('id, name, display_name, type, config, enabled, description')
    .eq('name', name)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  // Transform to the expected format
  // IMPORTANT: spread config FIRST, then table columns override —
  // ensures table-level fields (type, id, name...) are never overridden by stale JSONB values
  return {
    ...data.config,
    id: data.id,
    name: data.name,
    displayName: data.display_name,
    type: data.type,
    isEnabled: data.enabled,
    description: data.description,
  }
}

/**
 * Get all provider_config records
 */
async function getAllProviderConfigs() {
  const { data, error } = await supabaseAdmin
    .from('provider_config')
    .select('id, name, display_name, type, config, enabled, description')

  if (error) throw error

  return (data || []).map(row => ({
    ...row.config,
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    type: row.type,
    isEnabled: row.enabled,
    description: row.description,
  }))
}

/**
 * Update provider config in provider_config table
 * @param {string} name - Provider name
 * @param {object} updates - Config updates (apiKey will be encrypted if provided)
 */
async function updateProviderConfig(name, updates) {
  // Get existing raw row directly — NOT via getProviderConfig() which flattens config JSONB
  const { data: existingRow, error: fetchError } = await supabaseAdmin
    .from('provider_config')
    .select('id, name, display_name, type, config, enabled, description')
    .eq('name', name)
    .maybeSingle()

  if (fetchError) throw fetchError

  // Separate fields for table columns vs config JSONB
  const tableUpdates = {}
  const configUpdates = {}

  // Handle table-level fields
  if (updates.isEnabled !== undefined) {
    tableUpdates.enabled = updates.isEnabled
  }
  if (updates.displayName !== undefined) {
    tableUpdates.display_name = updates.displayName
  }
  if (updates.description !== undefined) {
    tableUpdates.description = updates.description
  }

  // Use the raw config JSONB from DB — no table-level fields mixed in
  const existingConfig = existingRow?.config || {}

  // Handle apiKey - encrypt if provided
  if (updates.apiKey !== undefined) {
    if (updates.apiKey === null || updates.apiKey === '') {
      configUpdates.apiKey = null
    } else {
      configUpdates.apiKey = encryptApiKey(updates.apiKey)
    }
  }

  // Handle domain
  if (updates.domain !== undefined) {
    if (updates.domain === null || updates.domain === '') {
      configUpdates.domain = null
    } else {
      configUpdates.domain = updates.domain
    }
  }

  // Handle apiKeyPlaceholder
  if (updates.apiKeyPlaceholder !== undefined) {
    configUpdates.apiKeyPlaceholder = updates.apiKeyPlaceholder
  }

  // Handle domainPlaceholder
  if (updates.domainPlaceholder !== undefined) {
    configUpdates.domainPlaceholder = updates.domainPlaceholder
  }

  // Handle parameters (for AI Gateway providers)
  if (updates.parameters !== undefined) {
    configUpdates.parameters = updates.parameters
  }

  // Merge existing config JSONB with updates
  const mergedConfig = { ...existingConfig, ...configUpdates }

  // Safety: remove any table-level fields that might have leaked into config JSONB
  delete mergedConfig.id
  delete mergedConfig.name
  delete mergedConfig.type
  delete mergedConfig.enabled
  delete mergedConfig.displayName
  delete mergedConfig.display_name
  delete mergedConfig.description
  delete mergedConfig.isEnabled

  if (existingRow) {
    // Update existing record
    console.log(`[updateProviderConfig] Updating '${name}': tableUpdates=${JSON.stringify(tableUpdates)}, configKeys=[${Object.keys(mergedConfig).join(', ')}]`)
    const { error } = await supabaseAdmin
      .from('provider_config')
      .update({
        ...tableUpdates,
        config: mergedConfig,
        updated_at: new Date().toISOString()
      })
      .eq('name', name)

    if (error) throw error
    console.log(`[updateProviderConfig] Successfully updated '${name}'`)
  } else {
    // Insert new record
    console.log(`[updateProviderConfig] Inserting new provider '${name}': type=${tableUpdates.type || 'API'}`)
    const { error } = await supabaseAdmin
      .from('provider_config')
      .insert({
        name,
        display_name: tableUpdates.display_name || name,
        type: tableUpdates.type || 'API',
        config: mergedConfig,
        enabled: tableUpdates.enabled ?? true,
        description: tableUpdates.description || ''
      })

    if (error) throw error
  }

  // Refresh in-memory gateway cache so code paths that read via getGatewayConfig()
  // (e.g. instance-provisioner, agent-config) see the latest enabled/domain values.
  // Cheap single-row read; safe to call for any provider update.
  try {
    await loadGatewayConfig()
  } catch (e) {
    console.warn(`[updateProviderConfig] failed to refresh gateway cache: ${e.message}`)
  }
}

const ProviderCodeParamsSchema = z.object({
  code: z.string().describe('供应商代码'),
})

const ProviderNameParamsSchema = z.object({
  name: z.string().describe('供应商名称'),
})

const TokensQuerySchema = z.object({
  days: z.string().optional().describe('查询天数(仅1或30, 默认1)'),
})

const UserLimitQuerySchema = z.object({ userId: z.string({ required_error: 'userId is required' }).min(1, { message: 'userId is required' }) }).passthrough()

const CreateProviderBody = z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]+$/, { message: 'Provider name can only contain letters, numbers, underscores and hyphens' }) }).passthrough()

const UpdateProviderBody = z.object({}).passthrough()

const UpdateProviderConfigBody = z.object({}).passthrough().describe('供应商详细配置字段(透传给具体 provider)')

const BudgetItemSchema = z.object({
  timeRate: z.string().describe('时间维度(daily|monthly)'),
  value: z.number().describe('限额数值'),
  unit: z.string().describe('限额单位(token|usd|cny|credits)'),
})

// develop 后端用 `Array.isArray(req.body) ? req.body : (req.body.budgets || [])`
// 接收两种格式 — schema 也照样接收两种,让 develop 客户端不用任何改动
const UpdateLimitConfigBody = z.union([z.array(BudgetItemSchema), z.object({ budgets: z.array(BudgetItemSchema) }).passthrough()])

const UpdateUserLimitBody = z.object({ userId: z.string({ required_error: 'userId is required' }).min(1, { message: 'userId is required' }) }).passthrough()

const ProviderListItemSchema = z.object({
  code: z.string().describe('供应商代码'),
  displayName: z.string().describe('显示名称'),
  type: z.string().nullable().optional().describe('供应商类型'),
  apiKeyPlaceholder: z.string().describe('API Key 占位提示'),
  domainPlaceholder: z.string().describe('Domain 占位提示'),
  isEnabled: z.boolean().describe('是否启用'),
  hasApiKey: z.boolean().describe('是否已配置 API Key'),
})

const ListProvidersResponseSchema = z.object({
  success: z.literal(true),
  providers: z.array(ProviderListItemSchema),
})

const ProviderDetailResponseSchema = z.object({
  success: z.literal(true),
  provider: z.object({ id: z.string(), name: z.string(), displayName: z.string().optional(), type: z.string(), isEnabled: z.boolean(), description: z.string().optional() }).passthrough(),
})

const CreateProviderResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().describe('操作结果消息'),
  provider: z.object({
    name: z.string().describe('供应商名称'),
    displayName: z.string().describe('显示名称'),
    type: z.string().describe('供应商类型'),
  }),
})

const UpdateProviderResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().describe('操作结果消息'),
})

const ToggleProviderResponseSchema = z.object({
  success: z.literal(true),
  provider: z.object({
    code: z.string().describe('供应商代码'),
    isEnabled: z.boolean().describe('当前启用状态'),
  }),
})

const ProviderConfigResponseSchema = z.object({
  success: z.literal(true),
  config: z.object({}).passthrough().describe('供应商配置参数(敏感字段已脱敏)'),
})

const LimitConfigSchema = z.object({
  enabled: z.boolean().describe('是否启用限额'),
  budgets: z.array(BudgetItemSchema).describe('限额条目列表'),
}).passthrough()

const GetLimitConfigResponseSchema = z.object({
  success: z.literal(true),
  config: LimitConfigSchema,
  supported: z.boolean().describe('供应商是否支持限额功能'),
})

const UpdateLimitConfigResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().describe('操作结果消息'),
})

const ProviderStatsResponseSchema = z.object({
  success: z.literal(true),
  stats: z.object({}).passthrough().nullable().describe('统计数据，结构因供应商类型而异；无启用供应商或不支持时为 null'),
  supported: z.boolean().describe('供应商是否支持统计功能'),
  message: z.string().optional().describe('附加提示信息'),
})

const ConsumerItemSchema = z.object({
  name: z.string().describe('用户标识').optional(),
  totalTokens: z.number().describe('Token 总消耗').optional(),
}).passthrough()

const TokensResponseSchema = z.object({
  success: z.literal(true),
  consumers: z.array(ConsumerItemSchema).describe('各用户 Token 消耗明细'),
  supported: z.boolean().describe('供应商是否支持统计功能'),
  message: z.string().optional().describe('附加提示信息'),
})

const UserLimitConfigSchema = z.object({
  enabled: z.boolean().describe('是否启用用户限额'),
  budgets: z.array(BudgetItemSchema).describe('用户级别限额列表'),
  globalBudgets: z.array(BudgetItemSchema).describe('全局级别限额列表'),
  effectiveBudgets: z.array(BudgetItemSchema).describe('生效的限额(用户与全局取较小值)'),
  hasConsumer: z.boolean().describe('用户是否已创建 Consumer'),
}).passthrough()

const GetUserLimitResponseSchema = z.object({
  success: z.literal(true),
  config: UserLimitConfigSchema,
})

const UpdateUserLimitResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().describe('操作结果消息'),
})
//
// Route declaration order is preserved from the pre-migration file so that
// Express path matching behaviour does not change. Note: `/providers/current/*`
// routes use the literal segment `current` and are declared AFTER the
// `/providers/{code}` and `/providers/{name}/...` routes — but since each path
// has a distinct path signature (different segment count or different literal
// last segment), declaration order does not affect routing in this file.

/**
 * List all providers
 * GET /api/providers
 * - All providers from provider_config table
 * - Auth users see only enabled=true providers
 * - Admin users see all providers
 */
defineRoute(router, {
  method: 'get',
  path: '/providers',
  operationId: 'listProviders',
  tags: ['Providers'],
  summary: '列出所有供应商',
  description: '获取所有供应商列表，普通用户仅可见已启用的供应商，管理员可见全部。',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: '成功返回供应商列表',
      content: { 'application/json': { schema: ListProvidersResponseSchema } },
    },
    401: errorResponse,
    500: errorResponse,
  },
}, requireAuth, async (req, res) => {
  const isAdmin = req.userProfile?.role === 'admin'

  // Get all provider configs from database
  const providerConfigs = await getAllProviderConfigs()

  // Build providers array
  const providers = providerConfigs
    .filter(config => {
      // Non-admin users only see enabled providers
      if (!isAdmin && !config.isEnabled) {
        return false
      }
      return true
    })
    .map(config => ({
      code: config.name,
      displayName: config.displayName || config.name,
      type: config.type,
      apiKeyPlaceholder: config.apiKeyPlaceholder || '',
      domainPlaceholder: config.domainPlaceholder || '',
      isEnabled: config.isEnabled,
      hasApiKey: !!(config.apiKey || config.aliyunAccessKeyId || config.masterKey || (config.parameters?.aliyunAccessKeyId && config.parameters?.aliyunAccessKeySecret))
    }))

  res.json({
    success: true,
    providers
  })
})

/**
 * Get single provider details with masked credentials
 * GET /api/providers/:code
 * - All data from provider_config table
 */
defineRoute(router, {
  method: 'get',
  path: '/providers/{code}',
  operationId: 'getProvidersByCode',
  tags: ['Providers'],
  summary: '获取供应商详情',
  description: '获取指定供应商的详细信息，包括配置参数（敏感字段已脱敏）。仅管理员可访问。',
  security: [{ bearerAuth: [] }],
  request: {
    params: ProviderCodeParamsSchema,
  },
  responses: {
    200: {
      description: '成功返回供应商详情',
      content: { 'application/json': { schema: ProviderDetailResponseSchema } },
    },
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ params: ProviderCodeParamsSchema }), async (req, res) => {
  const { code } = req.params
  console.log(`[GetProvider] Fetching provider: ${code}`)

  try {
    const provider = await createProviderFromDB(code)
    const result = await provider.getProviderDetail()

    console.log(`[GetProvider] Final result:`, JSON.stringify(result, null, 2))

    res.json({
      success: true,
      provider: result
    })
  } catch (error) {
    console.error('[GetProvider] Error:', error)
    if (error.message?.includes('not found')) {
      return res.status(404).json({ success: false, error: 'Provider not found' })
    }
    res.status(500).json({ success: false, error: error.message })
  }
})

/**
 * Create a new provider
 * POST /api/providers
 * Body: { name, displayName?, type, apiKeyPlaceholder?, domainPlaceholder?, description? }
 */
defineRoute(router, {
  method: 'post',
  path: '/providers',
  operationId: 'createProviders',
  tags: ['Providers'],
  summary: '创建新供应商',
  description: '管理员创建新的 AI 供应商配置，创建后默认未启用，需单独启用。同一时间只允许一个供应商处于启用状态。',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: CreateProviderBody } } },
  },
  responses: {
    200: {
      description: '成功创建供应商',
      content: { 'application/json': { schema: CreateProviderResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: CreateProviderBody }), async (req, res) => {
  const { name, displayName, type, apiKeyPlaceholder, domainPlaceholder, description } = req.body

  // Check if provider already exists
  const existing = await getProviderConfig(name)
  if (existing) {
    return res.status(400).json({
      success: false,
      error: 'Provider already exists'
    })
  }

  // Create new provider
  await updateProviderConfig(name, {
    displayName: displayName || name,
    type: type || 'API',
    apiKeyPlaceholder: apiKeyPlaceholder || '',
    domainPlaceholder: domainPlaceholder || '',
    description: description || '',
    isEnabled: false
  })

  res.json({
    success: true,
    message: 'Provider created successfully',
    provider: { name, displayName: displayName || name, type: type || 'API' }
  })
})

/**
 * Update provider configuration
 * PUT /api/providers/:code
 * Body: { apiKey?, domain?, type?, isEnabled?, displayName?, description?, apiKeyPlaceholder?, domainPlaceholder? }
 * - Updates provider_config table
 */
defineRoute(router, {
  method: 'put',
  path: '/providers/{code}',
  operationId: 'updateProvidersByCode',
  tags: ['Providers'],
  summary: '更新供应商配置',
  description: '更新供应商的基本配置信息（如 API Key、Domain、显示名等）。网关类型供应商不支持直接修改 API Key/Domain。',
  security: [{ bearerAuth: [] }],
  request: {
    params: ProviderCodeParamsSchema,
    body: { content: { 'application/json': { schema: UpdateProviderBody } } },
  },
  responses: {
    200: {
      description: '成功更新供应商配置',
      content: { 'application/json': { schema: UpdateProviderResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: UpdateProviderBody, params: ProviderCodeParamsSchema }), async (req, res) => {
  const { code } = req.params
  const { apiKey, domain, type, isEnabled, displayName, description, apiKeyPlaceholder, domainPlaceholder } = req.body
  console.log(`[PUT /providers/${code}] Request body:`, JSON.stringify(req.body))

  // Check if provider exists
  const existingConfig = await getProviderConfig(code)
  if (!existingConfig) {
    console.log(`[PUT /providers/${code}] Provider not found`)
    return res.status(404).json({
      success: false,
      error: 'Provider not found'
    })
  }


  // For gateway providers, block direct apiKey/domain changes
  const providerIsGateway = existingConfig.type === 'AlibabaCloudAIGateway' || existingConfig.type === 'LiteLLM'
  if (providerIsGateway && (apiKey || domain)) {
    return res.status(400).json({
      success: false,
      error: '网关类型 Provider 不支持直接修改 API Key/Domain，请使用配置面板'
    })
  }

  // Build config update
  const configUpdate = {}

  if (isEnabled !== undefined) configUpdate.isEnabled = isEnabled
  if (displayName !== undefined) configUpdate.displayName = displayName
  if (description !== undefined) configUpdate.description = description
  if (apiKeyPlaceholder !== undefined) configUpdate.apiKeyPlaceholder = apiKeyPlaceholder
  if (domainPlaceholder !== undefined) configUpdate.domainPlaceholder = domainPlaceholder

  // Handle API key
  if (apiKey !== undefined) {
    configUpdate.apiKey = apiKey === '' || apiKey === null ? null : apiKey
  }

  // Handle domain
  if (domain !== undefined) {
    configUpdate.domain = domain === '' || domain === null ? null : domain
  }

  // Update provider_config table
  if (Object.keys(configUpdate).length > 0) {
    console.log(`[PUT /providers/${code}] Applying update:`, JSON.stringify(configUpdate))
    await updateProviderConfig(code, configUpdate)
  } else {
    console.log(`[PUT /providers/${code}] No changes to apply`)
  }

  res.json({
    success: true,
    message: 'Provider updated successfully'
  })
})

/**
 * Toggle provider enabled status
 * PATCH /api/providers/:code/toggle
 * - Updates provider_config table enabled field
 * - Validates: normal providers need API Key, gateway providers need gateway configured
 * - Enforces single provider rule: only one provider can be enabled at a time
 */
defineRoute(router, {
  method: 'patch',
  path: '/providers/{code}/toggle',
  operationId: 'toggleProvidersByCodeToggle',
  tags: ['Providers'],
  summary: '切换供应商启用状态',
  description: '切换供应商的启用/禁用状态。启用时会验证配置完整性，且同一时间只允许一个供应商处于启用状态。',
  security: [{ bearerAuth: [] }],
  request: {
    params: ProviderCodeParamsSchema,
  },
  responses: {
    200: {
      description: '成功切换供应商状态',
      content: { 'application/json': { schema: ToggleProviderResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ params: ProviderCodeParamsSchema }), async (req, res) => {
  const { code } = req.params
  console.log(`[Toggle] Start toggle for provider: ${code}`)

  // Get current config
  const config = await getProviderConfig(code)
  if (!config) {
    console.log(`[Toggle] Provider ${code} not found`)
    return res.status(404).json({
      success: false,
      error: 'Provider not found'
    })
  }
  console.log(`[Toggle] Raw config:`, JSON.stringify(config, null, 2))

  const currentEnabled = config.isEnabled ?? false
  const newEnabled = !currentEnabled
  console.log(`[Toggle] Will set enabled to: ${newEnabled}`)

  // Validation: only check when enabling (not when disabling)
  if (newEnabled) {
    // Check if another provider is already enabled
    const allConfigs = await getAllProviderConfigs()
    const enabledProviders = allConfigs.filter(cfg => cfg.isEnabled && cfg.name !== code)
    console.log(`[Toggle] Found ${enabledProviders.length} other enabled providers`)

    if (enabledProviders.length > 0) {
      const enabledProviderNames = enabledProviders.map(cfg => cfg.name).join(', ')
      console.log(`[Toggle] Rejecting: other enabled providers: ${enabledProviderNames}`)
      return res.status(400).json({
        success: false,
        error: `Cannot enable: provider(s) already enabled (${enabledProviderNames}). Please disable them first. Only one provider can be active at a time.`
      })
    }

    // Delegate config validation to the provider instance
    const provider = await createProviderFromDB(code)
    const validation = await provider.validateConfig()
    if (!validation.valid) {
      console.log(`[Toggle] Validation failed: ${validation.errors.join(', ')}`)
      return res.status(400).json({
        success: false,
        error: `Cannot enable: ${validation.errors.join('; ')}`
      })
    }
  }

  // Update provider_config table enabled field
  await updateProviderConfig(code, { isEnabled: newEnabled })

  res.json({
    success: true,
    provider: {
      code,
      isEnabled: newEnabled
    }
  })
})

/**
 * Delete a provider
 * DELETE /api/providers/:code
 */
defineRoute(router, {
  method: 'delete',
  path: '/providers/{code}',
  operationId: 'deleteProvidersByCode',
  tags: ['Providers'],
  summary: '删除供应商',
  description: '删除指定供应商配置。已启用的供应商不允许删除，需先禁用。',
  security: [{ bearerAuth: [] }],
  request: {
    params: ProviderCodeParamsSchema,
  },
  responses: {
    200: {
      description: '成功删除供应商',
      content: { 'application/json': { schema: DeleteResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ params: ProviderCodeParamsSchema }), async (req, res) => {
  const { code } = req.params

  // Check if provider exists
  const config = await getProviderConfig(code)
  if (!config) {
    return res.status(404).json({
      success: false,
      error: 'Provider not found'
    })
  }

  // Don't allow deleting enabled provider
  if (config.isEnabled) {
    return res.status(400).json({
      success: false,
      error: 'Cannot delete enabled provider. Please disable it first.'
    })
  }

  // Delete from database
  const { error } = await supabaseAdmin
    .from('provider_config')
    .delete()
    .eq('name', code)

  if (error) throw error

  res.json({
    success: true,
    message: 'Provider deleted successfully'
  })
})

// ========== Provider-Specific Operations ==========

/**
 * Get provider detailed configuration
 * GET /api/providers/:name/config
 */
defineRoute(router, {
  method: 'get',
  path: '/providers/{name}/config',
  operationId: 'getProvidersByNameConfig',
  tags: ['Provider Operations'],
  summary: '获取供应商详细配置',
  description: '获取供应商的详细配置参数，包括网关域名、账号信息等（敏感字段已脱敏）。',
  security: [{ bearerAuth: [] }],
  request: {
    params: ProviderNameParamsSchema,
  },
  responses: {
    200: {
      description: '成功返回供应商配置',
      content: { 'application/json': { schema: ProviderConfigResponseSchema } },
    },
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ params: ProviderNameParamsSchema }), async (req, res) => {
  const { name } = req.params
  const provider = await createProviderFromDB(name)
  const config = await provider.getConfig()

  res.json({
    success: true,
    config
  })
})

/**
 * Update provider configuration
 * PUT /api/providers/:name/config
 */
defineRoute(router, {
  method: 'put',
  path: '/providers/{name}/config',
  operationId: 'updateProvidersByNameConfig',
  tags: ['Provider Operations'],
  summary: '更新供应商详细配置',
  description: '更新供应商的详细配置参数。对于阿里云网关类型，会自动拉取 environmentId 和 gatewayDomain。',
  security: [{ bearerAuth: [] }],
  request: {
    params: ProviderNameParamsSchema,
    body: { content: { 'application/json': { schema: UpdateProviderConfigBody } } },
  },
  responses: {
    200: {
      description: '成功更新供应商配置',
      content: { 'application/json': { schema: ProviderConfigResponseSchema } },
    },
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: UpdateProviderConfigBody, params: ProviderNameParamsSchema }), async (req, res) => {
  const { name } = req.params
  const provider = await createProviderFromDB(name)

  // Get current config (masked, for type check and non-sensitive fields)
  const currentConfig = await provider.getConfig()

  // For AlibabaCloudAIGateway, auto-fetch environmentId and gatewayDomain if not provided
  let updates = { ...req.body }

  if (currentConfig.type === 'AlibabaCloudAIGateway') {
    const { fetchHttpApiDetailsWithCredentials } = await import('../services/apig.js')

    const userProvidedEnvironmentId = updates.environmentId && updates.environmentId.trim() !== ''
    const userProvidedGatewayDomain = updates.gatewayDomain && updates.gatewayDomain.trim() !== ''

    // Load decrypted config for auto-fetch (getConfig() returns masked credentials)
    const decryptedConfig = await provider._loadConfigFromDB()

    const effectiveHttpApiId = updates.httpApiId || currentConfig.httpApiId
    const effectiveAccessKeyId = updates.aliyunAccessKeyId || decryptedConfig.aliyunAccessKeyId
    const effectiveAccessKeySecret = updates.aliyunAccessKeySecret || decryptedConfig.aliyunAccessKeySecret
    const effectiveRegionId = updates.regionId || currentConfig.regionId || 'cn-hangzhou'

    const needAutoFetch = (!userProvidedEnvironmentId || !userProvidedGatewayDomain) &&
                          effectiveHttpApiId && effectiveAccessKeyId && effectiveAccessKeySecret

    if (needAutoFetch) {
      try {
        console.log('🔄 Auto-fetching environmentId and gatewayDomain from GetHttpApi...')
        const fetched = await fetchHttpApiDetailsWithCredentials({
          httpApiId: effectiveHttpApiId,
          accessKeyId: effectiveAccessKeyId,
          accessKeySecret: effectiveAccessKeySecret,
          regionId: effectiveRegionId
        })

        if (!userProvidedEnvironmentId && fetched.environmentId) {
          updates.environmentId = fetched.environmentId
          console.log(`   ✅ Auto-set environmentId: ${fetched.environmentId}`)
        }
        if (!userProvidedGatewayDomain && fetched.gatewayDomain) {
          updates.gatewayDomain = fetched.gatewayDomain
          console.log(`   ✅ Auto-set gatewayDomain: ${fetched.gatewayDomain}`)
        }
      } catch (fetchError) {
        console.warn('⚠️ Failed to auto-fetch HTTP API details:', fetchError.message)
      }
    }
  }

  const updatedConfig = await provider.updateConfig(updates)

  res.json({
    success: true,
    config: updatedConfig
  })
})

/**
 * Get provider limit configuration (unified API for all providers)
 * GET /api/providers/:name/limit-config
 */
defineRoute(router, {
  method: 'get',
  path: '/providers/{name}/limit-config',
  operationId: 'getProvidersByNameLimitConfig',
  tags: ['Provider Operations'],
  summary: '获取供应商限额配置',
  description: '获取供应商的用户/分组默认限额配置（日限/月限）。如果供应商不支持限额功能，返回 supported=false。',
  security: [{ bearerAuth: [] }],
  request: {
    params: ProviderNameParamsSchema,
  },
  responses: {
    200: {
      description: '成功返回限额配置',
      content: { 'application/json': { schema: GetLimitConfigResponseSchema } },
    },
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ params: ProviderNameParamsSchema }), async (req, res) => {
  const { name } = req.params
  const provider = await createProviderFromDB(name)

  if (!provider.supportsLimitConfig()) {
    return res.json({
      success: true,
      config: { enabled: false, budgets: [] },
      supported: false
    })
  }

  const config = await provider.getLimitConfig()

  res.json({
    success: true,
    config,
    supported: true
  })
})

/**
 * Update provider limit configuration (unified API for all providers)
 * PUT /api/providers/:name/limit-config
 * Body: [{timeRate, value, unit}] or { budgets: [{timeRate, value, unit}] }
 */
defineRoute(router, {
  method: 'put',
  path: '/providers/{name}/limit-config',
  operationId: 'updateProvidersByNameLimitConfig',
  tags: ['Provider Operations'],
  summary: '更新供应商限额配置',
  description: '更新供应商的用户/分组默认限额配置，设置每日/每月的 Token 或预算上限。请求体支持 { budgets: [...] } 或 budgets 数组(向后兼容)两种形式。',
  security: [{ bearerAuth: [] }],
  request: {
    params: ProviderNameParamsSchema,
    body: { content: { 'application/json': { schema: UpdateLimitConfigBody } } },
  },
  responses: {
    200: {
      description: '成功更新限额配置',
      content: { 'application/json': { schema: UpdateLimitConfigResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: UpdateLimitConfigBody, params: ProviderNameParamsSchema }), async (req, res) => {
  const { name } = req.params
  const provider = await createProviderFromDB(name)

  if (!provider.supportsLimitConfig()) {
    return res.status(400).json({
      success: false,
      error: 'Limit configuration not supported by this provider'
    })
  }

  // Support both raw array and { budgets: [...] } format
  const budgets = Array.isArray(req.body) ? req.body : (req.body.budgets || [])
  const result = await provider.updateLimitConfig(budgets)

  res.json({
    success: true,
    message: result.message
  })
})

/**
 * Get the currently enabled provider name
 * @returns {Promise<string|null>} - The name of the enabled provider, or null if none
 */
async function getCurrentEnabledProvider() {
  const allConfigs = await getAllProviderConfigs()
  const enabled = allConfigs.find(cfg => cfg.isEnabled)
  return enabled ? enabled.name : null
}

/**
 * Get provider statistics for the currently enabled provider
 * GET /api/providers/current/stats
 */
defineRoute(router, {
  method: 'get',
  path: '/providers/current/stats',
  operationId: 'listProvidersCurrentStats',
  tags: ['Provider Operations'],
  summary: '获取供应商统计数据',
  description: '获取当前启用供应商的统计数据（调用量、Token消耗等）。若无启用供应商或供应商不支持统计，返回 supported=false。',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: '成功返回供应商统计数据',
      content: { 'application/json': { schema: ProviderStatsResponseSchema } },
    },
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, async (req, res) => {
  const enabledProvider = await getCurrentEnabledProvider()

  if (!enabledProvider) {
    return res.json({
      success: true,
      stats: null,
      supported: false,
      message: 'No provider is currently enabled'
    })
  }

  const provider = await createProviderFromDB(enabledProvider)

  if (!provider.supportsStats()) {
    return res.json({
      success: true,
      stats: null,
      supported: false
    })
  }

  const stats = await provider.getStats()

  res.json({
    success: true,
    stats,
    supported: true
  })
})

/**
 * Get token usage by consumer for the currently enabled provider
 * GET /api/providers/current/tokens?days=1|30
 */
defineRoute(router, {
  method: 'get',
  path: '/providers/current/tokens',
  operationId: 'listProvidersCurrentTokens',
  tags: ['Provider Operations'],
  summary: '获取令牌消耗详情',
  description: '获取当前启用供应商下各用户的 Token 消耗明细，支持按 1 天或 30 天范围查询。',
  security: [{ bearerAuth: [] }],
  request: {
    query: TokensQuerySchema,
  },
  responses: {
    200: {
      description: '成功返回令牌消耗数据',
      content: { 'application/json': { schema: TokensResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ query: TokensQuerySchema }), async (req, res) => {
  const enabledProvider = await getCurrentEnabledProvider()

  if (!enabledProvider) {
    return res.json({
      success: true,
      consumers: [],
      supported: false,
      message: 'No provider is currently enabled'
    })
  }

  const days = parseInt(req.query.days, 10) || 1

  if (![1, 30].includes(days)) {
    return res.status(400).json({
      success: false,
      error: 'days must be 1 or 30'
    })
  }

  const provider = await createProviderFromDB(enabledProvider)

  if (!provider.supportsStats()) {
    return res.json({
      success: true,
      consumers: [],
      supported: false
    })
  }

  const consumers = await provider.getUsageByConsumer(days)

  res.json({
    success: true,
    consumers,
    supported: true
  })
})

/**
 * Get per-user limit for the currently enabled provider (unified Budget API)
 * GET /api/providers/current/user-limit?userId=xxx
 */
defineRoute(router, {
  method: 'get',
  path: '/providers/current/user-limit',
  operationId: 'listProvidersCurrentUserLimit',
  tags: ['Provider Operations'],
  summary: '获取用户限额配置',
  description: '获取指定用户在当前启用供应商下的个人限额配置，包括用户级别和全局级别的生效限额。',
  security: [{ bearerAuth: [] }],
  request: {
    query: UserLimitQuerySchema,
  },
  responses: {
    200: {
      description: '成功返回用户限额配置',
      content: { 'application/json': { schema: GetUserLimitResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ query: UserLimitQuerySchema }), async (req, res) => {
  const userId = req.query.userId

  const enabledProvider = await getCurrentEnabledProvider()
  if (!enabledProvider) {
    return res.json({
      success: true,
      config: { enabled: false, budgets: [], globalBudgets: [], effectiveBudgets: [], hasConsumer: false }
    })
  }

  const provider = await createProviderFromDB(enabledProvider)
  const result = await provider.getUserLimit(userId)

  res.json({
    success: true,
    config: result
  })
})

/**
 * Update per-user limit for the currently enabled provider (unified Budget API)
 * PUT /api/providers/current/user-limit
 * Body: { userId, budgets: [{timeRate, value, unit}] }
 */
defineRoute(router, {
  method: 'put',
  path: '/providers/current/user-limit',
  operationId: 'updateProvidersCurrentUserLimit',
  tags: ['Provider Operations'],
  summary: '更新用户限额配置',
  description: '更新指定用户在当前启用供应商下的个人限额配置，支持设置每日/每月的 Token 消耗上限。',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: UpdateUserLimitBody } } },
  },
  responses: {
    200: {
      description: '成功更新用户限额',
      content: { 'application/json': { schema: UpdateUserLimitResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: UpdateUserLimitBody }), async (req, res) => {
  const { userId, budgets } = req.body

  const enabledProvider = await getCurrentEnabledProvider()
  if (!enabledProvider) {
    return res.status(400).json({ success: false, error: 'No provider is currently enabled' })
  }

  const provider = await createProviderFromDB(enabledProvider)
  let result
  try {
    result = await provider.updateUserLimit(userId, budgets || [])
  } catch (error) {
    const message = error?.message || 'Failed to update user limit'
    if (
      message.includes('User limit not supported by this provider') ||
      message.includes('用户不存在') ||
      message.includes('用户尚未绑定 Consumer')
    ) {
      return res.status(400).json({ success: false, error: message })
    }
    throw error
  }

  res.json({
    success: true,
    message: result.message
  })
})

// Helper function to sanitize consumer name (must match apig.js implementation)
function sanitizeConsumerName(email) {
  if (!email) return ''
  // Step 1: replace @ with dot, replace all other invalid chars with dash
  let name = email.replace(/@/g, '.').replace(/[^a-zA-Z0-9.\-]/g, '-')
  // Step 2: strip leading/trailing non-alphanumeric chars
  name = name.replace(/^[^a-zA-Z0-9]+/, '').replace(/[^a-zA-Z0-9]+$/, '')
  // Step 3: collapse consecutive dots/dashes
  name = name.replace(/([\.\-]){2,}/g, '$1')
  // Step 4: truncate to 64 characters
  if (name.length > 64) {
    name = name.slice(0, 64).replace(/[^a-zA-Z0-9]+$/, '')
  }
  // Step 5: ensure minimum length of 2
  if (name.length < 2) {
    name = name.padEnd(2, '0')
  }
  return name
}

export default router
