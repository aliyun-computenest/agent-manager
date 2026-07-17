const GATEWAY_AUTH_PATH = '/__agent_gateway_auth'
const GATEWAY_HEALTH_PATH = '/__agent_gateway_health'
const GATEWAY_UPSTREAM_TOKEN_PARAM_HEADER = 'X-Agent-Gateway-Upstream-Token-Param'
const GATEWAY_UPSTREAM_HOST_HEADER = 'X-Agent-Gateway-Upstream-Host'

function normalizeGatewayDomain(domain) {
  return String(domain || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .split('?')[0]
    .replace(/^\.+|\.+$/g, '')
}

function parseGatewayDomainConfig(value) {
  const raw = String(value || '').trim()
  const schemeMatch = raw.match(/^(https?):\/\//i)
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : 'http'
  const domain = normalizeGatewayDomain(raw)
  return {
    domain,
    scheme,
    enabled: Boolean(domain)
  }
}

function stripHostPort(host) {
  return String(host || '')
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/\.+$/g, '')
}

function isBareIpv4Host(host) {
  const value = String(host || '')
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(value)
    && value.split('.').every(part => Number(part) <= 255)
}

function normalizeGatewayInstanceId(instanceId) {
  const value = String(instanceId || '').trim()
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : null
}

function buildGatewayPath(instanceId) {
  const normalizedInstanceId = normalizeGatewayInstanceId(instanceId)
  return normalizedInstanceId ? `/${normalizedInstanceId}/` : null
}

function buildGatewayUrl({ scheme = 'http', instanceId, gatewayDomain }) {
  const normalizedScheme = String(scheme).toLowerCase() === 'https' ? 'https' : 'http'
  let host = normalizeGatewayDomain(gatewayDomain)
  const path = buildGatewayPath(instanceId)
  if (!host || !path) return null
  if (normalizedScheme === 'http' && isBareIpv4Host(host)) {
    host = `${host}:8080`
  }
  return `${normalizedScheme}://${host}${path}`
}

function normalizeNextPath(value) {
  let next = typeof value === 'string' && value.trim() ? value.trim() : '/'
  if (!next.startsWith('/') || next.startsWith('//')) return '/'
  if (/[\u0000-\u001f\u007f\s]/.test(next)) return '/'
  if (/^[a-z][a-z0-9+.-]*:/i.test(next)) return '/'

  for (let i = 0; i < 3; i += 1) {
    let decoded
    try {
      decoded = decodeURIComponent(next)
    } catch {
      return '/'
    }
    if (decoded === next) break
    next = decoded
    if (!next.startsWith('/') || next.startsWith('//')) return '/'
    if (/[\u0000-\u001f\u007f\s]/.test(next)) return '/'
    if (/^[a-z][a-z0-9+.-]*:/i.test(next)) return '/'
  }

  const pathOnly = next.split(/[?#]/, 1)[0]
  const segments = pathOnly.split('/').filter(Boolean)
  if (segments.some(segment => segment === '..')) return '/'

  return next
}

function sameHostname(leftUrl, rightHost) {
  try {
    const left = new URL(leftUrl)
    return stripHostPort(left.hostname) === stripHostPort(rightHost)
  } catch {
    return false
  }
}

function canAccessGatewayInstance({ isAdmin = false, instancePrincipalId, instanceUserId, requestUserId, groupMemberships = [] } = {}) {
  const ownerPrincipalId = instancePrincipalId || instanceUserId
  if (!ownerPrincipalId || !requestUserId) return false
  if (isAdmin) return true
  if (ownerPrincipalId === requestUserId) return true
  // 当实例 owner 是 group principal 时，同分组的 active 成员也可以访问。
  return groupMemberships.some(membership =>
    membership?.group_id === ownerPrincipalId
    && membership?.principal_id === requestUserId
    && membership?.status === 'active'
  )
}

export {
  GATEWAY_AUTH_PATH,
  GATEWAY_HEALTH_PATH,
  GATEWAY_UPSTREAM_HOST_HEADER,
  GATEWAY_UPSTREAM_TOKEN_PARAM_HEADER,
  buildGatewayPath,
  buildGatewayUrl,
  canAccessGatewayInstance,
  normalizeGatewayDomain,
  normalizeGatewayInstanceId,
  normalizeNextPath,
  parseGatewayDomainConfig,
  sameHostname,
  stripHostPort
}
