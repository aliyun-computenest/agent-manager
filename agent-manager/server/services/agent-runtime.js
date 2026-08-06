/**
 * Agent 运行时地址解析。
 * 统一从 Agent Type 的 readiness port 和 Sandbox ID 构造 E2B 上游地址，
 * 供实例详情、原生工作台代理和实例启动校验复用。
 */
import { E2B_DOMAIN } from '../config/index.js'
import { getAgentType } from '../utils/agent-config.js'
import { appLogger } from '../utils/logger.js'

const DEFAULT_AGENT_PORT = 18789

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

async function resolveAgentPort(agentTypeId, logContext = 'agent port lookup') {
  if (!agentTypeId) return DEFAULT_AGENT_PORT
  try {
    const agentType = await getAgentType(agentTypeId)
    return normalizeAgentPort(agentType?.readiness_check?.port)
  } catch (e) {
    appLogger.warn('Failed to resolve Agent runtime port', {
      err: e,
      agentTypeId,
      logContext
    })
    return DEFAULT_AGENT_PORT
  }
}

export {
  DEFAULT_AGENT_PORT,
  buildE2BUpstreamHost,
  resolveAgentPort
}
