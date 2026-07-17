/**
 * Observability Env Lazy Initialization Service
 *
 * On service startup, checks the built-in Agent Types (hermes/openclaw/qwenpaw)
 * and, if their `observability_env` is empty (`{}`), fetches ARMS parameters from
 * the CMS API and writes a per-type default config into the database.
 *
 * This is a lazy, idempotent init: it only fills records whose observability_env
 * is still empty, so admin-customized configs are never overwritten.
 *
 * If the CMS API is unreachable, the init silently skips (logs a warning) so the
 * service startup is never blocked.
 */

import { supabaseAdmin } from '../config/index.js'
import { getApmInstallParameters } from './gateway-config.js'
import { syncObservabilityEnvToSandboxSet } from './observability-env-sync.js'

// Built-in agent type codes that ship with default observability config
const BUILTIN_AGENT_TYPE_CODES = ['hermes', 'openclaw', 'qwenpaw']

/**
 * Build the observability_env object for a given agent type code from ARMS params.
 * @param {string} code - Agent type code ('hermes' | 'openclaw' | 'qwenpaw')
 * @param {{publicDomain: string, regionId: string, authToken: string, project: string, workspace: string}} apmParams
 * @returns {Record<string, string>} The observability_env key/value map
 */
function buildObservabilityEnv(code, apmParams) {
  const endpoint = `https://${apmParams.publicDomain}/apm/trace/opentelemetry`

  // Shared params for all agent types
  const baseResourceAttrs = 'acs.arms.service.feature=genai_app'
  // QwenPaw requires gen_ai.agent.system for LoongSuite GenAI content capture (input/output)
  const resourceAttrs = code === 'qwenpaw'
    ? `${baseResourceAttrs},gen_ai.agent.system=qwenpaw`
    : baseResourceAttrs

  const envObj = {
    ARMS_ENDPOINT: endpoint,
    ARMS_LICENSE_KEY: apmParams.authToken,
    ARMS_PROJECT: apmParams.project,
    ARMS_WORKSPACE: apmParams.workspace,
    ARMS_REGION_ID: apmParams.regionId || 'cn-hangzhou',
    APSARA_APM_APP_TYPE: 'app',
    OTEL_RESOURCE_ATTRIBUTES: resourceAttrs
  }

  // SERVICE_NAME is injected via K8s Downward API (metadata.name) in SandboxSet YAML,
  // not via observability_env, to ensure it uses the actual Pod name.

  return envObj
}

/**
 * Lazily initialize observability_env for built-in agent types.
 *
 * Steps:
 *   1. Query agent_types with empty observability_env ('{}')
 *   2. Fetch ARMS params from CMS API (getApmInstallParameters)
 *   3. Assemble per-type env and write to DB
 *
 * Never throws — CMS/DB failures are logged and skipped.
 * @returns {Promise<void>}
 */
export async function initializeObservabilityEnv() {
  try {
    // Step 1: Find built-in agent types whose observability_env is still empty or null
    const { data: emptyTypes, error: queryError } = await supabaseAdmin
      .from('agent_types')
      .select('id, code, sandbox_template_id, observability_env')
      .in('code', BUILTIN_AGENT_TYPE_CODES)
      .or('observability_env.eq.{},observability_env.is.null')

    if (queryError) {
      console.warn('[observability-init] Failed to query agent_types:', queryError.message)
      return
    }

    if (!emptyTypes || emptyTypes.length === 0) {
      console.log('[observability-init] No empty observability_env to initialize, skipping')
      return
    }

    // Step 2: Fetch ARMS params from CMS API (env vars or CMS OpenAPI)
    const apmParams = await getApmInstallParameters()
    if (!apmParams) {
      console.warn('[observability-init] ARMS parameters not available (CMS unreachable), skipping init. Admin can fill defaults later.')
      return
    }

    // Step 3: Assemble and write per-type observability_env
    for (const type of emptyTypes) {
      // Defensive re-check: only fill truly-empty records
      const current = type.observability_env
      const isEmpty = !current || (typeof current === 'object' && Object.keys(current).length === 0)
      if (!isEmpty) continue

      const envObj = buildObservabilityEnv(type.code, apmParams)

      const { error: updateError } = await supabaseAdmin
        .from('agent_types')
        .update({ observability_env: envObj })
        .eq('id', type.id)

      if (updateError) {
        console.warn(`[observability-init] Failed to update observability_env for ${type.code}:`, updateError.message)
      } else {
        console.log(`[observability-init] ✅ Initialized observability_env for ${type.code}`)
        // Sync to SandboxSet so new Pods inherit the params
        const templateId = type.sandbox_template_id || `agent-manager-${type.code}`
        syncObservabilityEnvToSandboxSet(templateId, envObj).catch(err => {
          console.warn(`[observability-init] Failed to sync SandboxSet for ${type.code}:`, err.message)
        })
      }
    }
  } catch (err) {
    // Never block startup — swallow and log
    console.warn('[observability-init] Unexpected error during observability_env init:', err.message)
  }
}
