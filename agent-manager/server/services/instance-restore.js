import {
  canAccessInstanceRecord,
  getActiveGroupMemberships,
  isPlatformAdminProfile,
  resolveRestoreTargetPrincipal
} from './principal-access.js'
import {
  CheckpointBackupError,
  getSandboxTargetFromInstance,
  listInstanceCheckpointBackups
} from './checkpoint-backups/index.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BACKUP_SOURCE_PREFIX_PATTERN = /^ocb-([0-9a-f]{8})(?:-|$)/i
const RESTORE_SOURCE_LOOKUP_CONCURRENCY = 8

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function getSourceInstanceIdPrefixFromBackupId(backupId) {
  const match = BACKUP_SOURCE_PREFIX_PATTERN.exec(String(backupId || ''))
  return match?.[1]?.toLowerCase() || null
}

async function getSupabaseAdminClient(explicitClient = null) {
  if (explicitClient) return explicitClient
  // Lazy-load config so helper unit tests can inject a client without requiring a local .env.
  const config = await import('../config/index.js')
  return config.supabaseAdmin
}

async function findRestoreSourceMatches(candidates, {
  principalId,
  memberships,
  userProfile,
  backupId,
  listBackups,
  concurrency = RESTORE_SOURCE_LOOKUP_CONCURRENCY
}) {
  const accessibleCandidates = (candidates || [])
    .filter(candidate => canAccessInstanceRecord(candidate, principalId, memberships, userProfile))
  const matches = []
  let nextIndex = 0
  let fatalError = null

  async function worker() {
    while (!fatalError && nextIndex < accessibleCandidates.length) {
      const candidate = accessibleCandidates[nextIndex]
      nextIndex += 1
      try {
        const items = await listBackups(candidate, { limit: 100 })
        if (items.some(item => item.backupId === backupId)) {
          matches.push(candidate)
        }
      } catch (error) {
        if (error instanceof CheckpointBackupError && ['K8S_UNAVAILABLE', 'BACKUP_NOT_FOUND'].includes(error.code)) {
          continue
        }
        fatalError = error
      }
    }
  }

  const workerCount = Math.min(
    Math.max(1, Number(concurrency) || RESTORE_SOURCE_LOOKUP_CONCURRENCY),
    accessibleCandidates.length
  )
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  if (fatalError) throw fatalError
  return matches
}

export async function loadRestoreSourcePrincipalProfile(sourceInstance, {
  supabaseClient = null
} = {}) {
  const principalId = sourceInstance?.principal_id
  if (!principalId) {
    throw new CheckpointBackupError('Restore source instance has no principal', 409, 'RESTORE_SOURCE_PRINCIPAL_NOT_FOUND')
  }
  const supabaseAdmin = await getSupabaseAdminClient(supabaseClient)
  const { data, error } = await supabaseAdmin
    .from('principal_profiles')
    .select('id, principal_type, name, email')
    .eq('id', principalId)
    .maybeSingle()
  if (error) {
    throw new CheckpointBackupError(`Failed to load restore source principal: ${error.message}`, 500, 'RESTORE_SOURCE_PRINCIPAL_LOOKUP_FAILED')
  }
  if (!data) {
    throw new CheckpointBackupError(`Restore source principal ${principalId} not found`, 409, 'RESTORE_SOURCE_PRINCIPAL_NOT_FOUND')
  }
  return data
}

export async function resolveRestoreSourceForCreate({
  principalId,
  userProfile,
  backupId,
  supabaseClient = null,
  loadMemberships = getActiveGroupMemberships,
  listBackups = listInstanceCheckpointBackups
}) {
  const memberships = await loadMemberships(principalId)
  const groupIds = memberships.map(membership => membership.group_id).filter(isUuid)
  const supabaseAdmin = await getSupabaseAdminClient(supabaseClient)
  let query = supabaseAdmin
    .from('agent_instances')
    .select('*')
    .not('sandbox_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1000)

  if (!isPlatformAdminProfile(userProfile)) {
    query = query.in('principal_id', [principalId, ...groupIds])
  }
  const { data: candidates, error } = await query
  if (error) {
    throw new CheckpointBackupError(`Failed to resolve backup source: ${error.message}`, 500, 'BACKUP_SOURCE_LOOKUP_FAILED')
  }

  const sourceIdPrefix = getSourceInstanceIdPrefixFromBackupId(backupId)
  const filteredCandidates = sourceIdPrefix
    ? (candidates || []).filter(candidate => String(candidate?.id || '').toLowerCase().startsWith(sourceIdPrefix))
    : (candidates || [])
  const matches = await findRestoreSourceMatches(filteredCandidates, {
    principalId,
    memberships,
    userProfile,
    backupId,
    listBackups
  })

  if (matches.length === 0) {
    throw new CheckpointBackupError(`Backup ${backupId} not found`, 404, 'BACKUP_NOT_FOUND')
  }
  if (matches.length > 1) {
    throw new CheckpointBackupError(`Backup ${backupId} matched multiple source instances`, 409, 'BACKUP_CONFLICT')
  }

  return {
    sourceInstance: matches[0],
    memberships
  }
}

export async function resolveRestoreTargetForSourceInstance({
  actorPrincipalId,
  sourceInstance,
  supabaseClient = null
}) {
  const sourcePrincipalProfile = await loadRestoreSourcePrincipalProfile(sourceInstance, {
    supabaseClient
  })
  return resolveRestoreTargetPrincipal({
    actorPrincipalId,
    sourceInstance,
    sourcePrincipalProfile
  })
}

export async function resolveCreateInstanceFromBackupOptions({
  actorPrincipalId,
  actorProfile,
  backupId,
  requestedAgentTypeId = null,
  requestedModelId = null,
  hasConfigJson = false,
  configJson = {},
  supabaseClient = null,
  loadMemberships,
  listBackups
}) {
  const normalizedBackupId = String(backupId || '')
  const { sourceInstance } = await resolveRestoreSourceForCreate({
    principalId: actorPrincipalId,
    userProfile: actorProfile,
    backupId: normalizedBackupId,
    supabaseClient,
    loadMemberships,
    listBackups
  })
  const restoreTargetPrincipal = await resolveRestoreTargetForSourceInstance({
    actorPrincipalId,
    sourceInstance,
    supabaseClient
  })

  return {
    restoreFromBackup: {
      backupId: normalizedBackupId,
      sourceInstance,
      namespace: getSandboxTargetFromInstance(sourceInstance).namespace
    },
    effectiveUserId: restoreTargetPrincipal.userId,
    effectiveGroupId: restoreTargetPrincipal.groupId,
    effectiveAgentTypeId: requestedAgentTypeId || sourceInstance?.agent_type_id || null,
    effectiveModelId: requestedModelId || sourceInstance?.model_id || null,
    effectiveConfigJson: hasConfigJson ? configJson : (sourceInstance?.config_json || {})
  }
}
