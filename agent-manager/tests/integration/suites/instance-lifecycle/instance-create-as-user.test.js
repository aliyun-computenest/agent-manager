/**
 * instance-lifecycle：以【普通用户】身份对【每一个】启用中的内置 agent-type
 * 执行完整生命周期（作为 admin 路径的对照）。
 *
 * 与 admin 路径的差异：
 *   - 元数据查询仍走 admin（保证能读全量 agent-types / models / channel-templates）
 *   - create / stop / start / modify / delete 全部以临时普通用户 token 执行
 *   - 验证 instance.principal_id 所有权校验分支（isAdmin=false && instance.principal_id === req.user.id）
 *   - 临时用户通过后端 /api/users 创建，规避"测试进程 → Supabase"与"后端 → Supabase"
 *     可能落到不同 pooler/replica 引起的 profile 可见性不一致
 *
 * 默认通过 TEST_SKIP_E2B=true 跳过；TEST_SKIP_INSTANCE_MODIFY=true 仅跳过 modify 两步。
 */
import { describe, it, afterAll } from 'vitest'
import { createApiClient } from '../../helpers/api-client.js'
import { getAdminToken, createEphemeralUserViaApi } from '../../helpers/auth.js'
import { deleteByPrefix } from '../../helpers/supabase.js'
import { entityPrefix } from '../../helpers/factory.js'
import { testEnv } from '../../setup/test-env.js'
import { discoverLifecycleContexts, runLifecycle } from './_shared.js'

// —— 文件加载阶段预取 admin / ephemeral-user / ctxs —————————————————————————
const admin = testEnv.skipE2b ? null : createApiClient({ token: await getAdminToken() })
const ctxs = admin ? await discoverLifecycleContexts(admin) : []
const ephemeral =
  admin && ctxs.length > 0
    ? await createEphemeralUserViaApi(admin, { role: 'user', tag: 'inst-user' })
    : null
const userClient = ephemeral ? createApiClient({ token: ephemeral.token }) : null

if (testEnv.skipE2b || ctxs.length === 0 || !userClient) {
  describe.skip('instance-lifecycle: 普通用户全链路 (E2B, 对照)', () => {
    it.skip(
      testEnv.skipE2b ? '跳过：TEST_SKIP_E2B=true' : '跳过：未发现启用中的内置 agent-type',
      () => {},
    )
  })
} else {
  console.log(
    `[instance-lifecycle:user] actor=${ephemeral.username}, 将覆盖 ${ctxs.length} 个内置 agent-type: ` +
      ctxs.map((c) => c.builtinAgentType.code).join(', '),
  )

  afterAll(async () => {
    await deleteByPrefix('agent_instances', 'name', entityPrefix)
    if (ephemeral?.cleanup) {
      await ephemeral.cleanup().catch(() => {})
    }
  })

  describe.each(ctxs)(
    'instance-lifecycle: 普通用户全链路 (E2B, 对照) [$builtinAgentType.code]',
    (ctx) => {
      const code = ctx.builtinAgentType.code
      it(
        `user[${code}]: 创建 → 暂停 → 唤醒 → 改模型 → 改渠道 → 删除`,
        async () => {
          console.log(
            `[instance-lifecycle:user:${code}] primaryModel=${ctx.primaryModel?.name || '-'}, ` +
              `switchTo=${ctx.switchableModel?.name || '-'}, channel=${ctx.channelType || '-'}`,
          )
          await runLifecycle(userClient, ctx, { label: `user-${code}` })
        },
        testEnv.instanceReadyTimeoutMs * 3 + 120_000,
      )
    },
  )
}
