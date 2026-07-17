/**
 * user-management: 批量导入
 * 覆盖 POST /api/users/batch
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createApiClient, expectOk } from '../../helpers/api-client.js'
import { getAdminToken } from '../../helpers/auth.js'
import { testSupabaseAdmin, deleteByPrefix } from '../../helpers/supabase.js'
import { prefixedEmail, prefixedName, entityPrefix } from '../../helpers/factory.js'

describe('user-management: batch import', () => {
  let admin
  const createdIds = []

  beforeAll(async () => {
    admin = createApiClient({ token: await getAdminToken() })
  })

  afterAll(async () => {
    for (const id of createdIds) {
      await testSupabaseAdmin.from('principal_profiles').delete().eq('id', id)
      await testSupabaseAdmin.auth.admin.deleteUser(id).catch(() => {})
    }
    await deleteByPrefix('principal_profiles', 'email', entityPrefix)
  })

  it('批量创建 3 个用户，部分字段缺失应正确报错', async () => {
    const good = [
      { email: prefixedEmail('b1'), username: prefixedName('b1'), password: 'Pwd!batch-1' },
      { email: prefixedEmail('b2'), username: prefixedName('b2'), password: 'Pwd!batch-2', role: 'admin', maxInstances: 8 },
    ]
    const bad = [
      { email: prefixedEmail('b3'), username: prefixedName('b3') }, // 缺 password
    ]

    const body = await expectOk(admin.post('/api/users/batch', { users: [...good, ...bad] }))
    expect(body.success).toBe(true)
    expect(body.total).toBe(3)
    expect(body.created).toBe(2)
    expect(body.failed).toBe(1)
    expect(body.errors?.[0]?.error).toMatch(/password/i)

    for (const r of body.results) {
      createdIds.push(r.userId)
    }

    // DB 侧核对
    const { data: rows } = await testSupabaseAdmin
      .from('principal_profiles')
      .select('id, role, max_agent_instances, email')
      .in('id', createdIds)
    expect(rows?.length).toBe(2)
    const b2 = rows.find((r) => r.email.includes('b2-'))
    expect(b2?.role).toBe('admin')
    expect(b2?.max_agent_instances).toBe(8)
  })

  it('users 为空数组应 400', async () => {
    const res = await admin.post('/api/users/batch', { users: [] })
    expect(res.status).toBe(400)
  })
})
