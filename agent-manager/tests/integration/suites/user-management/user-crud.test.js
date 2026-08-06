/**
 * user-management: 用户 CRUD
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createApiClient, expectOk } from '../../helpers/api-client.js'
import { getAdminToken } from '../../helpers/auth.js'
import { testSupabaseAdmin, deleteByPrefix } from '../../helpers/supabase.js'
import { prefixedName, prefixedEmail, entityPrefix } from '../../helpers/factory.js'

describe('user-management: CRUD', () => {
  let admin
  const createdUserIds = []
  const createdGroupIds = []

  beforeAll(async () => {
    admin = createApiClient({ token: await getAdminToken() })
  })

  afterAll(async () => {
    if (createdGroupIds.length > 0) {
      await testSupabaseAdmin.from('agent_group_members').delete().in('group_id', createdGroupIds)
      await testSupabaseAdmin.from('principal_profiles').delete().in('id', createdGroupIds)
    }
    for (const id of createdUserIds) {
      await testSupabaseAdmin.from('principal_profiles').delete().eq('id', id)
      await testSupabaseAdmin.auth.admin.deleteUser(id).catch(() => {})
    }
    // 兜底按前缀清理
    await deleteByPrefix('principal_profiles', 'email', entityPrefix)
  })

  it('创建用户 → 列表可见 → 更新角色 → 删除', async () => {
    const username = prefixedName('u-crud')
    const email = prefixedEmail('u-crud')
    const password = 'Pwd!integration-1'

    // create
    const createBody = await expectOk(admin.post('/api/users', {
      email, password, username, role: 'user', maxInstances: 3,
    }))
    expect(createBody.success).toBe(true)
    expect(createBody.user?.email).toBe(email)
    const userId = createBody.user.id
    createdUserIds.push(userId)

    // 列表可见（按 search 过滤）
    const listBody = await expectOk(admin.get(`/api/users?search=${encodeURIComponent(username)}&pageSize=10`))
    expect(listBody.users.some((u) => u.id === userId)).toBe(true)

    // DB 断言
    const { data: profile } = await testSupabaseAdmin
      .from('principal_profiles').select('role, max_agent_instances').eq('id', userId).single()
    expect(profile?.role).toBe('user')
    expect(profile?.max_agent_instances).toBe(3)

    // update role -> admin
    const updateBody = await expectOk(admin.put(`/api/users/${userId}`, {
      role: 'admin', maxInstances: 10,
    }))
    expect(updateBody.success).toBe(true)

    const { data: updated } = await testSupabaseAdmin
      .from('principal_profiles').select('role, max_agent_instances').eq('id', userId).single()
    expect(updated?.role).toBe('admin')
    expect(updated?.max_agent_instances).toBe(10)

    // delete
    const delBody = await expectOk(admin.delete(`/api/users/${userId}`))
    expect(delBody.success).toBe(true)

    const { data: gone } = await testSupabaseAdmin
      .from('principal_profiles').select('id').eq('id', userId).maybeSingle()
    expect(gone).toBeNull()

    // 从清理列表移除
    createdUserIds.splice(createdUserIds.indexOf(userId), 1)
  })

  it('用户是分组 admin 时仍允许删除并清理成员关系', async () => {
    const username = prefixedName('u-group-admin')
    const email = prefixedEmail('u-group-admin')
    const createBody = await expectOk(admin.post('/api/users', {
      email, password: 'Pwd!integration-1', username,
    }))
    const userId = createBody.user.id
    createdUserIds.push(userId)

    const groupBody = await expectOk(admin.post('/api/groups', {
      name: prefixedName('u-admin-group'),
    }))
    const groupId = groupBody.group.id
    createdGroupIds.push(groupId)

    await expectOk(admin.post(`/api/groups/${groupId}/members`, {
      email,
      role: 'admin',
    }))

    const deleteBody = await expectOk(admin.delete(`/api/users/${userId}`))
    expect(deleteBody.success).toBe(true)

    const { data: membership } = await testSupabaseAdmin
      .from('agent_group_members')
      .select('id')
      .eq('group_id', groupId)
      .eq('principal_id', userId)
      .maybeSingle()
    expect(membership).toBeNull()

    createdUserIds.splice(createdUserIds.indexOf(userId), 1)
  })

  it('创建用户时邮箱或用户名缺失应 400', async () => {
    const res = await admin.post('/api/users', { password: 'Pwd!123456' })
    expect(res.status).toBe(400)
    expect(res.body?.success).toBe(false)
  })

  it('密码过短应 400', async () => {
    const res = await admin.post('/api/users', {
      email: prefixedEmail('u-short'),
      username: prefixedName('u-short'),
      password: '123',
    })
    expect(res.status).toBe(400)
  })

  it('切换用户 status 应同步到 DB', async () => {
    const username = prefixedName('u-status')
    const email = prefixedEmail('u-status')
    const body = await expectOk(admin.post('/api/users', {
      email, password: 'Pwd!integration-1', username,
    }))
    const userId = body.user.id
    createdUserIds.push(userId)

    const r1 = await admin.put(`/api/users/${userId}/status`, { status: 'disabled' })
    expect(r1.status).toBe(200)
    const { data: d1 } = await testSupabaseAdmin
      .from('principal_profiles').select('status').eq('id', userId).single()
    expect(d1?.status).toBe('disabled')

    const r2 = await admin.put(`/api/users/${userId}/status`, { status: 'active' })
    expect(r2.status).toBe(200)
    const { data: d2 } = await testSupabaseAdmin
      .from('principal_profiles').select('status').eq('id', userId).single()
    expect(d2?.status).toBe('active')
  })
})
