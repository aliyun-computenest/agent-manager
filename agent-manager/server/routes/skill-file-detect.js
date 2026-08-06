/**
 * Skill File Detect Routes — POST/GET /api/skill-file-detect
 */

import { Router } from 'express'
import { z } from 'zod'
import { defineRoute } from '../openapi/route-helper.js'
import { requireAdmin } from '../middleware/auth.js'
import { errorResponse } from '../schemas/common.js'
import {
  CreateSkillFileDetectRequestSchema,
  CreateSkillFileDetectResponseSchema,
  GetSkillFileDetectResultResponseSchema,
} from '../schemas/skill-hub.js'
import * as computenest from '../services/computenest.js'
import { appLogger } from '../utils/logger.js'

const router = Router()

/**
 * POST /api/skill-file-detect — 提交文件安全检测
 */
defineRoute(router, {
  method: 'post',
  path: '/skill-file-detect',
  operationId: 'createSkillFileDetect',
  tags: ['SkillFileDetect'],
  summary: '提交文件安全检测',
  description: '提交 OSS 文件到计算巢安全检测。仅 sourceType=OSS 时需要。',
  security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: CreateSkillFileDetectRequestSchema } } } },
  responses: {
    200: { description: '提交成功', content: { 'application/json': { schema: CreateSkillFileDetectResponseSchema } } },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    502: errorResponse,
  },
}, requireAdmin, async (req, res) => {
  const { ossUrl } = req.body
  const result = await computenest.createSkillFileDetect({ ossUrl })
  appLogger.info(`[SkillFileDetect] Create hashKey=${result.HashKey || result.hashKey}, raw=${JSON.stringify(result)}`)
  res.json({ success: true, hashKey: result.HashKey || result.hashKey })
})

/**
 * GET /api/skill-file-detect/:hashKey — 查询检测结果
 */
defineRoute(router, {
  method: 'get',
  path: '/skill-file-detect/{hashKey}',
  operationId: 'getSkillFileDetectResult',
  tags: ['SkillFileDetect'],
  summary: '查询文件安全检测结果',
  description: '查询文件安全检测结果。result=3 表示检测中需轮询。',
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ hashKey: z.string() }) },
  responses: {
    200: { description: '检测结果', content: { 'application/json': { schema: GetSkillFileDetectResultResponseSchema } } },
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    502: errorResponse,
  },
}, requireAdmin, async (req, res) => {
  const { hashKey } = req.params
  const result = await computenest.getSkillFileDetectResult(hashKey)
  const resultValue = result.Result ?? result.result ?? 3
  appLogger.info(`[SkillFileDetect] Get hashKey=${hashKey}, raw=${JSON.stringify(result)}, resultValue=${resultValue}`)
  res.json({
    success: true,
    hashKey,
    result: resultValue,
    score: result.Score ?? result.score ?? 0,
    message: result.Message ?? result.message ?? '',
  })
})

export default router
