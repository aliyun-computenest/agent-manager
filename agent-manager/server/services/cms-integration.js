/**
 * CMS 2.0 Observability Auto-Integration
 *
 * Automatically integrates AI Gateway and ACK cluster into CMS 2.0
 * during instance creation. Failures are non-blocking (logged as warnings).
 *
 * Two integration chains with separate AK sources:
 * - AI Gateway Insight: uses customer AK from DB (getGatewayConfig)
 * - Container Insight:  uses deployment AK from env (getCmsCredentials)
 */

import _Cms20240330, * as $Cms20240330 from '@alicloud/cms20240330'
const Cms20240330 = _Cms20240330.default || _Cms20240330
import _OpenApi, * as $OpenApi from '@alicloud/openapi-client'
import * as $Util from '@alicloud/tea-util'
import { getGatewayConfig, getCmsCredentials, ensureWorkspace, listWorkspaces, queryGatewayEntity, queryK8sClusterEntity, getClusterId, getRegionIdFromK8sEnv } from './gateway-config.js'

// Addon names for the two integration chains
const ADDON_AI_GATEWAY = 'cloud-acs-ai-api'
const ADDON_CONTAINER = 'cloud-acs-ack'

// Policy types
const POLICY_TYPE_AI_GATEWAY = 'APIG:AI:GW'
const POLICY_TYPE_CONTAINER = 'CS'

// AI Gateway sub-addons (log + metric collection)
const AI_GATEWAY_SUB_ADDONS = {
  'cloud-acs-ai-api-log': { values: {}, enable: true },
  'cloud-acs-ai-api-metric': { values: {}, enable: true }
}

// Polling config for AddonRelease readiness
const POLL_INTERVAL = 10_000   // 10 seconds
const MAX_POLL_ATTEMPTS = 18   // 3 minutes total

function createCmsClient(akId, akSecret, regionId) {
  const config = new $OpenApi.Config({
    accessKeyId: akId,
    accessKeySecret: akSecret,
    endpoint: `cms.${regionId}.aliyuncs.com`
  })
  return new Cms20240330(config)
}

function createRuntimeOptions() {
  return new $Util.RuntimeOptions({
    connectTimeout: 5000,
    readTimeout: 10000,
    autoretry: true,
    maxAttempts: 2
  })
}

// ─────────────────────────────────────────────────────────
// IntegrationPolicy helpers
// ─────────────────────────────────────────────────────────

/**
 * List integration policies filtered by policyType and regionId
 */
async function listIntegrationPolicies(akId, akSecret, { policyType, regionId }) {
  const client = createCmsClient(akId, akSecret, regionId || 'cn-hongkong')
  const request = new $Cms20240330.ListIntegrationPoliciesRequest({
    policyType,
    maxResults: 100,
    filterRegionIds: regionId || undefined
  })
  const runtime = createRuntimeOptions()
  const resp = await client.listIntegrationPoliciesWithOptions(request, {}, runtime)
  const rawPolicies = resp.body?.policies || []
  const policies = rawPolicies.map(p => (typeof p.toMap === 'function') ? p.toMap() : p)
  console.log(`[cms-integration] Found ${policies.length} ${policyType} policies${regionId ? ` in ${regionId}` : ' (all regions)'}`)
  if (policies.length > 0) {
    policies.forEach(p => {
      console.log(`[cms-integration] Policy: id=${p.policyId}, name=${p.policyName}, workspace=${p.workspace || '(empty)'}, region=${p.regionId}`)
    })
  }
  return policies
}

/**
 * Create an integration policy
 * @returns {Promise<string>} policyId
 */
async function createIntegrationPolicy(akId, akSecret, regionId, { policyName, policyType, workspace, entityGroup }) {
  const client = createCmsClient(akId, akSecret, regionId)
  const request = new $Cms20240330.CreateIntegrationPolicyRequest({
    policyName,
    policyType,
    workspace
  })
  // Bypass SDK model for entityGroup: the model strips fields like instanceIds
  // that AI Gateway policies need. Plain objects pass through parseToMap intact.
  request.entityGroup = entityGroup
  const runtime = createRuntimeOptions()
  const resp = await client.createIntegrationPolicyWithOptions(request, {}, runtime)
  const policy = resp.body?.policy
  const policyId = policy?.policyId
  if (!policyId) {
    throw new Error('CreateIntegrationPolicy returned no policyId: ' + JSON.stringify(resp.body))
  }
  return policyId
}

/**
 * Delete an integration policy
 */
async function deleteIntegrationPolicy(akId, akSecret, regionId, policyId) {
  const client = createCmsClient(akId, akSecret, regionId)
  const request = new $Cms20240330.DeleteIntegrationPolicyRequest({})
  const runtime = createRuntimeOptions()
  await client.deleteIntegrationPolicyWithOptions(policyId, request, {}, runtime)
  console.log(`[cms-integration] Deleted policy: ${policyId}`)
}

/**
 * Find or create an integration policy for a given type + region.
 * Returns both policyId and the workspace actually bound to the policy,
 * so callers use the correct workspace for addon creation.
 * @returns {Promise<{policyId: string, workspace: string}>}
 */
async function ensurePolicy(akId, akSecret, { regionId, policyType, policyName, workspace, entityGroup }) {
  const policies = await listIntegrationPolicies(akId, akSecret, { policyType, regionId })

  // Match by policyName to avoid reusing another workspace's policy in the same region
  const existing = policies.find(p => p.regionId === regionId && p.policyName === policyName)
  if (existing) {
    if (existing.workspace && existing.workspace !== workspace) {
      console.log(`[cms-integration] Existing ${policyType} policy uses workspace "${existing.workspace}" (caller had "${workspace}"), adopting policy workspace`)
    }
    console.log(`[cms-integration] Reusing existing ${policyType} policy: ${existing.policyId}`)
    return { policyId: existing.policyId, workspace: existing.workspace || workspace }
  }

  // Create new policy with correct workspace
  try {
    const policyId = await createIntegrationPolicy(akId, akSecret, regionId, {
      policyName,
      policyType,
      workspace,
      entityGroup
    })
    console.log(`[cms-integration] Created ${policyType} policy: ${policyId}`)
    return { policyId, workspace }
  } catch (err) {
    // Race condition or filterRegionIds mismatch: policy exists but wasn't returned by list
    if (err.message && err.message.includes('is exist')) {
      console.warn(`[cms-integration] Policy already exists (list missed it), retrying without region filter`)
      const allPolicies = await listIntegrationPolicies(akId, akSecret, { policyType, regionId: undefined })
      const found = allPolicies.find(p => p.policyName === policyName || p.regionId === regionId)
      if (found) {
        console.log(`[cms-integration] Found existing ${policyType} policy after retry: ${found.policyId}`)
        return { policyId: found.policyId, workspace: found.workspace || workspace }
      }
    }
    throw err
  }
}

// ─────────────────────────────────────────────────────────
// AddonRelease helpers
// ─────────────────────────────────────────────────────────

/**
 * List addon releases under a policy
 */
async function listAddonReleases(akId, akSecret, regionId, policyId, addonName) {
  const client = createCmsClient(akId, akSecret, regionId)
  const request = new $Cms20240330.ListAddonReleasesRequest({ addonName })
  const runtime = createRuntimeOptions()
  const resp = await client.listAddonReleasesWithOptions(policyId, request, {}, runtime)
  const rawReleases = resp.body?.releases || []
  return rawReleases.map(r => (typeof r.toMap === 'function') ? r.toMap() : r)
}

/**
 * Create an addon release (install observability component)
 *
 * Based on the CMS console API, CreateAddonRelease requires:
 * - entityRules: which entities to bind (entityTypes, regionIds, instanceIds)
 * - values: sub-addon configuration (JSON string, similar to Helm values)
 * - workspace: workspace name
 * - version: addon version
 * - envType: "Cloud"
 *
 * @param {object} options
 * @param {string} options.addonName - Addon name (e.g. cloud-acs-ai-api)
 * @param {string} options.releaseName - Release name
 * @param {string} options.version - Addon version (e.g. 1.1.14)
 * @param {string} options.workspace - Workspace name
 * @param {object} [options.entityRules] - Entity binding rules { entityTypes, regionIds, instanceIds }
 * @param {object} [options.values] - Addon values (sub-addon configuration, will be JSON-stringified)
 */
async function createAddonRelease(akId, akSecret, regionId, policyId, { addonName, releaseName, version, workspace, entityRules, values, envType, aliyunLang }) {
  const client = createCmsClient(akId, akSecret, regionId)
  const request = new $Cms20240330.CreateAddonReleaseRequest({
    addonName,
    version: version || '1.0.0',
    envType: envType || 'Cloud',
    workspace,
    releaseName,
    values: values ? JSON.stringify(values) : '{}',
    entityRules: entityRules || undefined,
    aliyunLang: aliyunLang || undefined
  })
  console.log(`[cms-integration] CreateAddonRelease: addon=${addonName}, release=${releaseName}, policy=${policyId}`)
  const runtime = createRuntimeOptions()
  const resp = await client.createAddonReleaseWithOptions(policyId, request, {}, runtime)
  const rawRelease = resp.body?.release
  if (!rawRelease) {
    throw new Error('CreateAddonRelease returned no release: ' + JSON.stringify(resp.body).slice(0, 500))
  }
  const release = (typeof rawRelease.toMap === 'function') ? rawRelease.toMap() : rawRelease
  console.log(`[cms-integration] CreateAddonRelease succeeded: releaseName=${release.releaseName || releaseName}`)
  return release
}

/**
 * Get addon release status
 */
async function getAddonRelease(akId, akSecret, regionId, policyId, releaseName) {
  const client = createCmsClient(akId, akSecret, regionId)
  const request = new $Cms20240330.GetAddonReleaseRequest({})
  const runtime = createRuntimeOptions()
  const resp = await client.getAddonReleaseWithOptions(releaseName, policyId, request, {}, runtime)
  const rawRelease = resp.body?.release
  return rawRelease ? ((typeof rawRelease.toMap === 'function') ? rawRelease.toMap() : rawRelease) : {}
}

/**
 * Check if an addon release is Ready
 */
function isReleaseReady(release) {
  if (!release) return false
  // Check top-level status
  if (release.status === 'Ready' || release.status === 'running') return true
  // Check conditions array for Ready type
  const conditions = release.conditions || []
  return conditions.some(c => c.type === 'Ready' && c.status === 'True')
}

/**
 * Poll addon release until Ready or timeout
 */
async function pollUntilReady(akId, akSecret, regionId, policyId, releaseName) {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL))
    try {
      const release = await getAddonRelease(akId, akSecret, regionId, policyId, releaseName)
      if (isReleaseReady(release)) {
        console.log(`[cms-integration] Addon ${releaseName} is Ready`)
        return
      }
      // Check for failure conditions
      const conditions = release.conditions || []
      const failed = conditions.find(c => c.status === 'False' && c.type === 'Installed')
      if (failed) {
        throw new Error(`Addon ${releaseName} installation failed: ${failed.message || 'Unknown'}`)
      }
      console.log(`[cms-integration] Addon ${releaseName} status: ${release.status || 'pending'} (${i + 1}/${MAX_POLL_ATTEMPTS})`)
    } catch (err) {
      // Transient errors during polling — continue unless it's a definitive failure
      if (err.message.includes('installation failed')) throw err
      console.warn(`[cms-integration] Poll error for ${releaseName}: ${err.message}`)
    }
  }
  throw new Error(`Addon ${releaseName} timed out after ${MAX_POLL_ATTEMPTS * POLL_INTERVAL / 1000}s`)
}

/**
 * Fetch the latest available version for a CMS addon.
 * Falls back to null so callers can use a hardcoded default.
 */
async function getLatestAddonVersion(akId, akSecret, regionId, addonName) {
  try {
    const client = createCmsClient(akId, akSecret, regionId)
    const request = new $Cms20240330.GetAddonRequest({ version: '*' })
    const runtime = createRuntimeOptions()
    const resp = await client.getAddonWithOptions(addonName, request, {}, runtime)
    const version = resp.body?.data?.version
    if (version) {
      console.log(`[cms-integration] Latest ${addonName} version: ${version}`)
      return version
    }
  } catch (err) {
    console.warn(`[cms-integration] Failed to get latest version for ${addonName}: ${err.message}`)
  }
  return null
}

// ─────────────────────────────────────────────────────────
// Top-level exported functions
// ─────────────────────────────────────────────────────────

/**
 * Ensure AI Gateway is integrated into CMS 2.0
 * Uses customer AK from gateway config (DB)
 *
 * @param {object} options
 * @param {string} options.regionId - Region ID
 * @param {string} options.gatewayId - AI Gateway instance ID
 * @returns {Promise<{status: string, created: string[], skipped: string[], error?: string}>}
 */
export async function ensureGatewayIntegration({ regionId, gatewayId }) {
  const gwConfig = getGatewayConfig()
  const akId = gwConfig.aliyunAccessKeyId
  const akSecret = gwConfig.aliyunAccessKeySecret
  const created = []
  const skipped = []

  if (!akId || !akSecret) {
    return { status: 'failed', error: 'AI Gateway AK not configured in gateway settings', created: [], skipped: [] }
  }

  console.log(`[cms-integration] Starting AI Gateway integration: region=${regionId}, gateway=${gatewayId}`)

  // Step 1-2: Ensure workspace exists (ensureWorkspace returns an array)
  const workspaces = await ensureWorkspace(akId, akSecret, regionId)
  let workspaceName = workspaces[0]?.workspaceName
  if (!workspaceName) {
    return { status: 'failed', error: 'Failed to get workspace name after ensureWorkspace', created, skipped }
  }

  // Step 3: Ensure integration policy exists
  const { policyId, workspace: policyWorkspace } = await ensurePolicy(akId, akSecret, {
    regionId,
    policyType: POLICY_TYPE_AI_GATEWAY,
    policyName: `openclaw-ai-gateway-${regionId}`,
    workspace: workspaceName,
    entityGroup: {
      instanceIds: [gatewayId]
    }
  })
  workspaceName = policyWorkspace

  // Step 4: Check if addon is already installed
  const releases = await listAddonReleases(akId, akSecret, regionId, policyId, ADDON_AI_GATEWAY)
  const ready = releases.find(r => isReleaseReady(r))
  if (ready) {
    console.log(`[cms-integration] AI Gateway addon already installed and ready: ${ready.releaseName}`)
    return { status: 'ready', created: [], skipped: ['workspace', 'policy', 'addon'] }
  }

  // Step 5: Install addon with entityRules and values to bind gateway instances
  const addonVersion = await getLatestAddonVersion(akId, akSecret, regionId, ADDON_AI_GATEWAY) || '1.1.14'
  const releaseName = `openclaw-aigw-${regionId}`
  console.log(`[cms-integration] Installing AI Gateway addon: ${releaseName}, version=${addonVersion}`)
  const release = await createAddonRelease(akId, akSecret, regionId, policyId, {
    addonName: ADDON_AI_GATEWAY,
    releaseName,
    version: addonVersion,
    workspace: workspaceName,
    entityRules: {
      entityTypes: ['acs.apig.aigateway'],
      regionIds: [regionId],
      instanceIds: [gatewayId]
    },
    values: {
      addons: AI_GATEWAY_SUB_ADDONS
    }
  })

  // Step 6: Poll until ready
  const actualReleaseName = release.releaseName || releaseName
  await pollUntilReady(akId, akSecret, regionId, policyId, actualReleaseName)

  // Step 7: Verify entity exists in workspace (best-effort, warning-only)
  try {
    const entity = await queryGatewayEntity(akId, akSecret, regionId, workspaceName, gatewayId)
    if (entity) {
      console.log(`[cms-integration] Gateway entity verified: entityId=${entity.entityId}`)
    } else {
      console.warn(`[cms-integration] Gateway entity not yet visible in EntityStore (workspace=${workspaceName}, gatewayId=${gatewayId}). Entity registration may take additional time after addon Ready.`)
    }
  } catch (err) {
    console.warn(`[cms-integration] Entity verification skipped: ${err.message}`)
  }

  console.log(`[cms-integration] AI Gateway integration complete: policy=${policyId}, release=${actualReleaseName}`)
  return { status: 'ready', created: ['workspace', 'policy', 'addon'], skipped: [] }
}

/**
 * Ensure ACK cluster is integrated into CMS 2.0 (Container Insight)
 * Uses deployment AK from environment variables
 *
 * @param {object} options
 * @param {string} options.regionId - Region ID
 * @returns {Promise<{status: string, created: string[], skipped: string[], error?: string}>}
 */
export async function ensurePodIntegration({ regionId }) {
  const { accessKeyId: akId, accessKeySecret: akSecret } = getCmsCredentials()
  const created = []
  const skipped = []

  if (!akId || !akSecret) {
    return { status: 'failed', error: 'Container AK not configured (ALIBABA_CLOUD_ACCESS_KEY_ID)', created: [], skipped: [] }
  }

  // Get cluster ID and its actual region using auto-detection logic
  const { clusterId, clusterRegionId } = await getClusterId()
  if (!clusterId) {
    return { status: 'failed', error: 'Could not determine ACK cluster ID', created: [], skipped: [] }
  }

  // Use the cluster's actual region for all CMS operations (not the input regionId)
  // CMS resources must be in the same region as the monitored cluster
  const cmsRegionId = clusterRegionId || regionId
  console.log(`[cms-integration] Starting Container integration: inputRegion=${regionId}, clusterRegion=${cmsRegionId}, cluster=${clusterId}`)

  // Step 1-2: Ensure workspace exists in the cluster's actual region
  const workspaces = await ensureWorkspace(akId, akSecret, cmsRegionId)
  let workspaceName = workspaces[0]?.workspaceName
  if (!workspaceName) {
    return { status: 'failed', error: 'Failed to get workspace name after ensureWorkspace', created, skipped }
  }

  // Step 3: Ensure integration policy exists
  const { policyId, workspace: policyWorkspace } = await ensurePolicy(akId, akSecret, {
    regionId: cmsRegionId,
    policyType: POLICY_TYPE_CONTAINER,
    policyName: `openclaw-container-${cmsRegionId}`,
    workspace: workspaceName,
    entityGroup: {
      clusterId,
      clusterEntityType: 'acs.ack.cluster'
    }
  })
  workspaceName = policyWorkspace

  // Step 4: Check if addon is already installed
  const releases = await listAddonReleases(akId, akSecret, cmsRegionId, policyId, ADDON_CONTAINER)
  const ready = releases.find(r => isReleaseReady(r))
  if (ready) {
    console.log(`[cms-integration] Container addon already installed and ready: ${ready.releaseName}`)
    return { status: 'ready', created: [], skipped: ['workspace', 'policy', 'addon'] }
  }

  // Step 5: Install addon with entityRules to bind cluster
  const addonVersion = await getLatestAddonVersion(akId, akSecret, cmsRegionId, ADDON_CONTAINER) || '1.0.8'
  const releaseName = `openclaw-ack-${cmsRegionId}`
  console.log(`[cms-integration] Installing Container addon: ${releaseName}, version=${addonVersion}`)
  const release = await createAddonRelease(akId, akSecret, cmsRegionId, policyId, {
    addonName: ADDON_CONTAINER,
    releaseName,
    version: addonVersion,
    workspace: workspaceName,
    envType: 'CS',
    aliyunLang: 'zh',
    values: {
      store: { storageTarget: 'Default' },
      addons: {
        'ack-controlplane': { values: { installComponent: true }, enable: true },
        'cs-event': { values: {}, enable: true },
        'ingress-nginx': { values: { installComponent: true }, enable: true },
        'cs-default': { values: { installComponent: true, sdScrapeInterval: 30, storageMode: 'share', prometheus: {}, feePackage: 'CS_Basic' }, enable: true }
      }
    },
    entityRules: {
      entityTypes: ['acs.ack.cluster'],
      regionIds: [cmsRegionId],
      instanceIds: [clusterId]
    }
  })

  // Step 6: Poll until ready
  const actualReleaseName = release.releaseName || releaseName
  await pollUntilReady(akId, akSecret, cmsRegionId, policyId, actualReleaseName)

  console.log(`[cms-integration] Container integration complete: policy=${policyId}, release=${actualReleaseName}`)
  return { status: 'ready', created: ['workspace', 'policy', 'addon'], skipped: [] }
}

/**
 * Get cluster region ID from KUBERNETES_SERVICE_HOST (no gateway config fallback)
 * @returns {Promise<string>}
 */
export async function getRegionId() {
  return await getRegionIdFromK8sEnv()
}

/**
 * Check the status of each CMS 2.0 integration resource without creating anything.
 * Returns a structured status object for each of the 4 resources:
 *   Workspace → IntegrationPolicy → AddonRelease → Entity
 *
 * @param {object} options
 * @param {string} options.regionId - Region ID
 * @param {string} options.gatewayId - AI Gateway instance ID
 * @returns {Promise<{resources: {workspace: object, policy: object, addon: object, entity: object}, allReady: boolean}>}
 */
export async function checkGatewayIntegrationStatus({ regionId, gatewayId }) {
  const gwConfig = getGatewayConfig()
  const akId = gwConfig.aliyunAccessKeyId
  const akSecret = gwConfig.aliyunAccessKeySecret

  if (!akId || !akSecret) {
    return {
      resources: {
        workspace: { exists: false, reason: 'AI Gateway AK not configured' },
        policy: { exists: false, reason: 'Skipped: AK not configured' },
        addon: { exists: false, reason: 'Skipped: AK not configured' },
        entity: { exists: false, reason: 'Skipped: AK not configured' }
      },
      allReady: false
    }
  }

  const resources = {
    workspace: { exists: false },
    policy: { exists: false },
    addon: { exists: false },
    entity: { exists: false }
  }

  // Step 1: Check integration policy FIRST (policy carries its workspace)
  try {
    const policies = await listIntegrationPolicies(akId, akSecret, {
      policyType: POLICY_TYPE_AI_GATEWAY,
      regionId
    })
    const gwPolicyName = `openclaw-ai-gateway-${regionId}`
    const existing = policies.find(p => p.regionId === regionId && p.policyName === gwPolicyName)
    if (existing) {
      resources.policy = { exists: true, id: existing.policyId, name: existing.policyName }
      resources.workspace = { exists: true, name: existing.workspace }
    }
  } catch (err) {
    resources.policy = { exists: false, reason: err.message }
  }

  // Step 2: If no policy found, check workspace independently for status display
  if (!resources.policy.exists) {
    try {
      const workspaces = await listWorkspaces(akId, akSecret, regionId)
      const ws = workspaces[0]
      if (ws?.workspaceName) {
        resources.workspace = { exists: true, name: ws.workspaceName }
      } else {
        resources.workspace = { exists: false, reason: 'No workspace found in this region' }
      }
    } catch (err) {
      if (!resources.workspace.exists) {
        resources.workspace = { exists: false, reason: err.message }
      }
    }
    if (!resources.policy.exists && !resources.policy.reason) {
      resources.policy = { exists: false, reason: `No ${POLICY_TYPE_AI_GATEWAY} policy found in ${regionId}` }
    }
    resources.addon = { exists: false, reason: 'Skipped: policy not found' }
    resources.entity = { exists: false, reason: 'Skipped: policy not found' }
    return { resources, allReady: false }
  }

  const workspaceName = resources.workspace.name
  const policyId = resources.policy.id

  // Step 3: Check addon release
  try {
    const releases = await listAddonReleases(akId, akSecret, regionId, policyId, ADDON_AI_GATEWAY)
    const ready = releases.find(r => isReleaseReady(r))
    if (ready) {
      resources.addon = { exists: true, ready: true, name: ready.releaseName, status: ready.status || 'Ready' }
    } else if (releases.length > 0) {
      const latest = releases[0]
      resources.addon = { exists: true, ready: false, name: latest.releaseName, status: latest.status || 'Pending', reason: `Addon status: ${latest.status || 'Pending'}` }
    } else {
      resources.addon = { exists: false, reason: `No ${ADDON_AI_GATEWAY} addon release found` }
    }
  } catch (err) {
    resources.addon = { exists: false, reason: err.message }
  }

  // Step 4: Check entity (best-effort, non-blocking)
  try {
    const entity = await queryGatewayEntity(akId, akSecret, regionId, workspaceName, gatewayId)
    if (entity) {
      resources.entity = { exists: true, entityId: entity.entityId, entityType: entity.entityType }
    } else {
      resources.entity = { exists: false, reason: 'Gateway entity not yet visible in EntityStore' }
    }
  } catch (err) {
    resources.entity = { exists: false, reason: err.message }
  }

  const allReady = resources.workspace.exists && resources.policy.exists &&
    resources.addon.exists && resources.addon.ready && resources.entity.exists

  return { resources, allReady }
}

/**
 * Check the status of each CMS 2.0 container integration resource without creating anything.
 * Returns a structured status object for each of the 4 resources:
 *   Workspace → IntegrationPolicy → AddonRelease → K8sClusterEntity
 *
 * Uses deployment AK from environment variables (same as ensurePodIntegration).
 *
 * @param {object} options
 * @param {string} options.regionId - Region ID
 * @returns {Promise<{resources: {workspace: object, policy: object, addon: object, entity: object}, allReady: boolean}>}
 */
export async function checkContainerIntegrationStatus({ regionId }) {
  const { accessKeyId: akId, accessKeySecret: akSecret } = getCmsCredentials()

  if (!akId || !akSecret) {
    return {
      resources: {
        workspace: { exists: false, reason: 'Container AK not configured (ALIBABA_CLOUD_ACCESS_KEY_ID)' },
        policy: { exists: false, reason: 'Skipped: AK not configured' },
        addon: { exists: false, reason: 'Skipped: AK not configured' },
        entity: { exists: false, reason: 'Skipped: AK not configured' }
      },
      allReady: false
    }
  }

  // Align with ensurePodIntegration: use cluster's actual region for CMS operations
  let cmsRegionId = regionId
  try {
    const { clusterRegionId } = await getClusterId()
    if (clusterRegionId) cmsRegionId = clusterRegionId
  } catch {
    // fallback to input regionId
  }

  const resources = {
    workspace: { exists: false },
    policy: { exists: false },
    addon: { exists: false },
    entity: { exists: false }
  }

  // Step 1: Check integration policy FIRST (policy carries its workspace)
  try {
    const policies = await listIntegrationPolicies(akId, akSecret, {
      policyType: POLICY_TYPE_CONTAINER,
      regionId: cmsRegionId
    })
    const csPolicyName = `openclaw-container-${cmsRegionId}`
    const existing = policies.find(p => p.regionId === cmsRegionId && p.policyName === csPolicyName)
    if (existing) {
      resources.policy = { exists: true, id: existing.policyId, name: existing.policyName }
      resources.workspace = { exists: true, name: existing.workspace }
    }
  } catch (err) {
    resources.policy = { exists: false, reason: err.message }
  }

  // Step 2: If no policy found, check workspace independently for status display
  if (!resources.policy.exists) {
    try {
      const workspaces = await listWorkspaces(akId, akSecret, cmsRegionId)
      const ws = workspaces[0]
      if (ws?.workspaceName) {
        resources.workspace = { exists: true, name: ws.workspaceName }
      } else {
        resources.workspace = { exists: false, reason: 'No workspace found in this region' }
      }
    } catch (err) {
      if (!resources.workspace.exists) {
        resources.workspace = { exists: false, reason: err.message }
      }
    }
    if (!resources.policy.exists && !resources.policy.reason) {
      resources.policy = { exists: false, reason: `No ${POLICY_TYPE_CONTAINER} policy found in ${cmsRegionId}` }
    }
    resources.addon = { exists: false, reason: 'Skipped: policy not found' }
    resources.entity = { exists: false, reason: 'Skipped: policy not found' }
    return { resources, allReady: false }
  }

  const workspaceName = resources.workspace.name
  const policyId = resources.policy.id

  // Step 3: Check addon release
  try {
    const releases = await listAddonReleases(akId, akSecret, cmsRegionId, policyId, ADDON_CONTAINER)
    const ready = releases.find(r => isReleaseReady(r))
    if (ready) {
      resources.addon = { exists: true, ready: true, name: ready.releaseName, status: ready.status || 'Ready' }
    } else if (releases.length > 0) {
      const latest = releases[0]
      resources.addon = { exists: true, ready: false, name: latest.releaseName, status: latest.status || 'Pending', reason: `Addon status: ${latest.status || 'Pending'}` }
    } else {
      resources.addon = { exists: false, reason: `No ${ADDON_CONTAINER} addon release found` }
    }
  } catch (err) {
    resources.addon = { exists: false, reason: err.message }
  }

  // Step 4: Check K8s cluster entity (best-effort, requires clusterId)
  try {
    const { clusterId, clusterRegionId } = await getClusterId()
    const entityRegion = clusterRegionId || cmsRegionId
    if (clusterId) {
      const entity = await queryK8sClusterEntity(akId, akSecret, entityRegion, workspaceName, clusterId)
      if (entity) {
        resources.entity = { exists: true, entityId: entity.entityId, entityType: entity.entityType }
      } else {
        resources.entity = { exists: false, reason: 'K8s cluster entity not yet visible in EntityStore' }
      }
    } else {
      resources.entity = { exists: false, reason: 'Could not determine ACK cluster ID' }
    }
  } catch (err) {
    resources.entity = { exists: false, reason: err.message }
  }

  const allReady = resources.workspace.exists && resources.policy.exists &&
    resources.addon.exists && resources.addon.ready && resources.entity.exists

  return { resources, allReady }
}
