/**
 * qwenpaw-upgrade: live retention FVT
 *
 * Mirrors hermes-upgrade-retention.test.js but targets the QwenPaw agent type.
 * Uses two known QwenPaw-compatible images to toggle upgrades and verifies that
 * data under /app/working (covered by the preUpgrade tar archive) survives the
 * upgrade cycle.
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

const SKIP_QWENPAW = process.env.TEST_SKIP_QWENPAW_UPGRADE === 'true'
const RETENTION_FLAG = process.env.TEST_QWENPAW_UPGRADE_RETENTION
const ENABLED = !SKIP_QWENPAW && (RETENTION_FLAG === 'true' || (!RETENTION_FLAG && process.env.CI === 'true'))

const RETENTION_TIMEOUT_MS = Math.max(
  Number(process.env.TEST_QWENPAW_UPGRADE_RETENTION_TIMEOUT_MS || 0) || 0,
  900_000,
)
const WRITE_REQ_TIMEOUT_MS = Math.max(
  Number(process.env.TEST_INSTANCE_WRITE_TIMEOUT_MS || 0) || 0,
  testEnv.instanceReadyTimeoutMs,
  120_000,
)
const KUBECTL_TIMEOUT_MS = Number(process.env.TEST_QWENPAW_UPGRADE_KUBECTL_TIMEOUT_MS || 60_000)
const KUBECONFIG = process.env.TEST_KUBECONFIG || process.env.KUBECONFIG || defaultKubeconfigPath()

const QWENPAW_RETENTION_IMAGES = [
  'compute-nest-registry.cn-hangzhou.cr.aliyuncs.com/computenest/aliyun-computenest/agent-manager-qwenpaw-test:v0.0.1',
  'compute-nest-registry.cn-hangzhou.cr.aliyuncs.com/computenest/aliyun-computenest/agent-manager-qwenpaw-test:v0.0.1test4',
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
 * QwenPaw 把运行期可变数据写在 /app/working（config.json、profiles、workspaces 等），
 * 该目录由 preUpgrade hook 打包到 /backup，postUpgrade 会解压回 /app/working。
 * FVT marker 文件写到 /app/working/codex-fvt/<name>.json，与真实数据走同一条备份/恢复路径。
 */
function withFvtEnv(command, marker) {
  const fileName = safeFileName(marker)
  return [
    'set -euo pipefail',
    `QWENPAW_FVT_MARKER=${shellQuote(marker)}`,
    `QWENPAW_FVT_FILE="/app/working/codex-fvt/${fileName}.json"`,
    `QWENPAW_FVT_SECRET_FILE="/app/working.secret/codex-fvt/${fileName}.secret"`,
    'export QWENPAW_FVT_MARKER QWENPAW_FVT_FILE QWENPAW_FVT_SECRET_FILE',
    command,
  ].join('\n')
}

function defaultPreTaskCommand() {
  return [
    'QWENPAW_FVT_ROOT="$(dirname "$QWENPAW_FVT_FILE")"',
    'QWENPAW_FVT_SECRET_ROOT="$(dirname "$QWENPAW_FVT_SECRET_FILE")"',
    'mkdir -p "$QWENPAW_FVT_ROOT" "$QWENPAW_FVT_ROOT/chats" "$QWENPAW_FVT_ROOT/uploads" "$QWENPAW_FVT_ROOT/workspaces/project-a" "$QWENPAW_FVT_ROOT/profiles" "$QWENPAW_FVT_SECRET_ROOT"',
    'printf \'{"marker":"%s","kind":"qwenpaw-pre-upgrade","createdAt":"%s"}\\n\' "$QWENPAW_FVT_MARKER" "$(date -u +%FT%TZ)" > "$QWENPAW_FVT_FILE"',
    'printf \'{"role":"user","content":"analyze qwenpaw workspace","marker":"%s"}\\n{"role":"assistant","content":"qwenpaw result persisted","marker":"%s"}\\n\' "$QWENPAW_FVT_MARKER" "$QWENPAW_FVT_MARKER" > "$QWENPAW_FVT_ROOT/chats/session.jsonl"',
    'printf \'# uploaded note\\nmarker=%s\\ncontent=qwenpaw uploaded document before upgrade\\n\' "$QWENPAW_FVT_MARKER" > "$QWENPAW_FVT_ROOT/uploads/design-note.md"',
    'printf \'print("qwenpaw workspace marker: %s")\\n\' "$QWENPAW_FVT_MARKER" > "$QWENPAW_FVT_ROOT/workspaces/project-a/main.py"',
    'printf \'{"profile":"default","marker":"%s"}\\n\' "$QWENPAW_FVT_MARKER" > "$QWENPAW_FVT_ROOT/profiles/default.json"',
    'printf \'secret-marker=%s\\n\' "$QWENPAW_FVT_MARKER" > "$QWENPAW_FVT_SECRET_FILE"',
    'test -s "$QWENPAW_FVT_FILE"',
    'test -s "$QWENPAW_FVT_ROOT/chats/session.jsonl"',
    'test -s "$QWENPAW_FVT_ROOT/uploads/design-note.md"',
    'test -s "$QWENPAW_FVT_ROOT/workspaces/project-a/main.py"',
    'test -s "$QWENPAW_FVT_ROOT/profiles/default.json"',
    'test -s "$QWENPAW_FVT_SECRET_FILE"',
  ].join('\n')
}

function defaultPostVerifyCommand() {
  return [
    'QWENPAW_FVT_ROOT="$(dirname "$QWENPAW_FVT_FILE")"',
    'test -s "$QWENPAW_FVT_FILE"',
    'grep -F "$QWENPAW_FVT_MARKER" "$QWENPAW_FVT_FILE"',
    'grep -F "$QWENPAW_FVT_MARKER" "$QWENPAW_FVT_ROOT/chats/session.jsonl"',
    'grep -F "$QWENPAW_FVT_MARKER" "$QWENPAW_FVT_ROOT/uploads/design-note.md"',
    'grep -F "$QWENPAW_FVT_MARKER" "$QWENPAW_FVT_ROOT/workspaces/project-a/main.py"',
    'grep -F "$QWENPAW_FVT_MARKER" "$QWENPAW_FVT_ROOT/profiles/default.json"',
    'grep -F "$QWENPAW_FVT_MARKER" "$QWENPAW_FVT_SECRET_FILE"',
  ].join('\n')
}

const PRE_TASK_COMMAND = process.env.TEST_QWENPAW_UPGRADE_PRE_TASK_COMMAND || defaultPreTaskCommand()
const POST_VERIFY_COMMAND = process.env.TEST_QWENPAW_UPGRADE_POST_VERIFY_COMMAND || defaultPostVerifyCommand()

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

function getOppositeQwenPawRetentionImage(currentImage) {
  const index = QWENPAW_RETENTION_IMAGES.indexOf(currentImage)
  return index === -1 ? null : QWENPAW_RETENTION_IMAGES[(index + 1) % QWENPAW_RETENTION_IMAGES.length]
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

async function ensureQwenPawRetentionTargetImage(admin, instanceId, agentType, upgradeInfo) {
  const namespace = upgradeInfo?.Namespace
  const sandboxSetName = upgradeInfo?.SandboxSetName || inferSandboxSetName(agentType)
  const targetImage = getOppositeQwenPawRetentionImage(upgradeInfo?.CurrentImage)
  if (!namespace || !sandboxSetName || !targetImage) return upgradeInfo

  await waitForNoActiveSandboxUpdateOps(namespace, { label: '[qwenpaw-retention] wait before patching SandboxSet' })
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

async function discoverQwenPawAgentType(admin) {
  const qwenpawTypeId = process.env.TEST_QWENPAW_UPGRADE_AGENT_TYPE_ID
  if (qwenpawTypeId) {
    const detailRes = await admin.get(`/api/agent-types/${qwenpawTypeId}`)
    expect(detailRes.status).toBe(200)
    return detailRes.body?.agentType || null
  }

  const listRes = await admin.get('/api/agent-types')
  expect(listRes.status).toBe(200)
  return (listRes.body?.agentTypes || []).find(agentType =>
    agentType?.code === 'qwenpaw' &&
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
        throw new Error(`[qwenpaw-retention:${label}] instance failed: ${JSON.stringify(instance)}`)
      }
      return null
    },
    {
      timeoutMs: testEnv.instanceReadyTimeoutMs,
      intervalMs: 5_000,
      label: `[qwenpaw-retention:${label}] instance ${instanceId} -> ${expected}`,
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
        throw new Error(`[qwenpaw-retention] SandboxUpdateOps ${upgradeId} failed: ${JSON.stringify(upgrade)}`)
      }
      return null
    },
    {
      timeoutMs: RETENTION_TIMEOUT_MS,
      intervalMs: 10_000,
      label: `[qwenpaw-retention] SandboxUpdateOps ${upgradeId} -> Completed`,
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

describeRetention('qwenpaw-upgrade: live retention FVT', () => {
  let admin
  let agentType
  let instanceId
  let upgradeId

  beforeAll(async () => {
    if (SKIP_QWENPAW) {
      throw new Error('TEST_SKIP_QWENPAW_UPGRADE=true, qwenpaw retention FVT cannot run')
    }
    if (!KUBECONFIG) {
      throw new Error('Set TEST_KUBECONFIG/KUBECONFIG or provide ~/.kube/config before enabling qwenpaw retention FVT')
    }

    admin = createApiClient({ token: await getAdminToken() })
    agentType = await discoverQwenPawAgentType(admin)
    if (!agentType) {
      throw new Error('No enabled QwenPaw Agent Type with sandbox_template_id and upgrade hooks was found')
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
      const shouldKeepCompleted = process.env.TEST_QWENPAW_UPGRADE_RETENTION_CLEANUP !== 'true'
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

  it('升级前数据在 QwenPaw Sandbox 升级后仍保留', async () => {
    const primaryModel = await discoverPrimaryModel(admin, agentType)
    const marker = prefixedCode('qwenpaw-retention')
    const createRes = await admin.post(
      '/api/instances',
      {
        name: prefixedName('qwenpaw-retention'),
        agentTypeId: agentType.id,
        description: 'integration-test qwenpaw upgrade retention',
        modelId: primaryModel?.id || undefined,
        configJson: {},
        async: true,
      },
      undefined,
      { timeoutMs: WRITE_REQ_TIMEOUT_MS },
    )
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(200)
    expect(createRes.body?.success, JSON.stringify(createRes.body)).toBe(true)
    instanceId = createRes.body?.instance?.id
    expect(instanceId).toBeTruthy()

    await waitInstanceStatus(admin, instanceId, 'running', 'created')
    const instanceDetail = await expectOk(admin.get(`/api/instances/${instanceId}`))
    const upgradeInfo = await ensureQwenPawRetentionTargetImage(
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
        clientToken: uniqueToken('qwenpaw-retention'),
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
        label: `[qwenpaw-retention] ${namespace}/${sandboxName} post-upgrade artifact`,
      },
    )
  }, RETENTION_TIMEOUT_MS + testEnv.instanceReadyTimeoutMs + 60_000)
})
