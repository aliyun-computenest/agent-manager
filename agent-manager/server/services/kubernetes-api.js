import { KubeConfig, CoreV1Api, CustomObjectsApi } from '@kubernetes/client-node'
import fs from 'fs'

const GROUP = 'agents.kruise.io'
const VERSION = 'v1alpha1'
const SERVICE_ACCOUNT_NAMESPACE_FILE = '/var/run/secrets/kubernetes.io/serviceaccount/namespace'

let kubeConfig = null
let customApi = null
let coreApi = null

function getSandboxNamespace() {
  const envNamespace = process.env.SANDBOX_NAMESPACE || process.env.OPENCLAW_SANDBOX_NAMESPACE
  if (envNamespace) return envNamespace
  try {
    const namespace = fs.readFileSync(SERVICE_ACCOUNT_NAMESPACE_FILE, 'utf8').trim()
    if (namespace) return namespace
  } catch {
    // Local development and unit tests usually run outside Kubernetes.
  }
  return 'default'
}

function getKubeConfig() {
  if (kubeConfig) return kubeConfig
  const kc = new KubeConfig()
  const env = process.env.DEPLOY_ENVIRONMENT || 'local-dev'
  if (env === 'local-dev') {
    kc.loadFromDefault()
  } else {
    kc.loadFromCluster()
  }
  kubeConfig = kc
  return kubeConfig
}

function getApi() {
  if (customApi) return customApi
  customApi = getKubeConfig().makeApiClient(CustomObjectsApi)
  return customApi
}

function getCoreApi() {
  if (coreApi) return coreApi
  coreApi = getKubeConfig().makeApiClient(CoreV1Api)
  return coreApi
}

function getBody(res) {
  return res?.body ?? res
}

function labelSelectorToString(selector = {}) {
  const parts = []
  for (const [key, value] of Object.entries(selector.matchLabels || {})) {
    parts.push(`${key}=${value}`)
  }
  for (const expression of selector.matchExpressions || []) {
    if (expression.operator === 'Exists') {
      parts.push(expression.key)
    } else if (expression.operator === 'DoesNotExist') {
      parts.push(`!${expression.key}`)
    } else if (expression.operator === 'In' || expression.operator === 'NotIn') {
      const op = expression.operator === 'In' ? 'in' : 'notin'
      parts.push(`${expression.key} ${op} (${(expression.values || []).join(',')})`)
    }
  }
  return parts.join(',')
}

function listOptions(selector, options = {}) {
  const labelSelector = labelSelectorToString(selector)
  const result = labelSelector ? { labelSelector } : {}
  if (Number.isInteger(options.limit) && options.limit > 0) {
    result.limit = options.limit
  }
  return result
}

function getHttpStatus(err) {
  if (typeof err?.code === 'number') return err.code
  return err?.response?.statusCode || err?.statusCode
}

function resetKubernetesApiClients() {
  kubeConfig = null
  customApi = null
  coreApi = null
}

function shouldResetKubernetesApiClients(err, status) {
  return status === 401
    || err?.code === 'ECONNREFUSED'
    || err?.code === 'ECONNRESET'
    || err?.code === 'ENOTFOUND'
}

function getErrorMessage(err) {
  if (typeof err?.body === 'string') {
    try { return JSON.parse(err.body).message } catch (_) { /* ignore */ }
  }
  return err?.response?.body?.message || err?.body?.message || err?.message || 'Unknown K8s error'
}

function escapeJsonPointer(value) {
  return String(value).replace(/~/g, '~0').replace(/\//g, '~1')
}

function buildLabelJsonPatch(existingLabels = {}, labels = {}) {
  const patch = []
  const needsLabelsObject = Object.values(labels).some(value => value !== null)
  if (needsLabelsObject && (!existingLabels || Object.keys(existingLabels).length === 0)) {
    patch.push({ op: 'add', path: '/metadata/labels', value: {} })
  }
  for (const [key, value] of Object.entries(labels)) {
    if (value === null) {
      if (Object.prototype.hasOwnProperty.call(existingLabels || {}, key)) {
        patch.push({
          op: 'remove',
          path: `/metadata/labels/${escapeJsonPointer(key)}`
        })
      }
      continue
    }
    patch.push({
      op: Object.prototype.hasOwnProperty.call(existingLabels || {}, key) ? 'replace' : 'add',
      path: `/metadata/labels/${escapeJsonPointer(key)}`,
      value
    })
  }
  return patch
}

function buildMapJsonPatch(parentPath, existingValues = {}, values = {}) {
  const patch = []
  const needsObject = Object.values(values).some(value => value !== null)
  if (needsObject && (!existingValues || Object.keys(existingValues).length === 0)) {
    patch.push({ op: 'add', path: parentPath, value: {} })
  }
  for (const [key, value] of Object.entries(values)) {
    if (value === null) {
      if (Object.prototype.hasOwnProperty.call(existingValues || {}, key)) {
        patch.push({
          op: 'remove',
          path: `${parentPath}/${escapeJsonPointer(key)}`
        })
      }
      continue
    }
    patch.push({
      op: Object.prototype.hasOwnProperty.call(existingValues || {}, key) ? 'replace' : 'add',
      path: `${parentPath}/${escapeJsonPointer(key)}`,
      value
    })
  }
  return patch
}

function buildMetadataJsonPatch(existingMetadata = {}, { labels = {}, annotations = {} } = {}) {
  return [
    ...buildMapJsonPatch('/metadata/labels', existingMetadata.labels || {}, labels),
    ...buildMapJsonPatch('/metadata/annotations', existingMetadata.annotations || {}, annotations)
  ]
}

function wrapK8sError(err) {
  const status = getHttpStatus(err)
  if (shouldResetKubernetesApiClients(err, status)) {
    resetKubernetesApiClients()
  }
  const e = new Error(getErrorMessage(err))
  e.httpStatus = status || 500
  if (status >= 500 || err?.code === 'ECONNREFUSED' || err?.code === 'ENOTFOUND') {
    e.message = `K8s cluster unavailable: ${e.message}`
    e.httpStatus = 503
  }
  return e
}

function shouldRetryLabelPatch(error) {
  return error?.httpStatus === 409 || error?.httpStatus === 422
}

async function readObject(plural, namespace, name) {
  try {
    const res = await getApi().getNamespacedCustomObject({ group: GROUP, version: VERSION, namespace, plural, name })
    return getBody(res)
  } catch (err) {
    throw wrapK8sError(err)
  }
}

async function readPod(namespace, name) {
  try {
    const res = await getCoreApi().readNamespacedPod({ namespace, name })
    return getBody(res)
  } catch (err) {
    throw wrapK8sError(err)
  }
}

async function readConfigMap(namespace, name) {
  try {
    const res = await getCoreApi().readNamespacedConfigMap({ namespace, name })
    return getBody(res)
  } catch (err) {
    throw wrapK8sError(err)
  }
}

async function listConfigMaps(namespace, selector) {
  try {
    const res = await getCoreApi().listNamespacedConfigMap({ namespace, ...listOptions(selector) })
    return getBody(res)
  } catch (err) {
    throw wrapK8sError(err)
  }
}

async function listPods(namespace, selector) {
  try {
    const res = await getCoreApi().listNamespacedPod({ namespace, ...listOptions(selector) })
    return getBody(res)
  } catch (err) {
    throw wrapK8sError(err)
  }
}

async function listObjects(plural, namespace, selector, options = {}) {
  try {
    const res = await getApi().listNamespacedCustomObject({ group: GROUP, version: VERSION, namespace, plural, ...listOptions(selector, options) })
    return getBody(res)
  } catch (err) {
    throw wrapK8sError(err)
  }
}

async function createObject(plural, namespace, body) {
  try {
    const res = await getApi().createNamespacedCustomObject({ group: GROUP, version: VERSION, namespace, plural, body })
    return getBody(res)
  } catch (err) {
    throw wrapK8sError(err)
  }
}

async function patchObject(plural, namespace, name, body) {
  try {
    const res = await getApi().patchNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace,
      plural,
      name,
      body
    })
    return getBody(res)
  } catch (err) {
    throw wrapK8sError(err)
  }
}

async function deleteObject(plural, namespace, name) {
  try {
    const res = await getApi().deleteNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace,
      plural,
      name
    })
    return getBody(res)
  } catch (err) {
    throw wrapK8sError(err)
  }
}

function createKubernetesApi() {
  return {
    getSandboxSet(namespace, name) {
      return readObject('sandboxsets', namespace, name)
    },
    patchSandboxSet(namespace, name, patch) {
      return patchObject('sandboxsets', namespace, name, patch)
    },
    getSandbox(namespace, name) {
      return readObject('sandboxes', namespace, name)
    },
    getPod(namespace, name) {
      return readPod(namespace, name)
    },
    listPods(namespace, selector) {
      return listPods(namespace, selector)
    },
    listSandboxes(namespace, selector, options) {
      return listObjects('sandboxes', namespace, selector, options)
    },
    async patchSandboxLabels(namespace, name, labels) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const sandbox = await readObject('sandboxes', namespace, name)
        const patch = buildLabelJsonPatch(sandbox?.metadata?.labels || {}, labels)
        if (patch.length === 0) return sandbox
        try {
          return await patchObject('sandboxes', namespace, name, patch)
        } catch (error) {
          if (attempt === 0 && shouldRetryLabelPatch(error)) continue
          throw error
        }
      }
      return readObject('sandboxes', namespace, name)
    },
    patchSandbox(namespace, name, patch) {
      return patchObject('sandboxes', namespace, name, patch)
    },
    async patchSandboxMetadata(namespace, name, metadataPatch) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const sandbox = await readObject('sandboxes', namespace, name)
        const patch = buildMetadataJsonPatch(sandbox?.metadata || {}, metadataPatch)
        if (patch.length === 0) return sandbox
        try {
          return await patchObject('sandboxes', namespace, name, patch)
        } catch (error) {
          if (attempt === 0 && shouldRetryLabelPatch(error)) continue
          throw error
        }
      }
      return readObject('sandboxes', namespace, name)
    },
    createSandbox(namespace, body) {
      return createObject('sandboxes', namespace, body)
    },
    deleteSandbox(namespace, name) {
      return deleteObject('sandboxes', namespace, name)
    },
    getCheckpoint(namespace, name) {
      return readObject('checkpoints', namespace, name)
    },
    listCheckpoints(namespace, selector) {
      return listObjects('checkpoints', namespace, selector)
    },
    getConfigMap(namespace, name) {
      return readConfigMap(namespace, name)
    },
    listConfigMaps(namespace, selector) {
      return listConfigMaps(namespace, selector)
    },
    createSandboxUpdateOps(namespace, body) {
      return createObject('sandboxupdateops', namespace, body)
    },
    patchSandboxUpdateOps(namespace, name, patch) {
      return patchObject('sandboxupdateops', namespace, name, patch)
    },
    deleteSandboxUpdateOps(namespace, name) {
      return deleteObject('sandboxupdateops', namespace, name)
    },
    getSandboxUpdateOps(namespace, name) {
      return readObject('sandboxupdateops', namespace, name)
    },
    listSandboxUpdateOps(namespace, selector) {
      return listObjects('sandboxupdateops', namespace, selector)
    }
  }
}

export {
  buildLabelJsonPatch,
  buildMetadataJsonPatch,
  createKubernetesApi,
  getSandboxNamespace,
  labelSelectorToString
}
