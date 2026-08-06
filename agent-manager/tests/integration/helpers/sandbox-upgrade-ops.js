import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CustomObjectsApi, KubeConfig } from '@kubernetes/client-node'
import { waitFor } from './wait-for.js'

const K8S_GROUP = 'agents.kruise.io'
const K8S_VERSION = 'v1alpha1'

let kubeConfig = null
let customObjectsApi = null

function defaultKubeconfigPath() {
  const home = process.env.HOME
  if (!home) return ''
  const path = join(home, '.kube', 'config')
  return existsSync(path) ? path : ''
}

function getKubeconfigPath() {
  return process.env.TEST_KUBECONFIG || process.env.KUBECONFIG || defaultKubeconfigPath()
}

export function hasSandboxUpdateOpsKubeconfig() {
  return Boolean(getKubeconfigPath())
}

function getKubeConfig() {
  if (kubeConfig) return kubeConfig
  kubeConfig = new KubeConfig()
  const kubeconfigPath = getKubeconfigPath()
  if (kubeconfigPath) {
    kubeConfig.loadFromFile(kubeconfigPath)
  } else {
    kubeConfig.loadFromDefault()
  }
  return kubeConfig
}

function getCustomObjectsApi() {
  if (!customObjectsApi) {
    customObjectsApi = getKubeConfig().makeApiClient(CustomObjectsApi)
  }
  return customObjectsApi
}

async function listSandboxUpdateOps(namespace) {
  const result = await getCustomObjectsApi().listNamespacedCustomObject({
    group: K8S_GROUP,
    version: K8S_VERSION,
    namespace,
    plural: 'sandboxupdateops',
  })
  return result?.items || []
}

function isActiveSandboxUpdateOps(item) {
  const phase = item?.status?.phase
  return !phase || phase === 'Pending' || phase === 'Updating'
}

export async function waitForNoActiveSandboxUpdateOps(namespace, options = {}) {
  const timeoutMs = options.timeoutMs || 900_000
  const intervalMs = options.intervalMs || 10_000
  return waitFor(
    async () => {
      const active = (await listSandboxUpdateOps(namespace)).filter(isActiveSandboxUpdateOps)
      if (active.length === 0) return true
      console.warn(
        `[sandbox-upgrade] waiting for active SandboxUpdateOps: ${active.map(item => `${item.metadata?.name || 'unknown'}:${item.status?.phase || 'Pending'}`).join(', ')}`,
      )
      return null
    },
    {
      timeoutMs,
      intervalMs,
      label: options.label || `[sandbox-upgrade] no active SandboxUpdateOps in ${namespace}`,
    },
  )
}
