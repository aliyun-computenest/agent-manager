/**
 * SkillHub Config Routes — GET /api/skill-hub-config
 * Configuration is done on the ComputeNest side; this route is read-only.
 */

import { Router } from 'express'
import { defineRoute } from '../openapi/route-helper.js'
import { requireAdmin } from '../middleware/auth.js'
import { errorResponse } from '../schemas/common.js'
import {
  SkillHubConfigResponseSchema,
} from '../schemas/skill-hub.js'
import * as computenest from '../services/computenest.js'

const router = Router()

/**
 * GET /api/skill-hub-config — 获取 SkillHub 配置
 */
defineRoute(router, {
  method: 'get',
  path: '/skill-hub-config',
  operationId: 'getSkillHubConfig',
  tags: ['SkillHub'],
  summary: '获取 SkillHub 配置',
  description: '获取计算巢 SkillHub 配置状态（只读，配置需在计算巢控制台完成）。未配置时返回 configured=false。',
  security: [{ bearerAuth: [] }],
  request: {},
  responses: {
    200: { description: 'SkillHub 配置状态', content: { 'application/json': { schema: SkillHubConfigResponseSchema } } },
    401: errorResponse,
    403: errorResponse,
    502: errorResponse,
  },
}, requireAdmin, async (req, res) => {
  try {
    const result = await computenest.getSkillHubConfig()
    res.json({ success: true, ...result })
  } catch (e) {
    if (e.message && (e.message.includes('MISSING_CREDENTIALS') || e.message.includes('REGION_NOT_FOUND'))) {
      res.json({ success: true, configured: false, hubConfig: null })
    } else {
      throw e
    }
  }
})

export default router
