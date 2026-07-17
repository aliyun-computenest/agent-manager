/**
 * Shared helpers for agent group routes (groups.js, groups-limit.js)
 */

import { supabaseAdmin } from '../config/index.js'
import {
  AccessError,
  assertGroupMembership,
  isPlatformAdminProfile
} from '../services/principal-access.js'
import { ensurePrincipalConsumer } from '../services/instance-provisioner.js'
import { getConsumerKeyProvider } from '../utils/crypto.js'
import { appLogger } from '../utils/logger.js'

export function sendGroupError(res, error) {
  if (error instanceof AccessError) {
    return res.status(error.status).json({
      success: false,
      error: error.code || error.message,
      message: error.message
    })
  }
  appLogger.error({ err: error }, 'Group route error')
  return res.status(500).json({
    success: false,
    error: 'INTERNAL_ERROR',
    message: error.message || 'Internal server error'
  })
}

/**
 * Strip PostgREST operator characters from search input to prevent injection
 * via the .or() / .filter() string DSL. We keep alphanumerics, common email
 * characters, whitespace and CJK characters so legitimate searches still work.
 */
export function sanitizePostgrestSearch(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/[,()*]/g, '').trim()
}

export function parseFilters(rawFilter, allowedNames) {
  if (!rawFilter) return {}

  let filters = rawFilter
  if (typeof rawFilter === 'string') {
    try {
      filters = JSON.parse(rawFilter)
    } catch (_error) {
      throw new AccessError('Invalid filter', 400)
    }
  }
  if (!Array.isArray(filters)) {
    throw new AccessError('Invalid filter', 400)
  }

  const parsed = {}
  for (const filter of filters) {
    if (!filter?.name || !allowedNames.includes(filter.name)) {
      throw new AccessError('Unknown filter', 400)
    }
    parsed[filter.name] = Array.isArray(filter.value)
      ? filter.value
      : [filter.value].filter(value => value !== undefined && value !== null)
  }
  return parsed
}

export function buildPrincipalSummary(profile) {
  if (!profile) return null
  const principalId = profile.principal_id || profile.id
  return {
    principalId,
    username: profile.username || null,
    email: profile.email || null
  }
}

function getConsumerProviderFromKey(storedValue) {
  return getConsumerKeyProvider(storedValue)
}

export async function loadPrincipalProfiles(principalIds) {
  const ids = [...new Set((principalIds || []).filter(Boolean))]
  if (ids.length === 0) return new Map()

  const { data, error } = await supabaseAdmin
    .from('principal_profiles')
    .select('principal_id:id, username:name, email')
    .in('id', ids)

  if (error) throw new AccessError(`Failed to load principals: ${error.message}`, 500)
  return new Map((data || []).map(profile => [profile.principal_id, profile]))
}

export function buildGroupResponse(group, { role = null, used = 0 } = {}) {
  const principalId = group.principal_id || group.id
  return {
    id: principalId,
    name: group.name,
    role,
    quota: {
      used,
      limit: group.max_agent_instances ?? null
    },
    apiKey: {
      status: group._credentialError ? 'failed' : (group.consumer_apikey_encrypted ? 'ready' : 'missing'),
      provider: getConsumerProviderFromKey(group.consumer_apikey_encrypted)
    },
    createdAt: group.created_at,
    updatedAt: group.updated_at
  }
}

export async function getGroupOrThrow(groupId) {
  const { data: group, error } = await supabaseAdmin
    .from('principal_profiles')
    .select('principal_id:id, principal_type, email, role, status, is_first_login, name, max_agent_instances, consumer_id, consumer_apikey_encrypted, authorized_http_api_id, created_at, updated_at')
    .eq('id', groupId)
    .eq('principal_type', 'group')
    .maybeSingle()

  if (error) throw new AccessError(`Failed to load group: ${error.message}`, 500)
  if (!group) throw new AccessError('Group not found', 404)
  return group
}

export async function loadEnabledProviderName() {
  const { data, error } = await supabaseAdmin
    .from('provider_config')
    .select('name')
    .eq('enabled', true)
    .limit(1)

  if (error) throw new AccessError(`Failed to load enabled provider: ${error.message}`, 500)
  return data?.[0]?.name || null
}

export async function ensureGroupCredential(group) {
  const principalId = group.principal_id || group.id
  try {
    const providerName = await loadEnabledProviderName()
    if (!providerName) return group

    await ensurePrincipalConsumer({
      principalId,
      principalProfile: group,
      modelProvider: providerName
    })
    return getGroupOrThrow(principalId)
  } catch (error) {
    appLogger.warn({ err: error, principalId }, 'Failed to ensure group credential')
    return {
      ...group,
      _credentialError: error.message
    }
  }
}

export async function assertCanManageGroup({ principalId, userProfile, groupId }) {
  if (isPlatformAdminProfile(userProfile)) return { role: 'admin' }
  return assertGroupMembership({
    principalId,
    userProfile,
    groupId,
    allowedRoles: ['admin']
  })
}
