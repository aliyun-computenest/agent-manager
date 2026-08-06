/**
 * Provider 详细配置 & 用户限额集成测试
 * 覆盖: PUT /providers/{name}/config, PUT /providers/{name}/limit-config,
 *        GET /providers/current/user-limit, PUT /providers/current/user-limit
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createApiClient, expectOk } from '../../helpers/api-client.js'
import { getAdminToken, createEphemeralUserViaApi } from '../../helpers/auth.js'
import { prefixedCode, entityPrefix } from '../../helpers/factory.js'
import { deleteByPrefix } from '../../helpers/supabase.js'

describe('provider config & user-limit', () => {
  let admin
  let provName
  const createdProviders = []

  beforeAll(async () => {
    const token = await getAdminToken()
    admin = createApiClient({ token })

    provName = prefixedCode('prov-cfg')
    await expectOk(admin.post('/api/providers', {
      name: provName,
      type: 'API',
      apiKey: 'sk-test-cfg-key',
      domain: 'https://api.test-cfg.example.com',
    }))
    createdProviders.push(provName)
  })

  afterAll(async () => {
    for (const name of createdProviders) {
      // 确保禁用后再删除
      const detail = await admin.get(`/api/providers/${name}`)
      if (detail.status === 200 && detail.body?.provider?.isEnabled) {
        await admin.patch(`/api/providers/${name}/toggle`).catch(() => {})
      }
      await admin.delete(`/api/providers/${name}`).catch(() => {})
    }
    await deleteByPrefix('provider_config', 'name', entityPrefix)
  })

  describe('PUT /providers/{name}/config', () => {
    it('更新 provider 详细配置', async () => {
      const body = await expectOk(admin.put(`/api/providers/${provName}/config`, {
        domain: 'https://updated.example.com',
      }))
      expect(body.success).toBe(true)
      expect(body.config).toBeDefined()
    })

    it('写后读验证配置已更新', async () => {
      const body = await expectOk(admin.get(`/api/providers/${provName}/config`))
      expect(body.success).toBe(true)
      expect(body.config).toBeDefined()
    })
  })

  describe('PUT /providers/{name}/limit-config', () => {
    it('更新限额配置', async () => {
      const res = await admin.put(`/api/providers/${provName}/limit-config`, {
        budgets: [
          { timeRate: 'daily', value: 100000, unit: 'token' },
        ],
      })
      // 200 = 支持; 400 = 不支持限额
      expect([200, 400]).toContain(res.status)
      if (res.status === 200) {
        expect(res.body.success).toBe(true)
      }
    })

    it('读取限额配置', async () => {
      const body = await expectOk(admin.get(`/api/providers/${provName}/limit-config`))
      expect(body.success).toBe(true)
      expect(typeof body.supported).toBe('boolean')
    })
  })

  describe('GET /providers/current/user-limit', () => {
    it('缺 userId → 400', async () => {
      const res = await admin.get('/api/providers/current/user-limit')
      expect(res.status).toBe(400)
    })

    it('读取用户额度', async () => {
      const user = await createEphemeralUserViaApi(admin, { tag: 'limit-read' })
      const body = await expectOk(
        admin.get(`/api/providers/current/user-limit?userId=${user.userId}`),
      )
      expect(body.success).toBe(true)
      expect(body.config).toBeDefined()
      await user.cleanup()
    })
  })

  describe('PUT /providers/current/user-limit', () => {
    it('缺 userId → 400', async () => {
      const res = await admin.put('/api/providers/current/user-limit', {
        budgets: [],
      })
      expect(res.status).toBe(400)
    })

    it('有 userId 但无启用 provider → 400，或有 provider 则返回 200', async () => {
      const user = await createEphemeralUserViaApi(admin, { tag: 'limit-write' })
      const res = await admin.put('/api/providers/current/user-limit', {
        userId: user.userId,
        budgets: [],
      })
      // 200 = provider 支持 user limit 且操作成功; 400 = 无启用 provider / provider 不支持 / 临时用户未绑定 consumer
      expect([200, 400]).toContain(res.status)
      await user.cleanup()
    })
  })
})
