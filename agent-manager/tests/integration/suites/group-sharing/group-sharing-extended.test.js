/**
 * group-sharing-extended: edge cases, concurrency, credential isolation,
 * admin list filters, and gateway/LiteLLM resilience scenarios.
 *
 * Complements group-sharing.test.js which covers basic CRUD + access boundaries.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createApiClient, expectOk } from '../../helpers/api-client.js'
import { createEphemeralUserViaApi, getAdminToken } from '../../helpers/auth.js'
import { prefixedName } from '../../helpers/factory.js'
import { testSupabaseAdmin } from '../../helpers/supabase.js'
import { testEnv } from '../../setup/test-env.js'

describe('group-sharing-extended: edge cases and resilience', () => {
  const createdGroupIds = []
  const createdInstanceIds = []
  const users = []

  let adminClient
  let userA
  let userB
  let userC
  let clientA
  let clientB
  let clientC

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

  async function seedInstance({ name, creatorUser, groupId = null }) {
    const id = randomUUID()
    const { data, error } = await testSupabaseAdmin
      .from('agent_instances')
      .insert({
        id,
        principal_id: groupId || creatorUser.userId,
        name,
        description: null,
        status: 'stopped',
        config_json: {},
        sandbox_id: null,
        token: `it-${id}`,
      })
      .select()
      .single()

    if (error) throw new Error(`[seed] agent_instances insert failed: ${error.message}`)
    createdInstanceIds.push(id)
    return data
  }

  async function cleanup() {
    if (createdInstanceIds.length > 0) {
      await testSupabaseAdmin.from('agent_instances').delete().in('id', createdInstanceIds)
    }
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

    userA = await createUser('ext-user-a')
    userB = await createUser('ext-user-b')
    userC = await createUser('ext-user-c')

    clientA = createApiClient({ token: userA.token })
    clientB = createApiClient({ token: userB.token })
    clientC = createApiClient({ token: userC.token })
  })

  afterAll(cleanup)

  // --- Group name uniqueness ---

  it('rejects duplicate group names (case-insensitive unique index)', async () => {
    const g1 = await createGroup('dup-exact')
    const g1Name = g1.name

    const dup = await adminClient.post('/api/groups', {
      name: g1Name,
    })
    expect(dup.status).toBe(500)
  })

  // --- Cross-group isolation ---

  it('user in multiple groups sees only the selected group instances', async () => {
    const groupAlpha = await createGroup('alpha-group', 5)
    const groupBeta = await createGroup('beta-group', 5)
    const groupGamma = await createGroup('gamma-group', 5)

    await addMemberToGroup(groupAlpha, userA)
    await addMemberToGroup(groupBeta, userA)
    await addMemberToGroup(groupBeta, userB)
    await addMemberToGroup(groupGamma, userB)

    const alphaInstance = await seedInstance({
      name: prefixedName('alpha-inst'),
      creatorUser: userA,
      groupId: groupAlpha.id,
    })
    const betaInstance = await seedInstance({
      name: prefixedName('beta-inst'),
      creatorUser: userB,
      groupId: groupBeta.id,
    })
    const gammaInstance = await seedInstance({
      name: prefixedName('gamma-inst'),
      creatorUser: userB,
      groupId: groupGamma.id,
    })

    const alphaListA = await expectOk(clientA.get(`/api/instances?page=1&pageSize=100&scope=group&groupId=${groupAlpha.id}`))
    expect(alphaListA.instances.map(i => i.id)).toEqual([alphaInstance.id])

    const betaListA = await expectOk(clientA.get(`/api/instances?page=1&pageSize=100&scope=group&groupId=${groupBeta.id}`))
    expect(betaListA.instances.map(i => i.id)).toEqual([betaInstance.id])

    const gammaListA = await expectOk(clientA.get(`/api/instances?page=1&pageSize=100&scope=group&groupId=${groupGamma.id}`))
    expect(gammaListA.instances).toHaveLength(0)

    const betaListB = await expectOk(clientB.get(`/api/instances?page=1&pageSize=100&scope=group&groupId=${groupBeta.id}`))
    expect(betaListB.instances.map(i => i.id)).toEqual([betaInstance.id])

    const gammaListB = await expectOk(clientB.get(`/api/instances?page=1&pageSize=100&scope=group&groupId=${groupGamma.id}`))
    expect(gammaListB.instances.map(i => i.id)).toEqual([gammaInstance.id])

    const alphaListB = await expectOk(clientB.get(`/api/instances?page=1&pageSize=100&scope=group&groupId=${groupAlpha.id}`))
    expect(alphaListB.instances).toHaveLength(0)

    const listC = await expectOk(clientC.get('/api/instances?page=1&pageSize=100&scope=group'))
    expect(listC.instances).toHaveLength(0)
  })

  // --- Group filter on user list endpoint ---

  it('groupId filter on instance list only returns instances from that specific group', async () => {
    const groupX = await createGroup('filter-x', 5)
    const groupY = await createGroup('filter-y', 5)

    await addMemberToGroup(groupX, userA)
    await addMemberToGroup(groupY, userA)

    const marker = prefixedName('gf-marker')
    const xInst = await seedInstance({
      name: `${marker}-x`,
      creatorUser: userA,
      groupId: groupX.id,
    })
    const yInst = await seedInstance({
      name: `${marker}-y`,
      creatorUser: userA,
      groupId: groupY.id,
    })

    const xList = await expectOk(clientA.get(`/api/instances?page=1&pageSize=100&groupId=${groupX.id}&search=${encodeURIComponent(marker)}`))
    expect(xList.instances.map(i => i.id)).toEqual([xInst.id])

    const yList = await expectOk(clientA.get(`/api/instances?page=1&pageSize=100&groupId=${groupY.id}&search=${encodeURIComponent(marker)}`))
    expect(yList.instances.map(i => i.id)).toEqual([yInst.id])
  })

  // --- Admin instance list with group filter ---

  it('admin endpoint supports groupId filter for group-scoped instance listing', async () => {
    const adminGroup = await createGroup('admin-filter-group', 5)
    await addMemberToGroup(adminGroup, userA)

    const marker = prefixedName('admin-gf')
    const shared = await seedInstance({
      name: `${marker}-shared`,
      creatorUser: userA,
      groupId: adminGroup.id,
    })
    const privateInst = await seedInstance({
      name: `${marker}-private`,
      creatorUser: userA,
    })

    const query = `search=${encodeURIComponent(marker)}&page=1&pageSize=100`

    const all = await expectOk(adminClient.get(`/api/admin/instances?${query}`))
    const allIds = new Set(all.instances.map(i => i.id))
    expect(allIds.has(shared.id)).toBe(true)
    expect(allIds.has(privateInst.id)).toBe(true)

    const grouped = await expectOk(adminClient.get(`/api/admin/instances?${query}&groupId=${adminGroup.id}`))
    expect(grouped.instances.map(i => i.id)).toEqual([shared.id])

    const scopeGroupWithoutGroupId = await expectOk(adminClient.get(`/api/admin/instances?${query}&scope=group`))
    expect(scopeGroupWithoutGroupId.instances).toHaveLength(0)
  })

  // --- Role change effects ---

  it('downgrading from admin to member revokes delete permission on group instances', async () => {
    const roleGroup = await createGroup('role-change-group', 5)
    await addMemberToGroup(roleGroup, userA, 'admin')
    await addMemberToGroup(roleGroup, userB)

    const instance = await seedInstance({
      name: prefixedName('role-change-inst'),
      creatorUser: userB,
      groupId: roleGroup.id,
    })

    const detailAsAdmin = await expectOk(clientA.get(`/api/instances/${instance.id}`))
    expect(detailAsAdmin.instance.actions.canDelete).toBe(true)

    await expectOk(adminClient.post(`/api/groups/${roleGroup.id}/members`, {
      email: userA.email,
      role: 'member',
    }))

    const detailAsMember = await expectOk(clientA.get(`/api/instances/${instance.id}`))
    expect(detailAsMember.instance.actions.canDelete).toBe(false)

    const deleteAttempt = await clientA.delete(`/api/instances/${instance.id}`)
    expect(deleteAttempt.status).toBe(403)
  })

  // --- Admin delete effects ---

  it('group admin has delete permission on group instances', async () => {
    const adminGroup = await createGroup('admin-delete-group', 5)
    await addMemberToGroup(adminGroup, userA, 'admin')
    await addMemberToGroup(adminGroup, userB)

    const instance = await seedInstance({
      name: prefixedName('admin-delete-inst'),
      creatorUser: userB,
      groupId: adminGroup.id,
    })

    const detail = await expectOk(clientA.get(`/api/instances/${instance.id}`))
    expect(detail.instance.actions.canDelete).toBe(true)
  })

  // --- Removed member private instances unaffected ---

  it('removing a member from group does not affect their private instances', async () => {
    const removalGroup = await createGroup('removal-group', 5)
    await addMemberToGroup(removalGroup, userA)

    const privateInst = await seedInstance({
      name: prefixedName('removal-private'),
      creatorUser: userA,
    })
    const sharedInst = await seedInstance({
      name: prefixedName('removal-shared'),
      creatorUser: userA,
      groupId: removalGroup.id,
    })

    await expectOk(adminClient.delete(`/api/groups/${removalGroup.id}/members/${userA.userId}`))

    const privateDetail = await expectOk(clientA.get(`/api/instances/${privateInst.id}`))
    expect(privateDetail.instance.id).toBe(privateInst.id)

    const sharedDetail = await clientA.get(`/api/instances/${sharedInst.id}`)
    expect(sharedDetail.status).toBe(404)
  })

  // --- Credential consistency ---

  it('group instances record group as principal_id', async () => {
    const credGroup = await createGroup('cred-consistency', 5)
    await addMemberToGroup(credGroup, userA)
    await addMemberToGroup(credGroup, userB)

    const inst1 = await seedInstance({
      name: prefixedName('cred-inst-1'),
      creatorUser: userA,
      groupId: credGroup.id,
    })
    const inst2 = await seedInstance({
      name: prefixedName('cred-inst-2'),
      creatorUser: userB,
      groupId: credGroup.id,
    })

    const { data: rows, error } = await testSupabaseAdmin
      .from('agent_instances')
      .select('id, principal_id')
      .in('id', [inst1.id, inst2.id])

    if (error) throw new Error(`[assert] instance lookup failed: ${error.message}`)
    expect(rows).toHaveLength(2)

    for (const row of rows) {
      expect(row.principal_id).toBe(credGroup.id)
    }

  })

  // --- Gateway credential resilience ---

  it('group remains usable when credential is missing (gateway rate-limit or provisioning failure)', async () => {
    const resGroup = await createGroup('resilience-group', 5)
    await addMemberToGroup(resGroup, userA)

    const detail = await expectOk(clientA.get(`/api/groups/${resGroup.id}`))
    expect(detail.group.id).toBe(resGroup.id)
    expect(detail.group.apiKey).toHaveProperty('status')
    expect(['ready', 'missing']).toContain(detail.group.apiKey.status)

    const instances = await expectOk(clientA.get(`/api/instances?page=1&pageSize=10&groupId=${resGroup.id}`))
    expect(instances).toHaveProperty('instances')
  })

  // --- Simulated credential corruption / rate-limit state ---

  it('corrupted or missing consumer credential does not affect group CRUD operations', async () => {
    const gatewayGroup = await createGroup('gateway-sim', 5)
    await addMemberToGroup(gatewayGroup, userA)

    const { error: resetError } = await testSupabaseAdmin
      .from('principal_profiles')
      .update({
        consumer_id: null,
        consumer_apikey_encrypted: null,
        authorized_http_api_id: null,
      })
      .eq('id', gatewayGroup.id)
    if (resetError) throw new Error(`[setup] reset credential failed: ${resetError.message}`)

    const updated = await expectOk(adminClient.put(`/api/groups/${gatewayGroup.id}`, {
      name: prefixedName('gateway-sim-renamed'),
    }))
    expect(updated.group.apiKey.status).toBe('missing')

    await addMemberToGroup(gatewayGroup, userB)
    const members = await expectOk(adminClient.get(`/api/groups/${gatewayGroup.id}/members`))
    const memberIds = members.members.map(m => m.principalId)
    expect(memberIds).toContain(userB.userId)

    const groups = await expectOk(clientA.get('/api/groups'))
    const found = groups.groups.find(g => g.id === gatewayGroup.id)
    expect(found).toBeTruthy()
    expect(found.apiKey.status).toBe('missing')
  })

  // --- Overview counts accuracy ---

  it('user overview correctly reports private, group, and manageable group counts', async () => {
    const overviewGroup = await createGroup('overview-group', 5)
    await addMemberToGroup(overviewGroup, userC, 'admin')

    await seedInstance({
      name: prefixedName('overview-private'),
      creatorUser: userC,
    })
    await seedInstance({
      name: prefixedName('overview-shared'),
      creatorUser: userC,
      groupId: overviewGroup.id,
    })

    const overview = await expectOk(clientC.get('/api/instances/overview'))
    expect(overview.overview.privateInstances).toBeGreaterThanOrEqual(1)
    expect(overview.overview.groupInstances).toBeGreaterThanOrEqual(1)
    expect(overview.overview.groupCount).toBeGreaterThanOrEqual(1)

    const groupOverview = await expectOk(clientC.get(`/api/instances/overview?scope=group&groupId=${overviewGroup.id}`))
    expect(groupOverview.overview.privateInstances).toBe(0)
    expect(groupOverview.overview.groupInstances).toBe(1)
  })

  // --- Credential provider type mismatch detection ---

  it('stale credential from an unknown provider type does not expose the raw prefix', async () => {
    const mismatchGroup = await createGroup('provider-mismatch', 5)

    const { error } = await testSupabaseAdmin
      .from('principal_profiles')
      .update({
        consumer_id: 'fake-consumer-001',
        consumer_apikey_encrypted: 'FakeProvider:ZmFrZWtleQ==',
      })
      .eq('id', mismatchGroup.id)
    if (error) throw new Error(`[setup] write fake credential failed: ${error.message}`)

    const detail = await expectOk(adminClient.get(`/api/groups/${mismatchGroup.id}`))
    expect(detail.group.apiKey.status).toBe('ready')
    expect(detail.group.apiKey.provider).toBeNull()

    const { data: profile } = await testSupabaseAdmin
      .from('principal_profiles')
      .select('consumer_apikey_encrypted')
      .eq('id', mismatchGroup.id)
      .single()

    expect(profile.consumer_apikey_encrypted).toContain('FakeProvider:')
  })

  // --- Member add edge cases ---

  it('adding a non-existent email returns 404', async () => {
    const searchGroup = await createGroup('member-search-edge', 5)

    const notFound = await adminClient.post(`/api/groups/${searchGroup.id}/members`, {
      email: 'does-not-exist-ever@nowhere.test',
      role: 'member',
    })
    expect(notFound.status).toBe(404)
  })

  // --- Immutable group ownership on instances ---

  it('cannot move instance between groups or remove from group via update', async () => {
    const sourceGroup = await createGroup('move-source', 5)
    const destGroup = await createGroup('move-dest', 5)
    await addMemberToGroup(sourceGroup, userA)

    const instance = await seedInstance({
      name: prefixedName('move-test'),
      creatorUser: userA,
      groupId: sourceGroup.id,
    })

    const moveRes = await clientA.put(`/api/instances/${instance.id}`, {
      groupId: destGroup.id,
    })
    expect(moveRes.status).toBe(400)
    expect(moveRes.body?.error).toBe('INSTANCE_GROUP_MOVE_NOT_SUPPORTED')

    const removeRes = await clientA.put(`/api/instances/${instance.id}`, {
      groupId: null,
    })
    expect(removeRes.status).toBe(400)
  })
})
