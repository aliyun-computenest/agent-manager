// agent-manager/server/schemas/sso.js
import { z } from 'zod'
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'

extendZodWithOpenApi(z)

export const SSOSettingsSchema = z.object({
  site_url: z.string().describe('站点 URL'),
  uri_allow_list: z.string().describe('允许重定向的 URI 列表'),
}).openapi('SSOSettings', { description: 'SSO 站点设置' })

export const SSOModeSchema = z.enum(['none', 'oauth', 'saml'])
  .openapi('SSOMode', { description: 'SSO 模式' })
