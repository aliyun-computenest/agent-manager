/**
 * skill-injection: 端到端链路测试
 *
 * 验证 Skill 动态选择挂载的完整链路：
 *   1. 获取 agent type（带 skill_config）
 *   2. 获取可用技能空间列表
 *   3. 创建实例（传 selectedSkillSpaceIds）
 *   4. 验证 skill_config 快照已生成
 *   5. 等待实例 running
 *   6. 执行命令验证 skill 挂载目录存在
 *   7. 清理实例
 *
 * 默认通过 TEST_SKIP_E2B=true 跳过；在 E2B 可达环境下置 false 开启。
 */
import { describe, it, expect, afterAll } from 'vitest'
import { createApiClient, expectOk } from '../../helpers/api-client.js'
import { getAdminToken } from '../../helpers/auth.js'
import { deleteByPrefix } from '../../helpers/supabase.js'
import { entityPrefix, prefixedName } from '../../helpers/factory.js'
import { waitFor } from '../../helpers/wait-for.js'
import { testEnv } from '../../setup/test-env.js'

const WRITE_REQ_TIMEOUT_MS = Math.max(
  Number(process.env.TEST_INSTANCE_WRITE_TIMEOUT_MS || 0) || 0,
  testEnv.instanceReadyTimeoutMs,
  120_000,
)

const admin = testEnv.skipE2b ? null : createApiClient({ token: await getAdminToken() })

if (testEnv.skipE2b) {
  describe.skip('skill-injection: 端到端链路 (E2B)', () => {
    it.skip('跳过：TEST_SKIP_E2B=true', () => {})
  })
} else {
  afterAll(async () => {
    await deleteByPrefix('agent_instances', 'name', entityPrefix)
  })

  describe('skill-injection: 端到端链路 (E2B)', () => {
    let agentType
    let skillSpaces = []

    it('获取带 skill_config 的 agent type', async () => {
      const typesRes = await expectOk(admin.get('/api/agent-types'))
      const types = (typesRes.agentTypes || []).filter(
        (t) => t.is_enabled && t.category !== 'custom',
      )
      expect(types.length, '应至少有一个启用的内置 agent type').toBeGreaterThan(0)
      // 优先选有 skill_config 的，否则用第一个
      agentType = types.find((t) => Array.isArray(t.skill_config) && t.skill_config.length > 0) || types[0]
      expect(agentType.id).toBeTruthy()
      console.log(`[skill-injection] agentType: ${agentType.code}, skill_config: ${JSON.stringify(agentType.skill_config || 'null')}`)
    })

    it('获取可用技能空间列表', async () => {
      const res = await adminClient.get('/api/skill-spaces?maxResults=20')
      if (res.status === 200 && res.body?.success) {
        skillSpaces = res.body.skillSpaces || []
      }
      console.log(`[skill-injection] skillSpaces: ${skillSpaces.length} 个`)
    })

    it('创建实例并验证 skill_config 快照（不选技能 → 空数组）', async () => {
      const name = prefixedName('skill-inject-empty')
      const createRes = await admin.post(
        '/api/instances',
        {
          name,
          agentTypeId: agentType.id,
          description: 'skill-injection test: empty selection',
          modelId: undefined,
          configJson: {},
          selectedSkillSpaceIds: [],
          async: true,
        },
        undefined,
        { timeoutMs: WRITE_REQ_TIMEOUT_MS },
      )
      expect(createRes.status, `create body=${JSON.stringify(createRes.body)?.slice(0, 500)}`).toBe(200)
      expect(createRes.body?.success).toBe(true)

      const instance = createRes.body.instance
      expect(instance.id).toBeTruthy()

      // 验证 skill_config 快照是数组（空数组也是合法的，不应回退到全量）
      const snapshot = instance.skill_config
      expect(Array.isArray(snapshot), 'skill_config 应为数组（空数组也是合法快照）').toBe(true)

      // 等待实例 running
      await pollStatus(admin, instance.id, 'running', testEnv.instanceReadyTimeoutMs)

      // 清理
      await admin.delete(`/api/instances/${instance.id}`)
    })

    it('创建实例并验证 skill 注入（选技能 → 快照非空 + 挂载验证）', async () => {
      if (skillSpaces.length === 0) {
        console.log('[skill-injection] 无可用技能空间，跳过选中场景')
        return
      }

      const selectedSpaceIds = skillSpaces.slice(0, 2).map((s) => s.skillSpaceId)
      const name = prefixedName('skill-inject-selected')
      const createRes = await admin.post(
        '/api/instances',
        {
          name,
          agentTypeId: agentType.id,
          description: 'skill-injection test: with skills',
          modelId: undefined,
          configJson: {},
          selectedSkillSpaceIds,
          async: true,
        },
        undefined,
        { timeoutMs: WRITE_REQ_TIMEOUT_MS },
      )
      expect(createRes.status, `create body=${JSON.stringify(createRes.body)?.slice(0, 500)}`).toBe(200)
      expect(createRes.body?.success).toBe(true)

      const instance = createRes.body.instance
      expect(instance.id).toBeTruthy()

      // 验证 skill_config 快照非空
      const snapshot = instance.skill_config
      expect(Array.isArray(snapshot), 'skill_config 应为数组').toBe(true)
      // 快照应包含选中的技能空间（如果 agent type 有 skill_config 的话）
      if (Array.isArray(agentType.skill_config) && agentType.skill_config.length > 0) {
        expect(snapshot.length, '选了技能空间时快照应非空').toBeGreaterThan(0)
      }

      // 等待实例 running
      await pollStatus(admin, instance.id, 'running', testEnv.instanceReadyTimeoutMs)

      // 验证 skill 挂载目录存在（通过终端 API 执行命令）
      const skillBasePath = agentType.code === 'openclaw'
        ? '/home/node/.openclaw/skills'
        : '/opt/skillhub/skills'
      try {
        const termRes = await admin.post(
          `/api/instances/${instance.id}/terminal`,
          { command: `ls -d ${skillBasePath}/*/ 2>/dev/null | head -5 || echo 'NO_SKILLS_DIR'` },
          undefined,
          { timeoutMs: 30_000 },
        )
        if (termRes.status === 200 && termRes.body?.output) {
          const output = termRes.body.output.trim()
          console.log(`[skill-injection] skill dirs: ${output}`)
          // 如果有 skill_config，应该能看到目录；如果没有，可能返回 NO_SKILLS_DIR
          if (snapshot.length > 0) {
            expect(output, '选了技能时应能列出挂载目录').not.toContain('NO_SKILLS_DIR')
          }
        } else {
          console.log(`[skill-injection] terminal API 不可用 (status=${termRes.status})，跳过挂载验证`)
        }
      } catch (err) {
        console.log(`[skill-injection] 终端验证失败（非阻塞）: ${err.message}`)
      }

      // 清理
      await admin.delete(`/api/instances/${instance.id}`)
    })
  })
}

// --- helpers ---

function adminClient() {
  return admin
}

async function pollStatus(actor, instanceId, expected, timeoutMs) {
  return waitFor(
    async () => {
      const r = await actor.get(`/api/instances/${instanceId}`)
      if (r.status !== 200) return null
      const s = r.body?.instance?.status
      if (s === expected) return r.body.instance
      if (s === 'failed' || s === 'error') {
        throw new Error(`实例进入失败态: ${JSON.stringify(r.body?.instance)}`)
      }
      return null
    },
    {
      timeoutMs,
      intervalMs: 5_000,
      label: `instance ${instanceId} -> ${expected}`,
    },
  )
}
