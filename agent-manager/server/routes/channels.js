/**
 * Channel Template and Configuration Routes
 * Handles channel templates and config file management
 */

import { Router } from 'express'
import { z } from 'zod'
import { supabaseAdmin } from '../config/index.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'
import { defineRoute } from '../openapi/route-helper.js'
import { ChannelTemplateSchema } from '../schemas/channel-template.js'
import { errorResponse, DeleteResponseSchema } from '../schemas/common.js'
import { validate } from '../middleware/validate.js'

const router = Router()

const TemplateIdParamsSchema = z.object({
  id: z.string().describe('渠道模板 ID'),
})

const FileNameParamsSchema = z.object({
  fileName: z.string().describe('配置文件名(如 feishu-channel.json)'),
})

const ListTemplatesQuerySchema = z.object({
  agentTypeId: z.string().optional().describe('按智能体类型筛选'),
})

const GetConfigFileQuerySchema = z.object({
  agentTypeId: z.string().optional().describe('按智能体类型筛选'),
})

const CreateChannelTemplateBody = z.object({ channelType: z.enum(['feishu', 'dingtalk', 'qq', 'wecom']), name: z.string({ required_error: 'channelType and name are required' }).min(1, { message: 'channelType and name are required' }) }).passthrough()

const UpdateChannelTemplateBody = z.object({}).passthrough()

const SaveChannelConfigBody = z.object({ fileName: z.string({ required_error: 'fileName and content are required' }).min(1, { message: 'fileName and content are required' }), content: z.string({ required_error: 'fileName and content are required' }).min(1, { message: 'fileName and content are required' }) }).passthrough()

const ListChannelTemplatesResponseSchema = z.object({
  success: z.literal(true),
  templates: z.array(ChannelTemplateSchema),
})

const ChannelTemplateResponseSchema = z.object({
  success: z.literal(true),
  template: ChannelTemplateSchema,
})

const ChannelConfigFileSummarySchema = z.object({
  fileName: z.string().describe('配置文件名'),
  channelType: z.string().describe('渠道类型'),
  size: z.number().int().describe('配置内容字节数'),
  modifiedAt: z.string().nullable().describe('最后修改时间'),
})

const ListChannelConfigFilesResponseSchema = z.object({
  success: z.literal(true),
  files: z.array(ChannelConfigFileSummarySchema),
})

const SaveChannelConfigResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().describe('保存结果消息'),
  fileName: z.string().describe('保存后的文件名'),
})

const GetChannelConfigResponseSchema = z.object({
  success: z.literal(true),
  fileName: z.string().describe('配置文件名'),
  format: z.enum(['json', 'yaml']).describe('配置格式'),
  content: z.string().describe('配置内容(JSON 字符串或 YAML 文本)'),
})

// =====================================================
// Channel Template Management APIs
// =====================================================

/**
 * List all channel templates
 * GET /api/channel-templates
 */
defineRoute(router, {
  method: 'get',
  path: '/channel-templates',
  operationId: 'listChannelTemplates',
  tags: ['Channel Templates'],
  summary: '列出渠道模板',
  description: '获取所有渠道模板列表，可通过 agentTypeId 参数按智能体类型筛选。',
  security: [{ bearerAuth: [] }],
  request: {
    query: ListTemplatesQuerySchema,
  },
  responses: {
    200: {
      description: '成功返回模板列表',
      content: { 'application/json': { schema: ListChannelTemplatesResponseSchema } },
    },
    401: errorResponse,
    500: errorResponse,
  },
}, requireAuth, validate({ query: ListTemplatesQuerySchema }), async (req, res) => {
  const { agentTypeId } = req.query
  let query = supabaseAdmin
    .from('channel_templates')
    .select('*')
    .order('created_at', { ascending: false })

  if (agentTypeId) {
    query = query.eq('agent_type_id', agentTypeId)
  }

  const { data: templates, error } = await query

  if (error) throw error

  res.json({
    success: true,
    templates: templates || []
  })
})

/**
 * Create a new channel template (Admin only)
 * POST /api/channel-templates
 */
defineRoute(router, {
  method: 'post',
  path: '/channel-templates',
  operationId: 'createChannelTemplates',
  tags: ['Channel Templates'],
  summary: '创建渠道模板',
  description: '管理员创建新的渠道模板，需指定渠道类型（feishu/dingtalk/qq/wecom）和模板名称。',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: CreateChannelTemplateBody } } },
  },
  responses: {
    200: {
      description: '创建成功',
      content: { 'application/json': { schema: ChannelTemplateResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: CreateChannelTemplateBody }), async (req, res) => {
  const { channelType, name, description, configFields, configFile, agentTypeId } = req.body

  const insertData = {
    channel_type: channelType,
    name,
    description,
    config_fields: configFields || [
      { name: 'clientId', label: 'Client ID', type: 'text', required: true },
      { name: 'clientSecret', label: 'Client Secret', type: 'password', required: true }
    ],
    config_file: configFile || null
  }
  if (agentTypeId) insertData.agent_type_id = agentTypeId

  const { data: template, error } = await supabaseAdmin
    .from('channel_templates')
    .insert(insertData)
    .select()
    .single()

  if (error) throw error

  res.json({ success: true, template })
})

/**
 * Update a channel template (Admin only)
 * PUT /api/channel-templates/:id
 */
defineRoute(router, {
  method: 'put',
  path: '/channel-templates/{id}',
  operationId: 'updateChannelTemplatesById',
  tags: ['Channel Templates'],
  summary: '更新渠道模板',
  description: '管理员更新指定渠道模板的名称、描述、配置字段等信息，支持部分字段更新。',
  security: [{ bearerAuth: [] }],
  request: {
    params: TemplateIdParamsSchema,
    body: { content: { 'application/json': { schema: UpdateChannelTemplateBody } } },
  },
  responses: {
    200: {
      description: '更新成功',
      content: { 'application/json': { schema: ChannelTemplateResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: UpdateChannelTemplateBody, params: TemplateIdParamsSchema }), async (req, res) => {
  const { id } = req.params
  const { name, description, configFields, configFile, isEnabled } = req.body

  const updateData = {}
  if (name !== undefined) updateData.name = name
  if (description !== undefined) updateData.description = description
  if (configFields !== undefined) updateData.config_fields = configFields
  if (configFile !== undefined) updateData.config_file = configFile
  if (isEnabled !== undefined) updateData.is_enabled = isEnabled

  const { data: template, error } = await supabaseAdmin
    .from('channel_templates')
    .update(updateData)
    .eq('id', id)
    .select()
    .single()

  if (error) throw error

  res.json({ success: true, template })
})

/**
 * Toggle channel template enabled status (Admin only)
 * PATCH /api/channel-templates/:id/toggle
 */
defineRoute(router, {
  method: 'patch',
  path: '/channel-templates/{id}/toggle',
  operationId: 'toggleChannelTemplatesByIdToggle',
  tags: ['Channel Templates'],
  summary: '切换渠道模板启停状态',
  description: '管理员切换指定渠道模板的启用/禁用状态，状态会自动取反。',
  security: [{ bearerAuth: [] }],
  request: {
    params: TemplateIdParamsSchema,
  },
  responses: {
    200: {
      description: '切换成功',
      content: { 'application/json': { schema: ChannelTemplateResponseSchema } },
    },
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ params: TemplateIdParamsSchema }), async (req, res) => {
  const { id } = req.params

  const { data: template, error: fetchError } = await supabaseAdmin
    .from('channel_templates')
    .select('is_enabled')
    .eq('id', id)
    .single()

  if (fetchError || !template) {
    return res.status(404).json({ success: false, error: 'Template not found' })
  }

  const { data: updated, error } = await supabaseAdmin
    .from('channel_templates')
    .update({ is_enabled: !template.is_enabled })
    .eq('id', id)
    .select()
    .single()

  if (error) throw error

  res.json({ success: true, template: updated })
})

// =====================================================
// Channel Config Template APIs (stored in channel_templates.config_template)
// =====================================================

/**
 * List channel config entries from channel_templates
 * GET /api/channel-config-files
 */
defineRoute(router, {
  method: 'get',
  path: '/channel-config-files',
  operationId: 'listChannelConfigFiles',
  tags: ['Channel Config Files'],
  summary: '列出渠道配置文件',
  description: '获取所有渠道配置文件的摘要信息，包括文件名、渠道类型、大小和修改时间。',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: '成功返回配置文件列表',
      content: { 'application/json': { schema: ListChannelConfigFilesResponseSchema } },
    },
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('channel_templates')
    .select('channel_type, config_template, updated_at')
    .order('channel_type')

  if (error) throw error

  const files = (data || []).map(row => ({
    fileName: row.channel_type + '-channel.json',
    channelType: row.channel_type,
    size: JSON.stringify(row.config_template || {}).length,
    modifiedAt: row.updated_at
  }))

  res.json({ success: true, files })
})

/**
 * Save / upsert a channel config into channel_templates.config_template
 * POST /api/channel-config-files
 * Body: { fileName, content }
 */
defineRoute(router, {
  method: 'post',
  path: '/channel-config-files',
  operationId: 'createChannelConfigFiles',
  tags: ['Channel Config Files'],
  summary: '保存渠道配置文件',
  description: '保存或更新指定渠道的配置文件内容，支持 JSON 和 YAML 格式。配置写入 channel_templates 表的 config_template 字段。',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: SaveChannelConfigBody } } },
  },
  responses: {
    200: {
      description: '保存成功',
      content: { 'application/json': { schema: SaveChannelConfigResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: SaveChannelConfigBody }), async (req, res) => {
  const { fileName, content, format = 'json', agentTypeId } = req.body

  const channelType = fileName.replace(/-channel\.json$/, '').replace(/\.json$/, '')

  if (!/^[a-zA-Z0-9_-]+$/.test(channelType)) {
    return res.status(400).json({ success: false, error: 'Invalid file name' })
  }

  let configToSave
  if (format === 'yaml') {
    // YAML format: store as wrapper object with _format and _content
    configToSave = { _format: 'yaml', _content: typeof content === 'string' ? content : String(content) }
  } else {
    // JSON format: parse and store as object
    try {
      configToSave = typeof content === 'string' ? JSON.parse(content) : content
    } catch (e) {
      return res.status(400).json({ success: false, error: 'Invalid JSON content' })
    }
  }

  let updateQuery = supabaseAdmin
    .from('channel_templates')
    .update({
      config_template: configToSave,
      updated_at: new Date().toISOString()
    })
    .eq('channel_type', channelType)

  if (agentTypeId) {
    updateQuery = updateQuery.eq('agent_type_id', agentTypeId)
  }

  const { error } = await updateQuery

  if (error) throw error

  res.json({ success: true, message: 'Config saved successfully', fileName: `${channelType}-channel.json` })
})

/**
 * Get a channel config from channel_templates
 * GET /api/channel-config-files/:fileName
 */
defineRoute(router, {
  method: 'get',
  path: '/channel-config-files/{fileName}',
  operationId: 'getChannelConfigFilesByFileName',
  tags: ['Channel Config Files'],
  summary: '获取渠道配置文件内容',
  description: '根据文件名获取渠道配置文件的完整内容，返回时会标注格式（json/yaml）。',
  security: [{ bearerAuth: [] }],
  request: {
    params: FileNameParamsSchema,
    query: GetConfigFileQuerySchema,
  },
  responses: {
    200: {
      description: '成功返回配置内容',
      content: { 'application/json': { schema: GetChannelConfigResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ query: GetConfigFileQuerySchema, params: FileNameParamsSchema }), async (req, res) => {
  const { fileName } = req.params
  const { agentTypeId } = req.query
  const channelType = fileName.replace(/-channel\.json$/, '').replace(/\.json$/, '')

  if (!/^[a-zA-Z0-9_-]+$/.test(channelType)) {
    return res.status(400).json({ success: false, error: 'Invalid file name' })
  }

  let query = supabaseAdmin
    .from('channel_templates')
    .select('config_template')
    .eq('channel_type', channelType)

  if (agentTypeId) {
    query = query.eq('agent_type_id', agentTypeId)
  }

  const { data, error } = await query.maybeSingle()

  if (error) throw error
  if (!data) return res.status(404).json({ success: false, error: 'Config not found' })

  const tpl = data.config_template || {}
  const isYaml = tpl._format === 'yaml'
  if (isYaml) {
    res.json({ success: true, fileName, format: 'yaml', content: tpl._content || '' })
  } else {
    res.json({ success: true, fileName, format: 'json', content: JSON.stringify(tpl, null, 2) })
  }
})

/**
 * Delete a channel config (resets to empty)
 * DELETE /api/channel-config-files/:fileName
 */
defineRoute(router, {
  method: 'delete',
  path: '/channel-config-files/{fileName}',
  operationId: 'deleteChannelConfigFilesByFileName',
  tags: ['Channel Config Files'],
  summary: '删除渠道配置文件（重置为空）',
  description: '将指定渠道的配置文件内容重置为空对象，不会删除渠道模板本身。',
  security: [{ bearerAuth: [] }],
  request: {
    params: FileNameParamsSchema,
  },
  responses: {
    200: {
      description: '删除成功',
      content: { 'application/json': { schema: DeleteResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ params: FileNameParamsSchema }), async (req, res) => {
  const { fileName } = req.params
  const channelType = fileName.replace(/-channel\.json$/, '').replace(/\.json$/, '')

  if (!/^[a-zA-Z0-9_-]+$/.test(channelType)) {
    return res.status(400).json({ success: false, error: 'Invalid file name' })
  }

  const { error } = await supabaseAdmin
    .from('channel_templates')
    .update({ config_template: {}, updated_at: new Date().toISOString() })
    .eq('channel_type', channelType)

  if (error) throw error

  res.json({ success: true, message: 'Config deleted successfully' })
})

export default router
