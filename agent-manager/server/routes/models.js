/**
 * AI Model Management Routes
 * Handles AI model CRUD operations
 */

import { Router } from 'express'
import { z } from 'zod'
import { supabaseAdmin } from '../config/index.js'
import { requireAdmin, requireAuth } from '../middleware/auth.js'
import { defineRoute } from '../openapi/route-helper.js'
import { AIModelSchema } from '../schemas/ai-model.js'
import { errorResponse, DeleteResponseSchema } from '../schemas/common.js'
import { validate } from '../middleware/validate.js'

const router = Router()

const ModelIdParamsSchema = z.object({
  id: z.string().describe('AI 模型 ID'),
})

const CreateModelBody = z.object({ name: z.string({ required_error: 'name, provider and modelCode are required' }).min(1, { message: 'name, provider and modelCode are required' }), provider: z.string({ required_error: 'name, provider and modelCode are required' }).min(1, { message: 'name, provider and modelCode are required' }), modelCode: z.string({ required_error: 'name, provider and modelCode are required' }).min(1, { message: 'name, provider and modelCode are required' }) }).passthrough()

const UpdateModelBody = z.object({}).passthrough()

const ListModelsResponseSchema = z.object({
  success: z.literal(true),
  models: z.array(AIModelSchema),
})

const ModelResponseSchema = z.object({
  success: z.literal(true),
  model: AIModelSchema,
})

/**
 * List all AI models
 * GET /api/models
 * Filters out models whose provider is disabled
 */
defineRoute(router, {
  method: 'get',
  path: '/models',
  operationId: 'listModels',
  tags: ['AI Models'],
  summary: '列出AI模型（仅返回已启用供应商的模型）',
  description: '获取所有已启用供应商下的 AI 模型列表，禁用供应商的模型不会返回。',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: '成功返回模型列表',
      content: { 'application/json': { schema: ListModelsResponseSchema } },
    },
    401: errorResponse,
    500: errorResponse,
  },
}, requireAuth, async (req, res) => {
  // Get enabled providers to filter models
  const { data: enabledProviders } = await supabaseAdmin
    .from('provider_config')
    .select('name')
    .eq('enabled', true)

  const enabledProviderNames = (enabledProviders || []).map(p => p.name)

  let query = supabaseAdmin
    .from('ai_models')
    .select('*')
    .order('created_at', { ascending: false })

  // Filter by enabled providers (if any providers exist)
  if (enabledProviderNames.length > 0) {
    query = query.in('provider', enabledProviderNames)
  }

  const { data: models, error } = await query

  if (error) throw error

  res.json({
    success: true,
    models: models || []
  })
})

/**
 * Create a new AI model
 * POST /api/models
 * Body: { name, provider, modelCode, description?, status? }
 */
defineRoute(router, {
  method: 'post',
  path: '/models',
  operationId: 'createModels',
  tags: ['AI Models'],
  summary: '创建AI模型',
  description: '管理员创建新的 AI 模型记录，需指定模型名称、供应商和模型编码。创建后可在实例中选用。',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: CreateModelBody } } },
  },
  responses: {
    200: {
      description: '创建成功',
      content: { 'application/json': { schema: ModelResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: CreateModelBody }), async (req, res) => {
  const { name, provider, modelCode, description = null, status = 'active' } = req.body

  const { data: model, error } = await supabaseAdmin
    .from('ai_models')
    .insert({
      name,
      provider,
      model_code: modelCode,
      description,
      status,
      created_by: req.user.id
    })
    .select()
    .single()

  if (error) throw error

  res.json({
    success: true,
    model
  })
})

/**
 * Update an AI model
 * PUT /api/models/:id
 * Body: { name?, provider?, modelCode?, description?, status? }
 */
defineRoute(router, {
  method: 'put',
  path: '/models/{id}',
  operationId: 'updateModelsById',
  tags: ['AI Models'],
  summary: '更新AI模型',
  description: '管理员更新指定 AI 模型的名称、供应商、模型编码等信息，支持部分字段更新。',
  security: [{ bearerAuth: [] }],
  request: {
    params: ModelIdParamsSchema,
    body: { content: { 'application/json': { schema: UpdateModelBody } } },
  },
  responses: {
    200: {
      description: '更新成功',
      content: { 'application/json': { schema: ModelResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: UpdateModelBody, params: ModelIdParamsSchema }), async (req, res) => {
  const { id } = req.params
  const { name, provider, modelCode, description, status } = req.body

  const updateData = {}
  if (name !== undefined) updateData.name = name
  if (provider !== undefined) updateData.provider = provider
  if (modelCode !== undefined) updateData.model_code = modelCode
  if (description !== undefined) updateData.description = description
  if (status !== undefined) updateData.status = status

  if (Object.keys(updateData).length === 0) {
    return res.status(400).json({
      success: false,
      error: 'No fields to update'
    })
  }

  const { data: model, error } = await supabaseAdmin
    .from('ai_models')
    .update(updateData)
    .eq('id', id)
    .select()
    .single()

  if (error) throw error

  res.json({
    success: true,
    model
  })
})

/**
 * Delete an AI model
 * DELETE /api/models/:id
 */
defineRoute(router, {
  method: 'delete',
  path: '/models/{id}',
  operationId: 'deleteModelsById',
  tags: ['AI Models'],
  summary: '删除AI模型',
  description: '管理员删除指定的 AI 模型记录，删除后不可恢复。',
  security: [{ bearerAuth: [] }],
  request: {
    params: ModelIdParamsSchema,
  },
  responses: {
    200: {
      description: '删除成功',
      content: { 'application/json': { schema: DeleteResponseSchema } },
    },
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ params: ModelIdParamsSchema }), async (req, res) => {
  const { id } = req.params

  const { error } = await supabaseAdmin
    .from('ai_models')
    .delete()
    .eq('id', id)

  if (error) throw error

  res.json({
    success: true,
    message: 'Model deleted successfully'
  })
})

/**
 * Toggle model status
 * PATCH /api/models/:id/toggle
 */
defineRoute(router, {
  method: 'patch',
  path: '/models/{id}/toggle',
  operationId: 'toggleModelsByIdToggle',
  tags: ['AI Models'],
  summary: '切换AI模型启停状态',
  description: '管理员切换指定 AI 模型的启用/禁用状态，状态会自动取反。',
  security: [{ bearerAuth: [] }],
  request: {
    params: ModelIdParamsSchema,
  },
  responses: {
    200: {
      description: '切换成功',
      content: { 'application/json': { schema: ModelResponseSchema } },
    },
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ params: ModelIdParamsSchema }), async (req, res) => {
  const { id } = req.params

  // Get current status
  const { data: model, error: fetchError } = await supabaseAdmin
    .from('ai_models')
    .select('status')
    .eq('id', id)
    .single()

  if (fetchError || !model) {
    return res.status(404).json({
      success: false,
      error: 'Model not found'
    })
  }

  const newStatus = model.status === 'active' ? 'disabled' : 'active'

  const { data: updated, error } = await supabaseAdmin
    .from('ai_models')
    .update({ status: newStatus })
    .eq('id', id)
    .select()
    .single()

  if (error) throw error

  res.json({
    success: true,
    model: updated
  })
})

export default router
