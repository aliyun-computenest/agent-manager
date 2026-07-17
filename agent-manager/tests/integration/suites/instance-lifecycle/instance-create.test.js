/**
 * instance-lifecycle：以【管理员】身份对【每一个】启用中的内置 agent-type
 * 执行完整生命周期：create → running → stop → stopped → start → running →
 * (modify model) → (modify channel) → delete
 *
 * 默认通过 TEST_SKIP_E2B=true 跳过；在 E2B 可达环境下置 false 开启。
 * 可通过 TEST_SKIP_INSTANCE_MODIFY=true 仅跳过 modify-model / modify-channel 两步。
 */
import { describe, it, afterAll } from 'vitest'
import { createApiClient } from '../../helpers/api-client.js'
import { getAdminToken } from '../../helpers/auth.js'
import { deleteByPrefix } from '../../helpers/supabase.js'
import { entityPrefix } from '../../helpers/factory.js'
import { testEnv } from '../../setup/test-env.js'
import { discoverLifecycleContexts, runLifecycle } from './_shared.js'

// —— 文件加载阶段预取上下文，这样 describe.each 可以按"内置 agent-type"逐一展开 ——
const admin = testEnv.skipE2b ? null : createApiClient({ token: await getAdminToken() })
const ctxs = admin ? await discoverLifecycleContexts(admin) : []

if (testEnv.skipE2b || ctxs.length === 0) {
  describe.skip('instance-lifecycle: 管理员全链路 (E2B)', () => {
    it.skip(
      testEnv.skipE2b ? '跳过：TEST_SKIP_E2B=true' : '跳过：未发现启用中的内置 agent-type',
      () => {},
    )
  })
} else {
  console.log(
    `[instance-lifecycle:admin] 将覆盖 ${ctxs.length} 个内置 agent-type: ` +
      ctxs.map((c) => c.builtinAgentType.code).join(', '),
  )

  // 最终清理：删本 runId 创建的所有 agent_instances
  afterAll(async () => {
    await deleteByPrefix('agent_instances', 'name', entityPrefix)
  })

  describe.each(ctxs)(
    'instance-lifecycle: 管理员全链路 (E2B) [$builtinAgentType.code]',
    (ctx) => {
      const code = ctx.builtinAgentType.code
      it(
        `admin[${code}]: 创建 → 暂停 → 唤醒 → 改模型 → 改渠道 → 删除`,
        async () => {
          console.log(
            `[instance-lifecycle:admin:${code}] primaryModel=${ctx.primaryModel?.name || '-'}, ` +
              `switchTo=${ctx.switchableModel?.name || '-'}, channel=${ctx.channelType || '-'}`,
          )
          await runLifecycle(admin, ctx, { label: `admin-${code}` })
        },
        testEnv.instanceReadyTimeoutMs * 3 + 120_000,
      )
    },
  )
}
