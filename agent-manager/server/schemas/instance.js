// agent-manager/server/schemas/instance.js
import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

export const InstanceSchema = z.object({
  id: z.string().uuid().describe('实例ID'),
  principal_id: z.string().uuid().describe('实例归属主体ID'),
  agent_type_id: z.string().uuid().nullable().describe('智能体类型ID'),
  name: z.string().describe('实例名称'),
  description: z.string().nullable().describe('实例描述'),
  model_id: z.string().uuid().nullable().describe('AI模型ID'),
  status: z.enum(['running','stopped','error','starting','stopping','active','paused','disabled']).describe('实例状态'),
  config_json: z.object({}).passthrough().describe('实例配置，结构因智能体类型而异'),
  sandbox_id: z.string().nullable().describe('沙箱ID'),
  agent_image: z.string().nullable().describe('Agent镜像'),
  token: z.string().nullable().describe('实例Token'),
  last_activity_at: z.string().datetime({ offset: true }).nullable().describe('最后活跃时间'),
  skill_config: z.array(z.object({ pvName: z.string(), mountPath: z.string(), subPath: z.string(), isRequired: z.boolean(), skillSpaceId: z.string().optional() })).nullable().describe('实例创建时客户选择的技能挂载快照'),
  created_at: z.string().datetime({ offset: true }).describe('创建时间'),
  updated_at: z.string().datetime({ offset: true }).describe('更新时间'),
}).openapi('Instance', { description: 'Agent 实例' })
