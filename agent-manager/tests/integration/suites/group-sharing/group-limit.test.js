/**
 * group-limit: integration tests for group-level budget/limit API
 *
 * Covers:
 *   - GET  /api/groups/:groupId/limit (read group limit config)
 *   - PUT  /api/groups/:groupId/limit (update group limit config)
 *   - Permission control (admin can manage, member cannot)
 *   - Edge cases (non-existent group, no gateway configured)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createApiClient, expectOk } from '../../helpers/api-client.js'
import { createEphemeralUserViaApi, getAdminToken } from '../../helpers/auth.js'
import { prefixedName } from '../../helpers/factory.js'
import { testSupabaseAdmin } from '../../helpers/supabase.js'

describe('group-limit: group-level budget API', () => {
  const createdGroupIds = []
  const users = []

  let adminClient
  let extraAdminUser
  let groupAdminUser
  let memberUser
  let outsiderUser
  let extraAdminClient
  let groupAdminClient
  let memberClient
  let outsiderClient
  let testGroup

  async function createUser(tag) {
    const user = await createEphemeralUserViaApi(adminClient, { role: 'user', tag })
    users.push(user)
    return user
  }

  async function createGroup(tag) {
    const created = await expectOk(adminClient.post('/api/groups', {
      name: prefixedName(tag),
    }))
    createdGroupIds.push(created.group.id)
    return created.group
  }

  async function addMemberToGroup(group, user, role = 'member') {
    return expectOk(adminClient.post(`/api/groups/${group.id}/members`, {
      email: user.email,
      role,
    }))
  }

  async function cleanup() {
    if (createdGroupIds.length > 0) {
      await testSupabaseAdmin.from('agent_group_members').delete().in('group_id', createdGroupIds)
      await testSupabaseAdmin.from('principal_profiles').delete().in('id', createdGroupIds)
    }
    for (const user of users) {
      await user.cleanup().catch(() => {})
      await testSupabaseAdmin.from('principal_profiles').delete().eq('id', user.userId)
    }
  }

  beforeAll(async () => {
    adminClient = createApiClient({ token: await getAdminToken() })

    extraAdminUser = await createUser('glimit-extra-admin')
    groupAdminUser = await createUser('glimit-admin')
    memberUser = await createUser('glimit-member')
    outsiderUser = await createUser('glimit-outsider')

    extraAdminClient = createApiClient({ token: extraAdminUser.token })
    groupAdminClient = createApiClient({ token: groupAdminUser.token })
    memberClient = createApiClient({ token: memberUser.token })
    outsiderClient = createApiClient({ token: outsiderUser.token })

    // Create a group and assign roles
    testGroup = await createGroup('limit-test-group')

    // Add another admin to verify non-platform group admin access
    await addMemberToGroup(testGroup, extraAdminUser, 'admin')
    // Add groupAdminUser as admin
    await addMemberToGroup(testGroup, groupAdminUser, 'admin')
    // Add memberUser as plain member
    await addMemberToGroup(testGroup, memberUser, 'member')
  })

  afterAll(cleanup)

  // --- GET /api/groups/:groupId/limit ---

  describe('GET /api/groups/:groupId/limit', () => {
    it('platform admin can read group limit', async () => {
      const res = await adminClient.get(`/api/groups/${testGroup.id}/limit`)
      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data).toBeDefined()
      expect(typeof res.body.data.enabled).toBe('boolean')
      expect(Array.isArray(res.body.data.budgets)).toBe(true)
      expect(Array.isArray(res.body.data.globalBudgets)).toBe(true)
      expect(Array.isArray(res.body.data.effectiveBudgets)).toBe(true)
    })

    it('another group admin can read group limit', async () => {
      const res = await extraAdminClient.get(`/api/groups/${testGroup.id}/limit`)
      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data).toBeDefined()
      expect(typeof res.body.data.enabled).toBe('boolean')
    })

    it('group admin can read group limit', async () => {
      const res = await groupAdminClient.get(`/api/groups/${testGroup.id}/limit`)
      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data).toBeDefined()
    })

    it('group member cannot read group limit', async () => {
      const res = await memberClient.get(`/api/groups/${testGroup.id}/limit`)
      expect(res.status).toBe(403)
    })

    it('outsider cannot read group limit', async () => {
      const res = await outsiderClient.get(`/api/groups/${testGroup.id}/limit`)
      expect(res.status).toBe(403)
    })

    it('non-existent groupId returns 404', async () => {
      const fakeGroupId = randomUUID()
      const res = await adminClient.get(`/api/groups/${fakeGroupId}/limit`)
      expect(res.status).toBe(404)
    })

    it('invalid groupId format returns 400', async () => {
      const res = await adminClient.get('/api/groups/not-a-uuid/limit')
      expect(res.status).toBe(400)
    })
  })

  // --- PUT /api/groups/:groupId/limit ---

  describe('PUT /api/groups/:groupId/limit', () => {
    it('platform admin can update group limit', async () => {
      const res = await adminClient.put(`/api/groups/${testGroup.id}/limit`, {
        budgets: [
          { timeRate: 'daily', value: 50000, unit: 'token' },
        ],
      })
      // 200 = provider supports group limit and operation succeeded
      // 400 = no provider enabled / provider doesn't support group limit / consumer missing
      expect([200, 400]).toContain(res.status)
      if (res.status === 200) {
        expect(res.body.success).toBe(true)
      } else {
        // Expected error codes when gateway is not configured or doesn't support group limits
        expect(['GATEWAY_NOT_CONFIGURED', 'GATEWAY_GROUP_LIMIT_NOT_SUPPORTED', 'PRINCIPAL_CONSUMER_MISSING'])
          .toContain(res.body.error)
      }
    })

    it('another group admin can update group limit', async () => {
      const res = await extraAdminClient.put(`/api/groups/${testGroup.id}/limit`, {
        budgets: [
          { timeRate: 'monthly', value: 1000000, unit: 'token' },
        ],
      })
      expect([200, 400]).toContain(res.status)
      if (res.status === 200) {
        expect(res.body.success).toBe(true)
      } else {
        expect(['GATEWAY_NOT_CONFIGURED', 'GATEWAY_GROUP_LIMIT_NOT_SUPPORTED', 'PRINCIPAL_CONSUMER_MISSING'])
          .toContain(res.body.error)
      }
    })

    it('group admin can update group limit', async () => {
      const res = await groupAdminClient.put(`/api/groups/${testGroup.id}/limit`, {
        budgets: [],
      })
      expect([200, 400]).toContain(res.status)
      if (res.status === 200) {
        expect(res.body.success).toBe(true)
      } else {
        expect(['GATEWAY_NOT_CONFIGURED', 'GATEWAY_GROUP_LIMIT_NOT_SUPPORTED', 'PRINCIPAL_CONSUMER_MISSING'])
          .toContain(res.body.error)
      }
    })

    it('group member cannot update group limit', async () => {
      const res = await memberClient.put(`/api/groups/${testGroup.id}/limit`, {
        budgets: [
          { timeRate: 'daily', value: 10000, unit: 'token' },
        ],
      })
      expect(res.status).toBe(403)
    })

    it('outsider cannot update group limit', async () => {
      const res = await outsiderClient.put(`/api/groups/${testGroup.id}/limit`, {
        budgets: [
          { timeRate: 'daily', value: 10000, unit: 'token' },
        ],
      })
      expect(res.status).toBe(403)
    })

    it('non-existent groupId returns 404', async () => {
      const fakeGroupId = randomUUID()
      const res = await adminClient.put(`/api/groups/${fakeGroupId}/limit`, {
        budgets: [],
      })
      expect(res.status).toBe(404)
    })

    it('invalid groupId format returns 400', async () => {
      const res = await adminClient.put('/api/groups/not-a-uuid/limit', {
        budgets: [],
      })
      expect(res.status).toBe(400)
    })

    it('update with valid budgets then GET confirms values (when gateway is available)', async () => {
      const budgets = [
        { timeRate: 'daily', value: 88888, unit: 'token' },
      ]
      const putRes = await adminClient.put(`/api/groups/${testGroup.id}/limit`, { budgets })

      if (putRes.status !== 200) {
        // Gateway not available; skip the read-after-write assertion
        console.warn('[group-limit] gateway unavailable for write-read verification, skipping')
        return
      }

      expect(putRes.body.success).toBe(true)

      // Read back and verify
      const getRes = await adminClient.get(`/api/groups/${testGroup.id}/limit`)
      expect(getRes.status).toBe(200)
      expect(getRes.body.data.enabled).toBe(true)

      // The budgets or effectiveBudgets should contain the value we set
      const allBudgets = [
        ...getRes.body.data.budgets,
        ...getRes.body.data.effectiveBudgets,
      ]
      const found = allBudgets.some(
        b => b.timeRate === 'daily' && b.value === 88888 && b.unit === 'token'
      )
      expect(found, 'Expected the updated budget to appear in GET response').toBe(true)
    })

    it('clearing budgets with empty array succeeds (when gateway is available)', async () => {
      const putRes = await adminClient.put(`/api/groups/${testGroup.id}/limit`, {
        budgets: [],
      })

      if (putRes.status !== 200) {
        console.warn('[group-limit] gateway unavailable for clear verification, skipping')
        return
      }

      expect(putRes.body.success).toBe(true)
    })
  })

  // --- Edge: gateway not configured scenario ---

  describe('gateway not configured behavior', () => {
    it('GET returns enabled: false when provider does not support group limits', async () => {
      // We rely on the actual environment; if no gateway is configured this validates graceful fallback
      const res = await adminClient.get(`/api/groups/${testGroup.id}/limit`)
      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      // When no gateway: enabled=false; when gateway present: enabled can be true or false
      expect(typeof res.body.data.enabled).toBe('boolean')
      if (!res.body.data.enabled) {
        expect(res.body.data.budgets).toEqual([])
        expect(res.body.data.globalBudgets).toEqual([])
        expect(res.body.data.effectiveBudgets).toEqual([])
      }
    })

    it('PUT returns 400 with error code when gateway is not configured', async () => {
      // This test validates the error code pattern. If gateway IS configured it will succeed.
      const res = await adminClient.put(`/api/groups/${testGroup.id}/limit`, {
        budgets: [{ timeRate: 'daily', value: 1, unit: 'token' }],
      })
      // Either succeeds (200) or fails with a known error (400)
      expect([200, 400]).toContain(res.status)
      if (res.status === 400) {
        expect(res.body.success).toBe(false)
        expect(res.body.error).toBeDefined()
        expect(['GATEWAY_NOT_CONFIGURED', 'GATEWAY_GROUP_LIMIT_NOT_SUPPORTED', 'PRINCIPAL_CONSUMER_MISSING'])
          .toContain(res.body.error)
      }
    })
  })
})
