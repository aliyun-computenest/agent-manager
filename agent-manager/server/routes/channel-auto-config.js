/**
 * Channel Auto-Config Routes
 *
 * Provides API endpoints for automated channel configuration via
 * Device Registration Flow (scan QR code to configure).
 *
 * Endpoints:
 *   POST /api/channel-auto-config/dingtalk/begin – Start DingTalk registration, return QR code URL
 *   POST /api/channel-auto-config/dingtalk/poll  – Poll for DingTalk authorization result
 *   POST /api/channel-auto-config/feishu/begin  – Start Feishu registration, return QR code URL
 *   POST /api/channel-auto-config/feishu/poll   – Poll for Feishu authorization result
 *   POST /api/channel-auto-config/wecom/begin   – Start WeCom QR code generation, return auth URL
 *   POST /api/channel-auto-config/wecom/poll    – Poll for WeCom bot creation result
 */

import { Router } from 'express'
import { z } from 'zod'
import { defineRoute } from '../openapi/route-helper.js'
import { validate } from '../middleware/validate.js'
import { errorResponse } from '../schemas/common.js'
import { supabaseAdmin } from '../config/index.js'
import { requireAuth } from '../middleware/auth.js'
import { encryptApiKey } from '../utils/crypto.js'
import { getAgentType, runModifyCommand } from '../utils/agent-config.js'
import { getGatewayConfig } from '../services/gateway-config.js'
import { init, begin, poll } from '../services/dingtalk-auto-config.js'
import { begin as feishuBegin, poll as feishuPoll } from '../services/feishu-auto-config.js'
import { generate as wecomGenerate, queryResult as wecomQueryResult } from '../services/wecom-auto-config.js'
import {
  canAccessInstanceRecord,
  getActiveGroupMemberships,
  isPlatformAdminProfile
} from '../services/principal-access.js'

const router = Router()

// ─── Response Schemas ───────────────────────────────────────────────────────

const AutoConfigBeginResponseSchema = z.object({
  success: z.literal(true),
  deviceCode: z.string().optional(),
  userCode: z.string().optional(),
  verificationUrl: z.string().optional(),
  verificationUri: z.string().optional(),
  interval: z.number().optional(),
  expiresIn: z.number().optional(),
  authUrl: z.string().optional(),
  qcId: z.string().optional(),
})

const AutoConfigPollResponseSchema = z.object({
  success: z.literal(true),
  status: z.string().optional(),
  errmsg: z.string().optional(),
  configured: z.boolean().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  clientSecretMasked: z.string().optional(),
})

// ─── Request Body Schemas ───────────────────────────────────────────────────

const DingtalkPollBodySchema = z.object({ deviceCode: z.string({ required_error: 'deviceCode is required' }).min(1, { message: 'deviceCode is required' }), instanceId: z.string().optional() }).passthrough()
const FeishuPollBodySchema = z.object({ deviceCode: z.string({ required_error: 'deviceCode is required' }).min(1, { message: 'deviceCode is required' }), instanceId: z.string().optional() }).passthrough()
const WecomPollBodySchema = z.object({ qcId: z.string({ required_error: 'qcId is required' }).min(1, { message: 'qcId is required' }), instanceId: z.string().optional() }).passthrough()

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * POST /api/channel-auto-config/dingtalk/begin
 *
 * Initiates the DingTalk Device Registration Flow:
 * 1. Calls DingTalk /app/registration/init to get nonce
 * 2. Calls DingTalk /app/registration/begin to get device_code + QR code URL
 *
 * Returns the verification URL (to render as QR code) and device_code (for polling).
 */
defineRoute(router, {
  method: 'post',
  path: '/channel-auto-config/dingtalk/begin',
  operationId: 'beginDingtalkAutoConfig',
  tags: ['Channel Auto Config'],
  summary: '启动钉钉设备注册流程',
  description: '调用钉钉 Device Registration Flow 获取 nonce 并开始注册，返回二维码 URL 和设备码用于后续轮询。',
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: '成功', content: { 'application/json': { schema: AutoConfigBeginResponseSchema } } },
    401: errorResponse,
    500: errorResponse,
  },
}, requireAuth, async (req, res) => {
  // Step 1: init
  const { nonce } = await init()

  // Step 2: begin
  const result = await begin(nonce)

  res.json({
    success: true,
    deviceCode: result.deviceCode,
    userCode: result.userCode,
    verificationUrl: result.verificationUrl,
    verificationUri: result.verificationUri,
    interval: result.interval,
    expiresIn: result.expiresIn
  })
})

/**
 * POST /api/channel-auto-config/dingtalk/poll
 *
 * Polls the DingTalk Device Registration status.
 * When authorization completes (status=SUCCESS), automatically saves the
 * channel credentials to the specified instance.
 *
 * Body: { deviceCode: string, instanceId: string }
 */
defineRoute(router, {
  method: 'post',
  path: '/channel-auto-config/dingtalk/poll',
  operationId: 'pollDingtalkAutoConfig',
  tags: ['Channel Auto Config'],
  summary: '轮询钉钉设备注册状态',
  description: '轮询钉钉授权状态，授权完成后自动保存渠道凭证到指定实例。',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: DingtalkPollBodySchema } } },
  },
  responses: {
    200: { description: '成功', content: { 'application/json': { schema: AutoConfigPollResponseSchema } } },
    400: errorResponse,
    401: errorResponse,
    500: errorResponse,
  },
}, requireAuth, validate({ body: DingtalkPollBodySchema }), async (req, res) => {
  const { deviceCode, instanceId } = req.body

  // Poll DingTalk
  const result = await poll(deviceCode)

  // If not yet authorized, return pending status
  if (result.status !== 'SUCCESS') {
    return res.json({
      success: true,
      status: result.status,
      errmsg: result.errmsg
    })
  }

  // Authorization successful – we have client_id and client_secret
  const { clientId, clientSecret } = result

  // If instanceId is provided, persist the channel config to the instance
  if (instanceId) {
    await saveChannelConfig({
      instanceId,
      clientId,
      clientSecret,
      channelType: 'dingtalk',
      userId: req.user.id,
      userProfile: req.userProfile
    })
  }

  res.json(buildPollSuccessResponse({ clientId, clientSecret, instanceId }))
})

/**
 * POST /api/channel-auto-config/feishu/begin
 *
 * Initiates the Feishu Device Registration Flow:
 * Calls Feishu /oauth/v1/app/registration with action=begin
 * to get device_code + QR code URL.
 *
 * Returns the verification URL (to render as QR code) and device_code (for polling).
 */
defineRoute(router, {
  method: 'post',
  path: '/channel-auto-config/feishu/begin',
  operationId: 'beginFeishuAutoConfig',
  tags: ['Channel Auto Config'],
  summary: '启动飞书设备注册流程',
  description: '调用飞书 Device Registration Flow 获取设备码和二维码 URL。',
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: '成功', content: { 'application/json': { schema: AutoConfigBeginResponseSchema } } },
    401: errorResponse,
    500: errorResponse,
  },
}, requireAuth, async (req, res) => {
  const result = await feishuBegin()

  res.json({
    success: true,
    deviceCode: result.deviceCode,
    userCode: result.userCode,
    verificationUrl: result.verificationUrl,
    verificationUri: result.verificationUri,
    interval: result.interval,
    expiresIn: result.expiresIn
  })
})

/**
 * POST /api/channel-auto-config/feishu/poll
 *
 * Polls the Feishu Device Registration status.
 * When authorization completes (status=SUCCESS), automatically saves the
 * channel credentials to the specified instance.
 *
 * Body: { deviceCode: string, instanceId?: string }
 */
defineRoute(router, {
  method: 'post',
  path: '/channel-auto-config/feishu/poll',
  operationId: 'pollFeishuAutoConfig',
  tags: ['Channel Auto Config'],
  summary: '轮询飞书设备注册状态',
  description: '轮询飞书授权状态，授权完成后自动保存渠道凭证到指定实例。',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: FeishuPollBodySchema } } },
  },
  responses: {
    200: { description: '成功', content: { 'application/json': { schema: AutoConfigPollResponseSchema } } },
    400: errorResponse,
    401: errorResponse,
    500: errorResponse,
  },
}, requireAuth, validate({ body: FeishuPollBodySchema }), async (req, res) => {
  const { deviceCode, instanceId } = req.body

  // Poll Feishu
  const result = await feishuPoll(deviceCode)

  // If not yet authorized, return pending status
  if (result.status !== 'SUCCESS') {
    return res.json({
      success: true,
      status: result.status,
      errmsg: result.errmsg
    })
  }

  // Authorization successful – we have client_id and client_secret
  const { clientId, clientSecret } = result

  // If instanceId is provided, persist the channel config to the instance.
  // Credentials are encrypted server-side and we don't return clientSecret
  // back to the browser in that case (see buildPollSuccessResponse).
  if (instanceId) {
    await saveChannelConfig({
      instanceId,
      clientId,
      clientSecret,
      channelType: 'feishu',
      userId: req.user.id,
      userProfile: req.userProfile
    })
  }

  res.json(buildPollSuccessResponse({ clientId, clientSecret, instanceId }))
})

/**
 * POST /api/channel-auto-config/wecom/begin
 *
 * Initiates the WeCom QR Code Bot Registration Flow:
 * Calls WeCom /ai/qc/generate to get auth_url and qc_id.
 *
 * Returns the auth URL (to render as QR code) and qcId (for polling).
 */
defineRoute(router, {
  method: 'post',
  path: '/channel-auto-config/wecom/begin',
  operationId: 'beginWecomAutoConfig',
  tags: ['Channel Auto Config'],
  summary: '启动企微二维码注册流程',
  description: '调用企微 QR Code Bot Registration 获取认证 URL 和 qcId。',
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: '成功', content: { 'application/json': { schema: AutoConfigBeginResponseSchema } } },
    401: errorResponse,
    500: errorResponse,
  },
}, requireAuth, async (req, res) => {
  const result = await wecomGenerate()

  res.json({
    success: true,
    authUrl: result.authUrl,
    qcId: result.qcId,
    expiresIn: result.expiresIn
  })
})

/**
 * POST /api/channel-auto-config/wecom/poll
 *
 * Polls the WeCom bot creation result.
 * When bot creation completes (status=SUCCESS), automatically saves the
 * channel credentials to the specified instance.
 *
 * Body: { qcId: string, instanceId?: string }
 */
defineRoute(router, {
  method: 'post',
  path: '/channel-auto-config/wecom/poll',
  operationId: 'pollWecomAutoConfig',
  tags: ['Channel Auto Config'],
  summary: '轮询企微机器人创建状态',
  description: '轮询企微机器人创建结果，完成后自动保存渠道凭证到指定实例。',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: WecomPollBodySchema } } },
  },
  responses: {
    200: { description: '成功', content: { 'application/json': { schema: AutoConfigPollResponseSchema } } },
    400: errorResponse,
    401: errorResponse,
    500: errorResponse,
  },
}, requireAuth, validate({ body: WecomPollBodySchema }), async (req, res) => {
  const { qcId, instanceId } = req.body

  // Poll WeCom
  const result = await wecomQueryResult(qcId)

  // If not yet authorized, return pending status
  if (result.status !== 'SUCCESS') {
    return res.json({
      success: true,
      status: result.status,
      errmsg: result.errmsg
    })
  }

  // Authorization successful – we have botid and secret
  const { clientId, clientSecret } = result

  // If instanceId is provided, persist the channel config to the instance.
  // Credentials are encrypted server-side and we don't return clientSecret
  // back to the browser in that case (see buildPollSuccessResponse).
  if (instanceId) {
    await saveChannelConfig({
      instanceId,
      clientId,
      clientSecret,
      channelType: 'wecom',
      userId: req.user.id,
      userProfile: req.userProfile
    })
  }

  res.json(buildPollSuccessResponse({ clientId, clientSecret, instanceId }))
})

// ─── Helper Functions ───────────────────────────────────────────────────────

/**
 * Mask a credential for safe display in API responses.
 * Returns the first 3 and last 3 characters joined by '***'.
 * Short values fall back to a fixed mask to avoid leaking length signals.
 */
function maskCredential(value) {
  if (!value || typeof value !== 'string') return ''
  if (value.length <= 6) return '***'
  return `${value.substring(0, 3)}***${value.substring(value.length - 3)}`
}

/**
 * Build the JSON body returned by the auto-config /poll endpoints on SUCCESS.
 *
 * Security contract:
 *   - When `instanceId` is provided, credentials have already been encrypted
 *     and persisted server-side via saveChannelConfig(). We deliberately do
 *     NOT echo the plaintext clientSecret back to the browser; the frontend
 *     only needs a confirmation flag and a masked preview for display.
 *   - When `instanceId` is absent (creation flow before the instance exists),
 *     the frontend needs the credentials to submit them with the create
 *     request, so we return the full values exactly once.
 */
function buildPollSuccessResponse({ clientId, clientSecret, instanceId }) {
  if (instanceId) {
    return {
      success: true,
      status: 'SUCCESS',
      configured: true,
      clientId: maskCredential(clientId),
      clientSecretMasked: '***'
    }
  }
  return {
    success: true,
    status: 'SUCCESS',
    clientId,
    clientSecret
  }
}

/**
 * Save channel config to the database and trigger sandbox modification.
 */
async function saveChannelConfig({ instanceId, clientId, clientSecret, channelType, userId, userProfile }) {
  // Verify instance ownership and fetch full instance context for modify command
  const { data: instance, error: fetchError } = await supabaseAdmin
    .from('agent_instances')
    .select('id, principal_id, agent_type_id, sandbox_id, token, model_id')
    .eq('id', instanceId)
    .single()

  if (fetchError || !instance) {
    throw new Error('Instance not found')
  }

  if (!isPlatformAdminProfile(userProfile)) {
    const memberships = await getActiveGroupMemberships(userId)
    const allowed = canAccessInstanceRecord(instance, userId, memberships, userProfile)
    if (!allowed) {
      throw new Error('Access denied: you do not own this instance')
    }
  }

  const resolvedChannelType = channelType || 'dingtalk'
  const encryptedClientId = encryptApiKey(clientId)
  const encryptedClientSecret = encryptApiKey(clientSecret)

  // Build a structured metadata object for config_json. We deliberately do
  // NOT store the encrypted/plaintext credentials here — they already live in
  // the dedicated client_id / client_secret columns. Storing them again would
  // be redundant and, more importantly, would mislead any downstream code
  // that JSON.parse's config_json expecting plaintext (e.g. channel_template
  // rendering) and instead got the ciphertext.
  const configJsonMeta = {
    auto_config_method: `${resolvedChannelType}_qr_scan`,
    configured_at: new Date().toISOString()
  }

  // Check if channel config already exists
  const { data: existingConfig } = await supabaseAdmin
    .from('instance_channel_configs')
    .select('id')
    .eq('instance_id', instanceId)
    .single()

  if (existingConfig) {
    // Update existing config
    const { error: updateError } = await supabaseAdmin
      .from('instance_channel_configs')
      .update({
        channel_type: resolvedChannelType,
        client_id: encryptedClientId,
        client_secret: encryptedClientSecret,
        config_json: configJsonMeta,
        is_configured: true,
        updated_at: new Date().toISOString()
      })
      .eq('id', existingConfig.id)

    if (updateError) {
      throw new Error(`Failed to update channel config: ${updateError.message}`)
    }
  } else {
    // Insert new config
    const { error: insertError } = await supabaseAdmin
      .from('instance_channel_configs')
      .insert({
        instance_id: instanceId,
        channel_type: resolvedChannelType,
        client_id: encryptedClientId,
        client_secret: encryptedClientSecret,
        config_json: configJsonMeta,
        is_configured: true
      })

    if (insertError) {
      throw new Error(`Failed to save channel config: ${insertError.message}`)
    }
  }

  // Trigger sandbox modify-channel command if instance has a sandbox
  if (instance.sandbox_id && instance.agent_type_id) {
    try {
      const agentType = await getAgentType(instance.agent_type_id)
      if (agentType?.modify_channel_command?.trim()) {
        // Resolve model name/provider for full template context
        let modelName = ''
        let modelProvider = ''
        if (instance.model_id) {
          const { data: modelRow } = await supabaseAdmin
            .from('ai_models')
            .select('name, provider')
            .eq('id', instance.model_id)
            .maybeSingle()
          if (modelRow) {
            modelName = modelRow.name || ''
            modelProvider = modelRow.provider || ''
          }
        }

        console.log(`🔄 Running modify-channel for instance ${instanceId} via auto-config`)
        await runModifyCommand(
          instance.sandbox_id,
          agentType,
          agentType.modify_channel_command,
          {
            userId: instance.principal_id,
            token: instance.token || '',
            modelName,
            modelProvider,
            aiGatewayDomain: getGatewayConfig().gatewayDomain,
            channelType: resolvedChannelType,
            channelClientId: clientId,
            channelClientSecret: clientSecret
          }
        )
      }
    } catch (cmdError) {
      // Log but don't fail – config is already saved in DB
      console.error('modify-channel command failed (config saved in DB):', cmdError.message)
    }
  }
}

export default router
