/**
 * hermes-upgrade: live retention FVT
 *
 * Mirrors sandbox-upgrade-retention.test.js but targets the Hermes agent type.
 * Uses two known Hermes-compatible images to toggle upgrades and verifies that
 * data under /opt/data survives the upgrade cycle.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { CustomObjectsApi, Exec, KubeConfig } from '@kubernetes/client-node'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createApiClient, expectOk } from '../../helpers/api-client.js'
import { getAdminToken } from '../../helpers/auth.js'
import { prefixedCode, prefixedName } from '../../helpers/factory.js'
import { waitForNoActiveSandboxUpdateOps } from '../../helpers/sandbox-upgrade-ops.js'
import { waitFor } from '../../helpers/wait-for.js'
import { testEnv } from '../../setup/test-env.js'

const SKIP_HERMES = process.env.TEST_SKIP_HERMES_UPGRADE === 'true'
const RETENTION_FLAG = process.env.TEST_HERMES_UPGRADE_RETENTION
const ENABLED = !SKIP_HERMES && (RETENTION_FLAG === 'true' || (!RETENTION_FLAG && process.env.CI === 'true'))

const RETENTION_TIMEOUT_MS = Math.max(
  Number(process.env.TEST_HERMES_UPGRADE_RETENTION_TIMEOUT_MS || 0) || 0,
  900_000,
)
const WRITE_REQ_TIMEOUT_MS = Math.max(
  Number(process.env.TEST_INSTANCE_WRITE_TIMEOUT_MS || 0) || 0,
  testEnv.instanceReadyTimeoutMs,
  120_000,
)
const KUBECTL_TIMEOUT_MS = Number(process.env.TEST_HERMES_UPGRADE_KUBECTL_TIMEOUT_MS || 60_000)
const KUBECONFIG = process.env.TEST_KUBECONFIG || process.env.KUBECONFIG || defaultKubeconfigPath()

const HERMES_RETENTION_IMAGES = [
  'compute-nest-registry.cn-hangzhou.cr.aliyuncs.com/computenest/openclaw-manager-hermes-test:v0.0.2',
  'compute-nest-registry.cn-hangzhou.cr.aliyuncs.com/computenest/openclaw-manager-hermes-test:v0.0.12',
]

const K8S_GROUP = 'agents.kruise.io'
const K8S_VERSION = 'v1alpha1'

let kubeConfig = null
let customObjectsApi = null
let execClient = null

function defaultKubeconfigPath() {
  const home = process.env.HOME
  if (!home) return ''
  const path = join(home, '.kube', 'config')
  return existsSync(path) ? path : ''
}

function getKubeConfig() {
  if (kubeConfig) return kubeConfig
  kubeConfig = new KubeConfig()
  if (KUBECONFIG) {
    kubeConfig.loadFromFile(KUBECONFIG)
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

function getExecClient() {
  if (!execClient) {
    execClient = new Exec(getKubeConfig())
  }
  return execClient
}

function hasRunnableUpgradeMetadata(agentType) {
  const metadata = agentType?.upgrade_metadata || {}
  return Array.isArray(metadata.preUpgrade?.command) &&
    metadata.preUpgrade.command.length > 0 &&
    Array.isArray(metadata.postUpgrade?.command) &&
    metadata.postUpgrade.command.length > 0
}

function uniqueToken(tag) {
  return `${testEnv.runId}-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function safeFileName(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, '-')
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Hermes stores persistent data under /opt/data.  The FVT marker file is
 * written there so it goes through the same backup/restore path as real data.
 */
function withFvtEnv(command, marker) {
  const fileName = safeFileName(marker)
  return [
    'set -euo pipefail',
    `HERMES_FVT_MARKER=${shellQuote(marker)}`,
    `HERMES_FVT_FILE="/opt/data/codex-fvt/${fileName}.json"`,
    'export HERMES_FVT_MARKER HERMES_FVT_FILE',
    command,
  ].join('\n')
}

function defaultPreTaskCommand() {
  return [
    'HERMES_FVT_ROOT="$(dirname "$HERMES_FVT_FILE")"',
    'mkdir -p "$HERMES_FVT_ROOT" "$HERMES_FVT_ROOT/chats" "$HERMES_FVT_ROOT/uploads" "$HERMES_FVT_ROOT/workspaces/project-a" "$HERMES_FVT_ROOT/settings"',
    'printf \'{"marker":"%s","kind":"hermes-pre-upgrade","createdAt":"%s"}\\n\' "$HERMES_FVT_MARKER" "$(date -u +%FT%TZ)" > "$HERMES_FVT_FILE"',
    'printf \'{"role":"user","content":"run hermes task with uploaded context","marker":"%s"}\\n{"role":"assistant","content":"hermes task persisted","marker":"%s"}\\n\' "$HERMES_FVT_MARKER" "$HERMES_FVT_MARKER" > "$HERMES_FVT_ROOT/chats/session.jsonl"',
    'printf \'# uploaded note\\nmarker=%s\\ncontent=hermes uploaded document before upgrade\\n\' "$HERMES_FVT_MARKER" > "$HERMES_FVT_ROOT/uploads/design-note.md"',
    'printf \'print("hermes workspace marker: %s")\\n\' "$HERMES_FVT_MARKER" > "$HERMES_FVT_ROOT/workspaces/project-a/main.py"',
    'printf \'{"agent":"hermes","autoSave":true,"marker":"%s"}\\n\' "$HERMES_FVT_MARKER" > "$HERMES_FVT_ROOT/settings/user-preferences.json"',
    'test -s "$HERMES_FVT_FILE"',
    'test -s "$HERMES_FVT_ROOT/chats/session.jsonl"',
    'test -s "$HERMES_FVT_ROOT/uploads/design-note.md"',
    'test -s "$HERMES_FVT_ROOT/workspaces/project-a/main.py"',
    'test -s "$HERMES_FVT_ROOT/settings/user-preferences.json"',
  ].join('\n')
}

function defaultPostVerifyCommand() {
  return [
    'HERMES_FVT_ROOT="$(dirname "$HERMES_FVT_FILE")"',
    'test -s "$HERMES_FVT_FILE"',
    'grep -F "$HERMES_FVT_MARKER" "$HERMES_FVT_FILE"',
    'grep -F "$HERMES_FVT_MARKER" "$HERMES_FVT_ROOT/chats/session.jsonl"',
    'grep -F "$HERMES_FVT_MARKER" "$HERMES_FVT_ROOT/uploads/design-note.md"',
    'grep -F "$HERMES_FVT_MARKER" "$HERMES_FVT_ROOT/workspaces/project-a/main.py"',
    'grep -F "$HERMES_FVT_MARKER" "$HERMES_FVT_ROOT/settings/user-preferences.json"',
  ].join('\n')
}

const PRE_TASK_COMMAND = process.env.TEST_HERMES_UPGRADE_PRE_TASK_COMMAND || defaultPreTaskCommand()
const POST_VERIFY_COMMAND = process.env.TEST_HERMES_UPGRADE_POST_VERIFY_COMMAND || defaultPostVerifyCommand()

async function execInSandboxPod(namespace, podName, command, marker) {
  const stdout = []
  const stderr = []
  const stdoutStream = collectStream(stdout)
  const stderrStream = collectStream(stderr)
  const commandArgs = ['/bin/bash', '-lc', withFvtEnv(command, marker)]

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = callback => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      callback()
    }
    const timeout = setTimeout(() => {
      finish(() => reject(new Error(`[k8s exec] ${namespace}/${podName} timed out after ${KUBECTL_TIMEOUT_MS}ms`)))
    }, KUBECTL_TIMEOUT_MS)

    getExecClient().exec(
      namespace,
      podName,
      '',
      commandArgs,
      stdoutStream,
      stderrStream,
      null,
      false,
      status => {
        const code = status?.details?.causes?.find(cause => cause.reason === 'ExitCode')?.message || '0'
        if (status?.status === 'Success' || code === '0') {
          finish(() => resolve({ stdout: stdout.join(''), stderr: stderr.join('') }))
          return
        }
        finish(() => reject(new Error(
          `[k8s exec] ${namespace}/${podName} failed: ${status?.message || 'unknown'} stdout=${stdout.join('')} stderr=${stderr.join('')}`,
        )))
      },
    ).catch(error => {
      finish(() => reject(new Error(`[k8s exec] ${namespace}/${podName} failed: ${error.message}`)))
    })
  })
}

function collectStream(chunks) {
  return new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk))
      callback()
    },
  })
}

function getOppositeHermesRetentionImage(currentImage) {
  const index = HERMES_RETENTION_IMAGES.indexOf(currentImage)
  return index === -1 ? null : HERMES_RETENTION_IMAGES[(index + 1) % HERMES_RETENTION_IMAGES.length]
}

async function readSandboxSet(namespace, sandboxSetName) {
  return getCustomObjectsApi().getNamespacedCustomObject({
    group: K8S_GROUP,
    version: K8S_VERSION,
    namespace,
    plural: 'sandboxsets',
    name: sandboxSetName,
  })
}

function getSandboxSetFirstImage(sandboxSet) {
  return sandboxSet?.spec?.template?.spec?.containers?.[0]?.image || null
}

async function patchSandboxSetImage(namespace, sandboxSetName, targetImage) {
  const sandboxSet = await readSandboxSet(namespace, sandboxSetName)
  const body = JSON.parse(JSON.stringify(sandboxSet))
  const containers = body?.spec?.template?.spec?.containers
  if (!Array.isArray(containers) || !containers[0]) {
    throw new Error(`SandboxSet ${namespace}/${sandboxSetName} has no spec.template.spec.containers[0]`)
  }

  containers[0].image = targetImage
  delete body.status
  if (body.metadata) {
    delete body.metadata.managedFields
  }

  await getCustomObjectsApi().replaceNamespacedCustomObject({
    group: K8S_GROUP,
    version: K8S_VERSION,
    namespace,
    plural: 'sandboxsets',
    name: sandboxSetName,
    body,
  })

  const refreshed = await readSandboxSet(namespace, sandboxSetName)
  const observedImage = getSandboxSetFirstImage(refreshed)
  if (observedImage !== targetImage) {
    throw new Error(`SandboxSet ${namespace}/${sandboxSetName} image is ${observedImage}, expected ${targetImage}`)
  }
}

function inferSandboxSetName(agentType) {
  return agentType?.sandbox_template_id ||
    (agentType?.code ? `agent-manager-${agentType.code}` : null)
}

async function ensureHermesRetentionTargetImage(admin, instanceId, agentType, upgradeInfo) {
  const namespace = upgradeInfo?.Namespace
  const sandboxSetName = upgradeInfo?.SandboxSetName || inferSandboxSetName(agentType)
  const targetImage = getOppositeHermesRetentionImage(upgradeInfo?.CurrentImage)
  if (!namespace || !sandboxSetName || !targetImage) return upgradeInfo

  await waitForNoActiveSandboxUpdateOps(namespace, { label: '[hermes-retention] wait before patching SandboxSet' })
  await patchSandboxSetImage(namespace, sandboxSetName, targetImage)
  const refreshed = await admin.get(`/api/instances/${instanceId}`)
  const refreshedUpgradeInfo = refreshed.status === 200
    ? refreshed.body?.instance?.sandbox_upgrade
    : null

  return {
    ...(refreshedUpgradeInfo || upgradeInfo),
    TargetImage: targetImage,
    CanUpgrade: Boolean((refreshedUpgradeInfo || upgradeInfo)?.BackupReady),
    Reason: 'UPGRADE_AVAILABLE',
  }
}

async function discoverHermesAgentType(admin) {
  const hermesTypeId = process.env.TEST_HERMES_UPGRADE_AGENT_TYPE_ID
  if (hermesTypeId) {
    const detailRes = await admin.get(`/api/agent-types/${hermesTypeId}`)
    expect(detailRes.status).toBe(200)
    return detailRes.body?.agentType || null
  }

  const listRes = await admin.get('/api/agent-types')
  expect(listRes.status).toBe(200)
  return (listRes.body?.agentTypes || []).find(agentType =>
    agentType?.code === 'hermes' &&
    agentType?.is_enabled &&
    agentType?.sandbox_template_id &&
    hasRunnableUpgradeMetadata(agentType),
  ) || null
}

async function discoverPrimaryModel(admin, agentType) {
  const modelsBody = await expectOk(admin.get('/api/models'))
  const enabledModels = (modelsBody.models || []).filter(model => model.is_enabled !== false)
  const preferredProvider = agentType?.preferred_provider || agentType?.default_provider
  return enabledModels.find(model => preferredProvider && model.provider === preferredProvider) ||
    enabledModels[0] ||
    null
}

async function waitInstanceStatus(admin, instanceId, expected, label) {
  return waitFor(
    async () => {
      const res = await admin.get(`/api/instances/${instanceId}`)
      if (res.status !== 200) return null
      const instance = res.body?.instance
      if (instance?.status === expected) return instance
      if (instance?.status === 'failed' || instance?.status === 'error') {
        throw new Error(`[hermes-retention:${label}] instance failed: ${JSON.stringify(instance)}`)
      }
      return null
    },
    {
      timeoutMs: testEnv.instanceReadyTimeoutMs,
      intervalMs: 5_000,
      label: `[hermes-retention:${label}] instance ${instanceId} -> ${expected}`,
    },
  )
}

async function waitUpgradeCompleted(admin, upgradeId) {
  return waitFor(
    async () => {
      const detail = await admin.get(`/api/sandbox-upgrades/${upgradeId}`)
      if (detail.status !== 200) return null
      const upgrade = detail.body?.Upgrade
      if (upgrade?.Phase === 'Completed') return upgrade
      if (upgrade?.Phase === 'Failed') {
        throw new Error(`[hermes-retention] SandboxUpdateOps ${upgradeId} failed: ${JSON.stringify(upgrade)}`)
      }
      return null
    },
    {
      timeoutMs: RETENTION_TIMEOUT_MS,
      intervalMs: 10_000,
      label: `[hermes-retention] SandboxUpdateOps ${upgradeId} -> Completed`,
    },
  )
}

async function deleteUpgradeResource(admin, agentTypeId, upgradeId) {
  const detail = await admin.get(`/api/sandbox-upgrades/${upgradeId}`)
  const phase = detail.body?.Upgrade?.Phase
  if (phase === 'Updating') return
  await admin.delete(`/api/agent-types/${agentTypeId}/sandbox-upgrades/${upgradeId}/resource`).catch(() => {})
}

const describeRetention = ENABLED ? describe : describe.skip

describeRetention('hermes-upgrade: live retention FVT', () => {
  let admin
  let agentType
  let instanceId
  let upgradeId

  beforeAll(async () => {
    if (SKIP_HERMES) {
      throw new Error('TEST_SKIP_HERMES_UPGRADE=true, hermes retention FVT cannot run')
    }
    if (!KUBECONFIG) {
      throw new Error('Set TEST_KUBECONFIG/KUBECONFIG or provide ~/.kube/config before enabling hermes retention FVT')
    }

    admin = createApiClient({ token: await getAdminToken() })
    agentType = await discoverHermesAgentType(admin)
    if (!agentType) {
      throw new Error('No enabled Hermes Agent Type with sandbox_template_id and upgrade hooks was found')
    }

    // Clean up any blocking (non-Completed) SandboxUpdateOps left by previous runs
    const historyRes = await admin.get(`/api/sandbox-upgrades?agentTypeId=${encodeURIComponent(agentType.id)}`)
    if (historyRes.status === 200) {
      for (const item of historyRes.body?.Items || []) {
        if (item.Phase && item.Phase !== 'Completed') {
          await admin.delete(
            `/api/agent-types/${agentType.id}/sandbox-upgrades/${item.UpgradeId}/resource`,
          ).catch(() => {})
        }
      }
    }
  })

  afterAll(async () => {
    if (admin && upgradeId && agentType?.id) {
      const detail = await admin.get(`/api/sandbox-upgrades/${upgradeId}`).catch(() => null)
      const phase = detail?.body?.Upgrade?.Phase
      const isCompleted = phase === 'Completed'
      const shouldKeepCompleted = process.env.TEST_HERMES_UPGRADE_RETENTION_CLEANUP !== 'true'
      if (isCompleted && shouldKeepCompleted) {
        // Keep completed ops for postmortem unless explicitly asked to clean up
      } else {
        await deleteUpgradeResource(admin, agentType.id, upgradeId)
      }
    }
    if (admin && instanceId) {
      await admin.delete(`/api/instances/${instanceId}`).catch(() => {})
    }
  })

  it('升级前数据在 Hermes Sandbox 升级后仍保留', async () => {
    const primaryModel = await discoverPrimaryModel(admin, agentType)
    const marker = prefixedCode('hermes-retention')
    const createRes = await admin.post(
      '/api/instances',
      {
        name: prefixedName('hermes-retention'),
        agentTypeId: agentType.id,
        description: 'integration-test hermes upgrade retention',
        modelId: primaryModel?.id || undefined,
        configJson: {},
        async: true,
      },
      undefined,
      { timeoutMs: WRITE_REQ_TIMEOUT_MS },
    )
    expect(createRes.status).toBe(200)
    expect(createRes.body?.success).toBe(true)
    instanceId = createRes.body?.instance?.id
    expect(instanceId).toBeTruthy()

    await waitInstanceStatus(admin, instanceId, 'running', 'created')
    const instanceDetail = await expectOk(admin.get(`/api/instances/${instanceId}`))
    const upgradeInfo = await ensureHermesRetentionTargetImage(
      admin,
      instanceId,
      agentType,
      instanceDetail.instance?.sandbox_upgrade,
    )
    const namespace = upgradeInfo?.Namespace
    const sandboxName = upgradeInfo?.SandboxName

    expect(namespace).toBeTruthy()
    expect(sandboxName).toBeTruthy()
    expect(upgradeInfo?.BackupReady, JSON.stringify(upgradeInfo)).toBe(true)
    expect(upgradeInfo?.CanUpgrade, JSON.stringify(upgradeInfo)).toBe(true)
    expect(upgradeInfo?.CurrentImage).not.toBe(upgradeInfo?.TargetImage)

    await execInSandboxPod(namespace, sandboxName, PRE_TASK_COMMAND, marker)

    const startRes = await admin.post(
      `/api/agent-types/${agentType.id}/sandbox-upgrades`,
      {
        clientToken: uniqueToken('hermes-retention'),
        maxUnavailable: 1,
        lifecycleMode: 'Full',
        target: {
          type: 'SelectedSandboxes',
          sandboxNames: [sandboxName],
        },
      },
      undefined,
      { timeoutMs: WRITE_REQ_TIMEOUT_MS },
    )
    expect(startRes.status, JSON.stringify(startRes.body)).toBe(200)
    expect(startRes.body?.success).toBe(true)
    upgradeId = startRes.body?.UpgradeId
    expect(upgradeId).toBeTruthy()

    await waitUpgradeCompleted(admin, upgradeId)
    await waitInstanceStatus(admin, instanceId, 'running', 'upgraded')
    await waitFor(
      () => execInSandboxPod(namespace, sandboxName, POST_VERIFY_COMMAND, marker).then(() => true),
      {
        timeoutMs: testEnv.instanceReadyTimeoutMs,
        intervalMs: 5_000,
        label: `[hermes-retention] ${namespace}/${sandboxName} post-upgrade artifact`,
      },
    )
  }, RETENTION_TIMEOUT_MS + testEnv.instanceReadyTimeoutMs + 60_000)
})
