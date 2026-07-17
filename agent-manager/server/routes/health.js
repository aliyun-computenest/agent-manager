/**
 * Health Check & Version Routes
 */

import { Router } from 'express'
import { z } from 'zod'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { defineRoute } from '../openapi/route-helper.js'


const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Load version info from version.json (single source of truth)
let versionInfo = { version: 'unknown', buildDate: '' }
try {
  const versionPath = resolve(__dirname, '../../version.json')
  versionInfo = JSON.parse(readFileSync(versionPath, 'utf-8'))
} catch (e) {
  console.warn('Failed to load version.json:', e.message)
}

const router = Router()

const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  timestamp: z.string().datetime(),
})

const VersionResponseSchema = z.object({
  version: z.string(),
  buildDate: z.string().nullable(),
  environment: z.string(),
})

/**
 * Health check endpoint
 * GET /api/health
 */
defineRoute(router, {
  method: 'get',
  path: '/health',
  operationId: 'getHealth',
  tags: ['Health'],
  summary: '健康检查',
  description: '返回当前服务的健康状态,包含版本号和时间戳,不需要认证。',
  security: [],
  responses: {
    200: { description: '服务健康状态', content: { 'application/json': { schema: HealthResponseSchema } } },
  },
}, (req, res) => {
  res.json({
    status: 'ok',
    version: versionInfo.version,
    timestamp: new Date().toISOString()
  })
})

/**
 * Version info endpoint
 * GET /api/version
 */
defineRoute(router, {
  method: 'get',
  path: '/version',
  operationId: 'getVersion',
  tags: ['Health'],
  summary: '获取版本信息',
  description: '返回服务的详细版本信息,包括版本号、构建日期和运行环境,不需要认证。',
  security: [],
  responses: {
    200: { description: '版本信息', content: { 'application/json': { schema: VersionResponseSchema } } },
  },
}, (req, res) => {
  res.json({
    version: versionInfo.version,
    buildDate: versionInfo.buildDate || null,
    environment: process.env.NODE_ENV || 'development'
  })
})

export default router
