// agent-manager/server/schemas/agent-type.js
import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

export const AgentTypeSchema = z.object({
  id: z.string().uuid().describe('类型ID'),
  code: z.string().describe('类型编码(唯一标识)'),
  name: z.string().describe('类型名称'),
  description: z.string().nullable().describe('类型描述'),
  icon: z.string().describe('图标标识'),
  category: z.enum(['builtin', 'custom']).describe('分类(内置/自定义)'),
  sandbox_template_id: z.string().nullable().describe('沙箱模板ID'),
  sandbox_timeout: z.number().int().describe('沙箱超时秒数'),
  config_template: z.object({}).passthrough().describe('配置模板，结构因智能体类型而异'),
  config_write_path: z.string().nullable().describe('配置写入路径'),
  startup_command: z.string().nullable().describe('启动命令'),
  modify_model_command: z.string().nullable().describe('修改模型命令'),
  modify_channel_command: z.string().nullable().describe('修改渠道命令'),
  readiness_check: z.union([z.object({ type: z.literal('http'), port: z.number(), path: z.string(), timeout: z.number() }), z.object({ type: z.literal('tcp'), port: z.number(), timeout: z.number() })]).describe('就绪检查配置'),
  upgrade_metadata: z.object({ preUpgrade: z.object({ command: z.array(z.string()) }).optional(), postUpgrade: z.object({ command: z.array(z.string()) }).optional(), timeoutSeconds: z.number().optional() }).describe('升级元数据'),
  supports_channels: z.boolean().describe('是否支持渠道'),
  supports_env_vars: z.boolean().describe('是否支持环境变量'),
  supports_skills: z.boolean().describe('是否启用 Agent Type 的 Skill 配置能力'),
  skill_path: z.string().min(1).describe('在线安装 Skill 的根目录'),
  user_terminal_enabled: z.boolean().describe('是否启用用户终端'),
  sandbox_user: z.string().nullable().describe('沙箱运行用户'),
  terminal_user: z.string().describe('终端登录用户'),
  is_enabled: z.boolean().describe('是否启用'),
  sort_order: z.number().int().describe('排序序号'),
  skill_config: z.array(z.object({ pvName: z.string(), mountPath: z.string(), subPath: z.string(), isRequired: z.boolean().default(false), skillSpaceId: z.string().optional() })).nullable().describe('技能配置列表'),
  created_at: z.string().datetime({ offset: true }).describe('创建时间'),
  updated_at: z.string().datetime({ offset: true }).describe('更新时间'),
}).strict().openapi('AgentType', { description: '智能体类型' })
