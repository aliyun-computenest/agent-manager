import { createKubernetesApi, getSandboxNamespace } from '../kubernetes-api.js'

function getFirstContainerImage(containers) {
  if (!Array.isArray(containers)) return null
  return containers.find(container => typeof container?.image === 'string' && container.image.trim())?.image || null
}

export function getSandboxTemplateAgentImage(sandbox) {
  return getFirstContainerImage(sandbox?.spec?.template?.spec?.containers)
    || getFirstContainerImage(sandbox?.spec?.template?.containers)
    || getFirstContainerImage(sandbox?.spec?.containers)
    || getFirstContainerImage(sandbox?.template?.spec?.containers)
    || getFirstContainerImage(sandbox?.template?.containers)
}

export function getSandboxTargetFromSandboxId(sandboxId, fallbackNamespace = getSandboxNamespace()) {
  const value = String(sandboxId || '')
  if (!value) return { namespace: fallbackNamespace, sandboxName: null }
  const separatorIndex = value.indexOf('--')
  if (separatorIndex > 0) {
    const namespace = value.slice(0, separatorIndex) || fallbackNamespace
    const sandboxName = value.slice(separatorIndex + 2)
    return { namespace, sandboxName: sandboxName || null }
  }
  return { namespace: fallbackNamespace, sandboxName: value }
}

export async function readSandboxImageBySandboxId(sandboxId, {
  api = null,
  fallbackNamespace = getSandboxNamespace()
} = {}) {
  const { namespace, sandboxName } = getSandboxTargetFromSandboxId(sandboxId, fallbackNamespace)
  if (!sandboxName) return null
  const clusterApi = api || createKubernetesApi()
  const sandbox = await clusterApi.getSandbox(namespace, sandboxName)
  return getSandboxTemplateAgentImage(sandbox)
}
