import { describe, expect, it } from 'vitest'
import {
  canAccessInstanceRecord,
  canDeleteInstanceRecord,
  getInstanceQuotaPrincipalId,
  isPlatformAdminProfile,
  resolveRestoreTargetPrincipal
} from '../../server/services/principal-access.js'

describe('principal group sharing access helpers', () => {
  it('recognizes platform admins from user principal profiles', () => {
    expect(isPlatformAdminProfile({ principal_type: 'user', role: 'admin', status: 'active' })).toBe(true)
    expect(isPlatformAdminProfile({ principal_type: 'user', role: 'admin', status: 'disabled' })).toBe(false)
    expect(isPlatformAdminProfile({ principal_type: 'group', role: 'admin', status: 'active' })).toBe(false)
    expect(isPlatformAdminProfile({ role: 'admin', status: 'active' })).toBe(false)
  })

  it('requires group membership to access a group instance', () => {
    const shared = { principal_id: 'group-1' }
    const creatorMemberships = [{ group_id: 'group-1', principal_id: 'creator-1', role: 'member', status: 'active' }]
    const activeMemberships = [{ group_id: 'group-1', principal_id: 'member-1', role: 'member', status: 'active' }]
    const removedMemberships = [{ group_id: 'group-1', principal_id: 'member-1', role: 'member', status: 'removed' }]

    expect(canAccessInstanceRecord(shared, 'creator-1', creatorMemberships, { role: 'user', status: 'active' })).toBe(true)
    expect(canAccessInstanceRecord(shared, 'creator-1', [], { role: 'user', status: 'active' })).toBe(false)
    expect(canAccessInstanceRecord(shared, 'member-1', activeMemberships, { role: 'user', status: 'active' })).toBe(true)
    expect(canAccessInstanceRecord(shared, 'member-1', removedMemberships, { role: 'user', status: 'active' })).toBe(false)
    expect(canAccessInstanceRecord(shared, 'outsider-1', activeMemberships, { role: 'user', status: 'active' })).toBe(false)
    expect(canAccessInstanceRecord(shared, 'admin-1', [], { principal_type: 'user', role: 'admin', status: 'active' })).toBe(true)
  })

  it('limits group instance deletion to group admin or platform admin', () => {
    const shared = { principal_id: 'group-1' }
    const creatorMemberships = [{ group_id: 'group-1', principal_id: 'creator-1', role: 'member', status: 'active' }]
    const member = [{ group_id: 'group-1', principal_id: 'member-1', role: 'member', status: 'active' }]
    const legacyOwner = [{ group_id: 'group-1', principal_id: 'owner-1', role: 'owner', status: 'active' }]
    const groupAdmin = [{ group_id: 'group-1', principal_id: 'admin-2', role: 'admin', status: 'active' }]

    expect(canDeleteInstanceRecord(shared, 'creator-1', creatorMemberships, { role: 'user', status: 'active' })).toBe(false)
    expect(canDeleteInstanceRecord(shared, 'creator-1', [], { role: 'user', status: 'active' })).toBe(false)
    expect(canDeleteInstanceRecord(shared, 'member-1', member, { role: 'user', status: 'active' })).toBe(false)
    expect(canDeleteInstanceRecord(shared, 'owner-1', legacyOwner, { role: 'user', status: 'active' })).toBe(false)
    expect(canDeleteInstanceRecord(shared, 'admin-2', groupAdmin, { role: 'user', status: 'active' })).toBe(true)
    expect(canDeleteInstanceRecord(shared, 'admin-1', [], { principal_type: 'user', role: 'admin', status: 'active' })).toBe(true)
  })

  it('scopes instance quota to the group when creating in a group', () => {
    expect(getInstanceQuotaPrincipalId({ userId: 'user-1', groupId: 'group-1' })).toBe('group-1')
  })

  it('restores personal instances back to the source owner even when an admin starts the restore', () => {
    expect(resolveRestoreTargetPrincipal({
      actorPrincipalId: 'admin-1',
      sourceInstance: { principal_id: 'source-user-1' },
      sourcePrincipalProfile: { id: 'source-user-1', principal_type: 'user' }
    })).toEqual({
      userId: 'source-user-1',
      groupId: null
    })
  })

  it('restores group instances back to the source group while keeping the actor as creator', () => {
    expect(resolveRestoreTargetPrincipal({
      actorPrincipalId: 'member-1',
      sourceInstance: { principal_id: 'group-1' },
      sourcePrincipalProfile: { id: 'group-1', principal_type: 'group' }
    })).toEqual({
      userId: 'member-1',
      groupId: 'group-1'
    })
  })
})
