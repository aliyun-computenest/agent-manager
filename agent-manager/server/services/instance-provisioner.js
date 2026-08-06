/**
 * Instance Provisioner Service
 *
 * Orchestrates OpenClaw instance creation end-to-end:
 *   1. Quota check
 *   2. Consumer provisioning (APIG) + re-authorization
 *   3. E2B sandbox creation + template write
 *   4. Persist instance row
 *   5. Persist channel config
 *
 * Used by both user-self-create (POST /api/instances) and
 * admin-create-for-user (POST /api/admin/instances).
 */

import { execSync } from 'child_process'
import { randomUUID } from 'crypto'
import { Sandbox } from '@e2b/code-interpreter'
import {
  supabaseAdmin,
  E2B_DOMAIN,
  E2B_API_KEY,
  DEPLOY_ENVIRONMENT,
  E2B_HOSTS_IP,
  OSS_PV_NAME,
  BACKUP_MOUNT_PATH,
  VITE_OSS_PV_NAME,
  VITE_SKILLHUB_OSS_PV_NAME
} from '../config/index.js'
import {
  waitForSandboxReady,
  waitForGatewayReady
} from './sandbox.js'
import { encryptApiKey, encodeConsumerKey, decodeConsumerKey } from '../utils/crypto.js'
import { appLogger } from '../utils/logger.js'
import { generateAndWriteAgentConfig, getAgentType } from '../utils/agent-config.js'
import { getGatewayConfig } from './gateway-config.js'
import { createProviderFromDB } from './providers/index.js'
import { getImageFromSandboxSet } from './k8s.js'
import { createKubernetesApi, getSandboxNamespace } from './kubernetes-api.js'
import { CSI_VOLUME_CONFIG_METADATA_KEY, buildBackupVolumeConfig } from './backup-mounts.js'
import { getSandboxSetBackupRestoreCapability } from './sandbox-upgrades.js'
import { assertGroupMembership, getInstanceQuotaPrincipalId, isPlatformAdminProfile } from './principal-access.js'
import { restoreClaimedSandboxFromCheckpointBackup } from './checkpoint-backups/index.js'
import { readSandboxImageBySandboxId } from './checkpoint-backups/sandbox-image.js'

const MIN_RESTORE_SANDBOX_CREATE_TIMEOUT_MS = 300_000

/**
 * Build skill_config snapshot for a new instance based on
 * agentType.skill_config and selectedSkillSpaceIds.
 * Key rules:
 * - isRequired=true entries are ALWAYS included
 * - isRequired=false entries are included ONLY if skillSpaceId is in selectedSkillSpaceIds
 * - Entries without skillSpaceId (manual mounts) are ALWAYS included
 * - Invalid IDs in selectedSkillSpaceIds are silently ignored
 * - Snapshot is always an array (never null): [] or [{...}]
 */
export function buildSkillConfigSnapshot(skillConfig, selectedSkillSpaceIds = []) {
  // No skill config → empty array
  if (!Array.isArray(skillConfig) || skillConfig.length === 0) return []

  const selectedSet = new Set(selectedSkillSpaceIds)
  return skillConfig.filter(entry => {
    // Manual mounts (no skillSpaceId) always included
    if (!entry.skillSpaceId) return true
    // Required skills always included
    if (entry.isRequired) return true
    // Optional skills included only if selected
    return selectedSet.has(entry.skillSpaceId)
  })
}

/**
 * Lightweight error class that carries an HTTP status so routes can
 * translate to the correct response code.
 */
export class ProvisionError extends Error {
  constructor(message, status = 500) {
    super(message)
    this.name = 'ProvisionError'
    this.status = status
  }
}

export function createRestoredSandboxName(sandboxTemplateId = 'agent-sandbox') {
  const prefix = String(sandboxTemplateId || 'agent-sandbox')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    || 'agent-sandbox'
  const suffix = randomUUID().replace(/-/g, '').slice(0, 6)
  const maxPrefixLength = 63 - suffix.length - 1
  const trimmedPrefix = prefix.slice(0, maxPrefixLength).replace(/-+$/g, '') || 'agent'
  return `${trimmedPrefix}-${suffix}`
}

function getUniqueNamespaces(values = []) {
  return [...new Set(values
    .map(value => String(value || '').trim())
    .filter(Boolean))]
}

export async function resolveInstanceAgentImage({
  sandboxTemplateId,
  sandboxNamespace = null,
  restoredAgentImage = null,
  sourceAgentImage = null,
  lookupImage = getImageFromSandboxSet
} = {}) {
  if (restoredAgentImage) return restoredAgentImage
  if (sourceAgentImage) return sourceAgentImage
  if (!sandboxTemplateId) return null
  const namespaces = getUniqueNamespaces([sandboxNamespace, getSandboxNamespace(), 'default'])
  for (const namespace of namespaces) {
    try {
      const image = await lookupImage(sandboxTemplateId, namespace)
      if (image) return image
    } catch {
      // Try the next namespace candidate. Manager often runs outside the
      // Sandbox namespace, while sandboxId still carries the real namespace.
    }
  }
  return null
}

function getSandboxTargetFromSandboxId(sandboxId, fallbackNamespace = getSandboxNamespace()) {
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

function getSandboxNameFromSandboxId(sandboxId, namespace = getSandboxNamespace()) {
  return getSandboxTargetFromSandboxId(sandboxId, namespace).sandboxName
}

async function resolveBackupRestoreCapabilityForSandboxSet(
  sandboxSetName,
  {
    api = null,
    createApi = createKubernetesApi,
    namespaces = [getSandboxNamespace()],
    required = true
  } = {}
) {
  const namespaceCandidates = getUniqueNamespaces([...namespaces, getSandboxNamespace(), 'default'])
  const errors = []
  let resolvedApi
  try {
    resolvedApi = api || createApi()
  } catch (error) {
    const message = `Unable to check backup/restore capability for SandboxSet ${sandboxSetName}: ${error.message}`
    if (!required) {
      return {
        Supported: false,
        RequiredRuntimes: [],
        MissingRuntimes: [],
        Message: message
      }
    }
    throw new ProvisionError(message, 503)
  }

  for (const namespace of namespaceCandidates) {
    try {
      const sandboxSet = await resolvedApi.getSandboxSet(namespace, sandboxSetName)
      return getSandboxSetBackupRestoreCapability(sandboxSet)
    } catch (error) {
      errors.push(`${namespace}: ${error.message}`)
    }
  }

  const message = `Unable to check backup/restore capability for SandboxSet ${sandboxSetName}: ${errors.join('; ')}`
  if (!required) {
    return {
      Supported: false,
      RequiredRuntimes: [],
      MissingRuntimes: [],
      Message: message
    }
  }
  throw new ProvisionError(message, 503)
}

// --- Step 1: Quota ---------------------------------------------------------

async function loadPrincipalProfile(principalId) {
  const { data, error } = await supabaseAdmin
    .from('principal_profiles')
    .select('*')
    .eq('id', principalId)
    .maybeSingle()

  if (error) {
    throw new ProvisionError(`Failed to load principal profile: ${error.message}`, 500)
  }
  return data ? {
    ...data,
    username: data.principal_type === 'user' ? data.name : null,
    principal_id: data.id
  } : null
}

async function assertQuotaAvailable({ userId, userProfile, groupId }) {
  const targetId = groupId || userId
  const { count, error } = await supabaseAdmin
    .from('agent_instances')
    .select('id', { count: 'exact', head: true })
    .eq('principal_id', targetId)

  if (error) {
    throw new ProvisionError(`Failed to check quota: ${error.message}`, 500)
  }

  const max = userProfile?.max_agent_instances ?? 5
  if ((count || 0) >= max) {
    throw new ProvisionError(
      `${groupId ? 'Group' : 'User'} has reached the maximum limit of ${max} instances`,
      409
    )
  }
}

// --- Step 2: Agent Type resolution -----------------------------------------

async function resolveAgentType(inputAgentTypeId) {
  if (!inputAgentTypeId) {
    // Default to openclaw for backward compatibility
    const { data: defaultType } = await supabaseAdmin
      .from('agent_types')
      .select('*')
      .eq('code', 'openclaw')
      .single()
    return defaultType
  }

  try {
    const agentType = await getAgentType(inputAgentTypeId)
    return agentType
  } catch {
    throw new ProvisionError(`Agent 配置不存在: ${inputAgentTypeId}`, 400)
  }
}

// --- Step 3: Model lookup --------------------------------------------------

async function resolveModel(inputModelId, inputModelName) {
  if (!inputModelId && !inputModelName) {
    return { modelId: null, modelName: '', modelProvider: '' }
  }

  let query = supabaseAdmin
    .from('ai_models')
    .select('id, name, provider, model_code')

  if (inputModelId) {
    query = query.eq('id', inputModelId)
  } else {
    // Match by model_code or name (case-insensitive)
    query = query.or(`model_code.ilike.${inputModelName},name.ilike.${inputModelName}`)
    query = query.limit(1)
  }

  const { data, error } = inputModelId
    ? await query.single()
    : await query

  const model = inputModelId ? data : data?.[0]

  if (error && inputModelId) {
    console.warn(`[provisioner] model lookup error: ${error.message}`)
    return { modelId: null, modelName: '', modelProvider: '' }
  }
  if (!model) {
    console.warn(`[provisioner] model not found: ${inputModelId || inputModelName}`)
    return { modelId: null, modelName: '', modelProvider: '' }
  }

  return {
    modelId: model.id,
    modelName: model.model_code || model.name,
    modelProvider: model.provider
  }
}

// --- Step 4: Consumer Provisioning -----------------------------------------

function getConsumerName(principalId, principalProfile) {
  if (principalProfile?.principal_type === 'group') {
    return principalProfile.name || principalId
  }
  return principalProfile?.email || principalProfile?.name || principalProfile?.username || principalId
}

/**
 * Ensure the owning principal has a consumer for the active gateway provider.
 * Consumer credentials are stored on principal_profiles with a type prefix
 * in consumer_apikey_encrypted (format: `providerName:base64encrypted`).
 *
 * When the stored type doesn't match the current provider, a new consumer
 * is created via createConsumer (not reauthorizeConsumer), because the
 * consumer may not exist in the new provider.
 *
 * @returns {{ consumerApikey: string }}
 */
export async function ensurePrincipalConsumer({ principalId, principalProfile, modelProvider }) {
  let consumerApikey = ''

  if (!modelProvider) return { consumerApikey }

  // Get the model's provider to check capabilities
  let provider
  try {
    provider = await createProviderFromDB(modelProvider)
  } catch {
    console.log(`[provisioner] Provider ${modelProvider} not found, skipping consumer creation`)
    return { consumerApikey }
  }

  const supportsConsumer = provider?.supportsConsumerManagement?.() || false
  if (!supportsConsumer) return { consumerApikey }

  // Read existing consumer fields from principal_profiles
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('principal_profiles')
    .select('consumer_id, consumer_apikey_encrypted, authorized_http_api_id')
    .eq('id', principalId)
    .maybeSingle()

  if (profileError) {
    console.warn(`[provisioner] failed to read principal_profiles: ${profileError.message}`)
  }

  if (profile?.consumer_apikey_encrypted) {
    // Decode the stored key and check type prefix
    let decoded
    try {
      decoded = decodeConsumerKey(profile.consumer_apikey_encrypted)
    } catch (e) {
      console.warn(`[provisioner] decodeConsumerKey failed: ${e.message}`)
    }

    if (decoded?.apikey && decoded.type === modelProvider) {
      // Type matches current provider — use existing key
      consumerApikey = decoded.apikey

      // Check if re-authorization is needed (httpApiId changed within same provider)
      if (profile.consumer_id) {
        try {
          const providerConfig = await provider.getConfig()
          const authorized = profile.authorized_http_api_id
          if (authorized && providerConfig.httpApiId && authorized !== providerConfig.httpApiId) {
            console.log(`[provisioner] re-authorizing consumer ${profile.consumer_id} (${authorized} → ${providerConfig.httpApiId})`)
            try {
              const result = await provider.reauthorizeConsumer(profile.consumer_id)
              const reauthUpdate = {
                authorized_http_api_id: result.httpApiId,
                updated_at: new Date().toISOString()
              }
              // If reauthorize returned a new apikey (LiteLLM scenario), update it
              if (result.apikey) {
                consumerApikey = result.apikey
                reauthUpdate.consumer_apikey_encrypted = encodeConsumerKey(modelProvider, result.apikey)
              }
              await supabaseAdmin.from('principal_profiles').update(reauthUpdate).eq('id', principalId)
            } catch (err) {
              console.warn(`[provisioner] re-authorize failed: ${err.message}`)
            }
          }
        } catch (e) {
          console.log(`[provisioner] re-authorize check skipped: ${e.message}`)
        }
      }

      return { consumerApikey }
    }
    // Type mismatch or legacy data (type === null) — fall through to create new consumer
  }

  // No matching consumer — create one via the current provider
  const consumerName = getConsumerName(principalId, principalProfile)
  // displayName 优先取 DB 中的 principal 名称（user/group 名），供下游 Provider 生成可读 consumer_id
  // principalType 用于 displayName 经 sanitize 后为空（如纯中文）时的回退前缀（user/group）
  const displayName = principalProfile?.name || null
  const principalType = principalProfile?.principal_type || 'user'
  console.log(`[provisioner] creating consumer for ${consumerName} via ${modelProvider}`)
  try {
    const result = await provider.createConsumer(consumerName, { displayName, principalType })
    const encoded = encodeConsumerKey(modelProvider, result.apikey)
    await supabaseAdmin
      .from('principal_profiles')
      .update({
        consumer_id: result.consumerId,
        consumer_apikey_encrypted: encoded,
        authorized_http_api_id: result.httpApiId || null,
        updated_at: new Date().toISOString()
      })
      .eq('id', principalId)
    consumerApikey = result.apikey
  } catch (err) {
    throw new ProvisionError(`无法创建 Consumer: ${err.message}`, 500)
  }

  return { consumerApikey }
}

export async function ensureConsumer({ userId, userProfile, modelProvider }) {
  const principalProfile = await loadPrincipalProfile(userId)
  return ensurePrincipalConsumer({
    principalId: userId,
    principalProfile: principalProfile || userProfile,
    modelProvider
  })
}

// --- Step 5: Sandbox -------------------------------------------------------

function addLocalDevHosts(sandboxId, agentType) {
  if (DEPLOY_ENVIRONMENT !== 'local-dev') return

  // Determine agent service port from readiness_check config
  const readinessCheck = agentType?.readiness_check || {}
  const agentPort = readinessCheck.port || 18789

  const hosts = [
    `${E2B_HOSTS_IP} ${agentPort}-${sandboxId}.${E2B_DOMAIN || 'e2b.dev'}`,
    `${E2B_HOSTS_IP} 49983-${sandboxId}.${E2B_DOMAIN || 'e2b.dev'}`
  ]
  for (const entry of hosts) {
    try {
      const hostname = entry.split(' ')[1]
      const check = execSync(
        `grep -q "${hostname}" /etc/hosts && echo exists || echo missing`,
        { encoding: 'utf-8' }
      ).trim()
      if (check === 'missing') {
        execSync(`echo "${entry}" | sudo tee -a /etc/hosts`, { stdio: 'pipe' })
        console.log(`[provisioner] /etc/hosts added: ${entry}`)
      }
    } catch (e) {
      console.warn(`[provisioner] failed to add hosts entry: ${e.message}`)
    }
  }
}

export async function getBackupRestoreCapabilityForSandboxSet(
  sandboxSetName,
  {
    api = null,
    createApi = createKubernetesApi,
    namespace = getSandboxNamespace(),
    namespaces = null,
    required = true
  } = {}
) {
  return resolveBackupRestoreCapabilityForSandboxSet(sandboxSetName, {
    api,
    createApi,
    namespaces: namespaces || [namespace],
    required
  })
}

/**
 * Create an E2B sandbox, wait for it to be ready, write the Agent config
 * into it, and wait for the gateway to come online.
 *
 * When `skipHealthCheck` is true, only creates the sandbox and writes config,
 * but skips waiting for gateway readiness (used in async creation mode).
 *
 * @returns {{ sandbox, sandboxId }}
 * @throws {ProvisionError}
 */
async function provisionSandbox({
  userId,
  principalId = null,
  instanceId,
  instanceName,
  accessToken,
  agentType,
  modelName,
  modelProvider,
  consumerApikey,
  channelType,
  channelClientId,
  channelClientSecret,
  customVars = null,
  skipHealthCheck = false,
  deferBootstrap = false,
  skillConfigSnapshot = null,
  restoreFromBackup = null
}) {
  if (!E2B_API_KEY) {
    throw new ProvisionError('E2B API key not configured, cannot create sandbox', 500)
  }

  const started = Date.now()
  const sandboxTemplateId = agentType.sandbox_template_id || 'openclaw'
  const sandboxTimeout = (agentType.sandbox_timeout || 300) * 1000
  const sandboxCreateTimeout = restoreFromBackup?.backupId
    ? Math.max(sandboxTimeout, MIN_RESTORE_SANDBOX_CREATE_TIMEOUT_MS)
    : sandboxTimeout

  console.log(`[provisioner] Creating sandbox with template: ${sandboxTemplateId} (skipHealthCheck=${skipHealthCheck})`)

  // Build metadata for sandbox creation
  const metadata = {
    'e2b.agents.kruise.io/never-timeout': 'true',
    'agent-manager.io/managed-by': 'agent-manager',
    'agent-manager.io/instance-id': instanceId,
    'agent-manager.io/principal-id': principalId || userId,
    'openclaw.io/user-id': userId,
    'openclaw.io/instance-id': instanceId,
    'openclaw.io/agent-type-id': agentType.id,
    'openclaw.io/agent-type-code': agentType.code,
    userId,
    instanceId,
    instanceName,
    agentType: agentType.code
  }
  const csiVolumeConfig = []
  const sandboxNamespaceCandidates = getUniqueNamespaces([
    restoreFromBackup?.namespace,
    getSandboxNamespace(),
    'default'
  ])
  const backupRestoreCapability = await getBackupRestoreCapabilityForSandboxSet(sandboxTemplateId, {
    required: false,
    namespaces: sandboxNamespaceCandidates
  })

  // Use skillConfigSnapshot if provided (new instances), otherwise fallback to agentType.skill_config (legacy)
  const effectiveSkillConfig = skillConfigSnapshot || agentType.skill_config
  if (effectiveSkillConfig && Array.isArray(effectiveSkillConfig) && effectiveSkillConfig.length > 0) {
    // Optimization: merge all skill mounts into a single CSI volume entry per unique base path.
    // Instead of N separate ossfs mounts (slow), mount the SkillHub bucket once at the base path
    // and create symlinks for each skill space in skill-injector.
    const skillHubPvName = VITE_SKILLHUB_OSS_PV_NAME || VITE_OSS_PV_NAME
    const basePathSet = new Map() // basePath -> { pvName, subPath }
    for (const entry of effectiveSkillConfig) {
      const pvName = entry.pvName && entry.pvName !== '<VITE_OSS_PV_NAME>' ? entry.pvName : skillHubPvName
      // Extract base path: /home/user/.openclaw/skills/space-name → /home/user/.openclaw/skills
      const lastSlash = entry.mountPath.lastIndexOf('/')
      const basePath = entry.mountPath.substring(0, lastSlash)
      if (!basePathSet.has(basePath)) {
        // Extract the subPath root: spaces/ss-xxx/ → spaces/
        const subPathRoot = entry.subPath.split('/')[0] + '/'
        basePathSet.set(basePath, { pvName, subPath: subPathRoot })
      }
    }
    for (const [basePath, { pvName, subPath }] of basePathSet) {
      csiVolumeConfig.push({ pvName, mountPath: basePath, subPath })
    }
    if (!VITE_OSS_PV_NAME) {
      console.warn('[provisioner] VITE_OSS_PV_NAME is not configured, volume mounts may fail')
    }
  }

  let backupVolumeConfig = []
  if (backupRestoreCapability.Supported) {
    backupVolumeConfig = buildBackupVolumeConfig({
      pvName: OSS_PV_NAME,
      mountPath: BACKUP_MOUNT_PATH,
      agentTypeId: agentType.id,
      userId,
      instanceId
    })
    csiVolumeConfig.push(...backupVolumeConfig)
  } else {
    console.warn(`[provisioner] SandboxSet ${sandboxTemplateId} does not support backup/restore: ${backupRestoreCapability.Message}`)
  }

  if (csiVolumeConfig.length > 0) {
    metadata[CSI_VOLUME_CONFIG_METADATA_KEY] = JSON.stringify(csiVolumeConfig)
    metadata['e2b.agents.kruise.io/claim-timeout-seconds'] = '300'
    metadata['e2b.agents.kruise.io/wait-ready-timeout-seconds'] = '300'
    console.log(`[provisioner] CSI volume config: ${metadata[CSI_VOLUME_CONFIG_METADATA_KEY]}`)
  }

  console.log(`[provisioner] Creating sandbox with template ${sandboxTemplateId} and metadata:`, metadata)

  let sandbox
  let sandboxId
  let restoredAgentImage = null
  try {
    if (restoreFromBackup?.backupId && restoreFromBackup?.sourceInstance) {
      const restoreNamespace = restoreFromBackup.namespace || getSandboxNamespace()
      sandbox = await Sandbox.create(sandboxTemplateId, {
        timeoutMs: sandboxCreateTimeout,
        requestTimeoutMs: sandboxCreateTimeout,
        metadata
      })
      sandboxId = sandbox.sandboxId
      const sandboxName = getSandboxNameFromSandboxId(sandboxId, restoreNamespace)
      const result = await restoreClaimedSandboxFromCheckpointBackup(restoreFromBackup.sourceInstance, restoreFromBackup.backupId, {
        namespace: restoreNamespace,
        api: restoreFromBackup.api || null,
        now: restoreFromBackup.now || new Date(),
        sandboxName
      })
      sandboxId = result.sandboxId
      restoredAgentImage = result.agentImage || null
      sandbox = null
      console.log(`[provisioner] restore sandbox ${sandboxId} created from backup ${result.backupId}`)
    } else {
      sandbox = await Sandbox.create(sandboxTemplateId, {
        timeoutMs: sandboxTimeout,
        metadata
      })
      sandboxId = sandbox.sandboxId
    }
  } catch (err) {
    if (restoreFromBackup?.backupId) {
      await killSandboxSafely(sandbox, sandboxId)
      throw err
    }
    const apiHost = `api.${E2B_DOMAIN || 'e2b.app'}`
    const causeCode = err?.cause?.code ? ` (${err.cause.code})` : ''
    throw new ProvisionError(`Failed to connect to E2B API ${apiHost}${causeCode}: ${err.message}`, 500)
  }
  console.log(`[provisioner] sandbox ${sandboxId} created in ${((Date.now() - started) / 1000).toFixed(2)}s`)

  addLocalDevHosts(sandboxId, agentType)

  const bootstrapSandbox = async () => {
    try {
      let bootstrappedSandbox = sandbox
      if (restoreFromBackup?.backupId) {
        await waitForSandboxReady(sandboxId, sandboxCreateTimeout)
      } else {
        await waitForSandboxReady(sandboxId)
      }
      if (!bootstrappedSandbox) {
        bootstrappedSandbox = await Sandbox.connect(sandboxId)
      }
      sandbox = bootstrappedSandbox

      const gwConfig = getGatewayConfig()

      // Always use agent-specific config generation
      await generateAndWriteAgentConfig(bootstrappedSandbox, agentType, {
        userId,
        // 分组场景下 principalId=groupId，个人场景下 = userId；
        // agent-config.js 据此查 group 自己的 consumer_apikey 而不是创建者的
        principalId: principalId || userId,
        token: accessToken,
        modelName,
        modelProvider,
        consumerApikey,
        aiGatewayDomain: gwConfig.gatewayDomain,
        channelType,
        channelClientId,
        channelClientSecret,
        customVars,
        skillConfigSnapshot
      })

      if (!skipHealthCheck) {
        await waitForGatewayReady(bootstrappedSandbox, accessToken, agentType?.readiness_check)
      }

      return { sandbox: bootstrappedSandbox, sandboxId }
    } catch (err) {
      // Any failure after sandbox creation → kill sandbox for clean rollback
      await killSandboxSafely(sandbox, sandboxId)
      throw new ProvisionError(`Sandbox bootstrap failed: ${err.message}`, 500)
    }
  }

  if (deferBootstrap) {
    return { sandbox, sandboxId, backupVolumeConfig, backupRestoreCapability, restoredAgentImage, bootstrapSandbox }
  }

  await bootstrapSandbox()

  return { sandbox, sandboxId, backupVolumeConfig, backupRestoreCapability, restoredAgentImage }
}

export async function runBackgroundSandboxBootstrap({
  instanceId,
  bootstrapSandbox,
  sandboxId,
  accessToken,
  readinessCheck,
  logPrefix = 'provision'
}) {
  try {
    console.log(`[${logPrefix}] Starting background sandbox bootstrap for instance ${instanceId} (sandbox ${sandboxId})`)
    const result = await bootstrapSandbox()
    await runBackgroundHealthCheck({
      instanceId,
      sandbox: result?.sandbox || null,
      sandboxId: result?.sandboxId || sandboxId,
      accessToken,
      readinessCheck,
      logPrefix
    })
  } catch (err) {
    console.error(`[${logPrefix}] Background sandbox bootstrap failed for instance ${instanceId}:`, err.message)
    try {
      await markInstanceError({ instanceId, error: err, logPrefix })
    } catch (updateErr) {
      console.error(`[${logPrefix}] Failed to update instance ${instanceId} status to error:`, updateErr.message)
    }
  }
}

/**
 * Run health check in background for async-created instances.
 * Updates instance status to 'running' on success or 'error' on failure.
 *
 * Accepts either a live `sandbox` object or just `sandboxId`.
 * When only sandboxId is provided (e.g. recovery after server restart),
 * it connects to the sandbox automatically.
 */
export async function runBackgroundHealthCheck({
  instanceId,
  sandbox = null,
  sandboxId,
  accessToken,
  readinessCheck,
  logPrefix = 'provision'
}) {
  try {
    // If no live sandbox reference, connect by sandboxId
    let sbx = sandbox
    if (!sbx && sandboxId) {
      try {
        sbx = await Sandbox.connect(sandboxId)
      } catch (connErr) {
        console.warn(`[${logPrefix}] Cannot connect to sandbox ${sandboxId} for health check: ${connErr.message}`)
        // Sandbox might not be running yet — leave status as 'starting'
        return
      }
    }
    if (!sbx) {
      console.warn(`[${logPrefix}] No sandbox available for health check on instance ${instanceId}`)
      return
    }

    console.log(`[${logPrefix}] Starting background health check for instance ${instanceId} (sandbox ${sandboxId})`)
    const ready = await waitForGatewayReady(sbx, accessToken, readinessCheck)
    if (ready) {
      const update = await buildRunningInstanceUpdate({
        instanceId,
        sandboxId,
        logPrefix
      })
      await supabaseAdmin
        .from('agent_instances')
        .update(update)
        .eq('id', instanceId)
      console.log(`[${logPrefix}] Background health check passed, instance ${instanceId} is now running`)
    } else {
      // Timeout but service might still come up — leave as 'starting'
      // The GET detail auto-calibration will eventually correct it
      console.warn(`[${logPrefix}] Background health check timed out for instance ${instanceId}, status remains starting`)
    }
  } catch (err) {
    console.error(`[${logPrefix}] Background health check failed for instance ${instanceId}:`, err.message)
    try {
      await markInstanceError({ instanceId, error: err, logPrefix })
    } catch (updateErr) {
      console.error(`[${logPrefix}] Failed to update instance ${instanceId} status to error:`, updateErr.message)
    }
  }
}

async function killSandboxSafely(sandbox, sandboxId) {
  try {
    if (sandbox) {
      await sandbox.kill()
    } else if (sandboxId) {
      const s = await Sandbox.connect(sandboxId)
      await s.kill()
    }
    console.log(`[provisioner] sandbox ${sandboxId} killed for rollback`)
  } catch (e) {
    console.error(`[provisioner] failed to kill sandbox ${sandboxId} during rollback:`, e.message)
  }
}

// --- Step 6: Persist instance ---------------------------------------------

async function insertInstanceRow({
  id,
  principalId,
  name,
  description,
  agentTypeId,
  modelId,
  configJson,
  sandboxId,
  accessToken,
  agentImage,
  backupEnabled = false,
  status = null,
  skillConfig = null

}) {
  const finalStatus = status || (sandboxId ? 'running' : 'stopped')
  const { data: instance, error } = await supabaseAdmin
    .from('agent_instances')
    .insert({
      id,
      principal_id: principalId,
      name,
      description,
      agent_type_id: agentTypeId,
      model_id: modelId,
      config_json: configJson,
      sandbox_id: sandboxId,
      agent_image: agentImage,
      backup_enabled: backupEnabled,
      token: accessToken,
      status: finalStatus,
      skill_config: skillConfig
    })
    .select()
    .single()

  if (error) {
    throw error
  }
  return instance
}

async function deleteInstanceRowSafely(instanceId) {
  try {
    await supabaseAdmin.from('agent_instances').delete().eq('id', instanceId)
    console.log(`[provisioner] instance row ${instanceId} deleted for rollback`)
  } catch (e) {
    console.error(`[provisioner] failed to delete instance row ${instanceId}:`, e.message)
  }
}

// --- Step 7: Channel config -----------------------------------------------

async function persistChannelConfig({
  instanceId,
  channelType,
  channelClientId,
  channelClientSecret
}) {
  if (!channelType || !channelClientId || !channelClientSecret) return

  const encryptedClientId = encryptApiKey(channelClientId)
  const encryptedClientSecret = encryptApiKey(channelClientSecret)

  const { error } = await supabaseAdmin
    .from('instance_channel_configs')
    .insert({
      instance_id: instanceId,
      channel_type: channelType,
      client_id: encryptedClientId,
      client_secret: encryptedClientSecret,
      config_json: { clientId: encryptedClientId, clientSecret: encryptedClientSecret },
      is_configured: true
    })

  if (error) {
    throw new ProvisionError(`Failed to save channel config: ${error.message}`, 500)
  }
}

async function runBackgroundRestoreProvisioning({
  instanceId,
  userId,
  principalId,
  instanceName,
  accessToken,
  agentType,
  modelName,
  modelProvider,
  consumerApikey,
  channelType,
  channelClientId,
  channelClientSecret,
  customVars,
  skillConfigSnapshot,
  restoreFromBackup,
  sandboxTemplateId,
  logPrefix
}) {
  let provisionResult = null
  try {
    provisionResult = await provisionSandbox({
      userId,
      principalId,
      instanceId,
      instanceName,
      accessToken,
      agentType,
      modelName,
      modelProvider,
      consumerApikey,
      channelType,
      channelClientId,
      channelClientSecret,
      customVars,
      skipHealthCheck: true,
      deferBootstrap: true,
      skillConfigSnapshot,
      restoreFromBackup
    })

    const sandboxNamespace = getSandboxTargetFromSandboxId(provisionResult.sandboxId).namespace
    const agentImage = await resolveInstanceAgentImage({
      sandboxTemplateId,
      sandboxNamespace,
      restoredAgentImage: provisionResult.restoredAgentImage,
      sourceAgentImage: restoreFromBackup?.sourceInstance?.agent_image || null
    })
    const backupConfig = provisionResult.backupVolumeConfig?.[0] || null

    await supabaseAdmin
      .from('agent_instances')
      .update({
        sandbox_id: provisionResult.sandboxId,
        agent_image: agentImage,
        backup_enabled: Boolean(backupConfig),
        status: 'starting',
        updated_at: new Date().toISOString()
      })
      .eq('id', instanceId)

    await runBackgroundSandboxBootstrap({
      instanceId,
      bootstrapSandbox: provisionResult.bootstrapSandbox,
      sandboxId: provisionResult.sandboxId,
      accessToken,
      readinessCheck: agentType?.readiness_check,
      logPrefix
    })
  } catch (err) {
    console.error(`[${logPrefix}] Background restore provisioning failed for instance ${instanceId}:`, err.message)
    if (provisionResult?.sandbox || provisionResult?.sandboxId) {
      await killSandboxSafely(provisionResult.sandbox, provisionResult.sandboxId)
    }
    try {
      await markInstanceError({ instanceId, error: err, logPrefix })
    } catch (updateErr) {
      console.error(`[${logPrefix}] Failed to update restored instance ${instanceId} status to error:`, updateErr.message)
    }
  }
}

function toConfigObject(configJson) {
  return configJson && typeof configJson === 'object' && !Array.isArray(configJson)
    ? { ...configJson }
    : {}
}

export function completeCheckpointRestoreConfigJson(configJson, now = new Date()) {
  const finalConfigJson = toConfigObject(configJson)
  const restoreInfo = toConfigObject(finalConfigJson.checkpointRestore)
  if (restoreInfo.status !== 'restoring') {
    return { changed: false, configJson: finalConfigJson }
  }
  return {
    changed: true,
    configJson: {
      ...finalConfigJson,
      checkpointRestore: {
        ...restoreInfo,
        status: 'completed',
        completedAt: now.toISOString()
      }
    }
  }
}

function failCheckpointRestoreConfigJson(configJson, message, now = new Date()) {
  const finalConfigJson = toConfigObject(configJson)
  const restoreInfo = toConfigObject(finalConfigJson.checkpointRestore)
  if (!restoreInfo || Object.keys(restoreInfo).length === 0) {
    return { changed: false, configJson: finalConfigJson }
  }
  return {
    changed: true,
    configJson: {
      ...finalConfigJson,
      checkpointRestore: {
        ...restoreInfo,
        status: 'failed',
        failedAt: now.toISOString(),
        message: String(message || 'Restore failed').slice(0, 1000)
      }
    }
  }
}

async function buildErrorInstanceUpdate({ instanceId, error, now = new Date(), logPrefix = 'provision' }) {
  const update = {
    status: 'error',
    updated_at: now.toISOString()
  }

  const { data, error: loadError } = await supabaseAdmin
    .from('agent_instances')
    .select('config_json')
    .eq('id', instanceId)
    .maybeSingle()

  if (loadError) {
    console.warn(`[${logPrefix}] Failed to load instance ${instanceId} before error update: ${loadError.message}`)
    return update
  }

  const restoreConfig = failCheckpointRestoreConfigJson(data?.config_json, error?.message || error, now)
  if (restoreConfig.changed) {
    update.config_json = restoreConfig.configJson
  }

  return update
}

async function markInstanceError({ instanceId, error, logPrefix = 'provision' }) {
  const update = await buildErrorInstanceUpdate({ instanceId, error, logPrefix })
  await supabaseAdmin
    .from('agent_instances')
    .update(update)
    .eq('id', instanceId)
}

async function buildRunningInstanceUpdate({ instanceId, sandboxId, now = new Date(), logPrefix = 'provision' }) {
  const update = {
    status: 'running',
    updated_at: now.toISOString()
  }

  const { data, error } = await supabaseAdmin
    .from('agent_instances')
    .select('config_json, agent_image')
    .eq('id', instanceId)
    .maybeSingle()

  if (error) {
    console.warn(`[${logPrefix}] Failed to load instance ${instanceId} before running update: ${error.message}`)
    return update
  }

  const restoreConfig = completeCheckpointRestoreConfigJson(data?.config_json, now)
  if (restoreConfig.changed) {
    update.config_json = restoreConfig.configJson
  }

  if (!data?.agent_image && sandboxId) {
    try {
      const sandboxImage = await readSandboxImageBySandboxId(sandboxId)
      if (sandboxImage) update.agent_image = sandboxImage
    } catch (error) {
      console.warn(`[${logPrefix}] Failed to read sandbox image for ${sandboxId}: ${error.message}`)
    }
  }

  return update
}

function buildFinalInstanceConfigJson({ configJson, processedCustomVars, restoreFromBackup }) {
  let finalConfigJson = toConfigObject(configJson)
  if (restoreFromBackup?.backupId) {
    finalConfigJson = {
      ...finalConfigJson,
      checkpointRestore: {
        ...(toConfigObject(finalConfigJson.checkpointRestore)),
        backupId: restoreFromBackup.backupId,
        sourceInstanceId: restoreFromBackup.sourceInstance?.id || null,
        status: 'restoring',
        startedAt: new Date().toISOString()
      }
    }
  }
  if (processedCustomVars) {
    finalConfigJson = { ...finalConfigJson, customVars: processedCustomVars }
  }
  return finalConfigJson
}

// --- Public entrypoint -----------------------------------------------------

/**
 * Create an OpenClaw instance on behalf of `userId`.
 *
 * When `asyncMode` is true:
 *   - Sandbox is created and config is written, but health check is skipped.
 *   - Instance is persisted with status='starting'.
 *   - Health check runs in background; status updated to 'running' on success.
 *   - Returns immediately after DB insert so the frontend can navigate to detail page.
 *
 * When `asyncMode` is false (default):
 *   - Full synchronous provisioning with health check before returning.
 *   - Instance is persisted with status='running'.
 *
 * @param {object} params
 * @param {string} params.userId       Creator of the new instance
 * @param {object} params.userProfile  Full profile row for the creator
 * @param {string|null} [params.groupId] Optional owning group principal
 * @param {string|null} [params.actorPrincipalId] Caller principal
 * @param {object|null} [params.actorProfile] Caller profile
 * @param {string} params.name
 * @param {string|null} [params.description]
 * @param {string|null} [params.inputAgentTypeId]  Agent type ID (defaults to 'openclaw')
 * @param {string|null} [params.inputModelId]
 * @param {string|null} [params.inputModelName]  Alternative to inputModelId — matches model_code or name
 * @param {object}      [params.configJson]
 * @param {string|null} [params.channelType]
 * @param {string|null} [params.channelClientId]
 * @param {string|null} [params.channelClientSecret]
 * @param {string}      [params.logPrefix]
 * @param {boolean}     [params.asyncMode=false]  When true, skip health check and return immediately
 * @returns {Promise<{ id: string, name: string, sandboxId: string, status: string, createdAt: string }>}
 * @throws  {ProvisionError}
 */
export async function createInstanceForUser({
  userId,
  userProfile,
  name,
  description = null,
  inputAgentTypeId = null,
  inputModelId = null,
  inputModelName = null,
  configJson = {},
  channelType = null,
  channelClientId = null,
  channelClientSecret = null,
  customVars = null,
  logPrefix = 'provision',
  asyncMode = false,
  groupId = null,
  actorPrincipalId = userId,
  actorProfile = userProfile,
  selectedSkillSpaceIds = [],
  restoreFromBackup = null
}) {
  if (!userId) throw new ProvisionError('userId is required', 400)
  if (!name) throw new ProvisionError('name is required', 400)

  console.log(`[${logPrefix}] createInstanceForUser userId=${userId} groupId=${groupId || 'private'} name="${name}" agentTypeId=${inputAgentTypeId} modelId=${inputModelId} channelType=${channelType} async=${asyncMode} backupId=${restoreFromBackup?.backupId || '-'}`)

  const quotaPrincipalId = getInstanceQuotaPrincipalId({ userId, groupId })
  let quotaPrincipalProfile = await loadPrincipalProfile(quotaPrincipalId)
  if (groupId && (!quotaPrincipalProfile || quotaPrincipalProfile.principal_type !== 'group')) {
    throw new ProvisionError('Group not found', 404)
  }
  if (!quotaPrincipalProfile) {
    quotaPrincipalProfile = userProfile
  }
  let credentialPrincipalId = quotaPrincipalId
  let credentialPrincipalProfile = quotaPrincipalProfile

  if (groupId) {
    credentialPrincipalId = groupId
    if (!isPlatformAdminProfile(actorProfile)) {
      try {
        await assertGroupMembership({ principalId: actorPrincipalId, userProfile: actorProfile, groupId })
      } catch (error) {
        throw new ProvisionError(error.message, error.status || 403)
      }
    }
  }

  // 1. Quota
  await assertQuotaAvailable({
    userId: quotaPrincipalId,
    userProfile: quotaPrincipalProfile,
    groupId
  })

  // 2. Agent Type
  const agentType = await resolveAgentType(inputAgentTypeId)
  if (!agentType) {
    throw new ProvisionError('请选择 Agent 配置', 400)
  }

  // 2b. Validate and process custom variables
  let processedCustomVars = null
  if (agentType.custom_vars_schema && Array.isArray(agentType.custom_vars_schema) && agentType.custom_vars_schema.length > 0) {
    const schema = agentType.custom_vars_schema
    const vars = customVars || {}
    // Validate that keys in vars only contain schema-defined variable names
    const allowedNames = new Set(schema.map(f => f.name))
    for (const key of Object.keys(vars)) {
      if (!allowedNames.has(key)) {
        throw new ProvisionError(`Unknown custom variable: "${key}". Allowed: ${[...allowedNames].join(', ')}`, 400)
      }
    }
    // Validate required fields
    for (const field of schema) {
      if (field.required && !vars[field.name]) {
        throw new ProvisionError(`自定义变量 "${field.label || field.name}" 为必填项`, 400)
      }
    }
    // Encrypt password-type values, pass through others
    processedCustomVars = {}
    for (const field of schema) {
      const value = vars[field.name]
      if (value === undefined || value === null || value === '') {
        processedCustomVars[field.name] = ''
        continue
      }
      if (field.type === 'password') {
        processedCustomVars[field.name] = 'encrypted:' + encryptApiKey(value)
      } else {
        processedCustomVars[field.name] = value
      }
    }
    console.log(`[${logPrefix}] Processed ${Object.keys(processedCustomVars).length} custom variable(s)`)
  }

  // 3. Model
  const { modelId, modelName, modelProvider } = await resolveModel(inputModelId, inputModelName)

  // 4. Consumer (ensures consumer exists for this provider in principal_profiles)
  const { consumerApikey } = await ensurePrincipalConsumer({
    principalId: credentialPrincipalId,
    principalProfile: credentialPrincipalProfile,
    modelProvider
  })

  // 4b. Build skill_config snapshot (before provisionSandbox)
  const skillConfigSnapshot = buildSkillConfigSnapshot(agentType.skill_config, selectedSkillSpaceIds)
    appLogger.info(`[${logPrefix}] skill_config snapshot: ${JSON.stringify(skillConfigSnapshot)} (selectedSpaceIds=${selectedSkillSpaceIds})`)

  // 5. Sandbox (skip health check in async mode)
  const instanceId = randomUUID()
  const accessToken = `oc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 15)}${Math.random().toString(36).slice(2, 15)}`
  const deferSandboxBootstrap = Boolean(asyncMode && restoreFromBackup?.backupId)
  const sandboxTemplateId = agentType?.sandbox_template_id || agentType?.code || 'openclaw'

  if (deferSandboxBootstrap) {
    const restoreNamespace = restoreFromBackup.namespace
      || getSandboxTargetFromSandboxId(restoreFromBackup.sourceInstance?.sandbox_id).namespace
    const agentImage = await resolveInstanceAgentImage({
      sandboxTemplateId,
      sandboxNamespace: restoreNamespace,
      sourceAgentImage: restoreFromBackup?.sourceInstance?.agent_image || null
    })

    let instance
    try {
      const finalConfigJson = buildFinalInstanceConfigJson({
        configJson,
        processedCustomVars,
        restoreFromBackup
      })
      instance = await insertInstanceRow({
        id: instanceId,
        principalId: quotaPrincipalId,
        name,
        description,
        agentTypeId: agentType?.id,
        modelId,
        configJson: finalConfigJson,
        sandboxId: null,
        accessToken,
        agentImage,
        backupEnabled: false,
        status: 'starting',
        skillConfig: skillConfigSnapshot
      })
    } catch (err) {
      if (err?.message?.includes('has reached the maximum limit')) {
        throw new ProvisionError(err.message, 409)
      }
      throw new ProvisionError(`Failed to persist instance: ${err.message}`, 500)
    }

    try {
      await persistChannelConfig({
        instanceId: instance.id,
        channelType,
        channelClientId,
        channelClientSecret
      })
    } catch (err) {
      await deleteInstanceRowSafely(instance.id)
      throw err instanceof ProvisionError
        ? err
        : new ProvisionError(`Failed to save channel config: ${err.message}`, 500)
    }

    runBackgroundRestoreProvisioning({
      instanceId: instance.id,
      userId,
      principalId: credentialPrincipalId,
      instanceName: name,
      accessToken,
      agentType,
      modelName,
      modelProvider,
      consumerApikey,
      channelType,
      channelClientId,
      channelClientSecret,
      customVars: processedCustomVars,
      skillConfigSnapshot,
      restoreFromBackup: {
        ...restoreFromBackup,
        namespace: restoreNamespace
      },
      sandboxTemplateId,
      logPrefix
    })

    console.log(`[${logPrefix}] pending restored instance ${instance.id} created for user ${userId} group ${groupId || 'private'} [async=true]`)
    return {
      id: instance.id,
      name: instance.name,
      sandboxId: null,
      status: instance.status,
      createdAt: instance.created_at
    }
  }

  const { sandbox, sandboxId, backupVolumeConfig, restoredAgentImage, bootstrapSandbox } = await provisionSandbox({
    userId,
    principalId: credentialPrincipalId,
    instanceId,
    instanceName: name,
    accessToken,
    agentType,
    modelName,
    modelProvider,
    consumerApikey,
    channelType,
    channelClientId,
    channelClientSecret,
    customVars: processedCustomVars,
    skipHealthCheck: asyncMode,
    deferBootstrap: deferSandboxBootstrap,
    skillConfigSnapshot,
    restoreFromBackup
  })
  const backupConfig = backupVolumeConfig?.[0] || null

  // 6. Persist instance row (rollback sandbox on failure)
  //    In async mode, status='starting'; in sync mode, status='running'
  const sandboxNamespace = getSandboxTargetFromSandboxId(sandboxId).namespace
  const agentImage = await resolveInstanceAgentImage({
    sandboxTemplateId,
    sandboxNamespace,
    restoredAgentImage,
    sourceAgentImage: restoreFromBackup?.sourceInstance?.agent_image || null
  })

  let instance
  try {
    const finalConfigJson = buildFinalInstanceConfigJson({
      configJson,
      processedCustomVars,
      restoreFromBackup
    })
    instance = await insertInstanceRow({
      id: instanceId,
      principalId: quotaPrincipalId,
      name,
      description,
      agentTypeId: agentType?.id,
      modelId,
      configJson: finalConfigJson,
      sandboxId,
      accessToken,
      agentImage,
      backupEnabled: Boolean(backupConfig),
      status: asyncMode ? 'starting' : undefined,
      skillConfig: skillConfigSnapshot
    })
  } catch (err) {
    await killSandboxSafely(sandbox, sandboxId)
    if (err?.message?.includes('has reached the maximum limit')) {
      throw new ProvisionError(err.message, 409)
    }
    throw new ProvisionError(`Failed to persist instance: ${err.message}`, 500)
  }

  // 7. Persist channel (rollback sandbox + instance row on failure)
  try {
    await persistChannelConfig({
      instanceId: instance.id,
      channelType,
      channelClientId,
      channelClientSecret
    })
  } catch (err) {
    await deleteInstanceRowSafely(instance.id)
    await killSandboxSafely(sandbox, sandboxId)
    throw err instanceof ProvisionError
      ? err
      : new ProvisionError(`Failed to save channel config: ${err.message}`, 500)
  }

  console.log(`[${logPrefix}] instance ${instance.id} created for user ${userId} group ${groupId || 'private'} (sandbox ${sandboxId}) [async=${asyncMode}]`)

  // 8. In async mode, kick off background health check (fire-and-forget)
  if (asyncMode) {
    if (deferSandboxBootstrap && bootstrapSandbox) {
      runBackgroundSandboxBootstrap({
        instanceId: instance.id,
        bootstrapSandbox,
        sandboxId,
        accessToken,
        readinessCheck: agentType?.readiness_check,
        logPrefix
      })
    } else {
      runBackgroundHealthCheck({
        instanceId: instance.id,
        sandbox,
        sandboxId,
        accessToken,
        readinessCheck: agentType?.readiness_check,
        logPrefix
      })
    }
    // Do NOT await — return immediately
  }

  return {
    id: instance.id,
    name: instance.name,
    sandboxId: instance.sandbox_id,
    status: instance.status,
    createdAt: instance.created_at
  }
}
