/**
 * Skill Space & Skill CRUD Routes — 12 endpoints
 *   GET/POST   /api/skill-spaces
 *   GET/DELETE /api/skill-spaces/:skillSpaceId
 *   GET/POST   /api/skill-spaces/:skillSpaceId/skills
 *   GET/PUT/DELETE /api/skill-spaces/:skillSpaceId/skills/:skillId
 *   GET        /api/skill-spaces/:skillSpaceId/skills/:skillId/files
 *   GET        /api/skill-spaces/:skillSpaceId/skills/:skillId/file-content  (proxy)
 *   GET        /api/official-skills
 */

import { Router } from 'express'
import { z } from 'zod'
import { defineRoute } from '../openapi/route-helper.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { errorResponse } from '../schemas/common.js'
import {
  ListSkillSpacesResponseSchema,
  CreateSkillSpaceRequestSchema,
  CreateSkillSpaceResponseSchema,
  GetSkillSpaceResponseSchema,
  ListSkillsResponseSchema,
  CreateSkillRequestSchema,
  CreateSkillResponseSchema,
  GetSkillResponseSchema,
  UpdateSkillRequestSchema,
  UpdateSkillResponseSchema,
  ListSkillFilesResponseSchema,
  ListOfficialSkillsResponseSchema,
} from '../schemas/skill-hub.js'
import * as computenest from '../services/computenest.js'
import { appLogger } from '../utils/logger.js'

const router = Router()

const ListSkillsQuerySchema = z.object({
  keyword: z.string().optional(),
  nextToken: z.string().optional(),
  maxResults: z.coerce.number().int().optional(),
}).strict()

const ListOfficialSkillsQuerySchema = z.object({
  keyword: z.string().optional(),
  skillLabel: z.string().optional(),
  nextToken: z.string().optional(),
  maxResults: z.coerce.number().int().optional(),
}).strict()

function toCatalogSkill(skill) {
  // 下载地址只能由管理员下载代理在服务端使用，不能进入普通用户的目录响应。
  const catalogSkill = { ...skill }
  delete catalogSkill.downloadUrl
  delete catalogSkill.DownloadUrl
  return {
    ...catalogSkill,
    skillDisplayName: catalogSkill.skillDisplayName || catalogSkill.skillName,
  }
}

/**
 * Parse SKILL.md content and extract name and description.
 * Supports inline values, quoted strings, and YAML block scalars (>, >-, |, |-).
 * Aligned with ComputeNest parseSkillFromZip.ts / parseSkillMdContent()
 */
const YAML_BLOCK_SCALARS = new Set(['>', '>-', '|', '|-'])

function parseSkillMdContent(content) {
  if (!content || typeof content !== 'string') return null
  try {
    const lines = content.split('\n')
    let name = ''
    let description = ''
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (line.startsWith('#') && name && description) break
      if (line.startsWith('name:')) {
        const m = line.match(/^name:\s*(.+)$/)
        if (m) name = m[1].trim().replace(/^["']|["']$/g, '')
      }
      if (line.startsWith('description:')) {
        const rest = line.slice('description:'.length).trim()
        if (YAML_BLOCK_SCALARS.has(rest)) {
          const isFolded = rest.startsWith('>')
          const blockLines = []
          i++
          while (i < lines.length) {
            const raw = lines[i]
            if (/^\s/.test(raw) || raw.trim() === '') {
              blockLines.push(raw.trim())
              i++
            } else {
              i--
              break
            }
          }
          description = isFolded
            ? blockLines.filter(Boolean).join(' ').trim()
            : blockLines.join('\n').trim()
        } else if (rest.startsWith('"') && !rest.endsWith('"')) {
          let buf = rest.slice(1)
          while (++i < lines.length) {
            const next = lines[i].trim()
            buf += ` ${next}`
            if (next.endsWith('"')) {
              description = buf.slice(0, -1).trim()
              break
            }
          }
        } else {
          description = rest.replace(/^["']|["']$/g, '').trim()
        }
      }
    }
    return name && description ? { name, description } : null
  } catch {
    return null
  }
}

// Debug: log all skill-spaces requests
router.use((req, _res, next) => {
  appLogger.info(`[skill-spaces] ${req.method} ${req.originalUrl} params=${JSON.stringify(req.params)} query=${JSON.stringify(req.query)}`)
  next()
})

// ---------------------------------------------------------------------------
// Skill Spaces (4 endpoints)
// ---------------------------------------------------------------------------

defineRoute(router, {
  method: 'get',
  path: '/skill-spaces',
  operationId: 'listSkillSpaces',
  tags: ['SkillSpaces'],
  summary: '列出技能空间',
  description: '获取计算巢技能空间列表，支持按名称模糊搜索。',
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({ keyword: z.string().optional(), nextToken: z.string().optional(), maxResults: z.coerce.number().int().optional() }),
  },
  responses: {
    200: { description: '技能空间列表', content: { 'application/json': { schema: ListSkillSpacesResponseSchema } } },
    401: errorResponse,
    403: errorResponse,
    502: errorResponse,
  },
}, requireAuth, async (req, res) => {
  const { keyword, nextToken, maxResults } = req.query
  const result = await computenest.listSkillSpaces({ keyword, nextToken, maxResults })
  res.json({ success: true, ...result })
})

defineRoute(router, {
  method: 'post',
  path: '/skill-spaces',
  operationId: 'createSkillSpace',
  tags: ['SkillSpaces'],
  summary: '创建技能空间',
  description: '在计算巢中创建一个新的技能空间。',
  security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: CreateSkillSpaceRequestSchema } } } },
  responses: {
    200: { description: '创建成功', content: { 'application/json': { schema: CreateSkillSpaceResponseSchema } } },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    409: errorResponse,
    502: errorResponse,
  },
}, requireAdmin, async (req, res) => {
  const { skillSpaceName, skillSpaceDescription } = req.body
  const result = await computenest.createSkillSpace({ skillSpaceName, skillSpaceDescription })
  res.json({ success: true, skillSpaceId: result.SkillSpaceId || result.skillSpaceId })
})

defineRoute(router, {
  method: 'get',
  path: '/skill-spaces/{skillSpaceId}',
  operationId: 'getSkillSpace',
  tags: ['SkillSpaces'],
  summary: '获取技能空间详情',
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ skillSpaceId: z.string() }) },
  responses: {
    200: { description: '技能空间详情', content: { 'application/json': { schema: GetSkillSpaceResponseSchema } } },
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    502: errorResponse,
  },
}, requireAdmin, async (req, res) => {
  const result = await computenest.getSkillSpace(req.params.skillSpaceId)
  res.json({ success: true, skillSpace: result })
})

defineRoute(router, {
  method: 'delete',
  path: '/skill-spaces/{skillSpaceId}',
  operationId: 'deleteSkillSpace',
  tags: ['SkillSpaces'],
  summary: '删除技能空间',
  description: '删除技能空间（后端事务性清理）。Agent Type 中残留引用不自动清理。',
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ skillSpaceId: z.string() }) },
  responses: {
    200: { description: '删除成功', content: { 'application/json': { schema: z.object({ success: z.literal(true) }) } } },
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    502: errorResponse,
  },
}, requireAdmin, async (req, res) => {
  await computenest.deleteSkillSpace(req.params.skillSpaceId)
  res.json({ success: true })
})

// ---------------------------------------------------------------------------
// Skills (5 endpoints)
// ---------------------------------------------------------------------------

defineRoute(router, {
  method: 'get',
  path: '/skill-spaces/{skillSpaceId}/skills',
  operationId: 'listSkills',
  tags: ['Skills'],
  summary: '列出技能',
  description: '列出指定技能空间中的自定义技能。',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ skillSpaceId: z.string() }),
    query: ListSkillsQuerySchema,
  },
  responses: {
    200: { description: '技能列表', content: { 'application/json': { schema: ListSkillsResponseSchema } } },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    502: errorResponse,
  },
}, requireAuth, validate({ query: ListSkillsQuerySchema }), async (req, res) => {
  const { skillSpaceId } = req.params
  const { keyword, nextToken, maxResults } = req.query
  const result = await computenest.listSkills({ skillSpaceId, keyword, nextToken, maxResults })
  // Ensure each skill has skillDisplayName with fallback to skillName (for old data without displayName)
  const skills = (result.skills || []).map(toCatalogSkill)
  res.json({ success: true, ...result, skills })
})

defineRoute(router, {
  method: 'post',
  path: '/skill-spaces/{skillSpaceId}/skills',
  operationId: 'createSkill',
  tags: ['Skills'],
  summary: '创建技能',
  description: '在指定技能空间中创建技能（支持 OSS 和 COPY 来源）。',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ skillSpaceId: z.string() }),
    body: { content: { 'application/json': { schema: CreateSkillRequestSchema } } },
  },
  responses: {
    200: { description: '创建成功', content: { 'application/json': { schema: CreateSkillResponseSchema } } },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    409: errorResponse,
    502: errorResponse,
  },
}, requireAdmin, async (req, res) => {
  const { skillSpaceId } = req.params
  const { sourceType, skillName, skillDisplayName, skillDescription, ossUrl, sourceSkillId, skillLabels } = req.body
  const result = await computenest.createSkill({ skillSpaceId, sourceType, skillName, skillDisplayName, skillDescription, ossUrl, sourceSkillId, skillLabels })
  res.json({ success: true, skillId: result.SkillId || result.skillId })
})

defineRoute(router, {
  method: 'get',
  path: '/skill-spaces/{skillSpaceId}/skills/{skillId}',
  operationId: 'getSkill',
  tags: ['Skills'],
  summary: '获取技能详情',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ skillSpaceId: z.string(), skillId: z.string() }),
  },
  responses: {
    200: { description: '技能详情', content: { 'application/json': { schema: GetSkillResponseSchema } } },
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    502: errorResponse,
  },
}, requireAdmin, async (req, res) => {
  const { skillSpaceId, skillId } = req.params
  const result = await computenest.getSkill({ skillSpaceId, skillId })
  res.json({ success: true, skill: { ...result, skillDisplayName: result.skillDisplayName || result.skillName } })
})

defineRoute(router, {
  method: 'put',
  path: '/skill-spaces/{skillSpaceId}/skills/{skillId}',
  operationId: 'updateSkill',
  tags: ['Skills'],
  summary: '更新技能',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ skillSpaceId: z.string(), skillId: z.string() }),
    body: { content: { 'application/json': { schema: UpdateSkillRequestSchema } } },
  },
  responses: {
    200: { description: '更新成功', content: { 'application/json': { schema: UpdateSkillResponseSchema } } },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    502: errorResponse,
  },
}, requireAdmin, async (req, res) => {
  const { skillSpaceId, skillId } = req.params
  const { skillName, skillDisplayName, skillDescription, sourceType, ossUrl, sourceSkillId, skillLabels } = req.body
  const result = await computenest.updateSkill({ skillSpaceId, skillId, skillName, skillDisplayName, skillDescription, sourceType, ossUrl, sourceSkillId, skillLabels })
  res.json({ success: true, skillId })
})

defineRoute(router, {
  method: 'delete',
  path: '/skill-spaces/{skillSpaceId}/skills/{skillId}',
  operationId: 'deleteSkill',
  tags: ['Skills'],
  summary: '删除技能',
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ skillSpaceId: z.string(), skillId: z.string() }) },
  responses: {
    200: { description: '删除成功', content: { 'application/json': { schema: z.object({ success: z.literal(true) }) } } },
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    502: errorResponse,
  },
}, requireAdmin, async (req, res) => {
  const { skillSpaceId, skillId } = req.params
  await computenest.deleteSkill({ skillSpaceId, skillId })
  res.json({ success: true })
})

// ---------------------------------------------------------------------------
// Skill Files (1 endpoint)
// ---------------------------------------------------------------------------

defineRoute(router, {
  method: 'get',
  path: '/skill-spaces/{skillSpaceId}/skills/{skillId}/files',
  operationId: 'listSkillFiles',
  tags: ['Skills'],
  summary: '获取技能文件列表',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ skillSpaceId: z.string(), skillId: z.string() }),
    query: z.object({ maxResults: z.coerce.number().int().optional(), nextToken: z.string().optional() }),
  },
  responses: {
    200: { description: '技能文件列表', content: { 'application/json': { schema: ListSkillFilesResponseSchema } } },
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    502: errorResponse,
  },
}, requireAdmin, async (req, res) => {
  const { skillSpaceId, skillId } = req.params
  const { maxResults, nextToken } = req.query
  const result = await computenest.listSkillFiles({ skillSpaceId, skillId, maxResults, nextToken })
  res.json({ success: true, ...result })
})

// ---------------------------------------------------------------------------
// Skill File Content Proxy (avoids browser CORS when fetching OSS signedUrl)
// Front-end sends filePath, backend looks up signedUrl via listSkillFiles then proxies content
// ---------------------------------------------------------------------------

defineRoute(router, {
  method: 'get',
  path: '/skill-spaces/{skillSpaceId}/skills/{skillId}/file-content',
  operationId: 'getSkillFileContent',
  tags: ['Skills'],
  summary: '代理获取技能文件内容（避免浏览器CORS）',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ skillSpaceId: z.string(), skillId: z.string() }),
    query: z.object({ filePath: z.string().min(1) }),
  },
  responses: {
    200: { description: '文件内容', content: { 'text/plain': { schema: z.string() } } },
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    502: errorResponse,
  },
}, requireAdmin, async (req, res) => {
  const { skillSpaceId, skillId } = req.params
  const { filePath } = req.query

  try {
    // Step 1: Get signedUrl from listSkillFiles
    let signedUrl = null
    let nextToken = undefined
    do {
      const filesResult = await computenest.listSkillFiles({ skillSpaceId, skillId, maxResults: 100, nextToken })
      const match = filesResult.skillFiles?.find(f => f.filePath === filePath)
      if (match) {
        signedUrl = match.signedUrl
        break
      }
      nextToken = filesResult.nextToken
    } while (nextToken)

    if (!signedUrl) {
      res.status(404).json({ success: false, error: `File not found: ${filePath}` })
      return
    }

    // Step 2: Fetch file content from OSS via signedUrl
    const ossRes = await fetch(signedUrl, {
      method: 'GET',
      headers: { 'Accept': '*/*' },
      signal: AbortSignal.timeout(30000),
    })
    if (!ossRes.ok) {
      appLogger.warn(`[file-content-proxy] OSS returned ${ossRes.status} for ${signedUrl.substring(0, 100)}`)
      res.status(ossRes.status).json({ success: false, error: `OSS returned ${ossRes.status}` })
      return
    }
    const contentType = ossRes.headers.get('content-type') || 'text/plain'
    const content = await ossRes.text()
    // Truncate very large files to 1MB
    const truncated = content.length > 1_000_000
      ? content.slice(0, 1_000_000) + '\n\n... (truncated)'
      : content
    res.setHeader('Content-Type', contentType)
    res.setHeader('X-Content-Length', String(content.length))
    res.send(truncated)
  } catch (e) {
    appLogger.error(`[file-content-proxy] Error: ${e.message}`)
    res.status(502).json({ success: false, error: 'Failed to fetch file content from OSS' })
  }
})

// ---------------------------------------------------------------------------
// Skill Download Proxy (avoids browser CORS when fetching OSS downloadUrl)
// ---------------------------------------------------------------------------

defineRoute(router, {
  method: 'get',
  path: '/skill-spaces/{skillSpaceId}/skills/{skillId}/download',
  operationId: 'downloadSkill',
  tags: ['Skills'],
  summary: '代理下载技能文件（避免浏览器CORS）',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ skillSpaceId: z.string(), skillId: z.string() }),
    query: z.object({ skillName: z.string().optional(), skillType: z.enum(['official', 'custom']).default('custom') }),
  },
  responses: {
    200: { description: '技能 ZIP 文件', content: { 'application/octet-stream': { schema: z.string() } } },
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    502: errorResponse,
  },
}, requireAdmin, async (req, res) => {
  const { skillSpaceId, skillId } = req.params
  const { skillName, skillType } = req.query

  try {
    // Aligned with ComputeNest: use ListSkills+NeedDownloadUrl+Filter(SkillType,SkillId,SkillSpaceId)
    // GetSkill API does NOT support NeedDownloadUrl — the official frontend
    // calls ListSkills with Filter to obtain DownloadUrl.
    // Official skills → listOfficialSkills (path: /api/v1/skills)
    // Custom skills   → listSkills        (path: /api/v1/skillSpaces/{id}/skills)
    const listResult = skillType === 'official'
      ? await computenest.listOfficialSkills({ needDownloadUrl: true, skillId, skillSpaceId })
      : await computenest.listSkills({ skillSpaceId, needDownloadUrl: true, skillId })

    const skills = listResult?.skills || listResult?.Skills
    const matchedSkill = skills?.find(s => (s.SkillId || s.skillId) === skillId)
    const downloadUrl = matchedSkill?.DownloadUrl || matchedSkill?.downloadUrl
    appLogger.info(`[download-proxy] skillType=${skillType} ListSkills found ${skills?.length ?? 0} skills, downloadUrl=${downloadUrl ? 'present' : 'MISSING'}`)

    if (!downloadUrl) {
      appLogger.warn(`[download-proxy] No DownloadUrl for skillId=${skillId} skillType=${skillType}`)
      res.status(404).json({ success: false, error: 'Download URL not available for this skill' })
      return
    }

    // Step 2: Proxy download from OSS
    const ossRes = await fetch(downloadUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(60000),
    })
    if (!ossRes.ok) {
      appLogger.warn(`[download-proxy] OSS returned ${ossRes.status}`)
      res.status(ossRes.status).json({ success: false, error: `OSS returned ${ossRes.status}` })
      return
    }

    const fileName = `${skillName || matchedSkill?.SkillName || matchedSkill?.skillName || 'skill'}.zip`
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`)
    const contentLength = ossRes.headers.get('content-length')
    if (contentLength) res.setHeader('Content-Length', contentLength)

    // Stream the response
    ossRes.body?.pipeTo(new WritableStream({
      write(chunk) { res.write(chunk) },
      close() { res.end() },
      abort() { res.end() },
    })).catch(() => res.end())
  } catch (e) {
    appLogger.error(`[download-proxy] Error: ${e.message}`)
    res.status(502).json({ success: false, error: 'Failed to download skill file' })
  }
})

// ---------------------------------------------------------------------------
// Skill File Upload (proxy to OSS via ali-oss SDK)
// ---------------------------------------------------------------------------

defineRoute(router, {
  method: 'post',
  path: '/skill-spaces/{skillSpaceId}/skills/upload',
  operationId: 'uploadSkillFile',
  tags: ['Skills'],
  summary: '上传 Skill 文件到 OSS（后端代理）',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ skillSpaceId: z.string() }),
  },
  responses: {
    200: { description: '上传成功，返回 OSS URL 和元数据', content: { 'application/json': { schema: z.object({ success: z.boolean(), ossUrl: z.string(), metadata: z.object({ name: z.string(), description: z.string() }).nullable() }) } } },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    413: errorResponse,
    502: errorResponse,
  },
}, requireAdmin, async (req, res) => {
  const { skillSpaceId } = req.params

  try {
    // Get hub config for bucket info
    const { configured, hubConfig } = await computenest.getSkillHubConfig()
    if (!configured || !hubConfig?.ossBucketName || !hubConfig?.ossRegionId) {
      res.status(400).json({ success: false, error: 'SkillHub not configured or missing OSS bucket info' })
      return
    }

    const bucketName = hubConfig.ossBucketName
    // ComputeNest returns region like 'cn-hangzhou', but ali-oss SDK needs 'oss-cn-hangzhou'
    const rawRegion = hubConfig.ossRegionId
    const region = rawRegion.startsWith('oss-') ? rawRegion : `oss-${rawRegion}`

    // Handle multipart file upload
    const busboy = await import('busboy')
    const bb = busboy.default({
      headers: req.headers,
      limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    })

    let fileBuffer = null
    let fileName = ''
    let fileRejected = false

    bb.on('file', (_fieldname, stream, info) => {
      const ext = info.filename.endsWith('.zip') ? '' : ''
      fileName = `uploadTransfer/${Date.now()}_${info.filename}`
      const chunks = []
      stream.on('data', chunk => chunks.push(chunk))
      stream.on('end', () => {
        fileBuffer = Buffer.concat(chunks)
      })
      stream.on('limit', () => {
        fileRejected = true
      })
    })

    bb.on('finish', async () => {
      if (fileRejected) {
        res.status(413).json({ success: false, error: 'File size exceeds 10MB limit' })
        return
      }
      if (!fileBuffer || !fileName) {
        res.status(400).json({ success: false, error: 'No file uploaded' })
        return
      }

      // Upload to OSS via ali-oss SDK
      try {
        const OSS = (await import('ali-oss')).default
        const client = new OSS({
          region,
          accessKeyId: process.env.ALIBABA_CLOUD_ACCESS_KEY_ID,
          accessKeySecret: process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
          bucket: bucketName,
        })

        const result = await client.put(fileName, fileBuffer)
        // Use SDK to generate a clean URL (without signature) for ComputeNest API
        const ossUrl = client.generateObjectUrl(fileName)

        // Parse SKILL.md metadata from the ZIP (aligned with ComputeNest parseSkillFromZip)
        let metadata = null
        try {
          const AdmZip = (await import('adm-zip')).default
          const zip = new AdmZip(fileBuffer)
          const entries = zip.getEntries()
          const skillMdEntry = entries.find(e => /(^|[/\\])SKILL\.MD$/i.test(e.entryName))
          if (skillMdEntry) {
            const content = skillMdEntry.getData().toString('utf-8')
            metadata = parseSkillMdContent(content)
          }
        } catch (parseErr) {
          appLogger.warn(`[upload-proxy] Failed to parse SKILL.md: ${parseErr.message}`)
        }

        appLogger.info(`[upload-proxy] Uploaded ${fileName} to OSS, url=${ossUrl}, metadata=${metadata ? 'found' : 'none'}`)
        res.json({ success: true, ossUrl, metadata })
      } catch (ossErr) {
        appLogger.error(`[upload-proxy] OSS upload failed: ${ossErr.message}`)
        res.status(502).json({ success: false, error: `OSS upload failed: ${ossErr.message}` })
      }
    })

    bb.on('error', (err) => {
      appLogger.error(`[upload-proxy] Busboy error: ${err.message}`)
      res.status(400).json({ success: false, error: 'Invalid upload request' })
    })

    req.pipe(bb)
  } catch (e) {
    appLogger.error(`[upload-proxy] Error: ${e.message}`)
    res.status(502).json({ success: false, error: 'Failed to upload skill file' })
  }
})

// ---------------------------------------------------------------------------
// Official Skills (1 endpoint)
// ---------------------------------------------------------------------------

defineRoute(router, {
  method: 'get',
  path: '/official-skills',
  operationId: 'listOfficialSkills',
  tags: ['OfficialSkills'],
  summary: '列出官方技能',
  description: '获取计算巢官方预置技能列表，支持按标签分类筛选。',
  security: [{ bearerAuth: [] }],
  request: {
    query: ListOfficialSkillsQuerySchema,
  },
  responses: {
    200: { description: '官方技能列表', content: { 'application/json': { schema: ListOfficialSkillsResponseSchema } } },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    502: errorResponse,
  },
}, requireAuth, validate({ query: ListOfficialSkillsQuerySchema }), async (req, res) => {
  const { keyword, skillLabel, nextToken, maxResults } = req.query
  const result = await computenest.listOfficialSkills({ keyword, skillLabel, nextToken, maxResults })
  const skills = (result.skills || []).map(toCatalogSkill)
  res.json({ success: true, ...result, skills })
})

export default router
