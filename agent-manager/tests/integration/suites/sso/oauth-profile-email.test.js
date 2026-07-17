import { describe, expect, it } from 'vitest'
import { resolveOAuthProfileEmail } from '../../../../src/lib/oauth-profile-email.ts'

describe('sso: OAuth profile email normalization', () => {
  it('企业邮箱有效时优先使用 enterprise_email', () => {
    const email = resolveOAuthProfileEmail({
      provider: 'feishu',
      authEmail: 'ou_stub@feishu.user',
      metadata: {
        email: 'personal@example.com',
        enterprise_email: 'worker@corp.example.com',
      },
    })

    expect(email).toBe('worker@corp.example.com')
  })

  it('企业邮箱无效时跳过乱码并回退到普通 email', () => {
    const email = resolveOAuthProfileEmail({
      provider: 'feishu',
      authEmail: 'ou_stub@feishu.user',
      metadata: {
        email: 'personal@example.com',
        enterprise_email: '乱码',
      },
    })

    expect(email).toBe('personal@example.com')
  })

  it('metadata 邮箱都无效时保留 OAuth 占位邮箱', () => {
    const email = resolveOAuthProfileEmail({
      provider: 'dingtalk',
      authEmail: 'user_stub@dingtalk.user',
      metadata: {
        email: '???',
        enterprise_email: 'not-an-email',
      },
    })

    expect(email).toBe('user_stub@dingtalk.user')
  })

  it('metadata 为 null 时直接使用 authEmail', () => {
    const email = resolveOAuthProfileEmail({
      provider: 'feishu',
      authEmail: 'fallback@feishu.user',
      metadata: null,
    })

    expect(email).toBe('fallback@feishu.user')
  })
})
