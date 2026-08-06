// agent-manager/server/schemas/common.js
import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

export const ErrorResponseSchema = z.object({
  success: z.literal(false).optional().describe('某些 4xx 路径(如 SPA fallback)不返此字段'),
  error: z.string().describe('错误消息'),
  code: z.string().optional().describe('特定错误码(如 Cluster.Unavailable)'),
}).openapi('ErrorResponse', { description: '错误响应' })

export const DeleteResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().describe('删除消息'),
}).openapi('DeleteResponse', { description: '删除响应' })

export const PaginationSchema = z.object({
  page: z.number().int().describe('当前页码'),
  pageSize: z.number().int().describe('每页数量'),
  total: z.number().int().describe('总记录数'),
  totalPages: z.number().int().describe('总页数'),
}).openapi('Pagination', { description: '分页信息' })

// Shared response template for 4xx/5xx errors — every defineRoute uses this
export const errorResponse = {
  description: '错误',
  content: { 'application/json': { schema: ErrorResponseSchema } },
}
