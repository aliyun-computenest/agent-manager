import {
  E2B_DOMAIN,
  AGENT_GATEWAY_DOMAIN
} from '../config/index.js'
import { getAgentType } from '../utils/agent-config.js'
import {
  buildGatewayUrl,
  parseGatewayDomainConfig,
  sameHostname
} from '../utils/agent-gateway-auth.js'

const DEFAULT_AGENT_PORT = 18789

function getGatewayConfig() {
  return parseGatewayDomainConfig(AGENT_GATEWAY_DOMAIN)
}

function buildAgentGatewaySandboxUrl({
  instanceId
}) {
  const config = getGatewayConfig()
  if (!config.enabled || !instanceId) return null

  return buildGatewayUrl({
    scheme: config.scheme,
    instanceId,
    gatewayDomain: config.domain
  })
}

function buildE2BUpstreamHost({
  agentPort = DEFAULT_AGENT_PORT,
  sandboxId
}) {
  const port = Number(agentPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(String(sandboxId || ''))) return null
  return `${port}-${sandboxId}.${E2B_DOMAIN || 'e2b.dev'}`
}

function normalizeAgentPort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_AGENT_PORT
}

async function resolveAgentGatewayPort(agentTypeId, logContext = 'agent gateway port lookup') {
  if (!agentTypeId) return DEFAULT_AGENT_PORT
  try {
    const agentType = await getAgentType(agentTypeId)
    return normalizeAgentPort(agentType?.readiness_check?.port)
  } catch (e) {
    console.warn(`Failed to get agent type for ${logContext}: ${e.message}`)
    return DEFAULT_AGENT_PORT
  }
}

function buildAgentGatewayValidation({
  instance,
  gatewayHost,
  agentPort = DEFAULT_AGENT_PORT
}) {
  const gatewaySandboxUrl = instance?.sandbox_id && instance?.status === 'running'
    ? buildAgentGatewaySandboxUrl({
      instanceId: instance.id
    })
    : null
  const upstreamHost = buildE2BUpstreamHost({
    agentPort,
    sandboxId: instance?.sandbox_id
  })

  if (!gatewayHost) {
    return { ok: false, status: 400, error: 'Gateway host required' }
  }
  if (!gatewaySandboxUrl) {
    return { ok: false, status: 403, error: 'Gateway access is not available' }
  }
  if (!upstreamHost) {
    return { ok: false, status: 403, error: 'Gateway upstream is not available' }
  }
  if (!sameHostname(gatewaySandboxUrl, gatewayHost)) {
    return { ok: false, status: 403, error: 'Gateway host mismatch' }
  }

  return {
    ok: true,
    validation: {
      upstreamHost,
      upstreamTokenParam: instance.token ? `token=${encodeURIComponent(String(instance.token))}` : null
    }
  }
}

export {
  DEFAULT_AGENT_PORT,
  buildAgentGatewayValidation,
  buildAgentGatewaySandboxUrl,
  buildE2BUpstreamHost,
  resolveAgentGatewayPort
}
