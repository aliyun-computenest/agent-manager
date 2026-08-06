/**
 * 管理员实例操作集成测试
 * 覆盖: POST /admin/instances, GET /instances/{id}/channel-secret
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createApiClient, expectOk } from '../../helpers/api-client.js'
import { getAdminToken, createEphemeralUserViaApi } from '../../helpers/auth.js'
import { prefixedName } from '../../helpers/factory.js'
import { testEnv } from '../../setup/test-env.js'
import { waitFor } from '../../helpers/wait-for.js'
import { buildTestCustomVars } from './_shared.js'

const WRITE_TIMEOUT = Math.max(
  testEnv.instanceReadyTimeoutMs,
  120_000,
)

describe('instance admin operations', () => {
  let admin
  let createdInstanceIds = []

  beforeAll(async () => {
    const token = await getAdminToken()
    admin = createApiClient({ token })
  })

  afterAll(async () => {
    for (const id of createdInstanceIds) {
      await admin.delete(`/api/instances/${id}`).catch(() => {})
    }
  })

  describe('POST /admin/instances', () => {
    it('缺 userId 和 email → 400', async () => {
      const res = await admin.post('/api/admin/instances', {
        name: prefixedName('admin-no-user'),
      })
      expect(res.status).toBe(400)
    })

    if (testEnv.skipE2b) {
      it.skip('管理员为他人创建实例（跳过：TEST_SKIP_E2B=true）', () => {})
    } else {
      it('管理员为他人创建实例', async () => {
        const user = await createEphemeralUserViaApi(admin, { tag: 'admin-inst' })
        const name = prefixedName('admin-create')

        const typesBody = await expectOk(admin.get('/api/agent-types'))
        const enabledType = (typesBody.agentTypes || []).find(t => t.is_enabled)
        if (!enabledType) {
          console.warn('[instance-admin] 无可用 agent-type，跳过')
          await user.cleanup()
          return
        }

        const res = await admin.post(
          '/api/admin/instances',
          {
            userId: user.userId,
            name,
            agentTypeId: enabledType.id,
            async: true,
            ...(buildTestCustomVars(enabledType) ? { customVars: buildTestCustomVars(enabledType) } : {}),
          },
          undefined,
          { timeoutMs: WRITE_TIMEOUT },
        )
        // 暴露响应体供 CI 诊断 500 等服务端错误
        expect(
          res.status,
          `admin-create body=${(() => { try { return JSON.stringify(res.body)?.slice(0, 1000) } catch { return String(res.body) } })()}`,
        ).toBe(200)
        expect(res.body.success).toBe(true)
        expect(res.body.instance).toBeDefined()
        expect(res.body.instance.id).toBeTruthy()

        createdInstanceIds.push(res.body.instance.id)

        // 等待实例就绪或失败
        await waitFor(
          async () => {
            const r = await admin.get(`/api/instances/${res.body.instance.id}`)
            if (r.status !== 200) return null
            const s = r.body?.instance?.status
            if (s === 'running' || s === 'stopped') return r.body.instance
            if (s === 'failed' || s === 'error') return r.body.instance
            return null
          },
          { timeoutMs: WRITE_TIMEOUT, intervalMs: 5_000, label: 'admin-instance-ready' },
        ).catch(() => {})

        await user.cleanup()
      },
      // 显式覆盖 vitest 默认 testTimeout（60s）。post + 轮询就绪可能超过 60s，
      // 与 instance-create.test.js 的逻辑对齐：instanceReadyTimeoutMs * 2 + 120s
      testEnv.instanceReadyTimeoutMs * 2 + 120_000)
    }
  })

  describe('GET /instances/{id}/channel-secret', () => {
    it('未认证 → 401', async () => {
      const anonymous = createApiClient()
      const res = await anonymous.get('/api/instances/00000000-0000-0000-0000-000000000000/channel-secret')
      expect([401, 403]).toContain(res.status)
    })

    it('不存在的实例 → 404', async () => {
      const res = await admin.get('/api/instances/00000000-0000-0000-0000-000000000000/channel-secret')
      expect(res.status).toBe(404)
    })

    it('存在的实例读取 channel-secret', async () => {
      // 使用现有实例（如果有的话）
      const listBody = await expectOk(admin.get('/api/admin/instances?pageSize=1'))
      const instances = listBody.instances || []
      if (instances.length === 0) {
        console.warn('[instance-admin] 无实例可供测试 channel-secret')
        return
      }

      const instanceId = instances[0].id
      const res = await admin.get(`/api/instances/${instanceId}/channel-secret`)
      // 200 = 有渠道配置; 404 = 无渠道配置（也是正常的）
      expect([200, 404]).toContain(res.status)
      if (res.status === 200) {
        expect(res.body.success).toBe(true)
        expect(res.body).toHaveProperty('channelType')
        expect(res.body).toHaveProperty('clientId')
        expect(res.body).toHaveProperty('clientSecret')
      }
    })
  })
})
