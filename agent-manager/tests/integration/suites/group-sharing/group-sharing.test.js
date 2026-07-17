/**
 * group-sharing: principal-based group access
 *
 * Most cases avoid E2B by seeding stopped agent_instances through the
 * service-role client; the final credential case uses the real create flow.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createApiClient, expectOk } from '../../helpers/api-client.js'
import { createEphemeralUserViaApi, getAdminToken } from '../../helpers/auth.js'
import { prefixedName } from '../../helpers/factory.js'
import { testSupabaseAdmin } from '../../helpers/supabase.js'
import { testEnv } from '../../setup/test-env.js'
import { discoverLifecycleContext } from '../instance-lifecycle/_shared.js'

describe('group-sharing: access boundaries', () => {
  const createdGroupIds = []
  const createdInstanceIds = []
  const users = []

  let adminClient
  let creator
  let member
  let groupAdmin
  let outsider
  let removedUser
  let creatorClient
  let memberClient
  let groupAdminClient
  let outsiderClient
  let removedClient
  let group

  async function createUser(tag) {
    const user = await createEphemeralUserViaApi(adminClient, { role: 'user', tag })
    users.push(user)
    return user
  }

  async function addMember(user, role = 'member') {
    const currentGroup = requireGroup()
    return addMemberToGroup(currentGroup, user, role)
  }

  async function addMemberToGroup(targetGroup, user, role = 'member') {
    return expectOk(adminClient.post(`/api/groups/${targetGroup.id}/members`, {
      email: user.email,
      role,
    }))
  }

  async function createGroup(tag) {
    const created = await expectOk(adminClient.post('/api/groups', {
      name: prefixedName(tag),
    }))
    createdGroupIds.push(created.group.id)
    return created.group
  }

  function requireGroup() {
    if (!group?.id) {
      throw new Error('[setup] group was not created; verify TEST_BASE_URL is deployed with /api/groups')
    }
    return group
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

  async function removeAllActiveMembers(targetGroup) {
    const { data: memberships, error } = await testSupabaseAdmin
      .from('agent_group_members')
      .select('principal_id')
      .eq('group_id', targetGroup.id)
      .eq('status', 'active')

    if (error) throw new Error(`[setup] list active group members failed: ${error.message}`)

    for (const membership of memberships || []) {
      await expectOk(adminClient.delete(`/api/groups/${targetGroup.id}/members/${membership.principal_id}`))
    }
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

    creator = await createUser('group-creator')
    member = await createUser('group-member')
    groupAdmin = await createUser('group-admin')
    outsider = await createUser('group-outsider')
    removedUser = await createUser('group-removed')

    creatorClient = createApiClient({ token: creator.token })
    memberClient = createApiClient({ token: member.token })
    groupAdminClient = createApiClient({ token: groupAdmin.token })
    outsiderClient = createApiClient({ token: outsider.token })
    removedClient = createApiClient({ token: removedUser.token })
  })

  afterAll(cleanup)

  it('only platform admin can create groups and unknown filters are rejected', async () => {
    const denied = await memberClient.post('/api/groups', {
      name: prefixedName('deny-group'),
    })
    expect(denied.status, 'non-admin POST /api/groups should be forbidden, not missing').toBe(403)

    group = await createGroup('shared-group')

    expect(group).toMatchObject({
      role: 'admin',
      quota: { used: 0 },
    })
    expect(group.apiKey).toHaveProperty('status')

    const badFilter = await adminClient.get(
      `/api/groups?filter=${encodeURIComponent(JSON.stringify([{ name: 'bogus', value: ['x'] }]))}`,
    )
    expect(badFilter.status).toBe(400)
  })

  it('active members can see their group, outsiders and removed members cannot', async () => {
    const currentGroup = requireGroup()
    await addMember(creator)
    await addMember(member)
    await addMember(groupAdmin, 'admin')
    await addMember(removedUser)

    const removed = await expectOk(adminClient.delete(`/api/groups/${currentGroup.id}/members/${removedUser.userId}`))
    expect(removed.member).toMatchObject({
      principalId: removedUser.userId,
      status: 'removed',
    })

    const memberGroups = await expectOk(memberClient.get('/api/groups'))
    expect(memberGroups.groups.some((item) => item.id === currentGroup.id)).toBe(true)

    const memberDetail = await expectOk(memberClient.get(`/api/groups/${currentGroup.id}`))
    expect(memberDetail.group.id).toBe(currentGroup.id)

    const outsiderDetail = await outsiderClient.get(`/api/groups/${currentGroup.id}`)
    expect(outsiderDetail.status).toBe(403)

    const removedDetail = await removedClient.get(`/api/groups/${currentGroup.id}`)
    expect(removedDetail.status).toBe(403)
  })

  it('rejects the removed owner role', async () => {
    const currentGroup = requireGroup()
    const rejected = await adminClient.post(`/api/groups/${currentGroup.id}/members`, {
      email: groupAdmin.email,
      role: 'owner',
    })
    expect(rejected.status).toBe(400)
  })

  it('group instances are visible to active group members but private instances are not', async () => {
    const currentGroup = requireGroup()
    const shared = await seedInstance({
      name: prefixedName('shared-instance'),
      creatorUser: creator,
      groupId: currentGroup.id,
    })
    const privateInstance = await seedInstance({
      name: prefixedName('private-instance'),
      creatorUser: creator,
    })

    const memberList = await expectOk(memberClient.get(`/api/instances?page=1&pageSize=100&scope=group&groupId=${currentGroup.id}`))
    const memberIds = new Set(memberList.instances.map((instance) => instance.id))
    expect(memberIds.has(shared.id)).toBe(true)
    expect(memberIds.has(privateInstance.id)).toBe(false)

    const memberDetail = await expectOk(memberClient.get(`/api/instances/${shared.id}`))
    expect(memberDetail.instance.group).toMatchObject({ id: currentGroup.id, name: currentGroup.name })
    expect(memberDetail.instance.actions.canDelete).toBe(false)

    const removedDetail = await removedClient.get(`/api/instances/${shared.id}`)
    expect(removedDetail.status).toBe(404)

    const outsiderDetail = await outsiderClient.get(`/api/instances/${shared.id}`)
    expect(outsiderDetail.status).toBe(404)

    const creatorPrivateDetail = await expectOk(creatorClient.get(`/api/instances/${privateInstance.id}`))
    expect(creatorPrivateDetail.instance.id).toBe(privateInstance.id)
  })

  it('instance list supports ownership and group filters for the design list view', async () => {
    const currentGroup = requireGroup()
    const marker = prefixedName('list-filter')
    const shared = await seedInstance({
      name: `${marker}-shared`,
      creatorUser: creator,
      groupId: currentGroup.id,
    })
    const privateInstance = await seedInstance({
      name: `${marker}-private`,
      creatorUser: member,
    })
    const query = `search=${encodeURIComponent(marker)}&page=1&pageSize=100`

    const defaultList = await expectOk(memberClient.get(`/api/instances?${query}`))
    expect(defaultList.instances.map((instance) => instance.id)).toEqual([privateInstance.id])

    const privateList = await expectOk(memberClient.get(`/api/instances?${query}&scope=private`))
    expect(privateList.instances.map((instance) => instance.id)).toEqual([privateInstance.id])

    const groupList = await expectOk(memberClient.get(`/api/instances?${query}&scope=group&groupId=${currentGroup.id}`))
    expect(groupList.instances.map((instance) => instance.id)).toEqual([shared.id])
    expect(groupList.instances[0].group).toMatchObject({ id: currentGroup.id, name: currentGroup.name })
    expect(groupList.instances[0].principal).toMatchObject({ principalId: currentGroup.id })

    const outsiderGroupList = await expectOk(outsiderClient.get(`/api/instances?${query}&scope=group&groupId=${currentGroup.id}`))
    expect(outsiderGroupList.instances).toHaveLength(0)

    const badGroupFilter = await memberClient.get(`/api/instances?${query}&groupId=not-a-uuid`)
    expect(badGroupFilter.status).toBe(400)

    const overview = await expectOk(memberClient.get('/api/instances/overview'))
    expect(typeof overview.overview.privateInstances).toBe('number')
    expect(typeof overview.overview.groupInstances).toBe('number')
    expect(typeof overview.overview.groupCount).toBe('number')
  })

  it('plain members cannot delete shared instances, but group admins can', async () => {
    const currentGroup = requireGroup()
    const memberDenied = await seedInstance({
      name: prefixedName('member-delete-denied'),
      creatorUser: creator,
      groupId: currentGroup.id,
    })
    const adminAllowed = await seedInstance({
      name: prefixedName('admin-delete-allowed'),
      creatorUser: creator,
      groupId: currentGroup.id,
    })

    const denied = await memberClient.delete(`/api/instances/${memberDenied.id}`)
    expect(denied.status).toBe(403)

    const allowed = await expectOk(groupAdminClient.delete(`/api/instances/${adminAllowed.id}`))
    expect(allowed.instanceId).toBe(adminAllowed.id)

    const { data: deletedRow, error } = await testSupabaseAdmin
      .from('agent_instances')
      .select('id')
      .eq('id', adminAllowed.id)
      .maybeSingle()
    if (error) throw new Error(`[assert] deleted instance lookup failed: ${error.message}`)
    expect(deletedRow).toBeNull()
  })

  it('instance group migration is rejected after creation', async () => {
    const currentGroup = requireGroup()
    const shared = await seedInstance({
      name: prefixedName('migration-rejected'),
      creatorUser: creator,
      groupId: currentGroup.id,
    })

    const res = await creatorClient.put(`/api/instances/${shared.id}`, { groupId: null })
    expect(res.status).toBe(400)
    expect(res.body?.error).toBe('INSTANCE_GROUP_MOVE_NOT_SUPPORTED')
  })

  it('group-scoped instance creation rejects invalid, unknown, and inaccessible groups before provisioning', async () => {
    const currentGroup = requireGroup()

    const invalidGroupId = await memberClient.post('/api/instances', {
      name: prefixedName('invalid-group-id'),
      groupId: 'not-a-uuid',
    })
    expect(invalidGroupId.status).toBe(400)

    const unknownGroup = await memberClient.post('/api/instances', {
      name: prefixedName('unknown-group'),
      groupId: randomUUID(),
    })
    expect(unknownGroup.status).toBe(404)

    const inaccessibleGroup = await outsiderClient.post('/api/instances', {
      name: prefixedName('outsider-group-create'),
      groupId: currentGroup.id,
    })
    expect(inaccessibleGroup.status).toBe(403)
    expect(inaccessibleGroup.body?.error).toBe('Group access denied')
  })

  it('group deletion reports blocking preconditions in order', async () => {
    const currentGroup = await createGroup('delete-blocking-group', 2)
    await addMemberToGroup(currentGroup, member)

    const hasInstance = await seedInstance({
      name: prefixedName('delete-blocking-instance'),
      creatorUser: creator,
      groupId: currentGroup.id,
    })

    const blockedByInstance = await adminClient.delete(`/api/groups/${currentGroup.id}`)
    expect(blockedByInstance.status).toBe(409)
    expect(blockedByInstance.body?.error).toBe('GROUP_HAS_INSTANCES')

    await testSupabaseAdmin.from('agent_instances').delete().eq('id', hasInstance.id)

    const blockedByMembers = await adminClient.delete(`/api/groups/${currentGroup.id}`)
    expect(blockedByMembers.status).toBe(409)
    expect(blockedByMembers.body?.error).toBe('GROUP_HAS_ACTIVE_MEMBERS')

    await removeAllActiveMembers(currentGroup)

    const afterMemberRemoval = await adminClient.delete(`/api/groups/${currentGroup.id}`)
    expect(afterMemberRemoval.status).toBe(200)
  })

  it('normal group instance creation ensures credential on the group principal', async () => {
    if (testEnv.skipE2b) {
      console.warn('[group-sharing] TEST_SKIP_E2B=true，跳过 group credential provisioning 覆盖')
      return
    }

    const ctx = await discoverLifecycleContext(adminClient)
    if (!ctx.builtinAgentType || !ctx.primaryModel) {
      console.warn('[group-sharing] 缺少 enabled agent type 或 model，跳过 group credential provisioning 覆盖')
      return
    }

    const credentialGroup = await createGroup('credential-flow-group', 2)
    await addMemberToGroup(credentialGroup, member)

    const { error: resetError } = await testSupabaseAdmin
      .from('principal_profiles')
      .update({
        consumer_id: null,
        consumer_apikey_encrypted: null,
        authorized_http_api_id: null,
      })
      .eq('id', credentialGroup.id)
    if (resetError) throw new Error(`[setup] reset group credential failed: ${resetError.message}`)

    const providersBody = await expectOk(adminClient.get('/api/providers'))
    const provider = (providersBody.providers || []).find((item) => item.code === ctx.primaryModel.provider)

    const created = await memberClient.post(
      '/api/instances',
      {
        name: prefixedName('group-credential-instance'),
        agentTypeId: ctx.builtinAgentType.id,
        modelId: ctx.primaryModel.id,
        groupId: credentialGroup.id,
        async: true,
      },
      undefined,
      { timeoutMs: Math.max(testEnv.instanceReadyTimeoutMs, 120_000) },
    )
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    const instanceId = created.body.instance.id
    createdInstanceIds.push(instanceId)

    const { data: row, error: rowError } = await testSupabaseAdmin
      .from('agent_instances')
      .select('id, principal_id')
      .eq('id', instanceId)
      .single()
    if (rowError) throw new Error(`[assert] group instance lookup failed: ${rowError.message}`)
    expect(row.principal_id).toBe(credentialGroup.id)

    const { data: profile, error: profileError } = await testSupabaseAdmin
      .from('principal_profiles')
      .select('consumer_apikey_encrypted')
      .eq('id', credentialGroup.id)
      .single()
    if (profileError) throw new Error(`[assert] group credential lookup failed: ${profileError.message}`)

    if (['AlibabaCloudAIGateway', 'LiteLLM'].includes(provider?.type)) {
      expect(profile.consumer_apikey_encrypted).toContain(`${ctx.primaryModel.provider}:`)
    } else {
      console.warn(`[group-sharing] provider ${ctx.primaryModel.provider} 不支持 consumer 管理，跳过 credential 字段断言`)
    }

    const deleted = await adminClient.delete(`/api/instances/${instanceId}`)
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200)
  }, 300_000)
})
