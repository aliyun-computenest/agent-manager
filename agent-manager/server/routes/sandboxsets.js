import { Router } from 'express'
import { z } from 'zod'
import { supabaseAdmin } from '../config/index.js'
import { requireAdmin } from '../middleware/auth.js'
import { defineRoute } from '../openapi/route-helper.js'
import {
  listSandboxSets,
  getSandboxSet,
  createSandboxSet,
  updateSandboxSet,
  deleteSandboxSet,
} from '../services/k8s.js'
import { SandboxSetSchema } from '../schemas/sandbox-set.js'
import { errorResponse, DeleteResponseSchema } from '../schemas/common.js'
import { validate } from '../middleware/validate.js'

const router = Router()
const SandboxSetParamsSchema = z.object({
  name: z.string().describe('SandboxSet 名称'),
})

const NamespaceQuerySchema = z.object({
  namespace: z.string().optional().describe('K8s命名空间'),
})

const NamespaceQueryWithDefaultSchema = z.object({
  namespace: z.string().optional().describe('K8s命名空间(handler默认default)'),
})

const CreateSandboxsetBody = z.object({ name: z.string({ required_error: 'name and yaml are required' }).min(1, { message: 'name and yaml are required' }), yaml: z.string({ required_error: 'name and yaml are required' }).min(1, { message: 'name and yaml are required' }) }).passthrough()

const UpdateSandboxsetBody = z.object({ yaml: z.string({ required_error: 'yaml is required' }).min(1, { message: 'yaml is required' }) }).passthrough()

const ListSandboxsetsResponseSchema = z.object({
  success: z.literal(true),
  sandboxSets: z.array(SandboxSetSchema),
})

const SandboxsetResponseSchema = z.object({
  success: z.literal(true),
  sandboxSet: SandboxSetSchema,
})

/**
 * GET /api/sandboxsets
 */
defineRoute(router, {
  method: 'get',
  path: '/sandboxsets',
  operationId: 'listSandboxsets',
  tags: ['Sandbox Sets'],
  summary: '列出 SandboxSet 资源',
  description: '获取所有 SandboxSet K8s 资源列表，并关联显示每个 SandboxSet 对应的智能体类型编码。',
  security: [{ bearerAuth: [] }],
  request: {
    query: NamespaceQuerySchema,
  },
  responses: {
    200: {
      description: '成功返回 SandboxSet 列表',
      content: { 'application/json': { schema: ListSandboxsetsResponseSchema } },
    },
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ query: NamespaceQuerySchema }), async (req, res) => {
  try {
    const namespace = req.query.namespace || undefined
    const items = await listSandboxSets(namespace)

    const names = items.map(i => i.name)
    let codeMap = {}
    if (names.length > 0) {
      const { data: agentTypes } = await supabaseAdmin
        .from('agent_types')
        .select('code, sandbox_template_id')
      if (agentTypes) {
        for (const at of agentTypes) {
          const target = at.sandbox_template_id || at.code
          if (names.includes(target)) {
            if (!codeMap[target]) codeMap[target] = []
            codeMap[target].push(at.code)
          }
        }
      }
    }

    const result = items.map(item => ({
      ...item,
      relatedAgentTypeCodes: codeMap[item.name] || [],
    }))

    res.json({ success: true, sandboxSets: result })
  } catch (err) {
    console.error('List sandboxsets error:', err)
    res.status(err.httpStatus || 500).json({
      success: false,
      error: err.message,
      code: err.code,
    })
  }
})

/**
 * GET /api/sandboxsets/:name
 */
defineRoute(router, {
  method: 'get',
  path: '/sandboxsets/{name}',
  operationId: 'getSandboxsetsByName',
  tags: ['Sandbox Sets'],
  summary: '获取 SandboxSet 详情',
  description: '根据名称获取指定 SandboxSet 的完整 K8s 资源详情。',
  security: [{ bearerAuth: [] }],
  request: {
    params: SandboxSetParamsSchema,
    query: NamespaceQueryWithDefaultSchema,
  },
  responses: {
    200: {
      description: '成功返回 SandboxSet 详情',
      content: { 'application/json': { schema: SandboxsetResponseSchema } },
    },
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ query: NamespaceQueryWithDefaultSchema, params: SandboxSetParamsSchema }), async (req, res) => {
  try {
    const { name } = req.params
    const namespace = req.query.namespace || 'default'
    const detail = await getSandboxSet(name, namespace)
    if (!detail) {
      return res.status(404).json({
        success: false,
        error: `SandboxSet "${name}" not found`,
        code: 'SandboxSet.NotFound',
      })
    }
    res.json({ success: true, sandboxSet: detail })
  } catch (err) {
    console.error('Get sandboxset error:', err)
    res.status(err.httpStatus || 500).json({
      success: false,
      error: err.message,
      code: err.code,
    })
  }
})

/**
 * POST /api/sandboxsets
 */
defineRoute(router, {
  method: 'post',
  path: '/sandboxsets',
  operationId: 'createSandboxsets',
  tags: ['Sandbox Sets'],
  summary: '创建 SandboxSet',
  description: '管理员通过提供 K8s YAML 定义创建新的 SandboxSet 资源，用于托管智能体沙箱运行环境。',
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: CreateSandboxsetBody } } },
  },
  responses: {
    200: {
      description: '创建成功',
      content: { 'application/json': { schema: SandboxsetResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: CreateSandboxsetBody }), async (req, res) => {
  try {
    const { name, namespace = 'default', yaml: yamlStr } = req.body
    const detail = await createSandboxSet(name, namespace, yamlStr)
    res.json({ success: true, sandboxSet: detail })
  } catch (err) {
    console.error('Create sandboxset error:', err)
    res.status(err.httpStatus || 500).json({
      success: false,
      error: err.message,
      code: err.code,
    })
  }
})

/**
 * PUT /api/sandboxsets/:name
 */
defineRoute(router, {
  method: 'put',
  path: '/sandboxsets/{name}',
  operationId: 'updateSandboxsetsByName',
  tags: ['Sandbox Sets'],
  summary: '更新 SandboxSet',
  description: '管理员通过提供新的 K8s YAML 定义更新已有的 SandboxSet 资源配置。',
  security: [{ bearerAuth: [] }],
  request: {
    params: SandboxSetParamsSchema,
    query: NamespaceQueryWithDefaultSchema,
    body: { content: { 'application/json': { schema: UpdateSandboxsetBody } } },
  },
  responses: {
    200: {
      description: '更新成功',
      content: { 'application/json': { schema: SandboxsetResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: UpdateSandboxsetBody, query: NamespaceQueryWithDefaultSchema, params: SandboxSetParamsSchema }), async (req, res) => {
  try {
    const { name } = req.params
    const namespace = req.query.namespace || 'default'
    const { yaml: yamlStr } = req.body
    const detail = await updateSandboxSet(name, namespace, yamlStr)
    res.json({ success: true, sandboxSet: detail })
  } catch (err) {
    console.error('Update sandboxset error:', err)
    res.status(err.httpStatus || 500).json({
      success: false,
      error: err.message,
      code: err.code,
    })
  }
})

/**
 * DELETE /api/sandboxsets/:name
 */
defineRoute(router, {
  method: 'delete',
  path: '/sandboxsets/{name}',
  operationId: 'deleteSandboxsetsByName',
  tags: ['Sandbox Sets'],
  summary: '删除 SandboxSet',
  description: '管理员删除指定的 SandboxSet K8s 资源，删除后不可恢复。',
  security: [{ bearerAuth: [] }],
  request: {
    params: SandboxSetParamsSchema,
    query: NamespaceQueryWithDefaultSchema,
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
}, requireAdmin, validate({ query: NamespaceQueryWithDefaultSchema, params: SandboxSetParamsSchema }), async (req, res) => {
  try {
    const { name } = req.params
    const namespace = req.query.namespace || 'default'
    await deleteSandboxSet(name, namespace)
    res.json({ success: true, message: `SandboxSet "${name}" deleted` })
  } catch (err) {
    console.error('Delete sandboxset error:', err)
    res.status(err.httpStatus || 500).json({
      success: false,
      error: err.message,
      code: err.code,
    })
  }
})

export default router
