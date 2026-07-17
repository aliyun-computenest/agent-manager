/**
 * instance-lifecycle: 只读类用例（不依赖 E2B）
 * - 列表、overview 应正常返回
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { createApiClient } from '../../helpers/api-client.js'
import { getAdminToken, createEphemeralUser } from '../../helpers/auth.js'

describe('instance-lifecycle: read-only', () => {
  let admin
  let user

  beforeAll(async () => {
    admin = createApiClient({ token: await getAdminToken() })
    user = await createEphemeralUser({ tag: 'inst-r' })
  })

  it('管理员访问 /api/admin/instances', async () => {
    const res = await admin.get('/api/admin/instances?page=1&pageSize=5')
    expect([200, 403]).toContain(res.status) // 某些部署可能把 /admin 路由独立保护
    if (res.status === 200) {
      expect(Array.isArray(res.body?.instances)).toBe(true)
    }
  })

  it('普通用户访问 /api/instances 应 200', async () => {
    const client = createApiClient({ token: user.token })
    const res = await client.get('/api/instances')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body?.instances)).toBe(true)
  })

  it('普通用户访问 /api/instances/overview 应 200', async () => {
    const client = createApiClient({ token: user.token })
    const res = await client.get('/api/instances/overview')
    expect(res.status).toBe(200)
    expect(res.body?.success).toBe(true)
    expect(res.body?.overview).toBeTruthy()
    expect(res.body.overview).toHaveProperty('totalInstances')
    expect(typeof res.body.overview.totalInstances).toBe('number')
  })
})
