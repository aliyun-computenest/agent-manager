import type { Provider } from '@supabase/supabase-js'

export type SupportedOAuthProvider = Provider | 'alibabacloud' | 'feishu' | 'dingtalk'

const OAUTH_PROVIDER_SCOPES: Partial<Record<SupportedOAuthProvider, string>> = {
  alibabacloud: 'openid profile aliuid',
  feishu: 'contact:user.base:readonly contact:user.email:readonly contact:user.employee:readonly directory:employee.base.enterprise_email:read',
  dingtalk: 'Contact.User.Read',
}

export function getOAuthProviderScopes(provider: SupportedOAuthProvider) {
  return OAUTH_PROVIDER_SCOPES[provider]
}
