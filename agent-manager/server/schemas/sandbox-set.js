// agent-manager/server/schemas/sandbox-set.js
import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

export const SandboxSetSchema = z.object({
  name: z.string().describe('沙箱集名称'),
  namespace: z.string().describe('K8s命名空间'),
  image: z.string().describe('沙箱镜像'),
  replicas: z.number().int().describe('副本数'),
  createdAt: z.string().datetime({ offset: true }).describe('创建时间'),
  updatedAt: z.string().datetime({ offset: true }).describe('更新时间'),
  relatedAgentTypeCodes: z.array(z.string()).describe('关联的智能体类型编码列表'),
}).openapi('SandboxSet', { description: '沙箱集' })
