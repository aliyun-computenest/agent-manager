// agent-manager/server/openapi/definition.js
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

let version = '0.0.0'
try {
  version = JSON.parse(readFileSync(resolve(__dirname, '../../version.json'), 'utf-8')).version
} catch {}

export const info = {
  title: 'OpenClaw Platform API',
  version,
  description: 'OpenClaw Agent Management Platform REST API',
  license: { name: 'Apache 2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
}

export const servers = [{ url: '/api', description: 'API base path' }]

export const tags = [
  { name: 'Health',                  description: '健康检查与版本信息' },
  { name: 'AI Models',               description: 'AI 模型管理' },
  { name: 'Channel Templates',       description: '渠道模板管理' },
  { name: 'Channel Config Files',    description: '渠道配置文件管理' },
  { name: 'Email',                   description: '邮箱认证设置' },
  { name: 'Users',                   description: '用户管理' },
  { name: 'Agent Types',             description: '智能体类型与模板管理' },
  { name: 'Template (Legacy)',       description: 'OpenClaw 旧版模板接口(保留以兼容)' },
  { name: 'Sandbox Sets',            description: '沙箱集管理(K8s 资源)' },
  { name: 'Groups',                  description: 'Agent 分组共享管理' },
  { name: 'Instances',               description: 'Agent 实例生命周期管理' },
  { name: 'Instances (Admin)',       description: '管理员视角的实例管理' },
  { name: 'CheckpointBackups',        description: '实例 Checkpoint 备份与恢复执行管理' },
  { name: 'Providers',               description: 'AI 供应商配置与管理' },
  { name: 'Provider Operations',     description: '供应商运行时配置(限额、统计、token)' },
  { name: 'SSO',                     description: '单点登录(OAuth/SAML)配置' },
  { name: 'SSO Providers',           description: 'SSO 提供商管理' },
  { name: 'Sandbox Upgrades',        description: '沙箱升级与滚动更新管理' },
  { name: 'Terminal',                description: '终端会话管理' },
  { name: 'Channel Auto Config',    description: '渠道自动配置(扫码注册)' },
  { name: 'Observability',          description: '可观测性集成(CMS/仪表盘)' },
  { name: 'SkillHub',               description: '计算巢 SkillHub 配置' },
  { name: 'SkillSpaces',            description: '技能空间管理' },
  { name: 'Skills',                 description: '技能管理' },
  { name: 'OfficialSkills',         description: '计算巢官方技能' },
  { name: 'SkillFileDetect',        description: '技能文件安全检测' },
]

export const securitySchemes = {
  bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
}
