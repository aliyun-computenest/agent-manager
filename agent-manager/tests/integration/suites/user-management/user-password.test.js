/**
 * 用户密码管理集成测试
 * 覆盖: GET /users/me/auth-mode, PUT /users/me/password, PUT /users/{userId}/password
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createApiClient, expectOk } from '../../helpers/api-client.js'
import { getAdminToken, createEphemeralUserViaApi, signInWithPassword } from '../../helpers/auth.js'

describe('user password management', () => {
  let admin

  beforeAll(async () => {
    const token = await getAdminToken()
    admin = createApiClient({ token })
  })

  describe('GET /users/me/auth-mode', () => {
    it('已认证用户查看认证方式', async () => {
      const body = await expectOk(admin.get('/api/users/me/auth-mode'))
      expect(body.success).toBe(true)
      expect(body.data).toBeDefined()
      expect(typeof body.data.emailAuthEnabled).toBe('boolean')
    })

    it('未认证 → 401', async () => {
      const anonymous = createApiClient()
      const res = await anonymous.get('/api/users/me/auth-mode')
      expect([401, 403]).toContain(res.status)
    })
  })

  describe('PUT /users/me/password', () => {
    let ephemeral
    let ephemeralClient

    beforeAll(async () => {
      ephemeral = await createEphemeralUserViaApi(admin, { tag: 'pwd-self' })
      ephemeralClient = createApiClient({ token: ephemeral.token })
    })

    afterAll(async () => {
      await ephemeral.cleanup()
    })

    it('缺 currentPassword → 400', async () => {
      const res = await ephemeralClient.put('/api/users/me/password', {
        newPassword: 'NewPwd!123456',
      })
      expect(res.status).toBe(400)
    })

    it('当前密码错误 → 400', async () => {
      const res = await ephemeralClient.put('/api/users/me/password', {
        currentPassword: 'wrong-password',
        newPassword: 'NewPwd!123456',
      })
      expect(res.status).toBe(400)
    })

    it('用户修改自己密码', async () => {
      const newPassword = `New!${Date.now()}`
      const res = await ephemeralClient.put('/api/users/me/password', {
        currentPassword: ephemeral.password,
        newPassword,
      })
      // 200 = 直接修改; 也可能返回 requiresEmailVerification
      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)

      if (!res.body.requiresEmailVerification) {
        const token = await signInWithPassword(ephemeral.email, newPassword)
        expect(token).toBeTruthy()
      }
    })
  })

  describe('PUT /users/{userId}/password (admin)', () => {
    let target
    let targetCleanup

    beforeAll(async () => {
      target = await createEphemeralUserViaApi(admin, { tag: 'pwd-admin' })
      targetCleanup = target.cleanup
    })

    afterAll(async () => {
      await targetCleanup()
    })

    it('管理员重置用户密码', async () => {
      const newPassword = `Admin!${Date.now()}`
      const body = await expectOk(
        admin.put(`/api/users/${target.userId}/password`, { password: newPassword }),
      )
      expect(body.success).toBe(true)

      const token = await signInWithPassword(target.email, newPassword)
      expect(token).toBeTruthy()
    })

    it('密码少于 6 位 → 400', async () => {
      const res = await admin.put(`/api/users/${target.userId}/password`, { password: 'abc' })
      expect(res.status).toBe(400)
    })

    it('缺 password → 400', async () => {
      const res = await admin.put(`/api/users/${target.userId}/password`, {})
      expect(res.status).toBe(400)
    })

    it('普通用户不能重置别人密码 → 403', async () => {
      const user = await createEphemeralUserViaApi(admin, { tag: 'pwd-rbac' })
      const userClient = createApiClient({ token: user.token })

      const res = await userClient.put(`/api/users/${target.userId}/password`, {
        password: 'Hacker!123456',
      })
      expect([401, 403]).toContain(res.status)

      await user.cleanup()
    })
  })
})
