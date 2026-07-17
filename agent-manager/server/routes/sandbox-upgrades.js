import { Router } from 'express'
import { z } from 'zod'
import { supabaseAdmin } from '../config/index.js'
import { requireAdmin } from '../middleware/auth.js'
import { createKubernetesApi, getSandboxNamespace } from '../services/kubernetes-api.js'
import { defineRoute } from '../openapi/route-helper.js'
import { errorResponse } from '../schemas/common.js'
import { validate } from '../middleware/validate.js'
import {
  UPGRADE_ID_LABEL,
  buildOriginalTargetAnnotation,
  buildEffectiveSelector,
  buildSandboxUpdateOps,
  canRepairSandboxUpdateOps,
  createUpgradeId,
  getBlockingSandboxUpdateOps,
  getUpgradeSandboxes,
  getPatchContainersFromSandboxSet,
  getPatchSampleSandboxesForTarget,
  getRetryLifecycleMode,
  getRetryTargetFromSandboxUpdateOps,
  getSandboxListOptionsForTarget,
  getSandboxSetBackupRestoreCapability,
  hashClientToken,
  hashRequestBody,
  labelValue,
  normalizeLifecycleMode,
  normalizeTarget,
  normalizeUpgradeMetadataForLifecycle,
  isFailedUpgradeSandbox,
  shouldPatchUpgradeIdLabel,
  summarizeSandboxUpdateOps,
  validateMaxUnavailable
} from '../services/sandbox-upgrades.js'

const router = Router()

async function getAgentTypeOrThrow(agentTypeId) {
  const { data: agentType, error } = await supabaseAdmin
    .from('agent_types')
    .select('*')
    .eq('id', agentTypeId)
    .single()

  if (error || !agentType) {
    const notFound = new Error('Agent type not found')
    notFound.httpStatus = 404
    throw notFound
  }

  if (!agentType.sandbox_template_id) {
    const badRequest = new Error('Agent type has no sandbox template')
    badRequest.httpStatus = 400
    throw badRequest
  }

  return agentType
}

function isActiveUpgrade(item, sandboxes = []) {
  return item?.status?.phase === 'Updating' && !canRepairSandboxUpdateOps(item, sandboxes)
}

function assertSandboxUpdateOpsMutable(item, sandboxes = []) {
  if (isActiveUpgrade(item, sandboxes)) {
    throw badRequest('SandboxUpdateOps is Updating; wait until it completes or fails before modifying it')
  }
}

function sandboxIdFor(namespace, sandboxName) {
  return `${namespace}--${sandboxName}`
}

function getUniqueNamespaces(namespaces = []) {
  return [...new Set(namespaces
    .filter(namespace => typeof namespace === 'string')
    .map(namespace => namespace.trim())
    .filter(Boolean))]
}

function getSandboxNamespaceCandidates(...namespaces) {
  return getUniqueNamespaces([...namespaces, getSandboxNamespace(), 'default'])
}

function isK8sNotFound(error) {
  return error?.httpStatus === 404
}

function sandboxSetNotFoundError(sandboxSetName, namespaces) {
  const error = new Error(`SandboxSet ${sandboxSetName} not found in namespaces: ${namespaces.join(', ')}`)
  error.httpStatus = 404
  return error
}

async function resolveSandboxSetTarget(api, sandboxSetName, namespaceCandidates = []) {
  const namespaces = getSandboxNamespaceCandidates(...namespaceCandidates)
  for (const namespace of namespaces) {
    try {
      const sandboxSet = await api.getSandboxSet(namespace, sandboxSetName)
      return { namespace, sandboxSet }
    } catch (error) {
      if (!isK8sNotFound(error)) throw error
    }
  }
  throw sandboxSetNotFoundError(sandboxSetName, namespaces)
}

async function resolveAgentTypeSandboxTarget(api, agentTypeId, namespaceCandidates = []) {
  const agentType = await getAgentTypeOrThrow(agentTypeId)
  const { namespace, sandboxSet } = await resolveSandboxSetTarget(
    api,
    agentType.sandbox_template_id,
    namespaceCandidates
  )
  return { agentType, namespace, sandboxSet }
}

async function getSandboxUpdateOpsById(api, upgradeId, namespaceCandidates = []) {
  const namespaces = getSandboxNamespaceCandidates(...namespaceCandidates)
  for (const namespace of namespaces) {
    try {
      const item = await api.getSandboxUpdateOps(namespace, upgradeId)
      return { namespace, item }
    } catch (error) {
      if (!isK8sNotFound(error)) throw error
    }
  }
  const error = new Error(`SandboxUpdateOps ${upgradeId} not found in namespaces: ${namespaces.join(', ')}`)
  error.httpStatus = 404
  throw error
}

function getSandboxNameFromSandboxId(sandboxId) {
  if (!sandboxId || typeof sandboxId !== 'string') return null
  const parts = sandboxId.split('--')
  return parts.length >= 2 ? parts.slice(1).join('--') : sandboxId
}

function getTargetSandboxNames(item) {
  const raw = item?.metadata?.annotations?.['openclaw.io/target-sandbox-names']
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter(name => typeof name === 'string' && name.length > 0))]
      : []
  } catch (_) {
    return []
  }
}

function getListResultCount(itemList) {
  const itemCount = itemList?.items?.length || 0
  const remainingItemCount = itemList?.metadata?.remainingItemCount
  return Number.isInteger(remainingItemCount) && remainingItemCount >= 0
    ? itemCount + remainingItemCount
    : itemCount
}

function assertSandboxUpdateOpsForAgentType(item, agentTypeId) {
  if (item?.metadata?.labels?.['openclaw.io/agent-type-id'] !== labelValue(agentTypeId)) {
    const notFound = new Error('Sandbox upgrade not found for agent type')
    notFound.httpStatus = 404
    throw notFound
  }
}

function requireResourceObject(value, field = 'resource') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest(`${field} must be an object`)
  }
  return value
}

function assertSandboxUpdateOpsResource(resource, upgradeId, namespace, agentTypeId) {
  requireResourceObject(resource)
  if (resource.kind !== 'SandboxUpdateOps') {
    throw badRequest('resource.kind must be SandboxUpdateOps')
  }
  if (resource.metadata?.name !== upgradeId) {
    throw badRequest('resource.metadata.name must match upgradeId')
  }
  if ((resource.metadata?.namespace || namespace) !== namespace) {
    throw badRequest('resource.metadata.namespace must match sandbox namespace')
  }
  if (resource.metadata?.labels?.['openclaw.io/agent-type-id'] !== labelValue(agentTypeId)) {
    throw badRequest('resource.metadata.labels.openclaw.io/agent-type-id must match agent type')
  }
  if (!resource.spec || typeof resource.spec !== 'object' || Array.isArray(resource.spec)) {
    throw badRequest('resource.spec must be an object')
  }
}

function equalStringMap(left = {}, right = {}) {
  const leftEntries = Object.entries(left)
  const rightEntries = Object.entries(right)
  if (leftEntries.length !== rightEntries.length) return false
  return leftEntries.every(([key, value]) => right[key] === value)
}

function buildSandboxUpdateOpsEditPatch(current, edited) {
  const patch = []
  const currentLabels = current?.metadata?.labels || {}
  const editedLabels = edited?.metadata?.labels || {}
  if (!equalStringMap(currentLabels, editedLabels)) {
    throw badRequest('metadata.labels is read-only in the resource editor')
  }

  patch.push({
    op: current?.spec ? 'replace' : 'add',
    path: '/spec',
    value: edited.spec
  })
  patch.push({
    op: current?.metadata?.annotations ? 'replace' : 'add',
    path: '/metadata/annotations',
    value: edited.metadata?.annotations || {}
  })
  return patch
}

async function getBackupCapabilityBySandboxName(namespace, sandboxNames) {
  const names = [...new Set((sandboxNames || []).filter(Boolean))]
  if (names.length === 0) return new Map()

  const { data, error } = await supabaseAdmin
    .from('agent_instances')
    .select('sandbox_id, backup_enabled')
    .in('sandbox_id', names.map(name => sandboxIdFor(namespace, name)))

  if (error) throw error

  return new Map((data || [])
    .map(row => [getSandboxNameFromSandboxId(row.sandbox_id), {
      BackupReady: row.backup_enabled === true
    }])
    .filter(([sandboxName]) => Boolean(sandboxName)))
}

function getSandboxContainers(sandbox) {
  return sandbox?.spec?.template?.spec?.containers || []
}

function getSandboxImageSummary(sandbox, targetContainers) {
  const targetList = targetContainers || []
  const containers = getSandboxContainers(sandbox)
  const targetsByName = new Map(targetList.map(container => [container.name, container.image]))
  const images = containers.map(container => {
    const targetImage = targetsByName.get(container.name) || null
    return {
      Name: container.name,
      Image: container.image || null,
      TargetImage: targetImage,
      ImageMatchesTarget: !!targetImage && container.image === targetImage
    }
  })

  const imageMatchesTarget = targetList.length > 0 && targetList.every(target => {
    const current = containers.find(container => container.name === target.name)
    return current?.image === target.image
  })

  return {
    Images: images,
    CurrentImage: images[0]?.Image || null,
    TargetImage: images[0]?.TargetImage || targetList[0]?.image || null,
    ImageMatchesTarget: imageMatchesTarget
  }
}

function badRequest(message) {
  const error = new Error(message)
  error.httpStatus = 400
  return error
}

async function getSandboxPodRuntime(api, namespace, sandboxName) {
  try {
    const pod = await api.getPod(namespace, sandboxName)
    const statuses = pod?.status?.containerStatuses || []
    return {
      PodPhase: pod?.status?.phase || null,
      PodReady: pod?.status?.phase === 'Running' && statuses.length > 0 && statuses.every(status => status.ready),
      PodIP: pod?.status?.podIP || null
    }
  } catch (error) {
    return {
      PodPhase: null,
      PodReady: false,
      PodIP: null,
      Error: error.message
    }
  }
}

async function getSandboxUpgradeEligibility(api, namespace, sandbox, sandboxSetName, backupCapabilities = new Map(), { requireBackup = true } = {}) {
  const labels = sandbox?.metadata?.labels || {}
  const sandboxName = sandbox?.metadata?.name
  const sandboxPhase = sandbox?.status?.phase || null
  const podRuntime = await getSandboxPodRuntime(api, namespace, sandbox?.metadata?.name)
  if (labels['agents.kruise.io/sandbox-pool'] !== sandboxSetName) {
    return { Eligible: false, Reason: `does not belong to SandboxSet ${sandboxSetName}`, PodRuntime: podRuntime }
  }
  if (labels['agents.kruise.io/sandbox-claimed'] !== 'true') {
    return { Eligible: false, Reason: 'is not claimed', PodRuntime: podRuntime }
  }
  if (sandboxPhase !== 'Running' && sandboxPhase !== 'Upgrading') {
    return { Eligible: false, Reason: `is not Running or Upgrading (phase=${sandboxPhase || 'unknown'})`, PodRuntime: podRuntime }
  }
  if (sandboxPhase === 'Running' && !podRuntime.PodReady) {
    return { Eligible: false, Reason: 'is Running but Pod is not Ready', PodRuntime: podRuntime }
  }
  if (requireBackup && backupCapabilities.get(sandboxName)?.BackupReady !== true) {
    return { Eligible: false, Reason: 'was not created with backup CSI metadata', PodRuntime: podRuntime }
  }
  return { Eligible: true, Reason: null, PodRuntime: podRuntime }
}

async function ensureSandboxSelectable(api, namespace, sandbox, sandboxSetName, backupCapabilities = new Map(), options = {}) {
  const sandboxName = sandbox?.metadata?.name
  const eligibility = await getSandboxUpgradeEligibility(api, namespace, sandbox, sandboxSetName, backupCapabilities, options)
  if (!eligibility.Eligible) {
    throw badRequest(`Sandbox ${sandboxName} ${eligibility.Reason}`)
  }
  return eligibility.PodRuntime
}

async function syncReadyInstanceStatuses(namespace, podRuntimeBySandboxName) {
  const readySandboxIds = [...podRuntimeBySandboxName.entries()]
    .filter(([, runtime]) => runtime?.PodReady)
    .map(([sandboxName]) => `${namespace}--${sandboxName}`)

  if (readySandboxIds.length === 0) return

  await supabaseAdmin
    .from('agent_instances')
    .update({ status: 'running', updated_at: new Date().toISOString() })
    .in('sandbox_id', readySandboxIds)
    .eq('status', 'starting')
}

async function collectUpgradeSandboxes(api, namespace, itemOrUpgradeId) {
  const upgradeId = typeof itemOrUpgradeId === 'string' ? itemOrUpgradeId : itemOrUpgradeId?.metadata?.name
  const sandboxes = await api.listSandboxes(namespace, {
    matchLabels: {
      'agents.kruise.io/update-ops': upgradeId
    }
  })
  const currentItems = sandboxes.items || []
  const currentDetails = getUpgradeSandboxes(currentItems, upgradeId)
  const currentNames = new Set(currentDetails.map(sandbox => sandbox.SandboxName))
  const snapshotNames = typeof itemOrUpgradeId === 'string' ? [] : getTargetSandboxNames(itemOrUpgradeId)
  const missingNames = snapshotNames.filter(name => !currentNames.has(name))
  if (missingNames.length === 0) return currentDetails

  const settled = await Promise.allSettled(missingNames.map(name => api.getSandbox(namespace, name)))
  const snapshotItems = settled
    .filter(result => result.status === 'fulfilled')
    .map(result => result.value)
  const snapshotDetails = getUpgradeSandboxes(snapshotItems, upgradeId, { allowLabelMismatch: true })
  const allDetails = [...currentDetails]
  for (const detail of snapshotDetails) {
    if (!currentNames.has(detail.SandboxName)) {
      allDetails.push(detail)
    }
  }
  return allDetails.sort((a, b) => {
    const aIndex = snapshotNames.indexOf(a.SandboxName)
    const bIndex = snapshotNames.indexOf(b.SandboxName)
    if (aIndex === -1 && bIndex === -1) return a.SandboxName.localeCompare(b.SandboxName)
    if (aIndex === -1) return 1
    if (bIndex === -1) return -1
    return aIndex - bIndex
  })
}

async function createSandboxUpgrade({
  id,
  clientToken,
  maxUnavailable,
  target,
  selector,
  lifecycleMode,
  api,
  namespace,
  ignoredBlockingUpgradeId
}) {
  if (!clientToken) {
    throw badRequest('clientToken is required')
  }

  validateMaxUnavailable(maxUnavailable)
  const normalizedLifecycleMode = normalizeLifecycleMode(lifecycleMode || 'Full')
  const normalizedTarget = normalizeTarget({ target, selector })
  const clientTokenHash = hashClientToken(clientToken)
  const requestHash = hashRequestBody({
    agentTypeId: id,
    maxUnavailable,
    target: normalizedTarget,
    lifecycleMode: normalizedLifecycleMode
  })
  const upgradeId = createUpgradeId(clientToken, id)
  const {
    agentType,
    namespace: resolvedNamespace,
    sandboxSet
  } = await resolveAgentTypeSandboxTarget(api, id, [namespace])
  namespace = resolvedNamespace
  const upgradeMetadata = normalizeUpgradeMetadataForLifecycle(agentType.upgrade_metadata || {}, normalizedLifecycleMode)
  const requiresBackupRestore = normalizedLifecycleMode !== 'PatchOnly'

  const existing = await api.listSandboxUpdateOps(namespace, {
    matchLabels: {
      'openclaw.io/agent-type-id': labelValue(id),
      'openclaw.io/client-token-hash': labelValue(clientTokenHash)
    }
  })
  const existingItem = existing.items?.[0]
  if (existingItem) {
    if (existingItem.metadata?.annotations?.['openclaw.io/request-hash'] !== requestHash) {
      const conflict = new Error('clientToken already used with different request body')
      conflict.httpStatus = 409
      throw conflict
    }
    return { UpgradeId: existingItem.metadata.name }
  }

  const namespaceOps = await api.listSandboxUpdateOps(namespace)
  const blockingOps = getBlockingSandboxUpdateOps((namespaceOps.items || [])
    .filter(item => item.metadata?.name !== ignoredBlockingUpgradeId))
  if (blockingOps) {
    const blockingName = blockingOps.metadata?.name || 'unknown'
    const blockingPhase = blockingOps.status?.phase || 'Pending'
    const conflict = new Error(`SandboxUpdateOps ${blockingName} is ${blockingPhase} in this namespace; delete it or wait until it is Completed before creating another upgrade`)
    conflict.httpStatus = 409
    throw conflict
  }

  const backupRestoreCapability = getSandboxSetBackupRestoreCapability(sandboxSet)
  if (requiresBackupRestore && !backupRestoreCapability.Supported) {
    throw badRequest(backupRestoreCapability.Message || 'SandboxSet does not support backup and restore')
  }

  const taggedSandboxNames = []
  const podRuntimeBySandboxName = new Map()
  let selectedLabelsCommitted = false
  try {
    if (shouldPatchUpgradeIdLabel(normalizedTarget)) {
      const selectedBackupCapabilities = await getBackupCapabilityBySandboxName(namespace, normalizedTarget.sandboxNames)
      for (const sandboxName of normalizedTarget.sandboxNames) {
        const sandbox = await api.getSandbox(namespace, sandboxName)
        const podRuntime = await ensureSandboxSelectable(api, namespace, sandbox, sandboxSet.metadata.name, selectedBackupCapabilities, { requireBackup: requiresBackupRestore })
        podRuntimeBySandboxName.set(sandboxName, podRuntime)
        await api.patchSandboxLabels(namespace, sandboxName, { [UPGRADE_ID_LABEL]: upgradeId })
        taggedSandboxNames.push(sandboxName)
      }
    }

    const effectiveSelector = buildEffectiveSelector({
      sandboxSet,
      target: normalizedTarget,
      upgradeId
    })
    const matchedSandboxes = await api.listSandboxes(
      namespace,
      effectiveSelector,
      getSandboxListOptionsForTarget(normalizedTarget)
    )
    if (!matchedSandboxes.items || matchedSandboxes.items.length === 0) {
      throw badRequest('selector did not match any claimed Sandbox')
    }
    const patchSampleSandboxes = getPatchSampleSandboxesForTarget(normalizedTarget, matchedSandboxes.items || [])

    if (normalizedTarget.type === 'SelectedSandboxes') {
      const matchedBackupCapabilities = await getBackupCapabilityBySandboxName(
        namespace,
        (matchedSandboxes.items || []).map(sandbox => sandbox.metadata.name)
      )
      for (const sandbox of matchedSandboxes.items || []) {
        const sandboxName = sandbox.metadata.name
        if (!podRuntimeBySandboxName.has(sandboxName)) {
          const podRuntime = await ensureSandboxSelectable(api, namespace, sandbox, sandboxSet.metadata.name, matchedBackupCapabilities, { requireBackup: requiresBackupRestore })
          podRuntimeBySandboxName.set(sandboxName, podRuntime)
        }
      }
      await syncReadyInstanceStatuses(namespace, podRuntimeBySandboxName)
    }

    const targetSandboxNames = normalizedTarget.type === 'SelectedSandboxes'
      ? [...podRuntimeBySandboxName.keys()].sort()
      : []

    const manifest = buildSandboxUpdateOps({
      upgradeId,
      namespace,
      agentTypeId: id,
      sandboxSet,
      sandboxes: patchSampleSandboxes,
      selector: effectiveSelector,
      maxUnavailable,
      clientTokenHash,
      upgradeMetadata,
      lifecycleMode: normalizedLifecycleMode
    })
    manifest.metadata.annotations = {
      'openclaw.io/request-hash': requestHash,
      'openclaw.io/target-type': normalizedTarget.type,
      'openclaw.io/original-target': buildOriginalTargetAnnotation(normalizedTarget),
      'openclaw.io/lifecycle-mode': normalizedLifecycleMode,
      'openclaw.io/matched-sandbox-count': String(getListResultCount(matchedSandboxes)),
      'openclaw.io/patch-sandbox-sample-count': String(patchSampleSandboxes.length),
      'openclaw.io/selected-sandbox-count': String(targetSandboxNames.length),
      'openclaw.io/target-sandbox-names': JSON.stringify(targetSandboxNames),
      'openclaw.io/skipped-sandbox-count': '0'
    }

    await api.createSandboxUpdateOps(namespace, manifest)
    selectedLabelsCommitted = true
  } catch (error) {
    if (!selectedLabelsCommitted && taggedSandboxNames.length > 0) {
      const cleanups = await Promise.allSettled(
        taggedSandboxNames.map(name => api.patchSandboxLabels(namespace, name, { [UPGRADE_ID_LABEL]: null }))
      )
      cleanups
        .filter(result => result.status === 'rejected')
        .forEach(result => console.error('Cleanup selected sandbox upgrade label failed:', result.reason))
    }
    throw error
  }

  return { UpgradeId: upgradeId }
}

const AgentTypeIdParamsSchema = z.object({
  id: z.string().describe('智能体类型 ID (UUID)'),
})

const AgentTypeUpgradeIdParamsSchema = z.object({
  id: z.string().describe('智能体类型 ID (UUID)'),
  upgradeId: z.string().describe('升级任务 ID (UUID)'),
})

const UpgradeIdParamsSchema = z.object({
  upgradeId: z.string().describe('升级任务 ID (UUID)'),
})

const ListSandboxUpgradesQuerySchema = z.object({ agentTypeId: z.string({ required_error: 'agentTypeId is required' }).min(1, { message: 'agentTypeId is required' }) }).passthrough()

const CreateSandboxUpgradeBody = z.object({}).passthrough()

const RetrySandboxUpgradeBody = z.object({}).passthrough()

const UpdateSandboxUpgradeResourceBody = z.object({}).passthrough()

const SandboxItemSchema = z.object({
  Name: z.string(),
  Namespace: z.string(),
  Phase: z.string().nullable(),
  PodPhase: z.string().nullable(),
  PodReady: z.boolean(),
  PodIP: z.string().nullable(),
  BackupReady: z.boolean(),
  Images: z.array(z.object({ Name: z.string(), Image: z.string().nullable(), TargetImage: z.string().nullable(), ImageMatchesTarget: z.boolean().optional() })).optional(),
  CurrentImage: z.string().nullable().optional(),
  TargetImage: z.string().nullable().optional(),
  ImageMatchesTarget: z.boolean().optional(),
  Labels: z.record(z.string()).optional(),
  CreatedAt: z.string().optional(),
}).passthrough()

const ListSandboxesByAgentTypeResponseSchema = z.object({
  success: z.literal(true),
  Namespace: z.string(),
  SandboxSetName: z.string(),
  DefaultSelector: z.object({ matchLabels: z.record(z.string()).optional() }).passthrough(),
  TargetImages: z.array(z.object({
    Name: z.string(),
    Image: z.string(),
  })),
  TargetImage: z.string().nullable(),
  BackupRestoreCapability: z.object({ Supported: z.boolean(), RequiredRuntimes: z.array(z.string()).optional(), MissingRuntimes: z.array(z.string()).optional(), Message: z.string().nullable().optional() }).passthrough(),
  Items: z.array(SandboxItemSchema),
})

const CreateSandboxUpgradeResponseSchema = z.object({
  success: z.literal(true),
  RequestId: z.string().optional(),
  UpgradeId: z.string(),
})

const RetrySandboxUpgradeResponseSchema = z.object({
  success: z.literal(true),
  RequestId: z.string().optional(),
  UpgradeId: z.string(),
  RetriedFrom: z.string(),
  RetryTarget: z.object({ type: z.string().optional() }).passthrough(),
  LifecycleMode: z.string(),
})

const SandboxUpgradeResourceResponseSchema = z.object({
  success: z.literal(true),
  Resource: z.object({ apiVersion: z.string().optional(), kind: z.string().optional(), metadata: z.object({ name: z.string().optional() }).passthrough().optional() }).passthrough().describe('SandboxUpdateOps K8s 资源'),
})

const SuccessOnlyResponseSchema = z.object({
  success: z.literal(true),
})

const SandboxUpgradeSummarySchema = z.object({
  UpgradeId: z.string().optional(),
  Phase: z.string().optional(),
  CreatedAt: z.string().optional(),
  Progress: z.object({ total: z.number().optional(), current: z.number().optional() }).passthrough().optional(),
  Sandboxes: z.array(z.object({ name: z.string().optional(), phase: z.string().optional() }).passthrough()).optional(),
  FailedSandboxes: z.array(z.object({ name: z.string().optional(), phase: z.string().optional() }).passthrough()).optional(),
}).passthrough()

const ListSandboxUpgradesResponseSchema = z.object({
  success: z.literal(true),
  Items: z.array(SandboxUpgradeSummarySchema),
})

const GetSandboxUpgradeByIdResponseSchema = z.object({
  success: z.literal(true),
  Upgrade: SandboxUpgradeSummarySchema.extend({
    Spec: z.object({}).passthrough().optional(),
  }),
})

defineRoute(router, {
  method: 'get',
  path: '/agent-types/{id}/sandboxes',
  operationId: 'listSandboxesByAgentType',
  tags: ['Sandbox Upgrades'],
  summary: '列出智能体类型下的沙箱',
  description: '获取指定智能体类型关联的所有 Sandbox 列表，包含运行状态、镜像信息和备份能力。',
  security: [{ bearerAuth: [] }],
  request: {
    params: AgentTypeIdParamsSchema,
  },
  responses: {
    200: {
      description: '沙箱列表',
      content: { 'application/json': { schema: ListSandboxesByAgentTypeResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ params: AgentTypeIdParamsSchema }), async (req, res) => {
  const api = createKubernetesApi()
  const { namespace, sandboxSet } = await resolveAgentTypeSandboxTarget(api, req.params.id)
  const backupRestoreCapability = getSandboxSetBackupRestoreCapability(sandboxSet)
  const selector = buildEffectiveSelector({ sandboxSet })
  const sandboxes = await api.listSandboxes(namespace, selector)
  const targetContainers = getPatchContainersFromSandboxSet(sandboxSet)
  const sandboxNames = (sandboxes.items || []).map(sandbox => sandbox.metadata.name)
  const backupCapabilities = await getBackupCapabilityBySandboxName(namespace, sandboxNames)

  const items = await Promise.all((sandboxes.items || []).map(async sandbox => {
    const podRuntime = await getSandboxPodRuntime(api, namespace, sandbox.metadata.name)
    const backupCapability = backupCapabilities.get(sandbox.metadata.name)
    return {
      Name: sandbox.metadata.name,
      Namespace: sandbox.metadata.namespace,
      Phase: sandbox.status?.phase || null,
      PodPhase: podRuntime.PodPhase,
      PodReady: podRuntime.PodReady,
      PodIP: podRuntime.PodIP || sandbox.status?.podInfo?.podIP || sandbox.status?.sandboxIp || null,
      BackupReady: backupRestoreCapability.Supported && backupCapability?.BackupReady === true,
      ...getSandboxImageSummary(sandbox, targetContainers),
      Labels: sandbox.metadata.labels || {},
      CreatedAt: sandbox.metadata.creationTimestamp
    }
  }))

  items.sort((a, b) => Number(b.BackupReady) - Number(a.BackupReady) || String(b.CreatedAt || '').localeCompare(String(a.CreatedAt || '')))

  res.json({
    success: true,
    Namespace: namespace,
    SandboxSetName: sandboxSet.metadata.name,
    DefaultSelector: selector,
    TargetImages: targetContainers.map(container => ({
      Name: container.name,
      Image: container.image
    })),
    TargetImage: targetContainers[0]?.image || null,
    BackupRestoreCapability: backupRestoreCapability,
    Items: items
  })
})

defineRoute(router, {
  method: 'post',
  path: '/agent-types/{id}/sandbox-upgrades',
  operationId: 'createSandboxUpgradeByAgentType',
  tags: ['Sandbox Upgrades'],
  summary: '创建沙箱升级',
  description: '为指定智能体类型创建新的沙箱滚动升级任务，支持指定目标沙箱、生命周期模式和并发策略。',
  security: [{ bearerAuth: [] }],
  request: {
    params: AgentTypeIdParamsSchema,
    body: { content: { 'application/json': { schema: CreateSandboxUpgradeBody } } },
  },
  responses: {
    200: {
      description: '升级创建成功',
      content: { 'application/json': { schema: CreateSandboxUpgradeResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    409: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: CreateSandboxUpgradeBody, params: AgentTypeIdParamsSchema }), async (req, res) => {
  const { id } = req.params
  const { clientToken, maxUnavailable, target, selector, lifecycleMode } = req.body

  const namespace = getSandboxNamespace()
  const api = createKubernetesApi()
  const result = await createSandboxUpgrade({ id, clientToken, maxUnavailable, target, selector, lifecycleMode, api, namespace })
  res.json({ success: true, RequestId: req.requestId, UpgradeId: result.UpgradeId })
})

defineRoute(router, {
  method: 'post',
  path: '/agent-types/{id}/sandbox-upgrades/{upgradeId}/retry',
  operationId: 'retrySandboxUpgradeByAgentType',
  tags: ['Sandbox Upgrades'],
  summary: '重试失败的沙箱升级',
  description: '对指定的失败升级任务进行重试，自动选择失败的沙箱重新执行升级流程。',
  security: [{ bearerAuth: [] }],
  request: {
    params: AgentTypeUpgradeIdParamsSchema,
    body: { content: { 'application/json': { schema: RetrySandboxUpgradeBody } } },
  },
  responses: {
    200: {
      description: '重试成功',
      content: { 'application/json': { schema: RetrySandboxUpgradeResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: RetrySandboxUpgradeBody, params: AgentTypeUpgradeIdParamsSchema }), async (req, res) => {
  const { id, upgradeId } = req.params
  const { clientToken, lifecycleMode, maxUnavailable } = req.body
  if (!clientToken) {
    throw badRequest('clientToken is required')
  }
  const api = createKubernetesApi()
  const { namespace } = await resolveAgentTypeSandboxTarget(api, id)
  const current = await api.getSandboxUpdateOps(namespace, upgradeId)
  assertSandboxUpdateOpsForAgentType(current, id)

  const sandboxes = await collectUpgradeSandboxes(api, namespace, current)
  if (!canRepairSandboxUpdateOps(current, sandboxes)) {
    throw badRequest('only failed or stalled failed SandboxUpdateOps can be retried')
  }
  const failedSandboxes = sandboxes.filter(isFailedUpgradeSandbox)
  const retryTarget = getRetryTargetFromSandboxUpdateOps(current, failedSandboxes)
  const retryLifecycleMode = lifecycleMode || getRetryLifecycleMode(current, failedSandboxes)
  const retryMaxUnavailable = maxUnavailable ?? current?.spec?.updateStrategy?.maxUnavailable ?? 1

  await api.deleteSandboxUpdateOps(namespace, upgradeId)
  const result = await createSandboxUpgrade({
    id,
    clientToken,
    maxUnavailable: retryMaxUnavailable,
    target: retryTarget,
    lifecycleMode: retryLifecycleMode,
    api,
    namespace,
    ignoredBlockingUpgradeId: upgradeId
  })

  res.json({
    success: true,
    RequestId: req.requestId,
    UpgradeId: result.UpgradeId,
    RetriedFrom: upgradeId,
    RetryTarget: retryTarget,
    LifecycleMode: retryLifecycleMode
  })
})

defineRoute(router, {
  method: 'get',
  path: '/agent-types/{id}/sandbox-upgrades/{upgradeId}/resource',
  operationId: 'getSandboxUpgradeResourceByAgentType',
  tags: ['Sandbox Upgrades'],
  summary: '获取沙箱升级 K8s 资源',
  description: '获取指定升级任务的完整 SandboxUpdateOps K8s 资源对象。',
  security: [{ bearerAuth: [] }],
  request: {
    params: AgentTypeUpgradeIdParamsSchema,
  },
  responses: {
    200: {
      description: 'K8s 资源对象',
      content: { 'application/json': { schema: SandboxUpgradeResourceResponseSchema } },
    },
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ params: AgentTypeUpgradeIdParamsSchema }), async (req, res) => {
  const { id, upgradeId } = req.params
  const api = createKubernetesApi()
  const { namespace } = await resolveAgentTypeSandboxTarget(api, id)
  const item = await api.getSandboxUpdateOps(namespace, upgradeId)
  assertSandboxUpdateOpsForAgentType(item, id)
  res.json({ success: true, Resource: item })
})

defineRoute(router, {
  method: 'put',
  path: '/agent-types/{id}/sandbox-upgrades/{upgradeId}/resource',
  operationId: 'updateSandboxUpgradeResourceByAgentType',
  tags: ['Sandbox Upgrades'],
  summary: '更新沙箱升级 K8s 资源',
  description: '编辑指定升级任务的 SandboxUpdateOps 资源，仅允许修改 spec 和 annotations，labels 为只读。',
  security: [{ bearerAuth: [] }],
  request: {
    params: AgentTypeUpgradeIdParamsSchema,
    body: { content: { 'application/json': { schema: UpdateSandboxUpgradeResourceBody } } },
  },
  responses: {
    200: {
      description: '更新成功',
      content: { 'application/json': { schema: SandboxUpgradeResourceResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ body: UpdateSandboxUpgradeResourceBody, params: AgentTypeUpgradeIdParamsSchema }), async (req, res) => {
  const { id, upgradeId } = req.params
  const { resource } = req.body
  const api = createKubernetesApi()
  const { namespace } = await resolveAgentTypeSandboxTarget(api, id)
  const current = await api.getSandboxUpdateOps(namespace, upgradeId)
  assertSandboxUpdateOpsForAgentType(current, id)
  assertSandboxUpdateOpsMutable(current)
  assertSandboxUpdateOpsResource(resource, upgradeId, namespace, id)
  const patch = buildSandboxUpdateOpsEditPatch(current, resource)
  const updated = await api.patchSandboxUpdateOps(namespace, upgradeId, patch)
  res.json({ success: true, Resource: updated })
})

defineRoute(router, {
  method: 'delete',
  path: '/agent-types/{id}/sandbox-upgrades/{upgradeId}/resource',
  operationId: 'deleteSandboxUpgradeResourceByAgentType',
  tags: ['Sandbox Upgrades'],
  summary: '删除沙箱升级 K8s 资源',
  description: '删除指定的 SandboxUpdateOps 资源，仅允许非 Updating 状态的资源被删除。',
  security: [{ bearerAuth: [] }],
  request: {
    params: AgentTypeUpgradeIdParamsSchema,
  },
  responses: {
    200: {
      description: '删除成功',
      content: { 'application/json': { schema: SuccessOnlyResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ params: AgentTypeUpgradeIdParamsSchema }), async (req, res) => {
  const { id, upgradeId } = req.params
  const api = createKubernetesApi()
  const { namespace } = await resolveAgentTypeSandboxTarget(api, id)
  const current = await api.getSandboxUpdateOps(namespace, upgradeId)
  assertSandboxUpdateOpsForAgentType(current, id)
  const sandboxes = await collectUpgradeSandboxes(api, namespace, current)
  assertSandboxUpdateOpsMutable(current, sandboxes)
  await api.deleteSandboxUpdateOps(namespace, upgradeId)
  res.json({ success: true })
})

defineRoute(router, {
  method: 'get',
  path: '/sandbox-upgrades',
  operationId: 'listSandboxUpgrades',
  tags: ['Sandbox Upgrades'],
  summary: '列出沙箱升级列表',
  description: '获取指定智能体类型的所有升级任务列表，支持按阶段和失败状态过滤。',
  security: [{ bearerAuth: [] }],
  request: {
    query: ListSandboxUpgradesQuerySchema,
  },
  responses: {
    200: {
      description: '升级列表',
      content: { 'application/json': { schema: ListSandboxUpgradesResponseSchema } },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ query: ListSandboxUpgradesQuerySchema }), async (req, res) => {
  const { agentTypeId, phase, failedOnly } = req.query

  const api = createKubernetesApi()
  const { namespace } = await resolveAgentTypeSandboxTarget(api, agentTypeId)
  const list = await api.listSandboxUpdateOps(namespace, {
    matchLabels: {
      'openclaw.io/agent-type-id': labelValue(agentTypeId)
    }
  })

  const items = (await Promise.all((list.items || []).map(async item => {
    const sandboxes = await collectUpgradeSandboxes(api, namespace, item)
    const summary = summarizeSandboxUpdateOps(item, sandboxes)
    if (phase && summary.Phase !== phase && summary.RawPhase !== phase) return null
    if (failedOnly === 'true' && summary.Progress.FailedReplicas <= 0) return null
    summary.Sandboxes = sandboxes
    summary.FailedSandboxes = summary.Progress.FailedReplicas > 0 || summary.Phase === 'Failed'
      ? summary.Sandboxes.filter(isFailedUpgradeSandbox)
      : []
    return summary
  }))).filter(Boolean)

  items.sort((a, b) => String(b.CreatedAt || '').localeCompare(String(a.CreatedAt || '')))
  res.json({ success: true, Items: items })
})

defineRoute(router, {
  method: 'get',
  path: '/sandbox-upgrades/{upgradeId}',
  operationId: 'getSandboxUpgradeById',
  tags: ['Sandbox Upgrades'],
  summary: '获取沙箱升级详情',
  description: '获取指定升级任务的详细信息，包括进度、关联沙箱列表和失败沙箱。',
  security: [{ bearerAuth: [] }],
  request: {
    params: UpgradeIdParamsSchema,
  },
  responses: {
    200: {
      description: '升级详情',
      content: { 'application/json': { schema: GetSandboxUpgradeByIdResponseSchema } },
    },
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    500: errorResponse,
  },
}, requireAdmin, validate({ params: UpgradeIdParamsSchema }), async (req, res) => {
  const api = createKubernetesApi()
  const { namespace, item } = await getSandboxUpdateOpsById(api, req.params.upgradeId)
  const sandboxes = await collectUpgradeSandboxes(api, namespace, item)
  const summary = summarizeSandboxUpdateOps(item, sandboxes)
  summary.Spec = item.spec
  summary.Sandboxes = sandboxes
  summary.FailedSandboxes = summary.Progress.FailedReplicas > 0 || summary.Phase === 'Failed'
    ? summary.Sandboxes.filter(isFailedUpgradeSandbox)
    : []

  res.json({ success: true, Upgrade: summary })
})

export default router
