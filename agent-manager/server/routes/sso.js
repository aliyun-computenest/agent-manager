/**
 * SAML SSO Configuration Routes
 * Handles Supabase SSO provider and auth settings management
 */

import { Router } from 'express'
import { z } from 'zod'
import { requireAdmin } from '../middleware/auth.js'
import { env, supabaseUrl, serviceRoleKey, supabaseAdmin } from '../config/index.js'
import { defineRoute } from '../openapi/route-helper.js'
import { SSOSettingsSchema, SSOModeSchema } from '../schemas/sso.js'
import { errorResponse, DeleteResponseSchema } from '../schemas/common.js'
import { validate } from '../middleware/validate.js'

const router = Router()

const SSO_MODE_KEY = 'sso_active_mode'

const SsoIdParamsSchema = z.object({
  id: z.string().describe('SSO provider ID (UUID)'),
})

const UpdateSsoModeBody = z.object({ mode: z.enum(['none', 'oauth', 'saml']) }).passthrough()

const UpdateSsoSettingsBody = z.object({ site_url: z.string({ required_error: 'site_url is required' }).min(1, { message: 'site_url is required' }) }).passthrough()

const CreateSsoProviderBody = z.object({ domain: z.string({ required_error: 'domain and metadata_url are required' }).min(1, { message: 'domain and metadata_url are required' }), metadata_url: z.string({ required_error: 'domain and metadata_url are required' }).min(1, { message: 'domain and metadata_url are required' }) }).passthrough()

const SsoModeResponseSchema = z.object({
  success: z.literal(true),
  mode: SSOModeSchema,
})

const OAuthProviderSchema = z.object({
  provider: z.string().describe('OAuth provider key'),
  name: z.string().describe('显示名'),
  color: z.string().describe('品牌色'),
  enabled: z.boolean().describe('是否启用'),
})

const SamlProviderSummarySchema = z.object({
  id: z.string().describe('SAML provider ID'),
  type: z.literal('saml'),
  domains: z.array(z.string()).describe('SAML 关联域名'),
})

const SsoAuthProvidersResponseSchema = z.object({
  success: z.literal(true),
  oauthProviders: z.array(OAuthProviderSchema),
  samlProviders: z.array(SamlProviderSummarySchema),
  hasSaml: z.boolean(),
  activeMode: SSOModeSchema,
})

const SsoInfoResponseSchema = z.object({
  success: z.literal(true),
  supabaseUrl: z.string().describe('Supabase 服务地址'),
  spEntityId: z.string().describe('SAML SP Entity ID'),
  spAcsUrl: z.string().describe('SAML ACS 回调地址'),
})

const SsoSettingsResponseSchema = z.object({
  success: z.literal(true),
  settings: SSOSettingsSchema,
})

const SsoProviderPublicSchema = z.object({
  id: z.string().describe('SSO provider ID'),
  domains: z.array(z.object({ domain: z.string(), created_at: z.string().optional() })),
})

const ListSsoProvidersPublicResponseSchema = z.object({
  success: z.literal(true),
  providers: z.array(SsoProviderPublicSchema),
})

const ListSsoProvidersResponseSchema = z.object({
  success: z.literal(true),
  providers: z.array(z.object({ id: z.string().uuid(), created_at: z.string().optional(), updated_at: z.string().optional(), type: z.string().optional(), metadata_url: z.string().optional(), domains: z.array(z.object({ domain: z.string(), created_at: z.string().optional() })).optional(), issuer: z.string().optional() }).passthrough()),
})

const SsoProviderResponseSchema = z.object({
  success: z.literal(true),
  provider: z.object({ id: z.string().uuid(), created_at: z.string().optional(), updated_at: z.string().optional(), type: z.string().optional(), metadata_url: z.string().optional(), domains: z.array(z.object({ domain: z.string(), created_at: z.string().optional() })).optional(), issuer: z.string().optional() }).passthrough(),
})

// =====================================================
// SSO Mode APIs
// =====================================================

/**
 * 获取当前 SSO 启用模式
 * GET /api/sso/mode
 * 返回: { mode: 'none' | 'oauth' | 'saml' }
 */
defineRoute(router, {
  method: 'get',
  path: '/sso/mode',
  operationId: 'listSsoMode',
  tags: ['SSO'],
  summary: '获取当前 SSO 启用模式',
  description: '获取系统当前配置的 SSO 启用模式（none/oauth/saml），需要管理员权限。',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: '成功返回 SSO 模式',
      content: { 'application/json': { schema: SsoModeResponseSchema } },
    },
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, async (req, res) => {
  const { data } = await supabaseAdmin
    .from('system_config')
    .select('value')
    .eq('key', SSO_MODE_KEY)
    .maybeSingle()

  const mode = data?.value?.mode || 'none'
  res.json({ success: true, mode })
})

/**
 * 获取当前 SSO 启用模式（公开接口，登录页用）
 * GET /api/sso/mode/public
 */
defineRoute(router, {
  method: 'get',
  path: '/sso/mode/public',
  operationId: 'listSsoModePublic',
  tags: ['SSO'],
  summary: '公开接口，获取 SSO 模式（无需认证）',
  description: '获取当前 SSO 启用模式，用于登录页面判断认证方式，无需认证。',
  security: [],
  responses: {
    200: {
      description: '成功返回 SSO 模式',
      content: { 'application/json': { schema: SsoModeResponseSchema } },
    },
    500: errorResponse,
  },
}, async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('system_config')
      .select('value')
      .eq('key', SSO_MODE_KEY)
      .maybeSingle()

    const mode = data?.value?.mode || 'none'
    res.json({ success: true, mode })
  } catch (error) {
    console.error('Get SSO mode (public) error:', error)
    res.json({ success: true, mode: 'none' })
  }
})

/**
 * 设置 SSO 启用模式
 * PUT /api/sso/mode
 * Body: { mode: 'none' | 'oauth' | 'saml' }
 */
defineRoute(router, {
  method: 'put',
  path: '/sso/mode',
  operationId: 'updateSsoMode',
  tags: ['SSO'],
  summary: '设置 SSO 启用模式',
  description: '管理员设置系统的 SSO 启用模式，可选值为 none、oauth 或 saml。',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: UpdateSsoModeBody } } },
  },
  responses: {
    200: {
      description: '成功设置 SSO 模式',
      content: { 'application/json': { schema: SsoModeResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: UpdateSsoModeBody }), async (req, res) => {
  const { mode } = req.body

  const { error } = await supabaseAdmin
    .from('system_config')
    .upsert({
      key: SSO_MODE_KEY,
      value: { mode },
      description: '单点登录启用模式：none/oauth/saml',
      updated_at: new Date().toISOString()
    })

  if (error) throw error
  res.json({ success: true, mode })
})

// =====================================================
// SSO Auth Providers / Info / Settings APIs
// =====================================================

/**
 * 获取 Supabase 已启用的 Auth Providers（OAuth + SAML）
 * 通过 Supabase Auth settings API 获取
 */
defineRoute(router, {
  method: 'get',
  path: '/sso/auth-providers',
  operationId: 'listSsoAuthProviders',
  tags: ['SSO'],
  summary: '获取已启用的 Auth Providers（OAuth + SAML）',
  description: '获取 Supabase 中已启用的 OAuth 和 SAML SSO 提供商列表，并返回当前启用模式。',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: '成功返回 Auth Providers 列表',
      content: { 'application/json': { schema: SsoAuthProvidersResponseSchema } },
    },
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, async (req, res) => {
  // 获取 auth settings
  const settingsResponse = await fetch(`${supabaseUrl}/auth/v1/settings`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  })

  if (!settingsResponse.ok) {
    const errorText = await settingsResponse.text()
    throw new Error(`Failed to get auth settings: ${errorText}`)
  }

  const settings = await settingsResponse.json()

  // 解析已启用的 OAuth providers
  // 兼容官方嵌套格式 external.github 和旧扁平格式 external_github_enabled
  const oauthProviders = []
  const nestedExternal = settings.external && typeof settings.external === 'object' ? settings.external : {}

  const knownProviders = [
    { key: 'alibabacloud', name: '阿里云', color: '#FF6A00' },
    { key: 'github', name: 'GitHub', color: '#24292f' },
    { key: 'google', name: 'Google', color: '#4285f4' },
    { key: 'azure', name: 'Azure AD', color: '#0078d4' },
    { key: 'gitlab', name: 'GitLab', color: '#fc6d26' },
    { key: 'bitbucket', name: 'Bitbucket', color: '#0052cc' },
    { key: 'slack', name: 'Slack', color: '#4a154b' },
    { key: 'discord', name: 'Discord', color: '#5865f2' },
    { key: 'twitter', name: 'Twitter', color: '#1da1f2' },
    { key: 'facebook', name: 'Facebook', color: '#1877f2' },
    { key: 'linkedin_oidc', name: 'LinkedIn', color: '#0a66c2' },
    { key: 'notion', name: 'Notion', color: '#000000' },
    { key: 'spotify', name: 'Spotify', color: '#1db954' },
    { key: 'twitch', name: 'Twitch', color: '#9146ff' },
    { key: 'workos', name: 'WorkOS', color: '#6363f1' },
    { key: 'zoom', name: 'Zoom', color: '#2d8cff' },
    { key: 'keycloak', name: 'Keycloak', color: '#00a4d9' },
    { key: 'apple', name: 'Apple', color: '#000000' },
    { key: 'figma', name: 'Figma', color: '#f24e1e' },
    { key: 'fly', name: 'Fly.io', color: '#7b3fe4' },
    { key: 'kakao', name: 'Kakao', color: '#fee500' },
    { key: 'feishu', name: '飞书', color: '#3370FF' },
    { key: 'dingtalk', name: '钉钉', color: '#0089FF' },
    { key: 'wechat', name: '微信', color: '#07C160' },
    { key: 'alipay', name: '支付宝', color: '#1677FF' },
  ]

  for (const provider of knownProviders) {
    const flatKey = `external_${provider.key}_enabled`
    if (settings[flatKey] === true || nestedExternal[provider.key] === true) {
      oauthProviders.push({
        provider: provider.key,
        name: provider.name,
        color: provider.color,
        enabled: true,
      })
    }
  }

  // 获取 SAML SSO providers
  let samlProviders = []
  try {
    const ssoResponse = await fetch(`${supabaseUrl}/auth/v1/admin/sso/providers`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    })

    if (ssoResponse.ok) {
      const ssoData = await ssoResponse.json()
      samlProviders = (ssoData.items || []).map((p) => ({
        id: p.id,
        type: 'saml',
        domains: p.domains?.map((d) => d.domain) || [],
      }))
    }
  } catch (e) {
    console.warn('Failed to fetch SAML providers:', e.message)
  }

  // 获取管理员设置的 SSO 启用模式
  let activeMode = 'none'
  try {
    const { data: modeData } = await supabaseAdmin
      .from('system_config')
      .select('value')
      .eq('key', SSO_MODE_KEY)
      .maybeSingle()
    activeMode = modeData?.value?.mode || 'none'
  } catch (e) {
    console.warn('Failed to get SSO mode:', e.message)
  }

  res.json({
    success: true,
    oauthProviders,
    samlProviders,
    hasSaml: samlProviders.length > 0,
    activeMode,
  })
})

defineRoute(router, {
  method: 'get',
  path: '/sso/info',
  operationId: 'listSsoInfo',
  tags: ['SSO'],
  summary: '获取 SSO 信息（SP Entity ID、ACS URL）',
  description: '获取 SAML SSO 配置所需的服务提供商信息，包括 Entity ID 和 ACS URL。',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: '成功返回 SSO 信息',
      content: { 'application/json': { schema: SsoInfoResponseSchema } },
    },
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, async (req, res) => {
  const publicUrl = env.VITE_SUPABASE_URL
  const spEntityId = `${publicUrl}/auth/v1/sso/saml/metadata`
  const spAcsUrl = `${publicUrl}/auth/v1/sso/saml/acs`

  res.json({
    success: true,
    supabaseUrl: publicUrl,
    spEntityId,
    spAcsUrl,
  })
})

defineRoute(router, {
  method: 'get',
  path: '/sso/settings',
  operationId: 'listSsoSettings',
  tags: ['SSO'],
  summary: '获取 SSO 设置',
  description: '获取 SSO 回调相关设置，包括站点 URL 和允许的重定向 URI 列表。',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: '成功返回 SSO 设置',
      content: { 'application/json': { schema: SsoSettingsResponseSchema } },
    },
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, async (req, res) => {
  const response = await fetch(`${supabaseUrl}/auth/v1/settings`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to get settings: ${errorText}`)
  }

  const data = await response.json()
  res.json({
    success: true,
    settings: {
      site_url: data.site_url || '',
      uri_allow_list: data.uri_allow_list || '',
    },
  })
})

defineRoute(router, {
  method: 'patch',
  path: '/sso/settings',
  operationId: 'updateSsoSettings',
  tags: ['SSO'],
  summary: '更新 SSO 设置',
  description: '更新 SSO 回调相关设置，包括站点 URL 和允许的重定向 URI 列表。',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: UpdateSsoSettingsBody } } },
  },
  responses: {
    200: {
      description: '成功更新设置',
      content: { 'application/json': { schema: SsoSettingsResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: UpdateSsoSettingsBody }), async (req, res) => {
  const { site_url, uri_allow_list } = req.body

  if (!site_url) {
    return res.status(400).json({
      success: false,
      error: 'site_url is required',
    })
  }

  const updateData = {
    site_url,
    uri_allow_list: uri_allow_list || `${site_url}/`,
  }

  const response = await fetch(`${supabaseUrl}/auth/v1/modify/settings`, {
    method: 'PATCH',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(updateData),
  })

  if (!response.ok) {
    if (response.status === 404) {
      return res.status(501).json({
        success: false,
        error: 'Open-source Supabase does not support modifying settings via API. Please use kubectl to update GOTRUE_SITE_URL and GOTRUE_URI_ALLOW_LIST environment variables directly.',
      })
    }
    const errorText = await response.text()
    throw new Error(`Failed to update settings: ${errorText}`)
  }

  const data = await response.json()

  res.json({
    success: true,
    settings: {
      site_url: data.site_url,
      uri_allow_list: data.uri_allow_list,
    },
  })
})

// =====================================================
// SSO Providers APIs
// =====================================================

defineRoute(router, {
  method: 'get',
  path: '/sso/providers/public',
  operationId: 'listSsoProvidersPublic',
  tags: ['SSO Providers'],
  summary: '公开接口，获取 SSO providers（无需认证）',
  description: '获取已配置的 SSO providers 公开信息，用于登录页面展示，无需认证。',
  security: [],
  responses: {
    200: {
      description: '成功返回 providers 列表',
      content: { 'application/json': { schema: ListSsoProvidersPublicResponseSchema } },
    },
    500: errorResponse,
  },
}, async (req, res) => {
  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/admin/sso/providers`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    })

    if (!response.ok) {
      return res.json({ success: true, providers: [] })
    }

    const data = await response.json()
    const publicProviders = (data.items || []).map((provider) => ({
      id: provider.id,
      domains: provider.domains,
    }))

    res.json({ success: true, providers: publicProviders })
  } catch (error) {
    console.error('List public SSO providers error:', error)
    res.json({ success: true, providers: [] })
  }
})

defineRoute(router, {
  method: 'get',
  path: '/sso/providers',
  operationId: 'listSsoProviders',
  tags: ['SSO Providers'],
  summary: '列出 SSO providers',
  description: '获取所有已配置的 SAML SSO providers 完整信息，需要管理员权限。',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: '成功返回 providers 列表',
      content: { 'application/json': { schema: ListSsoProvidersResponseSchema } },
    },
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, async (req, res) => {
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/sso/providers`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to list SSO providers: ${errorText}`)
  }

  const data = await response.json()
  res.json({ success: true, providers: data.items || [] })
})

defineRoute(router, {
  method: 'post',
  path: '/sso/providers',
  operationId: 'createSsoProvider',
  tags: ['SSO Providers'],
  summary: '添加 SSO provider',
  description: '添加新的 SAML SSO provider 配置，需要提供企业域名和 IdP 元数据 URL。',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: CreateSsoProviderBody } } },
  },
  responses: {
    200: {
      description: '成功添加',
      content: { 'application/json': { schema: SsoProviderResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: CreateSsoProviderBody }), async (req, res) => {
  const { domain, metadata_url, attribute_mapping_email = 'email' } = req.body

  const providerData = {
    type: 'saml',
    metadata_url,
    domains: [domain],
    attribute_mapping: {
      keys: {
        email: { name: attribute_mapping_email },
      },
    },
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)

  const response = await fetch(`${supabaseUrl}/auth/v1/admin/sso/providers`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(providerData),
    signal: controller.signal,
  })

  clearTimeout(timeout)

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}))
    throw new Error(errorData.message || `Failed to add SSO provider: ${response.status}`)
  }

  const data = await response.json()
  res.json({ success: true, provider: data })
})

defineRoute(router, {
  method: 'delete',
  path: '/sso/providers/{id}',
  operationId: 'deleteSsoProvidersById',
  tags: ['SSO Providers'],
  summary: '删除 SSO provider',
  description: '管理员删除指定的 SAML SSO provider 配置，删除后对应域名的单点登录将失效。',
  security: [{ bearerAuth: [] }],
  request: {
    params: SsoIdParamsSchema,
  },
  responses: {
    200: {
      description: '成功删除',
      content: { 'application/json': { schema: DeleteResponseSchema } },
    },
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ params: SsoIdParamsSchema }), async (req, res) => {
  const { id } = req.params

  const response = await fetch(`${supabaseUrl}/auth/v1/admin/sso/providers/${id}`, {
    method: 'DELETE',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to delete SSO provider: ${errorText}`)
  }

  res.json({ success: true, message: 'SSO provider deleted successfully' })
})

export default router
