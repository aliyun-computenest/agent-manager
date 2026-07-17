/**
 * instance-lifecycle 共享链路：在给定身份的 client 上执行
 *   create → running → stop → stopped → start → running → (modify model) → (modify channel) → delete
 *
 * 元数据（agent-types / models / channel-templates）统一用 admin 查，避免 role 受限读不到全量。
 */
import { expect } from 'vitest'
import { createApiClient, expectOk } from '../../helpers/api-client.js'
import { testSupabaseAdmin } from '../../helpers/supabase.js'
import { prefixedName } from '../../helpers/factory.js'
import { waitFor } from '../../helpers/wait-for.js'
import { testEnv } from '../../setup/test-env.js'

const SKIP_MODIFY = process.env.TEST_SKIP_INSTANCE_MODIFY === 'true'
const POOL_COOLDOWN_MAX_MS = Number(process.env.TEST_POOL_COOLDOWN_MS || 0) || 180_000
const POOL_POLL_INTERVAL_MS = 10_000

/**
 * 实例 provision / modify 类 HTTP 请求的同步阶段（APIG consumer + E2B create/commit）
 * 经常超过默认 TEST_REQUEST_TIMEOUT_MS。这里统一给这类"写"请求单独放大超时，
 * 避免因 30s 默认值导致 aborted timeout。
 */
const WRITE_REQ_TIMEOUT_MS = Math.max(
  Number(process.env.TEST_INSTANCE_WRITE_TIMEOUT_MS || 0) || 0,
  testEnv.instanceReadyTimeoutMs,
  120_000,
)

/**
 * 通过 admin client 挑选：内置 agent-type、初始模型、切换目标模型、可选 channelType。
 *
 * 单数版本仅返回挑出的第一个内置 agent-type 的上下文，用于历史兼容（不再被新用例使用）。
 */
export async function discoverLifecycleContext(admin) {
  const list = await discoverLifecycleContexts(admin)
  return list[0] || {
    builtinAgentType: null,
    primaryModel: null,
    switchableModel: null,
    channelType: null,
  }
}

/**
 * 为【每一个】启用中的内置 agent-type 构造生命周期上下文：
 *   - builtinAgentType：当前遍历到的 agent-type
 *   - primaryModel：全局启用模型的第一条（若该 agent 提供 preferred_provider 则优先匹配）
 *   - switchableModel：同 provider 另一条启用模型，兜底回主模型自身
 *   - channelType：仅当 agent.supports_channels=true 时，按 agentTypeId 过滤第一条启用模板
 *
 * 返回数组顺序与后端 /api/agent-types 一致。`/api/models` 只拉一次做缓存。
 */
export async function discoverLifecycleContexts(admin) {
  const typesBody = await expectOk(admin.get('/api/agent-types'))
  const enabledBuiltins = (typesBody.agentTypes || []).filter(
    (t) => t.is_enabled && t.category !== 'custom',
  )
  if (enabledBuiltins.length === 0) return []

  const modelsBody = await expectOk(admin.get('/api/models'))
  const allEnabledModels = (modelsBody.models || []).filter((m) => m.is_enabled !== false)

  const contexts = []
  for (const agentType of enabledBuiltins) {
    const ctx = {
      builtinAgentType: agentType,
      primaryModel: null,
      switchableModel: null,
      channelType: null,
    }

    // 主模型：优先匹配 agent-type.preferred_provider（如字段存在），否则取全局第一条
    const preferredProvider = agentType.preferred_provider || agentType.default_provider
    if (preferredProvider) {
      ctx.primaryModel =
        allEnabledModels.find((m) => m.provider === preferredProvider) || allEnabledModels[0] || null
    } else {
      ctx.primaryModel = allEnabledModels[0] || null
    }

    // 切换模型：同 provider 另一条 → 兜底回主模型
    if (ctx.primaryModel) {
      ctx.switchableModel =
        allEnabledModels.find(
          (m) => m.id !== ctx.primaryModel.id && m.provider === ctx.primaryModel.provider,
        ) || ctx.primaryModel
    }

    // 渠道：按 agent-type 过滤 channel-templates
    if (agentType.supports_channels) {
      const chBody = await expectOk(
        admin.get(`/api/channel-templates?agentTypeId=${encodeURIComponent(agentType.id)}`),
      )
      const templates = chBody.channelTemplates || chBody.templates || []
      const enabledCh = templates.find((c) => c.is_enabled !== false)
      ctx.channelType = enabledCh?.channel_type || enabledCh?.channelType || null
    }

    contexts.push(ctx)
  }

  return contexts
}

/**
 * 以 actor 身份跑完「创建 → 暂停 → 唤醒 → 改模型 → 改渠道 → 删除」全链路。
 *
 * @param {ReturnType<typeof createApiClient>} actor 执行生命周期操作的客户端（admin 或 普通用户）
 * @param {Awaited<ReturnType<typeof discoverLifecycleContext>>} ctx
 * @param {{ label: string }} opts
 */
export async function runLifecycle(actor, ctx, opts) {
  const { builtinAgentType, primaryModel, switchableModel, channelType } = ctx
  const name = prefixedName(`inst-${opts.label}`)

  // 构建自定义变量测试值（如果 agent-type 定义了 custom_vars_schema）
  const customVars = buildTestCustomVars(builtinAgentType)

  // 1. 创建
  const createBody = {
    name,
    agentTypeId: builtinAgentType.id,
    description: `integration-test lifecycle (${opts.label})`,
    modelId: primaryModel?.id || undefined,
    configJson: {},
    async: true,
  }
  if (customVars) {
    createBody.customVars = customVars
    console.log(`[lifecycle:${opts.label}] customVars: ${JSON.stringify(Object.keys(customVars))}`)
  }
  const createRes = await actor.post(
    '/api/instances',
    createBody,
    undefined,
    { timeoutMs: WRITE_REQ_TIMEOUT_MS },
  )
  // 暴露响应体到断言信息，便于在 CI 中定位 500 等服务端错误
  // （否则只能看到 "expected 500 to be 200" 而无法获取 server-side error message）
  expect(
    createRes.status,
    `[${opts.label}] create body=${safeStringify(createRes.body)}`,
  ).toBe(200)
  expect(createRes.body?.success).toBe(true)
  const instanceId = createRes.body.instance.id
  expect(instanceId).toBeTruthy()

  // 2. running
  await pollStatus(actor, instanceId, 'running', testEnv.instanceReadyTimeoutMs, opts.label)

  // 3. stop → stopped
  const stopRes = await actor.post(`/api/instances/${instanceId}/stop`)
  expect(stopRes.status, `[${opts.label}] stop`).toBe(200)
  await pollStatus(actor, instanceId, 'stopped', 90_000, opts.label)

  // 4. start → running
  const startRes = await actor.post(`/api/instances/${instanceId}/start`)
  expect(startRes.status, `[${opts.label}] start`).toBe(200)
  await pollStatus(actor, instanceId, 'running', testEnv.instanceReadyTimeoutMs, opts.label)

  // 5. modify model
  if (!SKIP_MODIFY && switchableModel && builtinAgentType.modify_model_command?.trim()) {
    const putModelRes = await actor.put(
      `/api/instances/${instanceId}`,
      { modelName: switchableModel.name },
      undefined,
      { timeoutMs: WRITE_REQ_TIMEOUT_MS },
    )
    expect(putModelRes.status, `[${opts.label}] modify-model`).toBe(200)
    await pollStatus(actor, instanceId, 'running', testEnv.instanceReadyTimeoutMs, opts.label)
  } else {
    console.log(`[lifecycle:${opts.label}] 跳过 modify-model`)
  }

  // 6. modify channel
  if (!SKIP_MODIFY && channelType && builtinAgentType.modify_channel_command?.trim()) {
    const putChannelRes = await actor.put(
      `/api/instances/${instanceId}`,
      {
        channelType,
        channelClientId: `it-${channelType}-client-id`,
        channelClientSecret: `it-${channelType}-client-secret`,
      },
      undefined,
      { timeoutMs: WRITE_REQ_TIMEOUT_MS },
    )
    expect(putChannelRes.status, `[${opts.label}] modify-channel`).toBe(200)
    await pollStatus(actor, instanceId, 'running', testEnv.instanceReadyTimeoutMs, opts.label)
  } else {
    console.log(`[lifecycle:${opts.label}] 跳过 modify-channel`)
  }

  // 7. delete + DB gone
  const delRes = await actor.delete(`/api/instances/${instanceId}`)
  expect(delRes.status, `[${opts.label}] delete`).toBe(200)

  const { data: gone } = await testSupabaseAdmin
    .from('agent_instances')
    .select('id')
    .eq('id', instanceId)
    .maybeSingle()
  expect(gone, `[${opts.label}] DB should be gone`).toBeNull()

  // 8. 等待 sandbox pool 回补，避免下一个用例 claim 时池为空
  //    轮询 /api/agent-types/{id}/sandboxes，等 Items 中出现空闲 sandbox
  if (POOL_COOLDOWN_MAX_MS > 0 && builtinAgentType?.id) {
    console.log(`[lifecycle:${opts.label}] waiting for pool replenish (max ${POOL_COOLDOWN_MAX_MS}ms)`)
    try {
      await waitFor(
        async () => {
          const r = await actor.get(`/api/agent-types/${builtinAgentType.id}/sandboxes`)
          if (r.status !== 200) return null
          const items = r.body?.Items || []
          const free = items.filter(s => !s.Labels?.['openclaw.io/instance-id'])
          if (free.length > 0) {
            console.log(`[lifecycle:${opts.label}] pool has ${free.length} free sandbox(es)`)
            return true
          }
          return null
        },
        {
          timeoutMs: POOL_COOLDOWN_MAX_MS,
          intervalMs: POOL_POLL_INTERVAL_MS,
          label: `pool-replenish`,
        },
      )
    } catch {
      console.warn(`[lifecycle:${opts.label}] pool replenish wait timed out, proceeding anyway`)
    }
  }

  return { instanceId, name }
}

async function pollStatus(actor, instanceId, expected, timeoutMs, label) {
  return waitFor(
    async () => {
      const r = await actor.get(`/api/instances/${instanceId}`)
      if (r.status !== 200) return null
      const s = r.body?.instance?.status
      if (s === expected) return r.body.instance
      if (s === 'failed' || s === 'error') {
        throw new Error(
          `[lifecycle:${label}] 实例进入失败态: ${JSON.stringify(r.body?.instance)}`,
        )
      }
      return null
    },
    {
      timeoutMs,
      intervalMs: 5_000,
      label: `[${label}] instance ${instanceId} -> ${expected}`,
    },
  )
}

/**
 * 根据 agent-type 的 custom_vars_schema 生成测试用自定义变量值。
 * 若 schema 为空或未定义，返回 null。
 *
 * @param {object} agentType
 * @returns {Record<string, string> | null}
 */
function buildTestCustomVars(agentType) {
  const schema = agentType?.custom_vars_schema
  if (!Array.isArray(schema) || schema.length === 0) return null

  const vars = {}
  for (const field of schema) {
    if (!field.name) continue
    switch (field.type) {
      case 'password':
        vars[field.name] = `it-secret-${field.name.toLowerCase()}`
        break
      case 'textarea':
        vars[field.name] = `it-multiline-${field.name.toLowerCase()}\nline2`
        break
      default: // text
        vars[field.name] = `it-value-${field.name.toLowerCase()}`
        break
    }
  }
  return Object.keys(vars).length > 0 ? vars : null
}

/**
 * 导出 buildTestCustomVars 供其他测试文件复用
 */
export { buildTestCustomVars }

/**
 * 安全序列化任意响应体（避免循环引用 / 超长字符串在失败信息中造成噪声）。
 * 仅被断言错误信息使用，保证 CI 能看到 server-side error message。
 */
function safeStringify(obj) {
  try {
    const s = JSON.stringify(obj)
    return s.length > 1000 ? s.slice(0, 1000) + '...(truncated)' : s
  } catch {
    return String(obj)
  }
}
