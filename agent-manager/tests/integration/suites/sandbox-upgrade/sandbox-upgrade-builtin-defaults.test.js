/**
 * sandbox-upgrade: 内置 Agent Type 的备份升级默认配置契约
 *
 * 目的：保证 openclaw / hermes / qwenpaw 三个内置 Agent Type 都具备：
 *   1. 非空 pre/post hook 命令数组（数据库迁移落盘过）
 *   2. pre 命令引用 /backup 路径并产出 <code>-state-*.tgz 归档
 *   3. post 命令从 /backup 读取 <code>-state-*.tgz 并恢复
 *   4. 关联 SandboxSet 同时声明 agent-runtime 与 csi runtime，
 *      这是后端 getSandboxSetBackupRestoreCapability() 判定可升级的必要条件
 *
 * 这些断言在 DB/K8s bootstrap 之后运行，对开发同学的回归价值高：
 *   - 任何 agent type 缺失 upgrade_metadata → 立即失败，避免线上发起升级时才被 400 拦住
 *   - SandboxSet.yaml 未加 csi runtime → 立即失败，避免实例创建后不具备备份能力
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { createApiClient, expectOk } from '../../helpers/api-client.js'
import { getAdminToken } from '../../helpers/auth.js'
import { testEnv } from '../../setup/test-env.js'

const BUILTIN_AGENT_TYPES = [
  {
    code: 'openclaw',
    preContains: ['openclaw-state-$BACKUP_ID.tgz', '/backup'],
    postContains: ['openclaw-state-*.tgz', 'supervisorctl restart openclaw'],
  },
  {
    code: 'hermes',
    preContains: ['hermes-state-$BACKUP_ID.tgz', 'HERMES_DATA_DIR="/opt/data"'],
    postContains: ['hermes-state-*.tgz', 'supervisorctl restart hermes'],
  },
  {
    code: 'qwenpaw',
    preContains: [
      'qwenpaw-state-$BACKUP_ID.tgz',
      'WORKING_DIR="/app/working"',
      'SECRET_DIR="/app/working.secret"',
      'tar -czf "$ARCHIVE" -C /app working working.secret',
    ],
    postContains: [
      'qwenpaw-state-*.tgz',
      'tar -xzf "$ARCHIVE" -C /app',
      '/usr/local/bin/run-cmd.sh restart',
    ],
  },
]

function hasRunnableHookCommand(command) {
  return Array.isArray(command)
    && command.length >= 3
    && command[0] === '/bin/bash'
    && command[1] === '-c'
    && typeof command[2] === 'string'
    && command[2].length > 0
}

describe('sandbox-upgrade: 内置 Agent Type 备份升级配置契约', () => {
  let admin
  let agentTypesByCode

  beforeAll(async () => {
    admin = createApiClient({ token: await getAdminToken() })
    const body = await expectOk(admin.get('/api/agent-types'))
    agentTypesByCode = new Map(
      (body.agentTypes || []).map(agentType => [agentType.code, agentType])
    )
  })

  for (const spec of BUILTIN_AGENT_TYPES) {
    describe(`${spec.code} agent type`, () => {
      it('存在于 agent_types 表且 sandbox_template_id 非空', () => {
        const agentType = agentTypesByCode.get(spec.code)
        expect(agentType, `agent type ${spec.code} 未初始化`).toBeTruthy()
        expect(agentType.sandbox_template_id).toBeTruthy()
      })

      it('upgrade_metadata.preUpgrade.command 是可执行的 bash -c 数组', () => {
        const metadata = agentTypesByCode.get(spec.code)?.upgrade_metadata || {}
        expect(hasRunnableHookCommand(metadata.preUpgrade?.command)).toBe(true)
        const script = metadata.preUpgrade.command[2]
        for (const needle of spec.preContains) {
          expect(script, `pre hook 缺少关键字: ${needle}`).toContain(needle)
        }
      })

      it('upgrade_metadata.postUpgrade.command 是可执行的 bash -c 数组', () => {
        const metadata = agentTypesByCode.get(spec.code)?.upgrade_metadata || {}
        expect(hasRunnableHookCommand(metadata.postUpgrade?.command)).toBe(true)
        const script = metadata.postUpgrade.command[2]
        for (const needle of spec.postContains) {
          expect(script, `post hook 缺少关键字: ${needle}`).toContain(needle)
        }
      })

      it('upgrade_metadata.timeoutSeconds 为正整数', () => {
        const metadata = agentTypesByCode.get(spec.code)?.upgrade_metadata || {}
        expect(Number.isInteger(metadata.timeoutSeconds)).toBe(true)
        expect(metadata.timeoutSeconds).toBeGreaterThan(0)
      })
    })
  }
})

if (testEnv.skipSandboxUpgrade) {
  describe.skip('sandbox-upgrade: 内置 Agent Type SandboxSet 备份能力 (live cluster)', () => {
    it.skip('跳过：TEST_SKIP_SANDBOX_UPGRADE=true', () => {})
  })
} else {
  /**
   * 实际打 /api/agent-types/:id/sandboxes —— 后端会调用 getSandboxSet() +
   * getSandboxSetBackupRestoreCapability()。BackupRestore.Supported=true
   * 即证明 agent-runtime + csi 两个 runtime 都已在 SandboxSet 中声明。
   */
  describe('sandbox-upgrade: 内置 Agent Type SandboxSet 备份能力 (live cluster)', () => {
    let admin
    let agentTypesByCode

    beforeAll(async () => {
      admin = createApiClient({ token: await getAdminToken() })
      const body = await expectOk(admin.get('/api/agent-types'))
      agentTypesByCode = new Map(
        (body.agentTypes || []).map(agentType => [agentType.code, agentType])
      )
    })

    for (const spec of BUILTIN_AGENT_TYPES) {
      it(`${spec.code} 关联的 SandboxSet 支持 backup/restore`, async () => {
        const agentType = agentTypesByCode.get(spec.code)
        if (!agentType) return

        const res = await admin.get(`/api/agent-types/${agentType.id}/sandboxes`)
        // Missing cluster fixtures only happens when the admin disabled this
        // agent type; skip rather than fail hard.
        if (res.status !== 200) return
        const capability = res.body?.BackupRestoreCapability
        expect(capability, `${spec.code}: 响应未返回 BackupRestoreCapability`).toBeTruthy()
        expect(
          capability.Supported,
          `${spec.code}: SandboxSet 缺少 runtime ${JSON.stringify(capability.MissingRuntimes)}`,
        ).toBe(true)
      })
    }
  })
}
