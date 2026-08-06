/**
 * user-management: RBAC
 * 非 admin 用户访问 admin-only 接口应被拒绝（403）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createApiClient } from '../../helpers/api-client.js'
import { createEphemeralUser } from '../../helpers/auth.js'

describe('user-management: RBAC', () => {
  let user
  let client

  beforeAll(async () => {
    user = await createEphemeralUser({ role: 'user', tag: 'rbac' })
    client = createApiClient({ token: user.token })
  })

  afterAll(async () => {
    await user.cleanup()
  })

  it('普通用户访问 GET /api/users 应 403', async () => {
    const res = await client.get('/api/users')
    expect(res.status).toBe(403)
  })

  it('普通用户创建用户应 403', async () => {
    const res = await client.post('/api/users', {
      email: 'x@test.local', username: 'x', password: 'Pwd!123456',
    })
    expect(res.status).toBe(403)
  })

  it('普通用户创建 agent-type 应 403', async () => {
    const res = await client.post('/api/agent-types', {
      code: 'should-not-create', name: 'should-not-create',
    })
    expect(res.status).toBe(403)
  })
})
