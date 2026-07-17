export class AccessError extends Error {
  constructor(message, status = 403) {
    super(message)
    this.name = 'AccessError'
    this.status = status
  }
}

// 延迟加载 config，避免只导入纯权限 helper 的单测在 import 阶段强制读取运行时 .env。
async function getSupabaseAdmin() {
  const config = await import('../config/index.js')
  return config.supabaseAdmin
}

export function isPlatformAdminProfile(userProfile) {
  return userProfile?.principal_type === 'user'
    && userProfile?.role === 'admin'
    && userProfile?.status === 'active'
}

function getInstancePrincipalId(instance) {
  return instance?.principal_id || null
}

function isActiveMembership(membership, groupId, principalId) {
  return membership?.group_id === groupId
    && membership?.principal_id === principalId
    && membership?.status === 'active'
}

function hasGroupRole(membership, groupId, principalId, allowedRoles) {
  return isActiveMembership(membership, groupId, principalId)
    && allowedRoles.includes(membership.role)
}

export function canAccessInstanceRecord(instance, principalId, memberships = [], userProfile = null) {
  if (!instance || !principalId) return false
  if (isPlatformAdminProfile(userProfile)) return true
  const instancePrincipalId = getInstancePrincipalId(instance)
  return instancePrincipalId === principalId
    || memberships.some(membership => isActiveMembership(membership, instancePrincipalId, principalId))
}

export function canDeleteInstanceRecord(instance, principalId, memberships = [], userProfile = null) {
  if (!instance || !principalId) return false
  if (isPlatformAdminProfile(userProfile)) return true
  const instancePrincipalId = getInstancePrincipalId(instance)
  return instancePrincipalId === principalId
    || memberships.some(membership =>
      hasGroupRole(membership, instancePrincipalId, principalId, ['admin'])
    )
}

export function canUpdateInstanceRecord(instance, principalId, memberships = [], userProfile = null) {
  return canAccessInstanceRecord(instance, principalId, memberships, userProfile)
}

export function getInstanceQuotaPrincipalId({ userId, groupId }) {
  return groupId || userId
}

export function resolveRestoreTargetPrincipal({
  actorPrincipalId,
  sourceInstance,
  sourcePrincipalProfile
}) {
  const sourcePrincipalId = sourceInstance?.principal_id || null
  if (!sourcePrincipalId) {
    return { userId: actorPrincipalId, groupId: null }
  }
  if (sourcePrincipalProfile?.principal_type === 'group') {
    return { userId: actorPrincipalId, groupId: sourcePrincipalId }
  }
  return { userId: sourcePrincipalId, groupId: null }
}

export async function getActiveGroupMemberships(principalId) {
  if (!principalId) return []
  const supabaseAdmin = await getSupabaseAdmin()
  const { data, error } = await supabaseAdmin
    .from('agent_group_members')
    .select('group_id, principal_id, role, status')
    .eq('principal_id', principalId)
    .eq('status', 'active')

  if (error) {
    throw new AccessError(`Failed to load group memberships: ${error.message}`, 500)
  }
  return data || []
}

export async function assertGroupMembership({
  principalId,
  userProfile,
  groupId,
  allowedRoles = ['admin', 'member']
}) {
  if (!groupId) throw new AccessError('groupId is required', 400)
  if (isPlatformAdminProfile(userProfile)) return { role: 'admin' }

  const supabaseAdmin = await getSupabaseAdmin()
  const { data, error } = await supabaseAdmin
    .from('agent_group_members')
    .select('group_id, principal_id, role, status')
    .eq('group_id', groupId)
    .eq('principal_id', principalId)
    .eq('status', 'active')
    .maybeSingle()

  if (error) throw new AccessError(`Failed to check group membership: ${error.message}`, 500)
  if (!data || !allowedRoles.includes(data.role)) {
    throw new AccessError('Group access denied', 403)
  }
  return data
}

export async function assertInstanceAccess({
  principalId,
  userProfile,
  instanceId,
  action = 'read'
}) {
  const supabaseAdmin = await getSupabaseAdmin()
  const { data: instance, error } = await supabaseAdmin
    .from('agent_instances')
    .select('*')
    .eq('id', instanceId)
    .maybeSingle()

  if (error) throw new AccessError(`Failed to load instance: ${error.message}`, 500)
  if (!instance) throw new AccessError('Instance not found', 404)

  const memberships = await getActiveGroupMemberships(principalId)
  const allowed = action === 'delete'
    ? canDeleteInstanceRecord(instance, principalId, memberships, userProfile)
    : canAccessInstanceRecord(instance, principalId, memberships, userProfile)

  if (!allowed) {
    throw new AccessError(action === 'delete' ? 'Instance delete denied' : 'Instance not found', action === 'delete' ? 403 : 404)
  }

  return { instance, memberships }
}
