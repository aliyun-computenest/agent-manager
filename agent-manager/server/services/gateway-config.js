/**
 * AI Gateway Configuration Service
 * Manages AI gateway config stored in provider_config table (name: 'api_gateway')
 * Provides in-memory cache with DB persistence
 * Sensitive fields (API keys) are encrypted at rest using API_ENCRYPTION_KEY
 * 
 * Configuration is set via:
 * 1. SQL initialization (init_database.sql) - plaintext will be auto-encrypted on first load
 * 2. Admin configuration page (/admin/ai-gateway)
 */

import { supabaseAdmin } from '../config/index.js'
import { encryptApiKey, decryptApiKey } from '../utils/crypto.js'
import crypto from 'crypto'
import _Sts20150401 from '@alicloud/sts20150401'
const Sts20150401 = _Sts20150401.default || _Sts20150401
import _Cms20240330, * as $Cms20240330 from '@alicloud/cms20240330'
const Cms20240330 = _Cms20240330.default || _Cms20240330
import _OpenApi, * as $OpenApi from '@alicloud/openapi-client'
const OpenApiClient = _OpenApi.default || _OpenApi
import * as $Util from '@alicloud/tea-util'

const PROVIDER_NAME = 'api_gateway'

// Sensitive fields that need encryption (stored in config.parameters)
const SENSITIVE_FIELDS = ['dashscopeApiKey', 'aliyunAccessKeyId', 'aliyunAccessKeySecret']

// Default config values (stored in config.parameters)
const DEFAULT_PARAMETERS = {
  regionId: 'cn-hangzhou',
  gatewayId: '',
  httpApiId: '',
  environmentId: '',
  gatewayDomain: '',
  dashscopeApiKey: '',
  aliyunAccessKeyId: '',
  aliyunAccessKeySecret: ''
}

/**
 * Get CMS credentials from ALIBABA_CLOUD_ACCESS_KEY_ID/ALIBABA_CLOUD_ACCESS_KEY_SECRET env vars
 * @returns {{ accessKeyId: string, accessKeySecret: string }}
 */
function getCmsCredentials() {
  return {
    accessKeyId: process.env.ALIBABA_CLOUD_ACCESS_KEY_ID || '',
    accessKeySecret: process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || ''
  }
}

// In-memory cache (stores decrypted values)
let cachedConfig = {
  enabled: false,
  apiKeyPlaceholder: '${CONSUMER_API_KEY}',
  parameters: { ...DEFAULT_PARAMETERS }
}

// Config change listeners (to avoid circular dependency with sls.js)
const configChangeListeners = []

/**
 * Register a callback to be invoked when gateway config is updated
 * @param {(config: object) => void} fn - Callback function receiving the new config
 */
function onGatewayConfigChange(fn) {
  configChangeListeners.push(fn)
}

/**
 * Check if a string looks like encrypted data (valid Base64)
 * Encrypted values are Base64 encoded and typically longer
 * @param {string} value - Value to check
 * @returns {boolean} - True if likely encrypted
 */
function isLikelyEncrypted(value) {
  if (!value || value.length < 8) return false
  
  // Check if it's valid Base64 format
  const base64Regex = /^[A-Za-z0-9+/]+=*$/
  if (!base64Regex.test(value)) return false
  
  // Try to decode - encrypted data should be valid Base64
  try {
    const decoded = Buffer.from(value, 'base64')
    // If it decodes to printable ASCII that looks like an API key (sk-, LTAI, etc.), it's plaintext
    const decodedStr = decoded.toString('utf-8')
    // Common API key prefixes - if decrypted to these, it was probably encrypted
    if (decodedStr.startsWith('sk-') || decodedStr.startsWith('LTAI')) {
      return true // This was encrypted data
    }
    // If the original looks like a typical API key pattern, it's plaintext
    if (value.startsWith('sk-') || value.startsWith('LTAI')) {
      return false
    }
    // If Base64 decodes to roughly same length with non-printable chars, likely encrypted
    return decoded.length > 0 && decodedStr.length !== value.length
  } catch {
    return false
  }
}

/**
 * Encrypt sensitive fields in config.parameters for storage
 * @param {object} parameters - Parameters with plain text sensitive fields
 * @returns {object} - Parameters with encrypted sensitive fields
 */
function encryptSensitiveFields(parameters) {
  const encrypted = { ...parameters }
  for (const field of SENSITIVE_FIELDS) {
    if (encrypted[field]) {
      encrypted[field] = encryptApiKey(encrypted[field])
    }
  }
  return encrypted
}

/**
 * Decrypt sensitive fields in config.parameters after loading from DB
 * Also detects and returns whether any field was plaintext (needs re-encryption)
 * @param {object} parameters - Parameters with potentially encrypted sensitive fields
 * @returns {{decrypted: object, hadPlaintext: boolean}}
 */
function decryptSensitiveFieldsWithDetection(parameters) {
  const decrypted = { ...parameters }
  let hadPlaintext = false
  
  for (const field of SENSITIVE_FIELDS) {
    if (decrypted[field]) {
      // Check if this looks like encrypted data
      if (isLikelyEncrypted(decrypted[field])) {
        try {
          decrypted[field] = decryptApiKey(decrypted[field])
        } catch (e) {
          // Decryption failed - treat as plaintext
          console.warn(`⚠️ Field ${field} appears encrypted but failed to decrypt, treating as plaintext`)
          hadPlaintext = true
        }
      } else {
        // This is plaintext - keep it but mark for re-encryption
        console.log(`🔓 Detected plaintext ${field}, will encrypt and save`)
        hadPlaintext = true
      }
    }
  }
  
  return { decrypted, hadPlaintext }
}

/**
 * Load AI gateway config from provider_config table
 * Config should be pre-populated via SQL init or admin page
 * Automatically encrypts plaintext sensitive data found in DB
 */
async function loadGatewayConfig() {
  try {
    const { data, error } = await supabaseAdmin
      .from('provider_config')
      .select('id, name, type, config, enabled')
      .eq('name', PROVIDER_NAME)
      .maybeSingle()

    if (error) {
      console.error('Failed to load gateway config from DB:', error.message)
      console.log('🌐 AI Gateway: Using default config (not configured)')
      cachedConfig = {
        enabled: false,
        apiKeyPlaceholder: '${CONSUMER_API_KEY}',
        parameters: { ...DEFAULT_PARAMETERS }
      }
      return cachedConfig
    }

    if (data && data.config) {
      // Config exists in DB - support both flat format (new) and nested parameters format (legacy)
      // Flat format: { gatewayId, httpApiId, ... } directly in config
      // Nested format: { parameters: { gatewayId, httpApiId, ... } } in config
      const rawConfig = data.config
      // Extract parameter fields from config, supporting both formats:
      // - Flat format (new): { gatewayId, httpApiId, ... } directly in config
      // - Nested format (legacy): { parameters: { gatewayId, httpApiId, ... } }
      // When both exist (transition period), flat values take precedence
      const { apiKeyPlaceholder: _akp, domainPlaceholder: _dp, parameters: nestedParams, ...flatParams } = rawConfig
      // Merge: nested params as base, flat params override (flat wins when both exist)
      const parameters = { ...(nestedParams || {}), ...flatParams }

      const { decrypted, hadPlaintext } = decryptSensitiveFieldsWithDetection(parameters)

      cachedConfig = {
        enabled: !!data.enabled,
        apiKeyPlaceholder: rawConfig.apiKeyPlaceholder || '${CONSUMER_API_KEY}',
        parameters: { ...DEFAULT_PARAMETERS, ...decrypted }
      }
      
      // If any sensitive field was plaintext, re-encrypt and save
      if (hadPlaintext) {
        console.log('🔐 Encrypting plaintext sensitive data in database...')
        const encryptedParams = encryptSensitiveFields(cachedConfig.parameters)
        // Save in flat format (new standard)
        const { error: updateError } = await supabaseAdmin
          .from('provider_config')
          .update({
            config: {
              apiKeyPlaceholder: cachedConfig.apiKeyPlaceholder,
              ...encryptedParams
            },
            updated_at: new Date().toISOString()
          })
          .eq('name', PROVIDER_NAME)

        if (updateError) {
          console.error('Failed to encrypt sensitive config:', updateError.message)
        } else {
          console.log('✅ Sensitive data encrypted and saved (flat format)')
        }
      }
      
      logConfig()
      return cachedConfig
    }

    // No config in DB - use defaults
    // Config should be set via SQL init or admin page
    console.log('📦 No AI gateway config in DB, using defaults')
    console.log('   Configure via: Admin → AI 网关配置')
    cachedConfig = {
      enabled: false,
      apiKeyPlaceholder: '${CONSUMER_API_KEY}',
      parameters: { ...DEFAULT_PARAMETERS }
    }
    logConfig()
    return cachedConfig
  } catch (err) {
    console.error('Error loading gateway config:', err.message)
    cachedConfig = {
      enabled: false,
      apiKeyPlaceholder: '${CONSUMER_API_KEY}',
      parameters: { ...DEFAULT_PARAMETERS }
    }
    return cachedConfig
  }
}

/**
 * Log current config status
 */
function logConfig() {
  const params = cachedConfig.parameters || {}
  console.log('🌐 AI Gateway Config:')
  console.log(`   Gateway ID: ${params.gatewayId || 'not configured'}`)
  console.log(`   HTTP API ID: ${params.httpApiId || 'not configured'}`)
  console.log(`   Environment ID: ${params.environmentId || 'not configured'}`)
  console.log(`   Region: ${params.regionId}`)
  console.log(`   Gateway Domain: ${params.gatewayDomain || 'not configured'}`)
}

/**
 * Get cached gateway config (synchronous)
 * Returns decrypted values from memory cache
 * Flattens parameters for backwards compatibility
 * @returns {object} The cached gateway config
 */
function getGatewayConfig() {
  const params = cachedConfig.parameters || {}
  // Return flattened object for backwards compatibility
  return {
    enabled: !!cachedConfig.enabled,
    apiKeyPlaceholder: cachedConfig.apiKeyPlaceholder,
    gatewayId: params.gatewayId || '',
    httpApiId: params.httpApiId || '',
    environmentId: params.environmentId || '',
    regionId: params.regionId || 'cn-hangzhou',
    gatewayDomain: params.gatewayDomain || '',
    dashscopeApiKey: params.dashscopeApiKey || '',
    aliyunAccessKeyId: params.aliyunAccessKeyId || '',
    aliyunAccessKeySecret: params.aliyunAccessKeySecret || ''
  }
}

/**
 * Get Alibaba Cloud account ID using the given credentials via STS GetCallerIdentity
 * @param {string} akId - Access Key ID
 * @param {string} akSecret - Access Key Secret
 * @returns {Promise<string>} The account ID
 */
export async function getAccountIdWithCredentials(akId, akSecret) {
  if (!akId || !akSecret) {
    throw new Error('Alibaba Cloud credentials not configured')
  }

  const config = new $OpenApi.Config({
    accessKeyId: akId,
    accessKeySecret: akSecret,
    endpoint: 'sts.aliyuncs.com'
  })

  const client = new Sts20150401(config)
  const resp = await client.getCallerIdentity()
  const accountId = resp.body?.accountId || resp.body?.AccountId

  if (!accountId) {
    throw new Error('Failed to get account ID from STS GetCallerIdentity')
  }

  return String(accountId)
}

/**
 * Call CMS ListWorkspaces API to get workspaces in a specific region
 * Uses the `region` request parameter for server-side filtering
 * Result is cached in memory with 1-hour TTL (keyed by regionId)
 * @param {string} akId - Access Key ID
 * @param {string} akSecret - Access Key Secret
 * @param {string} regionId - Region ID
 * @returns {Promise<Array<{workspaceName: string, regionId: string, displayName: string}>>}
 */
async function listWorkspaces(akId, akSecret, regionId) {
  const config = new $OpenApi.Config({ accessKeyId: akId, accessKeySecret: akSecret, endpoint: `cms.${regionId}.aliyuncs.com` })
  const client = new Cms20240330(config)
  const runtime = new $Util.RuntimeOptions({})

  // Paginate through all workspaces in the target region (maxResults max=50, use nextToken for more)
  const allWorkspaces = []
  let nextToken = undefined
  do {
    const request = new $Cms20240330.ListWorkspacesRequest({ maxResults: 50, nextToken, region: regionId })
    const resp = await client.listWorkspacesWithOptions(request, {}, runtime)
    const workspaces = resp.body?.workspaces || []
    allWorkspaces.push(...workspaces)
    nextToken = resp.body?.nextToken || undefined
  } while (nextToken)

  // SDK objects require .toMap() for field access
  const workspacesList = allWorkspaces.map(ws => (typeof ws.toMap === 'function') ? ws.toMap() : ws)
  console.log(`[gateway-config] listWorkspaces: found ${workspacesList.length} workspaces in ${regionId}`)
  return workspacesList
}

/**
 * Ensure a CMS 2.0 workspace exists in the given region.
 * If no workspace is found, auto-create one with the naming convention:
 *   default-cms-{accountId}-{regionId}
 * Also creates EntityStore and Umodel for the workspace.
 * @param {string} akId - Access Key ID
 * @param {string} akSecret - Access Key Secret
 * @param {string} regionId - Region ID
 * @returns {Promise<Array<{workspaceName: string, regionId: string, displayName: string}>>}
 */
async function ensureWorkspace(akId, akSecret, regionId) {
  const existing = await listWorkspaces(akId, akSecret, regionId)
  if (existing.length > 0) {
    console.log(`[gateway-config] ensureWorkspace: found ${existing.length} existing workspace(s), skipping creation`)
    return existing
  }

  console.log(`🔧 No CMS workspace found, auto-creating workspace in ${regionId}...`)
  const accountId = await getAccountIdWithCredentials(akId, akSecret)

  // Step 2: Create workspace with naming convention
  const workspaceName = `default-cms-${accountId}-${regionId}`
  const config = new $OpenApi.Config({ accessKeyId: akId, accessKeySecret: akSecret, endpoint: `cms.${regionId}.aliyuncs.com` })
  const client = new Cms20240330(config)
  const runtime = new $Util.RuntimeOptions({})

  const putRequest = new $Cms20240330.PutWorkspaceRequest({
    slsProject: workspaceName,
    description: 'Auto-created by OpenClaw Manager'
  })

  console.log(`🔧 Creating workspace: ${workspaceName}...`)
  await client.putWorkspaceWithOptions(workspaceName, putRequest, {}, runtime)
  console.log(`✅ Workspace created: ${workspaceName}`)

  // Step 3: Create EntityStore
  try {
    console.log(`🔧 Creating EntityStore for workspace: ${workspaceName}...`)
    const entityStoreRequest = new $Cms20240330.CreateEntityStoreRequest({})
    await client.createEntityStoreWithOptions(workspaceName, entityStoreRequest, {}, runtime)
    console.log(`✅ EntityStore created`)
  } catch (err) {
    console.warn(`⚠️ Failed to create EntityStore (may already exist): ${err.message}`)
  }

  // Step 4: Create Umodel
  try {
    console.log(`🔧 Creating Umodel for workspace: ${workspaceName}...`)
    const umodelRequest = new $Cms20240330.CreateUmodelRequest({
      description: 'Auto-created by OpenClaw Manager'
    })
    await client.createUmodelWithOptions(workspaceName, umodelRequest, {}, runtime)
    console.log(`✅ Umodel created`)
  } catch (err) {
    console.warn(`⚠️ Failed to create Umodel (may already exist): ${err.message}`)
  }

  // Step 5: Poll until workspace is visible in list
  // CMS ListWorkspaces API has eventual consistency — newly created workspace
  // may not appear immediately, so we poll with retries
  const maxRetries = 6
  const retryDelay = 5_000 // 5 seconds
  for (let i = 0; i < maxRetries; i++) {
    if (i > 0) {
      console.log(`[gateway-config] Waiting for workspace to become visible (retry ${i}/${maxRetries})...`)
      await new Promise(resolve => setTimeout(resolve, retryDelay))
    }
    const workspaces = await listWorkspaces(akId, akSecret, regionId)
    if (workspaces.length > 0) {
      console.log(`✅ Workspace auto-creation complete, found ${workspaces.length} workspace(s)`)
      return workspaces
    }
  }

  throw new Error(`WORKSPACE_EMPTY: Failed to create workspace in region ${regionId} (not visible after ${maxRetries * retryDelay / 1000}s)`)
}

/**
 * Call CMS GetEntityStoreData API to query AI Gateway entities in a workspace
 * GetUmodelData is restricted (405), so we use GetEntityStoreData instead
 * @param {string} akId - Access Key ID
 * @param {string} akSecret - Access Key Secret
 * @param {string} regionId - Region ID
 * @param {string} workspaceName - Workspace name
 * @param {string} gatewayId - AI Gateway instance ID to match
 * @returns {Promise<{entityId: string, entityType: string, domain: string} | null>}
 */
async function queryGatewayEntity(akId, akSecret, regionId, workspaceName, gatewayId) {
  const config = new $OpenApi.Config({ accessKeyId: akId, accessKeySecret: akSecret, endpoint: `cms.${regionId}.aliyuncs.com` })
  const client = new OpenApiClient(config)

  const now = Math.floor(Date.now() / 1000)
  const thirtyDaysAgo = now - 30 * 24 * 3600

  const params = new $OpenApi.Params({
    action: 'GetEntityStoreData',
    version: '2024-03-30',
    protocol: 'HTTPS',
    method: 'POST',
    authType: 'AK',
    style: 'ROA',
    pathname: `/workspace/${workspaceName}/entitiesAndRelations`,
    reqBodyType: 'json',
    bodyType: 'json'
  })

  const request = new $OpenApi.OpenApiRequest({
    body: {
      from: thirtyDaysAgo,
      to: now,
      query: `.entity with(domain='acs', type='acs.apig.aigateway') | limit 0, 100`
    }
  })

  const runtime = new $Util.RuntimeOptions({})
  const result = await client.callApi(params, request, runtime)

  const header = result.body?.header || []
  const data = result.body?.data || []

  // Find column indices
  const colIdx = {}
  header.forEach((h, i) => { colIdx[h] = i })

  // Match by instance_id (name column is often empty for apig.aigateway entities)
  const targetRow = data.find(row => {
    const instanceId = row[colIdx['instance_id']] || ''
    return instanceId === gatewayId
  })

  if (!targetRow) {
    console.warn(`[gateway-config] queryGatewayEntity: no match for instance_id=${gatewayId} in workspace ${workspaceName}`)
    console.warn(`[gateway-config] Found ${data.length} entities of type acs.apig.aigateway`)
    if (data.length > 0) {
      const sampleIds = data.slice(0, 5).map(row => row[colIdx['instance_id']] || row[colIdx['name']] || '(unknown)')
      console.warn(`[gateway-config] Sample instance_id/name values: ${sampleIds.join(', ')}`)
    }
    return null
  }

  return {
    entityId: targetRow[colIdx['__entity_id__']] || '',
    entityType: targetRow[colIdx['__entity_type__']] || 'acs.apig.aigateway',
    domain: targetRow[colIdx['__domain__']] || 'acs'
  }
}

/**
 * Build the CMS AI Gateway observability URL dynamically
 * All URL parameters are queried via CMS API (ListWorkspaces + GetUmodelData),
 * no concatenation/guessing/MD5 computation.
 * @param {string} [consumerName] - Optional consumer name to pre-filter
 * @returns {Promise<string>} The full CMS observability URL
 */
async function buildGatewayObservabilityUrl(consumerName) {
  const gwConfig = getGatewayConfig()
  const gatewayId = gwConfig.gatewayId
  const regionId = gwConfig.regionId || 'cn-hangzhou'
  const akId = gwConfig.aliyunAccessKeyId || ''
  const akSecret = gwConfig.aliyunAccessKeySecret || ''

  if (!gatewayId) {
    throw new Error('AI Gateway ID not configured')
  }
  if (!akId || !akSecret) {
    throw new Error('AI Gateway Alibaba Cloud credentials not configured. Please set Access Key ID and Secret in AI Gateway settings.')
  }

  let entity = null
  let workspaceName
  let wsRegionId

  // Step 1: ListWorkspaces to get all workspaces
    console.log(`🔍 Querying CMS workspaces in ${regionId}...`)
    const workspaces = await listWorkspaces(akId, akSecret, regionId)

    if (workspaces.length === 0) {
      throw new Error('WORKSPACE_EMPTY: No CMS workspaces found in region ' + regionId + '. Please click "一键创建" to set up CMS integration first.')
    }

    // Step 2: For each workspace, query GetUmodelData to find the gateway entity
    for (const ws of workspaces) {
      const wsName = ws.workspaceName
      const wsRegion = ws.regionId || regionId

      console.log(`🔍 Querying gateway entity in workspace: ${wsName}...`)
      const result = await queryGatewayEntity(akId, akSecret, wsRegion, wsName, gatewayId)

      if (result) {
        entity = result
        workspaceName = wsName
        wsRegionId = wsRegion
        console.log(`✅ Found gateway entity: entityId=${result.entityId}, entityType=${result.entityType}, domain=${result.domain}, workspace=${wsName}`)
        break
      }
    }

    if (!entity) {
      throw new Error(
        `AI Gateway ${gatewayId} not found in any CMS workspace (region: ${regionId}). ` +
        `Checked ${workspaces.length} workspace(s): ${workspaces.map(ws => ws.workspaceName).join(', ')}. ` +
        `Possible causes: (1) auto-integration failed during instance creation, (2) addon entity registration still in progress, (3) gateway AK mismatch.`
      )
    }

  let url = `https://cmsnext.console.aliyun.com/next/region/${wsRegionId}/workspace/${workspaceName}/app/llm/entity-overview?entityId=${entity.entityId}&entityType=${entity.entityType}&domain=${entity.domain}`

  // Set time range to last 30 days (queryTimeType=99 with startTime/endTime in seconds)
  const now = Math.floor(Date.now() / 1000)
  const thirtyDaysAgo = now - 30 * 24 * 3600
  url += `&queryTimeType=99&startTime=${thirtyDaysAgo}&endTime=${now}`

  if (consumerName) {
    url += `&var-ai_log.consumer=${encodeURIComponent(consumerName)}`
  }

  return url
}

/**
 * Get region ID via kubectl from node labels
 * Get region ID from KUBERNETES_SERVICE_HOST environment variable
 * ACK clusters set KUBERNETES_SERVICE_HOST to apiserver.{clusterId}.{region}.cs.aliyuncs.com
 * @returns {Promise<string>} The region ID (e.g., 'cn-hangzhou')
 */
async function getRegionIdFromK8sEnv() {
  const k8sHost = process.env.KUBERNETES_SERVICE_HOST || ''
  const match = k8sHost.match(/^apiserver\.[a-f0-9]+\.([a-z]+-[a-z0-9-]+?)\.cs\.aliyuncs\.com$/)
  if (match) {
    console.log(`🌍 Region ID from KUBERNETES_SERVICE_HOST: ${match[1]}`)
    return match[1]
  }
  const ossEndpoint = process.env.OSS_ENDPOINT || ''
  const ossMatch = ossEndpoint.match(/^oss-([a-z]+-[a-z0-9-]+?)(?:-internal)?\.aliyuncs\.com$/)
  if (ossMatch) {
    console.warn(`⚠️  K8s env region unavailable, parsed regionId from OSS_ENDPOINT: ${ossMatch[1]}`)
    return ossMatch[1]
  }
  throw new Error('REGION_NOT_FOUND: KUBERNETES_SERVICE_HOST is not set and OSS_ENDPOINT not available')
}

/**
 * Get ACK cluster ID and region from KUBERNETES_SERVICE_HOST environment variable
 * ACK clusters set KUBERNETES_SERVICE_HOST to apiserver.{clusterId}.{region}.cs.aliyuncs.com
 * @returns {Promise<{clusterId: string, clusterRegionId: string}>}
 */
async function getClusterId() {
  const k8sHost = process.env.KUBERNETES_SERVICE_HOST || ''
  const match = k8sHost.match(/^apiserver\.([a-f0-9]+)\.([a-z]+-[a-z0-9-]+?)\.cs\.aliyuncs\.com$/)
  if (match) {
    const clusterId = match[1]
    const clusterRegionId = match[2]
    console.log(`☸️  Parsed cluster from KUBERNETES_SERVICE_HOST: clusterId=${clusterId}, region=${clusterRegionId}`)
    return { clusterId, clusterRegionId }
  }
  const envClusterId = process.env.VITE_ACS_CLUSTER_ID || ''
  if (envClusterId && envClusterId !== 'your-cluster-id') {
    const regionId = await getRegionIdFromK8sEnv()
    console.log(`☸️  Using VITE_ACS_CLUSTER_ID from env: clusterId=${envClusterId}, region=${regionId}`)
    return { clusterId: envClusterId, clusterRegionId: regionId }
  }
  throw new Error('CLUSTER_NOT_FOUND: KUBERNETES_SERVICE_HOST is not set and VITE_ACS_CLUSTER_ID not configured')
}

/**
 * Query K8s cluster entity from CMS GetEntityStoreData API in a specific workspace
 * entityId is NOT derived from clusterId (not MD5), it's assigned by CMS during entity registration
 * @param {string} akId - Access Key ID
 * @param {string} akSecret - Access Key Secret
 * @param {string} regionId - Region ID
 * @param {string} workspaceName - Workspace name
 * @param {string} clusterId - ACK cluster ID to match
 * @returns {Promise<{entityId: string, entityType: string, domain: string} | null>}
 */
async function queryK8sClusterEntity(akId, akSecret, regionId, workspaceName, clusterId) {
  const config = new $OpenApi.Config({
    accessKeyId: akId,
    accessKeySecret: akSecret,
    endpoint: `cms.${regionId}.aliyuncs.com`
  })
  const client = new OpenApiClient(config)

  const now = Math.floor(Date.now() / 1000)
  const thirtyDaysAgo = now - 30 * 24 * 3600

  const params = new $OpenApi.Params({
    action: 'GetEntityStoreData',
    version: '2024-03-30',
    protocol: 'HTTPS',
    method: 'POST',
    authType: 'AK',
    style: 'ROA',
    pathname: `/workspace/${workspaceName}/entitiesAndRelations`,
    reqBodyType: 'json',
    bodyType: 'json'
  })

  const request = new $OpenApi.OpenApiRequest({
    body: {
      from: thirtyDaysAgo,
      to: now,
      query: `.entity with(domain='k8s', type='k8s.cluster') | limit 0, 100`
    }
  })

  const runtime = new $Util.RuntimeOptions({})
  const result = await client.callApi(params, request, runtime)

  const header = result.body?.header || []
  const data = result.body?.data || []

  // Find column indices
  const colIdx = {}
  header.forEach((h, i) => { colIdx[h] = i })

  // Search for the target cluster by cluster_id
  const targetRow = data.find(row => row[colIdx['cluster_id']] === clusterId)

  if (!targetRow) {
    return null
  }

  return {
    entityId: targetRow[colIdx['__entity_id__']] || '',
    entityType: targetRow[colIdx['__entity_type__']] || 'k8s.cluster',
    domain: targetRow[colIdx['__domain__']] || 'k8s'
  }
}

/**
 * Query K8s Pod entity from CMS GetEntityStoreData API in a specific workspace
 * Matches by entity name field (format: "{namespace}/{pod_name}")
 * Per spec: no domain/kind filter in request, match client-side after fetching all entities
 * @param {string} akId - Access Key ID
 * @param {string} akSecret - Access Key Secret
 * @param {string} regionId - Region ID
 * @param {string} workspaceName - Workspace name
 * @param {string} namespace - K8s namespace
 * @param {string} podName - K8s pod name
 * @returns {Promise<{entityId: string, entityType: string, domain: string} | null>}
 */
async function queryPodEntity(akId, akSecret, regionId, workspaceName, namespace, podName) {
  const config = new $OpenApi.Config({
    accessKeyId: akId,
    accessKeySecret: akSecret,
    endpoint: `cms.${regionId}.aliyuncs.com`
  })
  const client = new OpenApiClient(config)

  const now = Math.floor(Date.now() / 1000)
  const sevenDaysAgo = now - 7 * 24 * 3600

  const params = new $OpenApi.Params({
    action: 'GetEntityStoreData',
    version: '2024-03-30',
    protocol: 'HTTPS',
    method: 'POST',
    authType: 'AK',
    style: 'ROA',
    pathname: `/workspace/${workspaceName}/entitiesAndRelations`,
    reqBodyType: 'json',
    bodyType: 'json'
  })

  const runtime = new $Util.RuntimeOptions({})
  const PAGE_SIZE = 100
  let offset = 0
  let totalScanned = 0
  let allCandidates = []

  console.log(`🔍 Looking for Pod entity with namespace=${namespace}, name=${podName} in workspace ${workspaceName}`)

  while (true) {
    const request = new $OpenApi.OpenApiRequest({
      body: {
        from: sevenDaysAgo,
        to: now,
        query: `.entity with(domain='k8s', type='k8s.pod') | limit ${offset}, ${PAGE_SIZE}`
      }
    })

    const result = await client.callApi(params, request, runtime)
    const header = result.body?.header || []
    const data = result.body?.data || []

    totalScanned += data.length
    console.log(`🔍 Page offset=${offset}, returned ${data.length} rows (total scanned: ${totalScanned})`)

    // Find column indices
    const colIdx = {}
    header.forEach((h, i) => { colIdx[h] = i })

    // Try exact match first
    let targetRow = data.find(row => {
      const entityName = row[colIdx['name']] || ''
      const entityNamespace = row[colIdx['namespace']] || ''
      return entityName === podName && entityNamespace === namespace
    })

    // If exact match fails, try fuzzy match
    if (!targetRow) {
      targetRow = data.find(row => {
        const entityName = row[colIdx['name']] || ''
        const entityNamespace = row[colIdx['namespace']] || ''
        const nameMatch = entityName.includes(podName) || podName.includes(entityName)
        const nsMatch = entityNamespace === namespace || !namespace || !entityNamespace
        return nameMatch && nsMatch
      })
    }

    if (targetRow) {
      console.log(`✅ Found Pod entity at offset ${offset}: entityId=${targetRow[colIdx['__entity_id__']]}, name=${targetRow[colIdx['name']]}, namespace=${targetRow[colIdx['namespace']]}`)
      return {
        entityId: targetRow[colIdx['__entity_id__']] || '',
        entityType: targetRow[colIdx['__entity_type__']] || 'k8s.pod',
        domain: targetRow[colIdx['__domain__']] || 'k8s'
      }
    }

    // Collect candidates for debugging if not found
    if (allCandidates.length < 20) {
      data.forEach(row => {
        if (allCandidates.length < 20) {
          allCandidates.push({
            name: row[colIdx['name']] || '',
            namespace: row[colIdx['namespace']] || '',
            entityId: row[colIdx['__entity_id__']] || ''
          })
        }
      })
    }

    // If returned less than PAGE_SIZE, we've reached the last page
    if (data.length < PAGE_SIZE) {
      console.log(`🔍 Reached last page (returned ${data.length} < ${PAGE_SIZE}). Total scanned: ${totalScanned}`)
      break
    }

    offset += PAGE_SIZE
  }

  console.log(`🔍 No matching Pod entity found after scanning ${totalScanned} entities. First ${allCandidates.length} candidates: ${JSON.stringify(allCandidates)}`)
  return null
}

/**
 * Get K8s cluster entityId by querying CMS ListWorkspaces + GetEntityStoreData
 * Uses the same rigorous approach as gateway entity lookup - all parameters from API queries
 * Result is cached in memory for the lifetime of the process
 * @param {string} regionId - Region ID
 * @param {string} clusterId - ACK cluster ID
 * @returns {Promise<{entityId: string, entityType: string, domain: string, workspaceName: string, regionId: string}>}
 */
async function getK8sClusterEntityId(regionId, clusterId) {
  // Use CMS AK/SK from ALIBABA_CLOUD_ACCESS_KEY_ID/ALIBABA_CLOUD_ACCESS_KEY_SECRET env vars
  const { accessKeyId: cmsAkId, accessKeySecret: cmsAkSecret } = getCmsCredentials()

  // Step 1: ListWorkspaces to get all workspaces
  console.log(`🔍 Querying CMS workspaces for K8s cluster in ${regionId}...`)
  const workspaces = await listWorkspaces(cmsAkId, cmsAkSecret, regionId)

  if (workspaces.length === 0) {
    throw new Error('WORKSPACE_EMPTY: No CMS workspaces found in region ' + regionId + '. Please click "一键创建" to set up CMS integration first.')
  }

  // Step 2: For each workspace, query GetEntityStoreData to find the K8s cluster entity
  for (const ws of workspaces) {
    const wsName = ws.workspaceName
    const wsRegion = ws.regionId || regionId

    console.log(`🔍 Querying K8s cluster entity in workspace: ${wsName}...`)
    const result = await queryK8sClusterEntity(cmsAkId, cmsAkSecret, wsRegion, wsName, clusterId)

    if (result && result.entityId) {
      const entity = { ...result, workspaceName: wsName, regionId: wsRegion }
      console.log(`☸️  Found K8s cluster entity: entityId=${result.entityId}, entityType=${result.entityType}, domain=${result.domain}, workspace=${wsName}`)
      return entity
    }
  }

  throw new Error(`CLUSTER_NOT_FOUND: K8s cluster ${clusterId} not found in any CMS workspace (region: ${regionId})`)
}

/**
 * Build the CMS K8s Pod observability URL dynamically
 * Follows the spec: instanceId → sandbox_id → namespace/pod_name → regionId (kubectl) → ListWorkspaces → GetEntityStoreData → URL
 * @param {string} instanceId - The agent instance ID from the instance list
 * @returns {Promise<string>} The full CMS Pod observability URL
 */
async function buildPodObservabilityUrl(instanceId) {
  if (!instanceId) {
    throw new Error('instanceId is required')
  }

  const { accessKeyId: cmsAkId, accessKeySecret: cmsAkSecret } = getCmsCredentials()
  if (!cmsAkId || !cmsAkSecret) {
    throw new Error('Alibaba Cloud credentials not configured')
  }

  // Step 1: Query instance from DB to get sandbox_id
  const { data: instance, error: fetchError } = await supabaseAdmin
    .from('agent_instances')
    .select('id, sandbox_id')
    .eq('id', instanceId)
    .single()

  if (fetchError || !instance) {
    throw new Error(`INSTANCE_NOT_FOUND: Instance ${instanceId} not found`)
  }

  if (!instance.sandbox_id) {
    throw new Error('SANDBOX_NOT_FOUND: Instance has no sandbox_id, possibly not deployed')
  }

  // Step 2: Parse sandbox_id → namespace and pod_name
  // Format: {namespace}--{pod_name}, split on first "--"
  const firstDashIdx = instance.sandbox_id.indexOf('--')
  if (firstDashIdx === -1) {
    throw new Error(`SANDBOX_NOT_FOUND: Invalid sandbox_id format: ${instance.sandbox_id}`)
  }
  const namespace = instance.sandbox_id.substring(0, firstDashIdx)
  const podName = instance.sandbox_id.substring(firstDashIdx + 2)

  console.log(`🔍 Pod observability: namespace=${namespace}, pod_name=${podName}`)

  // Step 3: Get regionId from KUBERNETES_SERVICE_HOST (cluster region, not gateway region)
  const regionId = await getRegionIdFromK8sEnv()

  // Step 4: ListWorkspaces

  let entity = null
  let workspaceName = ''
  let wsRegionId = ''

  let cmsRegionId = regionId
  try {
    const { clusterRegionId } = await getClusterId()
    if (clusterRegionId) cmsRegionId = clusterRegionId
  } catch {
    // ECI environments may not have KUBERNETES_SERVICE_HOST; use regionId from fallback
  }
  console.log(`🔍 Pod observability: inputRegion=${regionId}, clusterRegion=${cmsRegionId}`)

  console.log(`🔍 Querying CMS workspaces for Pod in ${cmsRegionId}...`)
  const workspaces = await listWorkspaces(cmsAkId, cmsAkSecret, cmsRegionId)

  if (workspaces.length === 0) {
    throw new Error('WORKSPACE_EMPTY: No CMS workspaces found in region ' + cmsRegionId + '. Please click "一键创建" to set up CMS integration first.')
  }

  for (const ws of workspaces) {
    const wsName = ws.workspaceName
    const wsRegion = ws.regionId || cmsRegionId

    try {
      console.log(`🔍 Querying Pod entity in workspace: ${wsName}...`)
      const result = await queryPodEntity(cmsAkId, cmsAkSecret, wsRegion, wsName, namespace, podName)

      if (result && result.entityId) {
        entity = result
        workspaceName = wsName
        wsRegionId = wsRegion
        console.log(`✅ Found Pod entity: entityId=${result.entityId}, entityType=${result.entityType}, domain=${result.domain}, workspace=${wsName}`)
        break
      }
    } catch (err) {
      // API_ERROR: log and continue with next workspace
      console.warn(`⚠️ Error querying workspace ${wsName}: ${err.message}`)
    }
  }

  if (!entity) {
    throw new Error(`ENTITY_NOT_FOUND: Pod ${namespace}/${podName} not found in any CMS workspace. Please check: 1) Pod is connected to Container Insights 2) namespace/name is correct 3) Cluster is connected to CMS 2.0`)
  }

  // Step 7: Assemble URL parameters
  const app = 'container' // k8s.pod → container mapping
  const now = Math.floor(Date.now() / 1000)
  const startTime = now - 7 * 24 * 60 * 60 // 7 days per spec
  const endTime = now

  const url = `https://cmsnext.console.aliyun.com/next/region/${wsRegionId}/workspace/${workspaceName}/app/${app}/entity-overview?entityId=${entity.entityId}&entityType=${entity.entityType}&domain=${entity.domain}&startTime=${startTime}&endTime=${endTime}&queryTimeType=2`

  return url
}

/**
 * Auto-configure AI gateway from environment variables (injected by ROS ConfigMap/Secret).
 * Called once at startup. Uses the same approach as the UI "Save AI Gateway" button:
 * calls APIG GetHttpApi API to dynamically fetch environmentId and gatewayDomain.
 * Skips if APIG_ENABLED != 'true' or if the gateway is already configured.
 */
async function autoConfigureFromEnv() {
  const enabled = process.env.APIG_ENABLED
  if (enabled !== 'true') {
    console.log('🌐 AI Gateway: Auto-config skipped (APIG_ENABLED != true)')
    return
  }

  const gatewayId = process.env.APIG_GATEWAY_ID || ''
  const httpApiId = process.env.APIG_HTTP_API_ID || ''
  const dashscopeApiKey = process.env.DASHSCOPE_API_KEY || ''
  const regionId = process.env.APIG_REGION_ID || ''

  if (!gatewayId || !httpApiId) {
    console.log('🌐 AI Gateway: Auto-config skipped (missing APIG_GATEWAY_ID or APIG_HTTP_API_ID)')
    return
  }

  if (!regionId) {
    console.error('🌐 AI Gateway: Auto-config failed (missing APIG_REGION_ID). Please set APIG_REGION_ID in environment.')
    return
  }

  // Skip if already properly configured (don't overwrite manual config)
  const current = getGatewayConfig()
  if (current.gatewayId && current.enabled) {
    console.log('🌐 AI Gateway: Already configured and enabled, skipping auto-config')
    return
  }

  console.log('🔧 AI Gateway: Auto-configuring from environment variables...')

  // Read cloud credentials from env (injected by K8s Secret)
  const aliyunAccessKeyId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID || ''
  const aliyunAccessKeySecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || ''

  // Dynamically fetch environmentId and gatewayDomain via APIG SDK
  // Same approach as the UI "Save AI Gateway" operation
  let environmentId = ''
  let gatewayDomain = ''

  if (aliyunAccessKeyId && aliyunAccessKeySecret) {
    try {
      const { fetchHttpApiDetailsWithCredentials } = await import('./apig.js')
      console.log('🔄 Auto-fetching environmentId and gatewayDomain from GetHttpApi...')
      const fetched = await fetchHttpApiDetailsWithCredentials({
        httpApiId,
        accessKeyId: aliyunAccessKeyId,
        accessKeySecret: aliyunAccessKeySecret,
        regionId
      })
      environmentId = fetched.environmentId || ''
      gatewayDomain = fetched.gatewayDomain || ''
      console.log(`   ✅ Auto-detected: environmentId=${environmentId}, gatewayDomain=${gatewayDomain}`)
    } catch (fetchError) {
      console.warn('⚠️ Failed to auto-fetch HTTP API details:', fetchError.message)
      // Fallback to env vars if available
      environmentId = process.env.APIG_ENVIRONMENT_ID || ''
      gatewayDomain = process.env.APIG_GATEWAY_DOMAIN || ''
    }
  } else {
    // No credentials available for API call, try env vars
    environmentId = process.env.APIG_ENVIRONMENT_ID || ''
    gatewayDomain = process.env.APIG_GATEWAY_DOMAIN || ''
  }

  // Build new params by merging defaults + existing config + new values
  const newParams = {
    ...DEFAULT_PARAMETERS,
    ...cachedConfig.parameters,
    gatewayId,
    httpApiId,
    environmentId,
    gatewayDomain,
    dashscopeApiKey,
    aliyunAccessKeyId,
    aliyunAccessKeySecret,
    regionId
  }

  // Update in-memory cache with plaintext values
  cachedConfig.parameters = newParams

  // Encrypt sensitive fields before saving to DB
  const encryptedParams = encryptSensitiveFields(newParams)

  // Upsert to provider_config table with enabled=true
  const { error: upsertError } = await supabaseAdmin
    .from('provider_config')
    .upsert({
      name: PROVIDER_NAME,
      type: 'AlibabaCloudAIGateway',
      config: {
        apiKeyPlaceholder: cachedConfig.apiKeyPlaceholder,
        ...encryptedParams
      },
      enabled: true,
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'name'
    })

  if (upsertError) {
    console.error('Failed to save auto-configured gateway:', upsertError.message)
  } else {
    // Disable bailian provider: only one provider can be active at a time
    const { error: disableBailianError } = await supabaseAdmin
      .from('provider_config')
      .update({ enabled: false, updated_at: new Date().toISOString() })
      .eq('name', 'bailian')
      .eq('enabled', true)

    if (disableBailianError) {
      console.warn('⚠️ Failed to disable bailian provider:', disableBailianError.message)
      // Rollback: set api_gateway to disabled to prevent two active providers
      await supabaseAdmin
        .from('provider_config')
        .update({ enabled: false, updated_at: new Date().toISOString() })
        .eq('name', PROVIDER_NAME)
      console.error('🔄 Rolled back api_gateway to disabled (cannot have two active providers)')
      return
    } else {
      console.log('🔄 Bailian provider disabled (AI Gateway is now active)')
    }

    // Seed a default model for api_gateway if none exists
    const { data: existingModels } = await supabaseAdmin
      .from('ai_models')
      .select('id')
      .eq('provider', 'api_gateway')
      .limit(1)

    if (!existingModels || existingModels.length === 0) {
      const { error: modelError } = await supabaseAdmin
        .from('ai_models')
        .insert([
          {
            name: 'qwen3.5-plus',
            provider: 'api_gateway',
            model_code: 'qwen3.5-plus',
            status: 'active',
            is_enabled: true,
            description: '通义千问 Qwen3.5-plus（通过 AI 网关代理）'
          },
          {
            name: 'qwen3.7-plus',
            provider: 'api_gateway',
            model_code: 'qwen3.7-plus',
            status: 'active',
            is_enabled: true,
            description: '通义千问 Qwen3.7-plus（通过 AI 网关代理）'
          },
          {
            name: 'qwen3.7-max',
            provider: 'api_gateway',
            model_code: 'qwen3.7-max',
            status: 'active',
            is_enabled: true,
            description: '通义千问 Qwen3.7-max（通过 AI 网关代理）'
          },
          {
            name: 'qwen3.6-plus',
            provider: 'api_gateway',
            model_code: 'qwen3.6-plus',
            status: 'active',
            is_enabled: true,
            description: '通义千问 Qwen3.6-plus（通过 AI 网关代理）'
          },
          {
            name: 'deepseek-v4-pro',
            provider: 'api_gateway',
            model_code: 'deepseek-v4-pro',
            status: 'active',
            is_enabled: true,
            description: 'DeepSeek V4 Pro（通过 AI 网关代理）'
          }
        ])

      if (modelError) {
        console.warn('⚠️ Failed to seed default models for api_gateway:', modelError.message)
      } else {
        console.log('📦 Default models seeded for api_gateway: qwen3.5-plus, qwen3.7-plus, qwen3.7-max, qwen3.6-plus, deepseek-v4-pro')
      }
    }

    cachedConfig.enabled = true
    console.log('✅ AI Gateway: Auto-configured and enabled from environment')
    logConfig()
  }
}

// ─────────────────────────────────────────────────────────
// ARMS APM (AI Application Observability)
// ─────────────────────────────────────────────────────────

/**
 * Read ARMS APM parameters from environment variables (fallback / local dev convenience)
 * @returns {{publicDomain: string, regionId: string, authToken: string, project: string, workspace: string} | null}
 */
function getApmParamsFromEnv() {
  const publicDomain = process.env.ARMS_PUBLIC_DOMAIN || ''
  const authToken = process.env.ARMS_AUTH_TOKEN || ''
  const project = process.env.ARMS_PROJECT_ID || ''
  const workspace = process.env.ARMS_WORKSPACE_NAME || ''
  const regionId = process.env.ARMS_REGION_ID || ''

  if (!publicDomain || !authToken || !project || !workspace) {
    return null
  }

  return { publicDomain, regionId, authToken, project, workspace }
}

/**
 * Get ARMS APM parameters from CMS OpenAPI GetServiceObservability
 * type 作为路径参数拼在 pathname 末尾: /workspace/{workspace}/service-observability/apm
 * @returns {Promise<{publicDomain: string, regionId: string, authToken: string, project: string, workspace: string} | null>}
 */
async function getApmParamsFromCmsApi() {
  const { accessKeyId: akId, accessKeySecret: akSecret } = getCmsCredentials()
  if (!akId || !akSecret) {
    return null
  }

  // Step 1: Determine region
  let regionId
  try {
    regionId = await getRegionIdFromK8sEnv()
  } catch {
    regionId = process.env.ARMS_REGION_ID || 'cn-hangzhou'
  }

  // Step 2: ListWorkspaces
  const workspaces = await listWorkspaces(akId, akSecret, regionId)
  if (workspaces.length === 0) {
    console.warn('[apm] No CMS workspace found, cannot get ARMS params')
    return null
  }
  const workspaceName = workspaces[0].workspaceName

  // Step 3: Call GetServiceObservability (GET)
  const config = new $OpenApi.Config({
    accessKeyId: akId,
    accessKeySecret: akSecret,
    endpoint: `cms.${regionId}.aliyuncs.com`
  })
  const client = new OpenApiClient(config)

  const params = new $OpenApi.Params({
    action: 'GetServiceObservability',
    version: '2024-03-30',
    protocol: 'HTTPS',
    method: 'GET',
    authType: 'AK',
    style: 'ROA',
    pathname: `/workspace/${workspaceName}/service-observability/apm`,
    reqBodyType: 'json',
    bodyType: 'json'
  })

  const request = new $OpenApi.OpenApiRequest({})
  const runtime = new $Util.RuntimeOptions({})
  const result = await client.callApi(params, request, runtime)

  const entryPointInfo = result?.body?.entryPointInfo
  if (!entryPointInfo || !entryPointInfo.authToken || !entryPointInfo.publicDomain) {
    console.warn('[apm] GetServiceObservability response missing entryPointInfo')
    return null
  }

  return {
    publicDomain: entryPointInfo.publicDomain,
    regionId,
    authToken: entryPointInfo.authToken,
    project: entryPointInfo.project || '',
    workspace: workspaceName
  }
}

/**
 * Get ARMS APM install parameters.
 * Priority:
 *   1. Environment variables (local dev / fallback)
 *   2. CMS OpenAPI GetServiceObservability (dynamic)
 * @returns {Promise<{publicDomain: string, regionId: string, authToken: string, project: string, workspace: string} | null>}
 */
async function getApmInstallParameters() {
  // 1. Try environment variables first
  const envParams = getApmParamsFromEnv()
  if (envParams) {
    console.log('[apm] ARMS parameters loaded from environment variables')
    return envParams
  }

  // 2. Try CMS OpenAPI
  try {
    const cmsParams = await getApmParamsFromCmsApi()
    if (cmsParams) {
      console.log('[apm] ARMS parameters loaded from CMS OpenAPI')
      return cmsParams
    }
  } catch (err) {
    console.warn('[apm] Failed to get ARMS params from CMS API:', err.message)
  }

  console.warn('[apm] ARMS parameters not available (neither env vars nor CMS API)')
  return null
}

/**
 * Query APM GenAI Service entity from CMS GetEntityStoreData API in a specific workspace
 * Tries multiple service-name candidates (see Appendix K.3 dual-match logic):
 *   - Pod name (new instances with image-preinstalled plugin)
 *   - instanceId (old instances installed via one-click)
 * @param {string} akId - Access Key ID
 * @param {string} akSecret - Access Key Secret
 * @param {string} regionId - Region ID
 * @param {string} workspaceName - CMS Workspace name
 * @param {string[]} serviceNames - Array of candidate SERVICE_NAME values to match against
 * @returns {Promise<{entityId: string, entityType: string, domain: string} | null>}
 */
async function queryApmServiceEntity(akId, akSecret, regionId, workspaceName, serviceNames) {
  const config = new $OpenApi.Config({
    accessKeyId: akId,
    accessKeySecret: akSecret,
    endpoint: `cms.${regionId}.aliyuncs.com`
  })
  const client = new OpenApiClient(config)

  const now = Math.floor(Date.now() / 1000)
  const thirtyDaysAgo = now - 30 * 24 * 3600

  // QwenPaw uses 'apm.genai.agent', OpenClaw/Hermes use 'apm.genai.service'
  const entityTypes = ['apm.genai.service', 'apm.genai.agent']
  const domain = 'apm'

  const params = new $OpenApi.Params({
    action: 'GetEntityStoreData',
    version: '2024-03-30',
    protocol: 'HTTPS',
    method: 'POST',
    authType: 'AK',
    style: 'ROA',
    pathname: `/workspace/${workspaceName}/entitiesAndRelations`,
    reqBodyType: 'json',
    bodyType: 'json'
  })

  // Query all genai entity types (service + agent), client-side matching
  // Single query with large limit (5000) covers all practical environments
  let allData = []
  let header = []
  let matchedEntityType = 'apm.genai.service' // default fallback
  const candidates = (Array.isArray(serviceNames) ? serviceNames : [serviceNames]).filter(Boolean)

  for (const entityType of entityTypes) {
    const request = new $OpenApi.OpenApiRequest({
      body: {
        from: thirtyDaysAgo,
        to: now,
        query: `.entity with(domain='${domain}', type='${entityType}') | limit 0, 5000`
      }
    })

    const runtime = new $Util.RuntimeOptions({})
    const result = await client.callApi(params, request, runtime)

    header = result.body?.header || header
    const data = result.body?.data || []
    allData = allData.concat(data)
  }
  const data = allData

  const colIdx = {}
  header.forEach((h, i) => { colIdx[h] = i })

  // Dual-match: try Pod name first, then instanceId (Appendix K.3)
  // CMS EntityStore response header contains 'service' column (not 'service_name' or 'name')
  // which holds the OpenTelemetry service.name value reported by the ARMS plugin.
  const targetRow = data.find(row => {
    const serviceName = row[colIdx['service']] || row[colIdx['service_name']] || row[colIdx['name']] || ''
    return candidates.some(sn => serviceName === sn)
  })

  if (!targetRow) {
    console.warn(`[apm] queryApmServiceEntity: no match for service=[${candidates.join(', ')}] in workspace ${workspaceName}`)
    console.warn(`[apm] Found ${data.length} entities of types ${entityTypes.join(', ')}`)
    if (data.length > 0) {
      const samples = data.slice(0, 5).map(row => row[colIdx['service']] || row[colIdx['service_name']] || row[colIdx['name']] || '(unknown)')
      console.warn(`[apm] Sample service names: ${samples.join(', ')}`)
    }
    return null
  }

  // Resolve the matched entity type from the row data, with fallback
  matchedEntityType = targetRow[colIdx['__entity_type__']] || matchedEntityType

  return {
    entityId: targetRow[colIdx['__entity_id__']] || '',
    entityType: matchedEntityType,
    domain: targetRow[colIdx['__domain__']] || domain
  }
}

/**
 * Build the CMS APM GenAI Service observability URL dynamically
 * Flow: instanceId → sandbox_id → podName → cluster region → ListWorkspaces → queryApmServiceEntity → URL
 * @param {string} instanceId - Agent instance ID
 * @returns {Promise<string>} CMS observability URL (without ticket)
 */
async function buildApmObservabilityUrl(instanceId) {
  if (!instanceId) {
    throw new Error('instanceId is required')
  }

  const { accessKeyId: akId, accessKeySecret: akSecret } = getCmsCredentials()
  if (!akId || !akSecret) {
    throw new Error('Alibaba Cloud credentials not configured (ALIBABA_CLOUD_ACCESS_KEY_ID)')
  }

  // Step 1: Query instance from DB to get sandbox_id + agent_type → parse podName
  const { data: instance, error: fetchError } = await supabaseAdmin
    .from('agent_instances')
    .select('id, sandbox_id, agent_type:agent_types(code)')
    .eq('id', instanceId)
    .single()

  if (fetchError || !instance) {
    throw new Error(`INSTANCE_NOT_FOUND: Instance ${instanceId} not found`)
  }

  if (!instance.sandbox_id) {
    throw new Error('SANDBOX_NOT_FOUND: Instance has no sandbox_id, possibly not deployed')
  }

  // sandbox_id format: {namespace}--{pod_name}
  const firstDashIdx = instance.sandbox_id.indexOf('--')
  if (firstDashIdx === -1) {
    throw new Error(`SANDBOX_FORMAT_ERROR: Invalid sandbox_id format: ${instance.sandbox_id}`)
  }
  const podName = instance.sandbox_id.substring(firstDashIdx + 2)

  // Per Appendix K.3: try both Pod name and instanceId as SERVICE_NAME
  const serviceNameCandidates = [podName, instanceId]
  console.log(`[apm] Building APM URL: instanceId=${instanceId}, candidates=[${serviceNameCandidates.join(', ')}]`)

  // Step 2: Get cluster region
  const { clusterRegionId } = await getClusterId()
  const regionId = clusterRegionId

  // Step 3: ListWorkspaces
  const workspaces = await listWorkspaces(akId, akSecret, regionId)
  if (workspaces.length === 0) {
    throw new Error('WORKSPACE_EMPTY: No CMS workspaces found in region ' + regionId)
  }

  // Step 4: Iterate workspaces to find APM entity
  let entity = null
  let workspaceName = ''
  let wsRegionId = ''

  for (const ws of workspaces) {
    const wsName = ws.workspaceName
    const wsRegion = ws.regionId || regionId

    try {
      console.log(`[apm] Querying APM entity in workspace: ${wsName}...`)
      const result = await queryApmServiceEntity(akId, akSecret, wsRegion, wsName, serviceNameCandidates)
      if (result) {
        entity = result
        workspaceName = wsName
        wsRegionId = wsRegion
        console.log(`[apm] Found APM entity: entityId=${result.entityId}, entityType=${result.entityType}, domain=${result.domain}, workspace=${wsName}`)
        break
      }
    } catch (err) {
      console.warn(`[apm] Error querying workspace ${wsName}: ${err.message}`)
    }
  }

  if (!entity) {
    // Check if the ARMS plugin is actually installed in the sandbox
    const pluginInstalled = await checkPluginInstalled(instance.sandbox_id, instance.agent_type?.code || 'openclaw')
    if (!pluginInstalled) {
      throw new Error(
        `PLUGIN_NOT_INSTALLED: ARMS plugin not found in sandbox for instance ${instanceId}. ` +
        `Please click "Install Plugin" to install it first.`
      )
    }
    throw new Error(
      `NO_TRACE_YET: Plugin is installed but no trace has been reported yet for instance ${instanceId}. ` +
      `Please start a conversation to activate monitoring. ` +
      `Entity registration may take 2-3 minutes after the first conversation.`
    )
  }

  // Step 5: Assemble URL — app=llm_agent for LLM Agent APM application
  const app = 'llm_agent'
  const now = Math.floor(Date.now() / 1000)
  const startTime = now - 7 * 24 * 60 * 60
  const endTime = now

  const url = `https://cmsnext.console.aliyun.com/next/region/${wsRegionId}/workspace/${workspaceName}/app/${app}/entity-overview?entityId=${entity.entityId}&entityType=${entity.entityType}&domain=${entity.domain}&startTime=${startTime}&endTime=${endTime}&queryTimeType=2`

  return url
}

/**
 * Check if ARMS observability plugin is installed/configured for an instance.
 * Supports two modes:
 *   1. Configuration-driven (preferred): If agentTypeRecord with non-empty observability_env is provided, returns true immediately.
 *   2. Legacy sandbox inspection (backward-compatible): Falls back to checking plugin files inside the sandbox.
 * @param {string} sandboxId - Sandbox ID
 * @param {string} [agentType='openclaw'] - Agent type ('openclaw', 'hermes', or 'qwenpaw')
 * @param {object} [agentTypeRecord] - Optional agent type record from DB; if its observability_env is non-empty, skip sandbox check
 * @returns {Promise<boolean>}
 */
async function checkPluginInstalled(sandboxId, agentType = 'openclaw', agentTypeRecord) {
  // Configuration-driven mode: if observability_env is configured, consider plugin ready
  if (agentTypeRecord?.observability_env && Object.keys(agentTypeRecord.observability_env).length > 0) {
    return true
  }

  // Legacy fallback: inspect sandbox filesystem
  if (!sandboxId) return false
  try {
    const { Sandbox } = await import('@e2b/code-interpreter')
    const sbx = await Sandbox.connect(sandboxId)
    try {
      if (agentType === 'hermes') {
        // Hermes: check Python agent in /opt/hermes/.venv/lib/python*/site-packages/aliyun/
        const result = await sbx.commands.run(
          'ls /opt/hermes/.venv/lib/python*/site-packages/aliyun/opentelemetry/instrumentation/auto_instrumentation/ 2>/dev/null && echo EXISTS || echo NOT_FOUND',
          { timeoutMs: 5000 }
        )
        return result.stdout?.includes('EXISTS') || false
      } else if (agentType === 'qwenpaw') {
        // QwenPaw: check for loongsuite (qwenpaw-cms-plugin)
        const result = await sbx.commands.run(
          '/app/venv/bin/python -c "import loongsuite; print(\'EXISTS\')" 2>/dev/null || echo "NOT_FOUND"',
          { timeoutMs: 5000 }
        )
        return result.stdout?.includes('EXISTS') || false
      } else {
        // OpenClaw: check Node.js plugin in /home/node/.openclaw/extensions/
        const files = await sbx.files.list('/home/node/.openclaw/extensions/opentelemetry-instrumentation-openclaw/')
        return files && files.length > 0
      }
    } finally {
      // Sandbox connection is auto-managed
    }
  } catch (err) {
    console.warn(`[apm] checkPluginInstalled: failed to check sandbox ${sandboxId} (${agentType}): ${err.message}`)
    return false
  }
}

export {
  loadGatewayConfig,
  getGatewayConfig,
  onGatewayConfigChange,
  autoConfigureFromEnv,
  getCmsCredentials,
  getRegionIdFromK8sEnv,
  getClusterId,
  listWorkspaces,
  queryGatewayEntity,
  queryK8sClusterEntity,
  buildGatewayObservabilityUrl,
  buildPodObservabilityUrl,
  ensureWorkspace,
  getApmInstallParameters,
  buildApmObservabilityUrl,
  queryApmServiceEntity,
  checkPluginInstalled
}
