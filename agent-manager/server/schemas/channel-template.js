// agent-manager/server/schemas/channel-template.js
import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

export const ChannelTemplateSchema = z.object({
  id: z.string().uuid().describe('模板ID'),
  channel_type: z.string().describe('渠道类型(feishu/dingtalk/qq/wecom 等)'),
  agent_type_id: z.string().uuid().nullable().describe('关联的智能体类型ID'),
  name: z.string().describe('模板名称'),
  description: z.string().nullable().describe('模板描述'),
  config_fields: z.array(z.object({ name: z.string(), type: z.string(), label: z.string().optional(), required: z.boolean().optional(), placeholder: z.string().optional() }).passthrough()).describe('配置字段列表'),
  config_file: z.string().nullable().describe('配置文件路径'),
  config_template: z.object({}).passthrough().describe('渠道配置模板，结构因渠道类型而异'),
  is_enabled: z.boolean().describe('是否启用'),
  created_at: z.string().datetime({ offset: true }).describe('创建时间'),
  updated_at: z.string().datetime({ offset: true }).describe('更新时间'),
}).strict().openapi('ChannelTemplate', { description: '渠道模板' })
