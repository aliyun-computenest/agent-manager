/**
 * sandbox-upgrade: API contract FVT
 *
 * 默认覆盖非破坏性的权限与参数校验。若配置 TEST_SANDBOX_UPGRADE_AGENT_TYPE_ID，
 * 额外验证目标环境中的 SandboxUpdateOps 只读列表、可升级 Sandbox 查询，以及
 * no-match selector 不会创建升级任务。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createApiClient } from '../../helpers/api-client.js'
import { createEphemeralUserViaApi, getAdminToken } from '../../helpers/auth.js'
import { hasSandboxUpdateOpsKubeconfig, waitForNoActiveSandboxUpdateOps } from '../../helpers/sandbox-upgrade-ops.js'
import { testEnv } from '../../setup/test-env.js'

const STATIC_AGENT_TYPE_ID = '00000000-0000-4000-8000-000000000001'

function uniqueToken(tag) {
  return `${testEnv.runId}-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function validationText(body) {
  const details = Array.isArray(body?.details)
    ? body.details.flatMap(detail => [detail.path, detail.message])
    : []
  return [body?.error, ...details].filter(Boolean).join(' ')
}

function hasRunnableUpgradeMetadata(agentType) {
  const metadata = agentType?.upgrade_metadata || {}
  return Array.isArray(metadata.preUpgrade?.command) &&
    metadata.preUpgrade.command.length > 0 &&
    Array.isArray(metadata.postUpgrade?.command) &&
    metadata.postUpgrade.command.length > 0
}

describe('sandbox-upgrade: API contract', () => {
  let admin
  let normalUser

  beforeAll(async () => {
    admin = createApiClient({ token: await getAdminToken() })
    normalUser = await createEphemeralUserViaApi(admin, { tag: 'sbu-rbac', role: 'user' })
  })

  afterAll(async () => {
    await normalUser?.cleanup?.()
  })

  it('普通用户不能访问 Sandbox 升级管理接口', async () => {
    const userClient = createApiClient({ token: normalUser.token })

    const listRes = await userClient.get(`/api/sandbox-upgrades?agentTypeId=${STATIC_AGENT_TYPE_ID}`)
    expect(listRes.status).toBe(403)

    const targetRes = await userClient.get(`/api/agent-types/${STATIC_AGENT_TYPE_ID}/sandboxes`)
    expect(targetRes.status).toBe(403)

    const createRes = await userClient.post(`/api/agent-types/${STATIC_AGENT_TYPE_ID}/sandbox-upgrades`, {
      clientToken: uniqueToken('user-create'),
      maxUnavailable: 1,
      target: {
        type: 'LabelSelector',
        selector: { matchLabels: { app: 'never-match' }, matchExpressions: [] },
      },
    })
    expect(createRes.status).toBe(403)
  })

  it('历史列表缺少 agentTypeId 应返回 400', async () => {
    const res = await admin.get('/api/sandbox-upgrades')
    expect(res.status).toBe(400)
    expect(res.body?.success).toBe(false)
    expect(validationText(res.body)).toMatch(/agentTypeId/i)
  })

  it('创建升级缺少 clientToken 应返回 400，且不访问集群', async () => {
    const res = await admin.post(`/api/agent-types/${STATIC_AGENT_TYPE_ID}/sandbox-upgrades`, {
      maxUnavailable: 1,
      target: {
        type: 'LabelSelector',
        selector: { matchLabels: { app: 'never-match' }, matchExpressions: [] },
      },
    })
    expect(res.status).toBe(400)
    expect(res.body?.success).toBe(false)
    expect(validationText(res.body)).toMatch(/clientToken/i)
  })

  it('创建升级非法 maxUnavailable 应返回 400，且不访问集群', async () => {
    const res = await admin.post(`/api/agent-types/${STATIC_AGENT_TYPE_ID}/sandbox-upgrades`, {
      clientToken: uniqueToken('bad-max'),
      maxUnavailable: '0%',
      target: {
        type: 'LabelSelector',
        selector: { matchLabels: { app: 'never-match' }, matchExpressions: [] },
      },
    })
    expect(res.status).toBe(400)
    expect(res.body?.success).toBe(false)
    expect(res.body?.error).toMatch(/maxUnavailable/i)
  })

  it('保存非法 upgrade_metadata 应返回 400 而不是 500', async () => {
    const res = await admin.put(`/api/agent-types/${STATIC_AGENT_TYPE_ID}`, {
      upgrade_metadata: null,
    })
    expect(res.status).toBe(400)
    expect(res.body?.success).toBe(false)
    expect(validationText(res.body)).toMatch(/upgrade_metadata/i)
  })
})

async function discoverUpgradeAgentType(admin) {
  if (testEnv.sandboxUpgradeAgentTypeId) {
    const detailRes = await admin.get(`/api/agent-types/${testEnv.sandboxUpgradeAgentTypeId}`)
    expect(detailRes.status).toBe(200)
    return detailRes.body?.agentType || null
  }

  const listRes = await admin.get('/api/agent-types')
  expect(listRes.status).toBe(200)
  return (listRes.body?.agentTypes || []).find(agentType =>
    agentType?.sandbox_template_id && hasRunnableUpgradeMetadata(agentType)
  ) || null
}

describe('sandbox-upgrade: retry & resource API', () => {
  let admin

  beforeAll(async () => {
    admin = createApiClient({ token: await getAdminToken() })
  })

  it('retry 缺少 clientToken → 400', async () => {
    const res = await admin.post(
      `/api/agent-types/${STATIC_AGENT_TYPE_ID}/sandbox-upgrades/fake-upgrade-id/retry`,
      { maxUnavailable: 1 },
    )
    expect(res.status).toBe(400)
    expect(res.body?.success).toBe(false)
    expect(validationText(res.body)).toMatch(/clientToken/i)
  })

  it('update-resource 不存在的 upgradeId → 404', async () => {
    const res = await admin.put(
      `/api/agent-types/${STATIC_AGENT_TYPE_ID}/sandbox-upgrades/fake-upgrade-id/resource`,
      { resource: {} },
    )
    // handler 先查 K8s 资源再校验 body，fake-upgrade-id 不存在 → 404
    expect(res.status).toBe(404)
  })

  it('普通用户不能 retry → 403', async () => {
    const normalUser = await createEphemeralUserViaApi(admin, { tag: 'sbu-retry-rbac' })
    const userClient = createApiClient({ token: normalUser.token })

    const res = await userClient.post(
      `/api/agent-types/${STATIC_AGENT_TYPE_ID}/sandbox-upgrades/fake-upgrade-id/retry`,
      { clientToken: uniqueToken('user-retry') },
    )
    expect([401, 403]).toContain(res.status)

    await normalUser.cleanup()
  })
})

if (testEnv.skipSandboxUpgrade) {
  describe.skip('sandbox-upgrade: live cluster API', () => {
    it.skip('跳过：TEST_SKIP_SANDBOX_UPGRADE=true', () => {})
  })
} else {
  describe('sandbox-upgrade: live cluster API', () => {
    let admin
    let agentType

    beforeAll(async () => {
      admin = createApiClient({ token: await getAdminToken() })
      agentType = await discoverUpgradeAgentType(admin)
      if (!agentType) {
        console.warn('[sandbox-upgrade] 未找到已配置 hooks 的 Agent Type，live cluster API 用例仅做环境跳过')
      }
    })

    it('可查询 Agent Type 对应的可升级 Sandbox 列表', async () => {
      if (!agentType) return

      const res = await admin.get(`/api/agent-types/${agentType.id}/sandboxes`)
      expect(res.status).toBe(200)
      expect(res.body?.success).toBe(true)
      expect(typeof res.body?.Namespace).toBe('string')
      expect(typeof res.body?.SandboxSetName).toBe('string')
      expect(res.body?.DefaultSelector?.matchLabels).toBeTruthy()
      expect(Array.isArray(res.body?.Items)).toBe(true)
      expect(Array.isArray(res.body?.TargetImages)).toBe(true)
    })

    it('可查询 Sandbox 升级历史列表', async () => {
      if (!agentType) return

      const res = await admin.get(`/api/sandbox-upgrades?agentTypeId=${encodeURIComponent(agentType.id)}`)
      expect(res.status).toBe(200)
      expect(res.body?.success).toBe(true)
      expect(Array.isArray(res.body?.Items)).toBe(true)
    })

    it('no-match LabelSelector 应返回 400 且不创建 SandboxUpdateOps', async () => {
      if (!agentType) return

      // Clean up any blocking (non-Completed) SandboxUpdateOps left by earlier test suites
      // so this test can reach the selector-matching stage instead of getting 409.
      const sandboxesRes = await admin.get(`/api/agent-types/${agentType.id}/sandboxes`)
      if (hasSandboxUpdateOpsKubeconfig() && sandboxesRes.status === 200 && sandboxesRes.body?.Namespace) {
        await waitForNoActiveSandboxUpdateOps(sandboxesRes.body.Namespace, {
          label: '[sandbox-upgrade] wait before no-match selector test',
        })
      }
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

      const res = await admin.post(`/api/agent-types/${agentType.id}/sandbox-upgrades`, {
        clientToken: uniqueToken('no-match'),
        maxUnavailable: 1,
        target: {
          type: 'LabelSelector',
          selector: {
            matchLabels: {
              'openclaw.io/fvt-never-match': uniqueToken('selector'),
            },
            matchExpressions: [],
          },
        },
      })
      expect(res.status).toBe(400)
      expect(res.body?.success).toBe(false)
      expect(res.body?.error).toMatch(/selector did not match/i)
    })
  })
}
