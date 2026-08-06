/**
 * Email Authentication Routes
 * Handles email auth and signup toggles via GoTrue API
 */

import { Router } from 'express'
import { z } from 'zod'
import { supabaseAdmin, supabaseUrl, serviceRoleKey } from '../config/index.js'
import { requireAdmin } from '../middleware/auth.js'
import { defineRoute } from '../openapi/route-helper.js'
import { errorResponse } from '../schemas/common.js'
import { validate } from '../middleware/validate.js'

const router = Router()
const SIGNUP_ENABLED_KEY = 'signup_enabled'

const EmailAuthSettingsSchema = z.object({
  enabled: z.boolean().describe('是否启用邮箱认证'),
  signupEnabled: z.boolean().describe('是否允许用户自助注册'),
  smtpConfigured: z.boolean().describe('SMTP 是否已配置'),
  smtpHost: z.string().describe('SMTP 服务器地址'),
  siteUrl: z.string().describe('站点 URL'),
})

const GetEmailAuthSettingsResponseSchema = z.object({
  success: z.literal(true),
  data: EmailAuthSettingsSchema,
})

const UpdateEmailAuthSettingsBody = z.object({
  enabled: z.boolean().optional(),
  signupEnabled: z.boolean().optional(),
}).passthrough()

const UpdateEmailAuthSettingsResponseSchema = z.object({
  success: z.literal(true),
  data: EmailAuthSettingsSchema,
  warnings: z.array(z.string()).optional(),
  warningCodes: z.array(z.string()).optional(),
})

function authHeaders() {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  }
}

async function fetchAuthSettings() {
  const response = await fetch(`${supabaseUrl}/auth/v1/settings`, {
    headers: authHeaders(),
  })

  if (!response.ok) {
    throw new Error(`Failed to get settings: ${await response.text()}`)
  }

  return response.json()
}

function pickBoolean(...values) {
  return values.find(value => typeof value === 'boolean')
}

function buildSettingsData(settings) {
  const mailerAutoconfirm = pickBoolean(
    settings.mailer_autoconfirm,
    settings.autoconfirm,
    settings.MAILER_AUTOCONFIRM
  )
  const disableSignup = pickBoolean(settings.disable_signup, settings.DISABLE_SIGNUP)

  // Open-source GoTrue does not expose smtp_host in /settings response.
  // When mailer_autoconfirm is explicitly false, SMTP must have been configured
  // via env vars (GoTrue would fail to start otherwise), so infer smtpConfigured.
  const smtpConfigured = settings.smtp_host
    ? true
    : mailerAutoconfirm === false

  return {
    enabled: mailerAutoconfirm === undefined ? false : !mailerAutoconfirm,
    signupEnabled: disableSignup === undefined ? true : !disableSignup,
    smtpConfigured,
    smtpHost: settings.smtp_host || '',
    siteUrl: settings.site_url || '',
  }
}

async function patchAuthSettings(updateData, fallbackData = null) {
  const response = await fetch(`${supabaseUrl}/auth/v1/modify/settings`, {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify(updateData),
  })

  if (response.ok) {
    return { warnings: [] }
  }

  const errorText = await response.text()

  if (fallbackData && (response.status === 400 || response.status === 422)) {
    const fallbackResponse = await fetch(`${supabaseUrl}/auth/v1/modify/settings`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify(fallbackData),
    })

    if (fallbackResponse.ok) {
      return {
        warnings: ['已更新用户自助注册开关；部分底层认证加固项需要由 Auth 服务版本支持。'],
        warningCodes: ['unsupportedHardening'],
      }
    }
  }

  if (response.status === 404 || response.status === 405) {
    return {
      unsupported: true,
      errorCode: 'modifyUnsupported',
      error: '当前 Supabase Auth 不支持通过 API 动态修改认证设置。开源版请通过环境变量设置 GOTRUE_DISABLE_SIGNUP=true 后重启 Auth 服务。',
    }
  }

  throw new Error(`Failed to update settings: ${errorText}`)
}

/**
 * GET /api/email/auth-settings
 * Returns current email auth status + SMTP info
 */
defineRoute(router, {
  method: 'get',
  path: '/email/auth-settings',
  operationId: 'getEmailAuthSettings',
  tags: ['Email'],
  summary: '获取邮箱认证设置',
  description: '获取当前邮箱认证的开关状态、SMTP 配置信息及站点 URL，用于管理员查看邮箱登录配置。',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: '成功返回邮箱认证设置',
      content: { 'application/json': { schema: GetEmailAuthSettingsResponseSchema } },
    },
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, async (req, res) => {
  const settings = await fetchAuthSettings()

  res.json({
    success: true,
    data: buildSettingsData(settings),
  })
})

/**
 * PUT /api/email/auth-settings
 * Toggle email auth on/off
 */
defineRoute(router, {
  method: 'put',
  path: '/email/auth-settings',
  operationId: 'updateEmailAuthSettings',
  tags: ['Email'],
  summary: '切换邮箱认证开关',
  description: '管理员启用或禁用邮箱认证及用户自助注册功能，通过 GoTrue API 修改认证配置，并将状态持久化到 system_config。',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: UpdateEmailAuthSettingsBody } } },
  },
  responses: {
    200: {
      description: '更新成功',
      content: { 'application/json': { schema: UpdateEmailAuthSettingsResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: UpdateEmailAuthSettingsBody }), async (req, res) => {
  const { enabled, signupEnabled } = req.body

  if (enabled === undefined && signupEnabled === undefined) {
    return res.status(400).json({
      success: false,
      error: 'enabled or signupEnabled is required',
    })
  }

  const updateData = {}
  const fallbackData = {}
  let fallbackForUnsupportedHardening = null

  if (enabled !== undefined) {
    updateData.mailer_autoconfirm = !enabled
    fallbackData.mailer_autoconfirm = !enabled
  }

  if (signupEnabled !== undefined) {
    updateData.disable_signup = !signupEnabled
    fallbackData.disable_signup = !signupEnabled

    if (!signupEnabled) {
      updateData.external_anonymous_users_enabled = false
      updateData.security_manual_linking_enabled = false
      fallbackForUnsupportedHardening = fallbackData
    }
  }

  const updateResult = await patchAuthSettings(updateData, fallbackForUnsupportedHardening)
  if (updateResult.unsupported) {
    return res.status(501).json({
      success: false,
      error: updateResult.error,
      errorCode: updateResult.errorCode,
    })
  }

  const upserts = []
  if (enabled !== undefined) {
    upserts.push({
      key: 'email_auth_enabled',
      value: { enabled },
      description: '邮箱认证开关',
      updated_at: new Date().toISOString(),
    })
  }
  if (signupEnabled !== undefined) {
    upserts.push({
      key: SIGNUP_ENABLED_KEY,
      value: { enabled: signupEnabled },
      description: '用户自助注册开关',
      updated_at: new Date().toISOString(),
    })
  }

  if (upserts.length > 0) {
    await supabaseAdmin
      .from('system_config')
      .upsert(upserts)
  }

  const settings = await fetchAuthSettings()

  res.json({
    success: true,
    data: buildSettingsData(settings),
    ...(updateResult.warnings.length > 0 ? { warnings: updateResult.warnings } : {}),
    ...(updateResult.warningCodes?.length > 0 ? { warningCodes: updateResult.warningCodes } : {}),
  })
})

export default router
