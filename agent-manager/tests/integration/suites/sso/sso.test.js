/**
 * SSO 配置集成测试
 * 覆盖 P1 级别：SSO 模式切换 + 公开接口 + Auth Providers + RBAC
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createApiClient, expectOk } from '../../helpers/api-client.js'
import { getAdminToken, createEphemeralUserViaApi } from '../../helpers/auth.js'
import { entityPrefix, testEnv } from '../../setup/test-env.js'

describe('sso', () => {
  let admin
  let anonymous

  beforeAll(async () => {
    const token = await getAdminToken()
    admin = createApiClient({ token })
    anonymous = createApiClient()
  })

  // 记录原始 SSO 模式，afterAll 还原
  let originalMode
  let originalSignupEnabled

  afterAll(async () => {
    // 尽力还原 SSO 模式
    if (originalMode) {
      await admin.put('/api/sso/mode', { mode: originalMode }).catch(() => {})
    }
    if (originalSignupEnabled !== undefined) {
      await admin.put('/api/email/auth-settings', { signupEnabled: originalSignupEnabled }).catch(() => {})
    }
  })

  const fetchGotrueSettings = async () => {
    const res = await fetch(`${testEnv.supabaseUrl}/auth/v1/settings`, {
      headers: {
        apikey: testEnv.anonKey,
        Authorization: `Bearer ${testEnv.anonKey}`,
      },
      signal: AbortSignal.timeout(testEnv.requestTimeoutMs),
    })
    expect(res.ok).toBe(true)
    return res.json()
  }

  // ========================================
  // SSO Mode
  // ========================================
  describe('SSO Mode', () => {
    it('SSO-001: 查看当前 SSO 模式', async () => {
      const body = await expectOk(admin.get('/api/sso/mode'))
      expect(body.success).toBe(true)
      expect(['none', 'oauth', 'saml']).toContain(body.mode)
      // 记录原始值
      if (!originalMode) originalMode = body.mode
    })

    it('SSO-003: 公开接口获取 SSO 模式（无需认证）', async () => {
      const body = await expectOk(anonymous.get('/api/sso/mode/public'))
      expect(body.success).toBe(true)
      expect(['none', 'oauth', 'saml']).toContain(body.mode)
    })

    it('SSO-002: 切换 SSO 模式为 oauth', async () => {
      const body = await expectOk(admin.put('/api/sso/mode', { mode: 'oauth' }))
      expect(body.success).toBe(true)
      expect(body.mode).toBe('oauth')

      // 验证模式已更新
      const verifyBody = await expectOk(admin.get('/api/sso/mode'))
      expect(verifyBody.mode).toBe('oauth')
    })

    it('SSO-002: 切换 SSO 模式为 none', async () => {
      const body = await expectOk(admin.put('/api/sso/mode', { mode: 'none' }))
      expect(body.success).toBe(true)
      expect(body.mode).toBe('none')
    })

    it('非法 SSO 模式应返回 400', async () => {
      const res = await admin.put('/api/sso/mode', { mode: 'invalid-mode' })
      expect(res.status).toBe(400)
    })
  })

  // ========================================
  // SSO Info
  // ========================================
  describe('SSO Info', () => {
    it('SSO-007: 获取 SSO 信息（SP Entity ID、ACS URL）', async () => {
      const body = await expectOk(admin.get('/api/sso/info'))
      expect(body.success).toBe(true)
      expect(body).toHaveProperty('spEntityId')
      expect(body).toHaveProperty('spAcsUrl')
      expect(body.spEntityId).toContain('/sso/saml/metadata')
      expect(body.spAcsUrl).toContain('/sso/saml/acs')
    })
  })

  // ========================================
  // SSO Auth Providers
  // ========================================
  describe('SSO Auth Providers', () => {
    it('SSO-004: 查看已启用 Auth Providers', async () => {
      const body = await expectOk(admin.get('/api/sso/auth-providers'))
      expect(body.success).toBe(true)
      expect(Array.isArray(body.oauthProviders)).toBe(true)
      expect(Array.isArray(body.samlProviders)).toBe(true)
      expect(body).toHaveProperty('hasSaml')
      expect(body).toHaveProperty('activeMode')
    })
  })

  describe('OAuth signup guard', () => {
    it('OAuth 模式下关闭自助注册后，GoTrue 拒绝创建新 Auth 用户', async () => {
      if (!originalMode) {
        const modeBody = await expectOk(admin.get('/api/sso/mode'))
        originalMode = modeBody.mode
      }
      if (originalSignupEnabled === undefined) {
        const settingsBody = await expectOk(admin.get('/api/email/auth-settings'))
        originalSignupEnabled = settingsBody.data.signupEnabled
      }

      const modeBody = await expectOk(admin.put('/api/sso/mode', { mode: 'oauth' }))
      expect(modeBody.mode).toBe('oauth')

      const signupSettings = await expectOk(admin.put('/api/email/auth-settings', {
        signupEnabled: false,
      }))
      expect(signupSettings.data.signupEnabled).toBe(false)

      const settings = await fetchGotrueSettings()
      expect(settings.disable_signup).toBe(true)

      const tag = Math.random().toString(36).slice(2, 8)
      const email = `${entityPrefix}oauth-denied-${tag}@test.local`
      const password = `Pwd!oauth-denied-${tag}`

      const loginRes = await fetch(`${testEnv.supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: {
          apikey: testEnv.anonKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(testEnv.requestTimeoutMs),
      })

      expect(loginRes.status).toBeGreaterThanOrEqual(400)

      const signupRes = await fetch(`${testEnv.supabaseUrl}/auth/v1/signup`, {
        method: 'POST',
        headers: {
          apikey: testEnv.anonKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          email,
          password,
          data: { username: `${entityPrefix}oauth-denied-${tag}` },
        }),
        signal: AbortSignal.timeout(testEnv.requestTimeoutMs),
      })
      const signupText = await signupRes.text()
      expect(signupRes.status, signupText).toBeGreaterThanOrEqual(400)
    })
  })

  // ========================================
  // SSO Providers (Public)
  // ========================================
  describe('SSO Providers Public', () => {
    it('SSO-003: 公开接口获取 SSO Providers（无需认证）', async () => {
      const body = await expectOk(anonymous.get('/api/sso/providers/public'))
      expect(body.success).toBe(true)
      expect(Array.isArray(body.providers)).toBe(true)
    })
  })

  // ========================================
  // SSO Providers (Admin)
  // ========================================
  describe('SSO Providers Admin', () => {
    it('SSO-004: 查看 SSO Providers 列表', async () => {
      const body = await expectOk(admin.get('/api/sso/providers'))
      expect(body.success).toBe(true)
      expect(Array.isArray(body.providers)).toBe(true)
    })
  })

  // ========================================
  // SSO Settings
  // ========================================
  describe('SSO Settings', () => {
    it('获取 SSO 设置', async () => {
      const body = await expectOk(admin.get('/api/sso/settings'))
      expect(body.success).toBe(true)
      expect(body.settings).toBeDefined()
      expect(body.settings).toHaveProperty('site_url')
    })
  })

  // ========================================
  // SSO Settings PATCH
  // ========================================
  describe('SSO Settings PATCH', () => {
    let originalSiteUrl

    afterAll(async () => {
      if (originalSiteUrl !== undefined) {
        await admin.patch('/api/sso/settings', { site_url: originalSiteUrl }).catch(() => {})
      }
    })

    it('读取当前 SSO 设置并记录原始值', async () => {
      const body = await expectOk(admin.get('/api/sso/settings'))
      expect(body.success).toBe(true)
      expect(body.settings).toBeDefined()
      originalSiteUrl = body.settings.site_url
    })

    it('更新 site_url', async () => {
      const res = await admin.patch('/api/sso/settings', {
        site_url: 'https://test-sso-settings.example.com',
      })
      // 200 = 修改成功; 501 = 开源 Supabase 不支持
      expect([200, 501]).toContain(res.status)
      if (res.status === 200) {
        expect(res.body.success).toBe(true)
        expect(res.body.settings.site_url).toBe('https://test-sso-settings.example.com')
      }
    })

    it('缺 site_url → 400', async () => {
      const res = await admin.patch('/api/sso/settings', {})
      expect(res.status).toBe(400)
    })
  })

  // ========================================
  // SSO Providers CRUD
  // ========================================
  describe('SSO Providers CRUD', () => {
    let createdProviderId

    afterAll(async () => {
      if (createdProviderId) {
        await admin.delete(`/api/sso/providers/${createdProviderId}`).catch(() => {})
      }
    })

    it('缺 domain → 400', async () => {
      const res = await admin.post('/api/sso/providers', {
        metadata_url: 'https://idp.example.com/metadata',
      })
      expect(res.status).toBe(400)
    })

    it('缺 metadata_url → 400', async () => {
      const res = await admin.post('/api/sso/providers', {
        domain: 'test-sso-crud.example.com',
      })
      expect(res.status).toBe(400)
    })

    it('创建 SAML provider', async () => {
      const res = await admin.post('/api/sso/providers', {
        domain: 'it-sso-test.example.com',
        metadata_url: 'https://idp.example.com/metadata.xml',
      })
      // 200 = 成功; 500 = IdP metadata 不可达（预期，不报错）
      if (res.status === 200) {
        expect(res.body.success).toBe(true)
        expect(res.body.provider).toBeDefined()
        createdProviderId = res.body.provider.id
      } else {
        console.warn(`[sso] 创建 SAML provider 返回 ${res.status}，可能 IdP metadata URL 不可达，跳过后续 CRUD`)
      }
    })

    it('删除 provider', async () => {
      if (!createdProviderId) return
      const body = await expectOk(admin.delete(`/api/sso/providers/${createdProviderId}`))
      expect(body.success).toBe(true)
      createdProviderId = null
    })
  })

  // ========================================
  // RBAC: 普通用户权限
  // ========================================
  describe('SSO RBAC', () => {
    let userClient
    let userCleanup

    beforeAll(async () => {
      const user = await createEphemeralUserViaApi(admin, { tag: 'sso-rbac' })
      userClient = createApiClient({ token: user.token })
      userCleanup = user.cleanup
    })

    afterAll(async () => {
      await userCleanup()
    })

    it('SEC-001: 普通用户不能设置 SSO 模式', async () => {
      const res = await userClient.put('/api/sso/mode', { mode: 'saml' })
      expect([401, 403]).toContain(res.status)
    })

    it('SEC-001: 普通用户不能查看 SSO providers（管理接口）', async () => {
      const res = await userClient.get('/api/sso/providers')
      expect([401, 403]).toContain(res.status)
    })

    it('SEC-002: 匿名用户不能访问管理员 SSO 接口', async () => {
      const res = await anonymous.get('/api/sso/mode')
      expect([401, 403]).toContain(res.status)
    })
  })
})
