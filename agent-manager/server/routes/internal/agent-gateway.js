/**
 * Internal Agent Gateway Routes
 * Handles nginx/OpenResty authorization checks before proxying sandbox traffic.
 */

import { createHash } from 'crypto'
import { Router } from 'express'
import { z } from 'zod'
import {
  supabaseAdmin
} from '../../config/index.js'
import { requireAuth } from '../../middleware/auth.js'
import { defineRoute } from '../../openapi/route-helper.js'
import { errorResponse } from '../../schemas/common.js'
import {
  canAccessInstanceRecord,
  getActiveGroupMemberships
} from '../../services/principal-access.js'
import {
  buildAgentGatewayValidation,
  resolveAgentGatewayPort
} from '../../services/agent-gateway.js'
import {
  GATEWAY_UPSTREAM_HOST_HEADER,
  GATEWAY_UPSTREAM_TOKEN_PARAM_HEADER
} from '../../utils/agent-gateway-auth.js'

const router = Router()

const GatewayInstanceParamsSchema = z.object({
  instanceId: z.string().describe('实例 ID'),
})

const GATEWAY_VALIDATION_CACHE_TTL_MS = 3 * 1000
const GATEWAY_VALIDATION_CACHE_MAX_ENTRIES = 1000
const gatewayValidationCache = new Map()

function getGatewayRequestHost(req) {
  return String(req.get('x-agent-gateway-host') || '')
    .split(',')[0]
    .trim()
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null
  return authHeader.substring(7)
}

function getGatewayValidationCacheKey(req) {
  const token = getBearerToken(req)
  const gatewayHost = getGatewayRequestHost(req)
  const instanceId = req.params?.instanceId
  if (!token || !gatewayHost || !instanceId) return null

  const tokenHash = createHash('sha256').update(token).digest('base64url')
  return JSON.stringify([instanceId, gatewayHost.toLowerCase(), tokenHash])
}

function getCachedGatewayValidation(cacheKey) {
  if (!cacheKey) return null
  const cached = gatewayValidationCache.get(cacheKey)
  if (!cached) return null
  if (cached.expiresAt <= Date.now()) {
    gatewayValidationCache.delete(cacheKey)
    return null
  }
  return cached.validation
}

function setCachedGatewayValidation(cacheKey, validation) {
  if (!cacheKey) return
  if (gatewayValidationCache.size >= GATEWAY_VALIDATION_CACHE_MAX_ENTRIES) {
    const oldestKey = gatewayValidationCache.keys().next().value
    if (oldestKey) gatewayValidationCache.delete(oldestKey)
  }
  gatewayValidationCache.set(cacheKey, {
    expiresAt: Date.now() + GATEWAY_VALIDATION_CACHE_TTL_MS,
    validation
  })
}

function sendGatewayValidationResult(res, validation) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader(GATEWAY_UPSTREAM_HOST_HEADER, validation.upstreamHost)
  if (validation.upstreamTokenParam) {
    res.setHeader(GATEWAY_UPSTREAM_TOKEN_PARAM_HEADER, validation.upstreamTokenParam)
  }
  return res.status(204).end()
}

function sendCachedGatewayValidation(req, res, next) {
  const cacheKey = getGatewayValidationCacheKey(req)
  const cachedValidation = getCachedGatewayValidation(cacheKey)
  if (cachedValidation) {
    return sendGatewayValidationResult(res, cachedValidation)
  }
  req.gatewayValidationCacheKey = cacheKey
  return next()
}

defineRoute(router, {
  method: 'get',
  path: '/instances/{instanceId}',
  operationId: 'validateAgentGatewayInstance',
  tags: ['Internal'],
  summary: '验证 Agent Gateway 实例访问权限',
  description: 'Nginx/OpenResty 授权检查接口，验证用户对指定实例的访问权限并返回上游路由信息。',
  security: [{ bearerAuth: [] }],
  request: {
    params: GatewayInstanceParamsSchema,
  },
  responses: {
    204: { description: '验证通过，上游信息通过 Header 返回' },
    401: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, sendCachedGatewayValidation, requireAuth, async (req, res) => {
  const { instanceId } = req.params
  const userProfile = req.userProfile

  // agent_instances.principal_id 表示实例归属主体：
  // 私有实例为用户 principal id，分组实例为 group principal id。
  // 这里先按 instanceId 取实例，再用当前用户的 active 分组成员关系校验访问权限；
  // 如果提前按用户过滤，会误拒绝同分组但非归属主体本人的成员访问分组实例。
  const { data: instance, error } = await supabaseAdmin
    .from('agent_instances')
    .select('id,principal_id,sandbox_id,status,token,agent_type_id')
    .eq('id', instanceId)
    .maybeSingle()

  if (error || !instance) {
    return res.status(404).json({ success: false, error: 'Instance not found' })
  }

  const memberships = await getActiveGroupMemberships(req.user.id)
  if (!canAccessInstanceRecord(instance, req.user.id, memberships, userProfile)) {
    return res.status(404).json({ success: false, error: 'Instance not found' })
  }

  const agentPort = await resolveAgentGatewayPort(instance.agent_type_id, 'gateway validation port lookup')
  const gatewayHost = getGatewayRequestHost(req)
  const result = buildAgentGatewayValidation({
    instance,
    gatewayHost,
    agentPort
  })
  if (!result.ok) {
    return res.status(result.status).json({ success: false, error: result.error })
  }
  const { validation } = result
  setCachedGatewayValidation(req.gatewayValidationCacheKey, validation)
  return sendGatewayValidationResult(res, validation)
})

export default router
