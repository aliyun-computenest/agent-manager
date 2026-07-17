// agent-manager/server/schemas/ai-model.js
import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

export const AIModelSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  provider: z.string(),
  model_code: z.string(),
  description: z.string().nullable(),
  is_enabled: z.boolean().describe('是否启用'),
  status: z.enum(['active', 'disabled']),
  created_by: z.string().uuid().nullable(),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }).describe('更新时间'),
}).strict().openapi('AIModel', { description: 'AI 模型' })
