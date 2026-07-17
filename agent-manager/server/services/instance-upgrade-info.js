import { supabaseAdmin } from '../config/index.js'
import { appLogger } from '../utils/logger.js'
import { createKubernetesApi, getSandboxNamespace } from './kubernetes-api.js'
import {
  getPatchContainersFromSandboxSet,
  getSandboxSetBackupRestoreCapability
} from './sandbox-upgrades.js'
import {
  getSandboxTargetFromSandboxId,
  getSandboxTemplateAgentImage
} from './checkpoint-backups/sandbox-image.js'

const SANDBOX_POOL_LABEL = 'agents.kruise.io/sandbox-pool'
const RUNTIME_STATUS_PERSIST_DEBOUNCE_MS = 60 * 1000
const MAX_RUNTIME_STATUS_PERSIST_ATTEMPTS = 1000

const runtimeStatusPersistAttempts = new Map()

function getSandboxNameFromInstance(instance) {
  return getSandboxTargetFromInstance(instance).sandboxName
}

function getSandboxTargetFromInstance(instance) {
  return getSandboxTargetFromSandboxId(instance?.sandbox_id, getSandboxNamespace())
}

function getSandboxImageKey(namespace, sandboxName) {
  if (!sandboxName) return null
  return `${namespace || getSandboxNamespace()}/${sandboxName}`
}

function getSandboxImageKeyFromInstance(instance) {
  const { namespace, sandboxName } = getSandboxTargetFromInstance(instance)
  return getSandboxImageKey(namespace, sandboxName)
}

function getUpgradeTargetKey(agentTypeId, namespace) {
  if (!agentTypeId) return null
  return `${agentTypeId}/${namespace || getSandboxNamespace()}`
}

function getUpgradeTargetForInstance(instance, upgradeTargets) {
  if (!instance?.agent_type_id) return null
  const { namespace } = getSandboxTargetFromInstance(instance)
  return upgradeTargets.get(getUpgradeTargetKey(instance.agent_type_id, namespace))
    || upgradeTargets.get(instance.agent_type_id)
    || null
}

function getSandboxCurrentImage(sandbox) {
  return getSandboxTemplateAgentImage(sandbox)
}

function getSandboxPoolName(agentType) {
  return agentType?.sandbox_template_id || agentType?.code || null
}

function getSandboxPoolNamesForInstances(instances, agentTypes = []) {
  const agentTypesById = new Map((agentTypes || [])
    .filter(agentType => agentType?.id)
    .map(agentType => [agentType.id, agentType]))
  return [...new Set((instances || [])
    .map(instance => agentTypesById.get(instance?.agent_type_id))
    .map(getSandboxPoolName)
    .filter(Boolean))]
}

function buildSandboxPoolSelector(poolNames) {
  const names = [...new Set(poolNames || [])].filter(Boolean)
  if (names.length === 0) return null
  if (names.length === 1) {
    return {
      matchLabels: {
        [SANDBOX_POOL_LABEL]: names[0]
      }
    }
  }
  return {
    matchExpressions: [{
      key: SANDBOX_POOL_LABEL,
      operator: 'In',
      values: names
    }]
  }
}

function buildSandboxImageInfo({ sandbox, pod, instance, error }) {
  const podStatuses = pod?.status?.containerStatuses || []
  const podReady = pod?.status?.phase === 'Running' && podStatuses.length > 0 && podStatuses.every(status => status.ready)
  if (sandbox) {
    return {
      CurrentImage: getSandboxCurrentImage(sandbox),
      Phase: sandbox?.status?.phase || null,
      BackupReady: instance?.backup_enabled === true,
      PodPhase: pod?.status?.phase || null,
      PodReady: podReady,
      PodIP: pod?.status?.podIP || null,
      Error: error
    }
  }
  return {
    CurrentImage: null,
    Phase: null,
    BackupReady: false,
    PodPhase: pod?.status?.phase || null,
    PodReady: podReady,
    PodIP: pod?.status?.podIP || null,
    Error: error
  }
}

async function loadSandboxImageInfoByName(api, namespace, sandboxName, instance) {
  const [sandboxResult, podResult] = await Promise.allSettled([
    api.getSandbox(namespace, sandboxName),
    api.getPod(namespace, sandboxName)
  ])
  const error = [
    sandboxResult.status === 'rejected' ? sandboxResult.reason?.message || sandboxResult.reason : null,
    podResult.status === 'rejected' ? podResult.reason?.message || podResult.reason : null
  ].filter(Boolean).join('; ') || null
  return buildSandboxImageInfo({
    sandbox: sandboxResult.status === 'fulfilled' ? sandboxResult.value : null,
    pod: podResult.status === 'fulfilled' ? podResult.value : null,
    instance,
    error
  })
}

async function getCurrentSandboxImages(instances, agentTypes = []) {
  const api = createKubernetesApi()
  const images = new Map()
  const targets = (instances || [])
    .map(instance => {
      const { namespace, sandboxName } = getSandboxTargetFromInstance(instance)
      return {
        namespace,
        sandboxName,
        key: getSandboxImageKey(namespace, sandboxName),
        instance
      }
    })
    .filter(target => target.namespace && target.sandboxName && target.key)

  if (targets.length === 0) return images

  const targetsByNamespace = new Map()
  for (const target of targets) {
    if (!targetsByNamespace.has(target.namespace)) targetsByNamespace.set(target.namespace, [])
    targetsByNamespace.get(target.namespace).push(target)
  }

  for (const [namespace, namespaceTargets] of targetsByNamespace) {
    const sandboxNames = [...new Set(namespaceTargets.map(target => target.sandboxName))]
    const sandboxNameSet = new Set(sandboxNames)
    const instancesBySandboxName = new Map(namespaceTargets.map(target => [target.sandboxName, target.instance]))
    const sandboxPoolSelector = buildSandboxPoolSelector(getSandboxPoolNamesForInstances(
      namespaceTargets.map(target => target.instance),
      agentTypes
    ))

    const setImageInfo = (sandboxName, info) => {
      images.set(getSandboxImageKey(namespace, sandboxName), info)
    }

    if (!sandboxPoolSelector) {
      const results = await Promise.allSettled(sandboxNames.map(async sandboxName => {
        setImageInfo(sandboxName, await loadSandboxImageInfoByName(api, namespace, sandboxName, instancesBySandboxName.get(sandboxName)))
      }))
      results
        .filter(result => result.status === 'rejected')
        .forEach(result => appLogger.warn('Failed to load sandbox image info', {
          error: result.reason?.message || result.reason
        }))
      continue
    }

    const [sandboxesResult, podsResult] = await Promise.allSettled([
      api.listSandboxes(namespace, sandboxPoolSelector),
      api.listPods(namespace, sandboxPoolSelector)
    ])
    const sandboxesByName = new Map(sandboxesResult.status === 'fulfilled'
      ? (sandboxesResult.value?.items || [])
        .filter(sandbox => sandboxNameSet.has(sandbox?.metadata?.name))
        .map(sandbox => [sandbox.metadata.name, sandbox])
      : [])
    const podsByName = new Map(podsResult.status === 'fulfilled'
      ? (podsResult.value?.items || [])
        .filter(pod => sandboxNameSet.has(pod?.metadata?.name))
        .map(pod => [pod.metadata.name, pod])
      : [])

    for (const sandboxName of sandboxNames) {
      const sandbox = sandboxesByName.get(sandboxName) || null
      const pod = podsByName.get(sandboxName) || null
      const error = [
        sandboxesResult.status === 'rejected' ? sandboxesResult.reason?.message || sandboxesResult.reason : null,
        podsResult.status === 'rejected' ? podsResult.reason?.message || podsResult.reason : null
      ].filter(Boolean).join('; ') || null
      setImageInfo(sandboxName, buildSandboxImageInfo({
        sandbox,
        pod,
        instance: instancesBySandboxName.get(sandboxName),
        error
      }))
    }

    const fallbackResults = await Promise.allSettled([...sandboxNameSet]
      .filter(sandboxName => !sandboxesByName.has(sandboxName))
      .map(async sandboxName => {
        setImageInfo(sandboxName, await loadSandboxImageInfoByName(api, namespace, sandboxName, instancesBySandboxName.get(sandboxName)))
      }))
    fallbackResults
      .filter(result => result.status === 'rejected')
      .forEach(result => appLogger.warn('Failed to load sandbox image info by name', {
        error: result.reason?.message || result.reason
      }))
  }

  return images
}

function getSandboxNamespacesByAgentTypeId(instances) {
  const namespacesByAgentTypeId = new Map()
  for (const instance of instances || []) {
    if (!instance?.agent_type_id) continue
    const { namespace } = getSandboxTargetFromInstance(instance)
    if (!namespace) continue
    if (!namespacesByAgentTypeId.has(instance.agent_type_id)) {
      namespacesByAgentTypeId.set(instance.agent_type_id, new Set())
    }
    namespacesByAgentTypeId.get(instance.agent_type_id).add(namespace)
  }
  return namespacesByAgentTypeId
}

async function getUpgradeTargets(agentTypes, instances = []) {
  const fallbackNamespace = getSandboxNamespace()
  const api = createKubernetesApi()
  const targets = new Map()
  const namespacesByAgentTypeId = getSandboxNamespacesByAgentTypeId(instances)

  await Promise.all((agentTypes || []).flatMap(agentType => {
    if (!agentType?.id) return []
    const namespaces = [...(namespacesByAgentTypeId.get(agentType.id) || new Set([fallbackNamespace]))]
    const sandboxSetName = agentType.sandbox_template_id || agentType.code
    return namespaces.map(async namespace => {
      const targetKey = getUpgradeTargetKey(agentType.id, namespace)
      if (!sandboxSetName) {
        targets.set(targetKey, {
          Namespace: namespace,
          SandboxSetName: null,
          TargetImage: null,
          Error: 'Agent type has no SandboxSet'
        })
        return
      }

      try {
        const sandboxSet = await api.getSandboxSet(namespace, sandboxSetName)
        const targetContainers = getPatchContainersFromSandboxSet(sandboxSet)
        const backupRestoreCapability = getSandboxSetBackupRestoreCapability(sandboxSet)
        const target = {
          Namespace: namespace,
          SandboxSetName: sandboxSet?.metadata?.name || sandboxSetName,
          TargetImage: targetContainers[0]?.image || null,
          TargetImages: targetContainers.map(container => ({
            Name: container.name,
            Image: container.image
          })),
          BackupRestoreCapability: backupRestoreCapability
        }
        targets.set(targetKey, target)
        if (!targets.has(agentType.id)) targets.set(agentType.id, target)
      } catch (error) {
        const target = {
          Namespace: namespace,
          SandboxSetName: sandboxSetName,
          TargetImage: null,
          Error: error.message
        }
        targets.set(targetKey, target)
        if (!targets.has(agentType.id)) targets.set(agentType.id, target)
      }
    })
  }))

  return targets
}

function getInstanceUpgradeReason({
  target,
  sandboxImage,
  instance,
  sandboxName,
  sandboxReady,
  backupReady,
  currentImage,
  targetImage
}) {
  if (target?.Error) return 'TARGET_UNAVAILABLE'
  if (sandboxImage?.Error && !currentImage) return 'CURRENT_UNAVAILABLE'
  if (target?.BackupRestoreCapability?.Supported === false) return 'SANDBOXSET_BACKUP_UNSUPPORTED'
  if (!instance.agent_type_id) return 'NO_AGENT_TYPE'
  if (!sandboxName) return 'NO_SANDBOX'
  if (!sandboxReady) return 'NOT_RUNNING'
  if (!backupReady) return 'NO_BACKUP_MOUNT'
  if (!currentImage) return 'NO_INSTANCE_IMAGE'
  if (!targetImage) return 'NO_TARGET_IMAGE'
  if (currentImage === targetImage) return 'UP_TO_DATE'
  return 'UPGRADE_AVAILABLE'
}

function buildInstanceUpgradeInfo(instance, upgradeTargets, sandboxImages) {
  const target = getUpgradeTargetForInstance(instance, upgradeTargets)
  const sandboxTarget = getSandboxTargetFromInstance(instance)
  const sandboxName = getSandboxNameFromInstance(instance)
  const sandboxImageKey = getSandboxImageKeyFromInstance(instance)
  const sandboxImage = sandboxImageKey ? sandboxImages.get(sandboxImageKey) : null
  const currentImage = sandboxImage?.CurrentImage || instance.agent_image || null
  const targetImage = target?.TargetImage || null
  const sandboxReady = sandboxImage?.PodReady || (sandboxImage?.Phase ? sandboxImage.Phase === 'Running' : instance.status === 'running')
  const backupReady = sandboxImage?.BackupReady === true
  const reason = getInstanceUpgradeReason({
    target,
    sandboxImage,
    instance,
    sandboxName,
    sandboxReady,
    backupReady,
    currentImage,
    targetImage
  })
  const canUpgrade = reason === 'UPGRADE_AVAILABLE'

  return {
    CanUpgrade: canUpgrade,
    Reason: reason,
    AgentTypeId: instance.agent_type_id || null,
    SandboxName: sandboxName,
    SandboxPhase: sandboxImage?.Phase || null,
    PodPhase: sandboxImage?.PodPhase || null,
    PodReady: sandboxImage?.PodReady || false,
    PodIP: sandboxImage?.PodIP || null,
    BackupReady: backupReady,
    Namespace: target?.Namespace || sandboxTarget.namespace || getSandboxNamespace(),
    SandboxSetName: target?.SandboxSetName || null,
    CurrentImage: currentImage,
    TargetImage: targetImage,
    Error: target?.Error || sandboxImage?.Error || null
  }
}

function isCheckpointRestoreInProgress(instance) {
  const restoreInfo = instance?.config_json?.checkpointRestore
  return restoreInfo
    && typeof restoreInfo === 'object'
    && !Array.isArray(restoreInfo)
    && restoreInfo.status === 'restoring'
    && instance?.status !== 'error'
}

function getRuntimeStatusFromSandbox(instance, sandboxImages) {
  if (isCheckpointRestoreInProgress(instance)) return 'starting'
  if (!instance?.sandbox_id) return instance?.status

  const sandboxImageKey = getSandboxImageKeyFromInstance(instance)
  const sandboxImage = sandboxImageKey ? sandboxImages.get(sandboxImageKey) : null
  if (!sandboxImage) return instance.status

  const sandboxPhase = String(sandboxImage.Phase || '').toLowerCase()
  if (instance.status !== 'stopping'
      && sandboxImage.PodReady
      && sandboxPhase !== 'paused'
      && sandboxPhase !== 'stopped') {
    return 'running'
  }

  return instance.status
}

function cleanupRuntimeStatusPersistAttempts(now) {
  if (runtimeStatusPersistAttempts.size <= MAX_RUNTIME_STATUS_PERSIST_ATTEMPTS) return
  for (const [key, lastAttemptAt] of runtimeStatusPersistAttempts.entries()) {
    if (now - lastAttemptAt > RUNTIME_STATUS_PERSIST_DEBOUNCE_MS) {
      runtimeStatusPersistAttempts.delete(key)
    }
  }
}

function shouldPersistRuntimeStatus(instance, runtimeStatus, now = Date.now()) {
  if (!instance?.id || !runtimeStatus || runtimeStatus === instance.status) return false
  const key = `${instance.id}:${instance.status}->${runtimeStatus}`
  const lastAttemptAt = runtimeStatusPersistAttempts.get(key)
  if (lastAttemptAt && now - lastAttemptAt < RUNTIME_STATUS_PERSIST_DEBOUNCE_MS) return false
  runtimeStatusPersistAttempts.set(key, now)
  cleanupRuntimeStatusPersistAttempts(now)
  return true
}

async function persistRuntimeStatuses(instances, sandboxImages) {
  const updates = (instances || [])
    .map(instance => ({
      instance,
      runtimeStatus: getRuntimeStatusFromSandbox(instance, sandboxImages)
    }))
    .filter(({ instance, runtimeStatus }) => runtimeStatus && runtimeStatus !== instance.status)
    .filter(({ instance, runtimeStatus }) => shouldPersistRuntimeStatus(instance, runtimeStatus))

  if (updates.length === 0) return

  const results = await Promise.allSettled(updates.map(({ instance, runtimeStatus }) =>
    supabaseAdmin
      .from('agent_instances')
      .update({ status: runtimeStatus, updated_at: new Date().toISOString() })
      .eq('id', instance.id)
      .eq('status', instance.status)
  ))

  results.forEach((result, index) => {
    const instance = updates[index]?.instance
    if (result.status === 'rejected') {
      appLogger.warn('Failed to persist runtime status for instance', {
        instanceId: instance?.id,
        error: result.reason?.message || result.reason
      })
      return
    }
    if (result.value?.error) {
      appLogger.warn('Failed to persist runtime status for instance', {
        instanceId: instance?.id,
        error: result.value.error.message
      })
    }
  })
}

export {
  buildInstanceUpgradeInfo,
  getCurrentSandboxImages,
  getRuntimeStatusFromSandbox,
  getUpgradeTargets,
  persistRuntimeStatuses,
  shouldPersistRuntimeStatus
}
