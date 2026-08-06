/**
 * Smoke: 鉴权路径
 * - 无 token 访问 admin 接口应 401
 * - 管理员登录后可访问 admin 接口
 * - 非法 token 被拒绝
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { createApiClient } from '../../helpers/api-client.js'
import { getAdminToken } from '../../helpers/auth.js'

describe('smoke: auth', () => {
  const anonymous = createApiClient()
  let adminClient

  beforeAll(async () => {
    const token = await getAdminToken()
    adminClient = createApiClient({ token })
  })

  it('匿名访问 /api/users 应被拒绝', async () => {
    const res = await anonymous.get('/api/users')
    expect([401, 403]).toContain(res.status)
  })

  it('非法 token 应被拒绝', async () => {
    const client = createApiClient({ token: 'invalid.token.value' })
    const res = await client.get('/api/users')
    expect(res.status).toBe(401)
  })

  it('管理员访问 /api/users 成功', async () => {
    const res = await adminClient.get('/api/users?page=1&pageSize=1')
    expect(res.status).toBe(200)
    expect(res.body?.success).toBe(true)
    expect(Array.isArray(res.body?.users)).toBe(true)
  })
})
