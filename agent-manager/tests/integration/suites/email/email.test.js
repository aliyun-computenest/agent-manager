/**
 * Email 认证设置集成测试
 * 覆盖: GET /email/auth-settings, PUT /email/auth-settings
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createApiClient, expectOk } from '../../helpers/api-client.js'
import { getAdminToken, createEphemeralUserViaApi } from '../../helpers/auth.js'

describe('email auth settings', () => {
  let admin
  let originalEnabled

  beforeAll(async () => {
    const token = await getAdminToken()
    admin = createApiClient({ token })
  })

  afterAll(async () => {
    if (originalEnabled !== undefined) {
      await admin.put('/api/email/auth-settings', { enabled: originalEnabled }).catch(() => {})
    }
  })

  describe('GET /email/auth-settings', () => {
    it('管理员读取邮箱认证设置', async () => {
      const body = await expectOk(admin.get('/api/email/auth-settings'))
      expect(body.success).toBe(true)
      expect(body.data).toBeDefined()
      expect(typeof body.data.enabled).toBe('boolean')
      expect(typeof body.data.smtpConfigured).toBe('boolean')
      expect(body.data).toHaveProperty('smtpHost')
      expect(body.data).toHaveProperty('siteUrl')
      originalEnabled = body.data.enabled
    })

    it('未认证用户 → 401', async () => {
      const anonymous = createApiClient()
      const res = await anonymous.get('/api/email/auth-settings')
      expect([401, 403]).toContain(res.status)
    })
  })

  describe('PUT /email/auth-settings', () => {
    it('切换邮箱认证开关', async () => {
      const res = await admin.put('/api/email/auth-settings', { enabled: false })
      // 200 = GoTrue 支持修改; 501 = 开源 Supabase 不支持
      expect([200, 501]).toContain(res.status)
      if (res.status === 200) {
        expect(res.body.success).toBe(true)
        expect(typeof res.body.data.enabled).toBe('boolean')
      }
    })

    it('缺少 enabled → 400', async () => {
      const res = await admin.put('/api/email/auth-settings', {})
      expect(res.status).toBe(400)
    })

    it('enabled 非布尔值 → 400', async () => {
      const res = await admin.put('/api/email/auth-settings', { enabled: 'yes' })
      expect(res.status).toBe(400)
    })
  })

  describe('RBAC', () => {
    let userClient
    let userCleanup

    beforeAll(async () => {
      const user = await createEphemeralUserViaApi(admin, { tag: 'email-rbac' })
      userClient = createApiClient({ token: user.token })
      userCleanup = user.cleanup
    })

    afterAll(async () => {
      await userCleanup()
    })

    it('普通用户不能读取邮箱认证设置 → 403', async () => {
      const res = await userClient.get('/api/email/auth-settings')
      expect([401, 403]).toContain(res.status)
    })

    it('普通用户不能修改邮箱认证设置 → 403', async () => {
      const res = await userClient.put('/api/email/auth-settings', { enabled: true })
      expect([401, 403]).toContain(res.status)
    })
  })
})
