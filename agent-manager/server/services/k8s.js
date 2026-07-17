import { KubeConfig, CustomObjectsApi } from '@kubernetes/client-node'
import yaml from 'js-yaml'

const GROUP = 'agents.kruise.io'
const VERSION = 'v1alpha1'
const PLURAL = 'sandboxsets'

let customApi = null

function getApi() {
  if (customApi) return customApi
  const kc = new KubeConfig()
  const env = process.env.DEPLOY_ENVIRONMENT || 'local-dev'
  if (env === 'local-dev') {
    kc.loadFromDefault()
  } else {
    kc.loadFromCluster()
  }
  customApi = kc.makeApiClient(CustomObjectsApi)
  return customApi
}

function extractSummary(obj) {
  const meta = obj.metadata || {}
  const spec = obj.spec || {}
  const containers = spec.template?.spec?.containers || []
  return {
    name: meta.name,
    namespace: meta.namespace || 'default',
    image: containers[0]?.image || '',
    replicas: spec.replicas ?? 0,
    createdAt: meta.creationTimestamp || '',
    updatedAt: meta.creationTimestamp || '',
  }
}

function getBody(res) {
  return res?.body ?? res
}

// Used only on write paths (create/update): K8s rejects writes that carry
// server-managed fields like managedFields / uid / generation / resourceVersion.
// Read paths must NOT use this — they should return the raw object as-is.
function cleanForApply(obj) {
  const cleaned = structuredClone(obj)
  delete cleaned.status
  if (cleaned.metadata) {
    delete cleaned.metadata.managedFields
    delete cleaned.metadata.creationTimestamp
    delete cleaned.metadata.uid
    delete cleaned.metadata.generation
    delete cleaned.metadata.resourceVersion
  }
  return cleaned
}

export async function listSandboxSets(namespace) {
  const api = getApi()
  try {
    if (namespace) {
      const res = await api.listNamespacedCustomObject({ group: GROUP, version: VERSION, namespace, plural: PLURAL })
      return (getBody(res)?.items || []).map(extractSummary)
    }
    const res = await api.listClusterCustomObject({ group: GROUP, version: VERSION, plural: PLURAL })
    return (getBody(res)?.items || []).map(extractSummary)
  } catch (err) {
    if (getHttpStatus(err) === 404) return []
    throw wrapK8sError(err)
  }
}

export async function getSandboxSet(name, namespace = 'default') {
  const api = getApi()
  try {
    const res = await api.getNamespacedCustomObject({ group: GROUP, version: VERSION, namespace, plural: PLURAL, name })
    const obj = getBody(res)
    return {
      ...extractSummary(obj),
      yaml: yaml.dump(obj, { lineWidth: -1 }),
    }
  } catch (err) {
    if (getHttpStatus(err) === 404) return null
    throw wrapK8sError(err)
  }
}

export async function createSandboxSet(name, namespace, yamlStr) {
  const api = getApi()
  const body = parseAndValidateYaml(yamlStr)
  body.metadata = { ...body.metadata, name, namespace }
  body.apiVersion = `${GROUP}/${VERSION}`
  body.kind = 'SandboxSet'
  try {
    const res = await api.createNamespacedCustomObject({ group: GROUP, version: VERSION, namespace, plural: PLURAL, body })
    const obj = getBody(res)
    return {
      ...extractSummary(obj),
      yaml: yaml.dump(obj, { lineWidth: -1 }),
    }
  } catch (err) {
    if (getHttpStatus(err) === 409) {
      const e = new Error(`SandboxSet "${name}" already exists`)
      e.code = 'SandboxSet.NameConflict'
      e.httpStatus = 409
      throw e
    }
    throw wrapK8sError(err)
  }
}

export async function updateSandboxSet(name, namespace, yamlStr) {
  const api = getApi()
  const body = parseAndValidateYaml(yamlStr)
  delete body.metadata?.managedFields
  delete body.metadata?.creationTimestamp
  delete body.metadata?.uid
  delete body.metadata?.generation
  delete body.status
  body.metadata = { ...body.metadata, name, namespace }
  body.apiVersion = `${GROUP}/${VERSION}`
  body.kind = 'SandboxSet'

  try {
    const existing = await api.getNamespacedCustomObject({ group: GROUP, version: VERSION, namespace, plural: PLURAL, name })
    body.metadata.resourceVersion = getBody(existing).metadata.resourceVersion
  } catch (err) {
    if (getHttpStatus(err) === 404) {
      const e = new Error(`SandboxSet "${name}" not found`)
      e.code = 'SandboxSet.NotFound'
      e.httpStatus = 404
      throw e
    }
    throw wrapK8sError(err)
  }

  try {
    const res = await api.replaceNamespacedCustomObject({ group: GROUP, version: VERSION, namespace, plural: PLURAL, name, body })
    const obj = getBody(res)
    return {
      ...extractSummary(obj),
      yaml: yaml.dump(obj, { lineWidth: -1 }),
    }
  } catch (err) {
    throw wrapK8sError(err)
  }
}

export async function deleteSandboxSet(name, namespace = 'default') {
  const api = getApi()
  try {
    await api.deleteNamespacedCustomObject({ group: GROUP, version: VERSION, namespace, plural: PLURAL, name })
  } catch (err) {
    if (getHttpStatus(err) === 404) {
      const e = new Error(`SandboxSet "${name}" not found`)
      e.code = 'SandboxSet.NotFound'
      e.httpStatus = 404
      throw e
    }
    throw wrapK8sError(err)
  }
}

export async function getImageFromSandboxSet(name, namespace = 'default') {
  const detail = await getSandboxSet(name, namespace)
  return detail?.image || null
}

function parseAndValidateYaml(yamlStr) {
  let parsed
  try {
    parsed = yaml.load(yamlStr)
  } catch (err) {
    const e = new Error(`YAML parse error: ${err.message}`)
    e.code = 'InvalidYaml'
    e.httpStatus = 400
    throw e
  }
  if (!parsed || typeof parsed !== 'object') {
    const e = new Error('YAML must be a valid object')
    e.code = 'InvalidYaml'
    e.httpStatus = 400
    throw e
  }
  return parsed
}

function getHttpStatus(err) {
  if (typeof err?.code === 'number') return err.code
  return err?.response?.statusCode || err?.statusCode
}

function getErrorMessage(err) {
  if (typeof err?.body === 'string') {
    try { return JSON.parse(err.body).message } catch (_) { /* ignore */ }
  }
  return err?.response?.body?.message || err?.body?.message || err?.message || 'Unknown K8s error'
}

function wrapK8sError(err) {
  const status = getHttpStatus(err)
  const msg = getErrorMessage(err)

  if (status >= 500 || err?.code === 'ECONNREFUSED' || err?.code === 'ENOTFOUND') {
    const e = new Error(`K8s cluster unavailable: ${msg}`)
    e.code = 'Cluster.Unavailable'
    e.httpStatus = 503
    return e
  }

  const e = new Error(msg)
  e.httpStatus = status || 500
  return e
}
