import { describe, expect, it } from 'vitest'
import { getOAuthProviderScopes } from '../../../../src/lib/oauth-provider-scopes.ts'

describe('sso: OAuth provider scopes', () => {
  it('uses Feishu profile, email, employee, and enterprise email scopes', () => {
    expect(getOAuthProviderScopes('feishu')).toBe('contact:user.base:readonly contact:user.email:readonly contact:user.employee:readonly directory:employee.base.enterprise_email:read')
  })

  it('uses DingTalk user profile scope', () => {
    expect(getOAuthProviderScopes('dingtalk')).toBe('Contact.User.Read')
  })

  it('uses Alibaba Cloud OIDC scopes', () => {
    expect(getOAuthProviderScopes('alibabacloud')).toBe('openid profile aliuid')
  })
})
