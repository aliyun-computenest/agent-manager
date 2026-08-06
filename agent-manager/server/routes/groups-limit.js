/**
 * Agent group limit/budget routes
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { defineRoute } from '../openapi/route-helper.js'
import { errorResponse } from '../schemas/common.js'
import { createProviderFromDB } from '../services/providers/index.js'
import { getGroupOrThrow, assertCanManageGroup, sendGroupError, loadEnabledProviderName } from './groups-helpers.js'

const router = Router()

const GroupIdParamsSchema = z.object({
  groupId: z.string().uuid().describe('Group principal ID')
})

const BudgetItemSchema = z.object({
  timeRate: z.string().describe('时间维度(daily|monthly)'),
  value: z.number().describe('限额数值'),
  unit: z.string().describe('限额单位(token|usd|cny|credits)')
})

const GroupLimitConfigSchema = z.object({
  enabled: z.boolean().describe('是否启用分组限额'),
  usageUnit: z.string().optional().describe('限额单位(token|usd|cny|credits)'),
  budgets: z.array(BudgetItemSchema).describe('分组级别限额列表'),
  globalBudgets: z.array(BudgetItemSchema).describe('全局级别限额列表'),
  effectiveBudgets: z.array(BudgetItemSchema).describe('生效的限额'),
  hasConsumer: z.boolean().optional().describe('分组是否已创建 Consumer')
}).passthrough()

const GetGroupLimitResponseSchema = z.object({
  success: z.literal(true),
  data: GroupLimitConfigSchema
})

const UpdateGroupLimitBody = z.object({
  budgets: z.array(BudgetItemSchema).optional().describe('分组限额条目列表')
})

const UpdateGroupLimitResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().optional().describe('操作结果消息')
}).passthrough()

/**
 * GET /api/groups/:groupId/limit
 */
defineRoute(router, {
  method: 'get',
  path: '/groups/{groupId}/limit',
  operationId: 'getGroupLimit',
  tags: ['Groups'],
  summary: '获取分组限额配置',
  description: '获取指定分组在当前启用网关下的单独限额配置，包括分组级别、默认级别和生效限额。平台管理员或分组 admin 可访问。',
  security: [{ bearerAuth: [] }],
  request: { params: GroupIdParamsSchema },
  responses: {
    200: { description: '成功返回分组限额配置', content: { 'application/json': { schema: GetGroupLimitResponseSchema } } },
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse
  }
}, requireAuth, validate({ params: GroupIdParamsSchema }), async (req, res) => {
  try {
    const { groupId } = req.params
    await getGroupOrThrow(groupId)
    await assertCanManageGroup({ principalId: req.user.id, userProfile: req.userProfile, groupId })

    const enabledProvider = await loadEnabledProviderName()
    if (!enabledProvider) {
      return res.json({
        success: true,
        data: { enabled: false, budgets: [], globalBudgets: [], effectiveBudgets: [] }
      })
    }

    const provider = await createProviderFromDB(enabledProvider)
    if (!provider.getPrincipalLimit) {
      return res.json({
        success: true,
        data: { enabled: false, budgets: [], globalBudgets: [], effectiveBudgets: [] }
      })
    }

    const result = await provider.getPrincipalLimit(groupId)
    res.json({ success: true, data: result })
  } catch (error) {
    return sendGroupError(res, error)
  }
})

/**
 * PUT /api/groups/:groupId/limit
 */
defineRoute(router, {
  method: 'put',
  path: '/groups/{groupId}/limit',
  operationId: 'updateGroupLimit',
  tags: ['Groups'],
  summary: '更新分组限额配置',
  description: '更新指定分组在当前启用网关下的单独限额配置。平台管理员或分组 admin 可访问。',
  security: [{ bearerAuth: [] }],
  request: {
    params: GroupIdParamsSchema,
    body: { content: { 'application/json': { schema: UpdateGroupLimitBody } } }
  },
  responses: {
    200: { description: '成功更新分组限额', content: { 'application/json': { schema: UpdateGroupLimitResponseSchema } } },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse
  }
}, requireAuth, validate({ params: GroupIdParamsSchema, body: UpdateGroupLimitBody }), async (req, res) => {
  try {
    const { groupId } = req.params
    const { budgets } = req.body
    await getGroupOrThrow(groupId)
    await assertCanManageGroup({ principalId: req.user.id, userProfile: req.userProfile, groupId })

    const enabledProvider = await loadEnabledProviderName()
    if (!enabledProvider) {
      return res.status(400).json({
        success: false,
        error: 'GATEWAY_NOT_CONFIGURED',
        message: 'AI gateway provider is not configured'
      })
    }

    const provider = await createProviderFromDB(enabledProvider)
    if (!provider.updatePrincipalLimit) {
      return res.status(400).json({
        success: false,
        error: 'GATEWAY_GROUP_LIMIT_NOT_SUPPORTED',
        message: 'Current gateway does not support group-level rate limits'
      })
    }

    const result = await provider.updatePrincipalLimit(groupId, budgets || [])
    res.json({ success: true, ...result })
  } catch (error) {
    const message = error?.message || 'Failed to update group limit'
    if (
      message.includes('该主体尚未绑定 Consumer') ||
      message.includes('主体不存在')
    ) {
      return res.status(400).json({
        success: false,
        error: 'PRINCIPAL_CONSUMER_MISSING',
        message
      })
    }
    if (message.includes('当前网关不支持分组限额')) {
      return res.status(400).json({
        success: false,
        error: 'GATEWAY_GROUP_LIMIT_NOT_SUPPORTED',
        message: 'Current gateway does not support group-level rate limits'
      })
    }
    return sendGroupError(res, error)
  }
})

export default router
