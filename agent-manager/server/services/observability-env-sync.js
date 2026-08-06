/**
 * Observability Env Sync Service
 *
 * Patches the SandboxSet CR's env array with the latest observability_env values.
 * Called only when admin saves observability_env (PUT agent-types) or during lazy init.
 * NOT called on every instance creation — new Pods inherit env from the SandboxSet template.
 */

import { createKubernetesApi } from './kubernetes-api.js'
import { listSandboxSets } from './k8s.js'

// Env var names managed by observability (will be patched/replaced in SandboxSet)
const OBSERVABILITY_ENV_KEYS = new Set([
  'ARMS_ENDPOINT',
  'ARMS_LICENSE_KEY',
  'ARMS_PROJECT',
  'ARMS_WORKSPACE',
  'OTEL_RESOURCE_ATTRIBUTES'
])

/**
 * Sync observability_env from database into the SandboxSet's container env array.
 * Preserves non-observability env vars (like SERVICE_NAME Downward API).
 *
 * @param {string} sandboxTemplateId - SandboxSet name (e.g. 'agent-manager-openclaw')
 * @param {Record<string, string>} envObj - The observability_env key-value map
 */
export async function syncObservabilityEnvToSandboxSet(sandboxTemplateId, envObj) {
  if (!envObj || Object.keys(envObj).length === 0) return

  try {
    const api = createKubernetesApi()

    // Cross-namespace lookup — consistent with UI sandbox template dropdown
    const allSandboxSets = await listSandboxSets()
    const target = allSandboxSets.find(s => s.name === sandboxTemplateId)
    const ns = target?.namespace || 'default'

    // Read current SandboxSet
    const sandboxSet = await api.getSandboxSet(ns, sandboxTemplateId)
    const currentEnv = sandboxSet?.spec?.template?.spec?.containers?.[0]?.env || []

    // Remove old observability env vars, keep everything else (e.g. SERVICE_NAME)
    const filteredEnv = currentEnv.filter(e => !OBSERVABILITY_ENV_KEYS.has(e.name))

    // Add new observability env vars
    for (const [key, value] of Object.entries(envObj)) {
      if (value) {
        filteredEnv.push({ name: key, value: String(value) })
      }
    }

    // Patch SandboxSet with updated env array
    await api.patchSandboxSet(ns, sandboxTemplateId, [
      { op: 'replace', path: '/spec/template/spec/containers/0/env', value: filteredEnv }
    ])

    console.log(`[observability-env-sync] Patched SandboxSet ${sandboxTemplateId} with ${Object.keys(envObj).length} observability env var(s)`)
  } catch (err) {
    console.warn(`[observability-env-sync] Failed to patch SandboxSet ${sandboxTemplateId}:`, err.message)
  }
}
