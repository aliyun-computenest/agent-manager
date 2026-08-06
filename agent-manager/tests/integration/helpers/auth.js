/**
 * 鉴权辅助：登录、签发 token、创建临时用户
 */
import { testEnv } from '../setup/test-env.js'
import { testSupabaseAdmin } from './supabase.js'
import { entityPrefix } from '../setup/test-env.js'

/**
 * 使用邮箱密码获取 access_token（走 Supabase GoTrue）
 */
export async function signInWithPassword(email, password) {
  const res = await fetch(`${testEnv.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: testEnv.anonKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(testEnv.requestTimeoutMs),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`[auth] 登录 ${email} 失败: HTTP ${res.status} ${text}`)
  }
  const json = JSON.parse(text)
  if (!json.access_token) {
    throw new Error(`[auth] 登录响应未返回 access_token: ${text}`)
  }
  return json.access_token
}

/** 获取管理员 token（缓存到模块内，避免重复登录） */
let cachedAdminToken = null
export async function getAdminToken() {
  if (cachedAdminToken) return cachedAdminToken
  cachedAdminToken = await signInWithPassword(testEnv.adminEmail, testEnv.adminPassword)
  return cachedAdminToken
}

/**
 * 创建临时用户（用于 RBAC 等场景），返回登录 token 与 cleanup。
 * username/email 都会带上 it-{runId}- 前缀。
 *
 * @param {object} opts
 * @param {('admin'|'user')=} opts.role 默认 'user'
 * @param {string=} opts.tag 用例自定义后缀，便于日志定位
 */
export async function createEphemeralUser(opts = {}) {
  const role = opts.role || 'user'
  const tag = (opts.tag || Math.random().toString(36).slice(2, 8)).toLowerCase()
  const username = `${entityPrefix}user-${tag}`
  const email = `${username}@test.local`
  const password = `Pwd!${tag}-${Date.now()}`

  const { data, error } = await testSupabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { username, role },
  })
  if (error) throw new Error(`[auth] 创建临时用户失败: ${error.message}`)
  const userId = data.user.id

  // 由触发器创建/已存在的 profile 做一次 upsert 校正
  const { error: upsertErr } = await testSupabaseAdmin
    .from('principal_profiles')
    .upsert({
      id: userId,
      name: username,
      email,
      role,
      status: 'active',
      max_agent_instances: 5,
      updated_at: new Date().toISOString(),
    })
  if (upsertErr) throw new Error(`[auth] 维护临时用户档案失败: ${upsertErr.message}`)

  const token = await signInWithPassword(email, password)

  const cleanup = async () => {
    await testSupabaseAdmin.from('principal_profiles').delete().eq('id', userId)
    await testSupabaseAdmin.auth.admin.deleteUser(userId).catch(() => {})
  }

  return { userId, email, username, password, token, cleanup }
}

/**
 * 通过【被测后端 /api/users】创建临时用户（不直连 Supabase Auth）。
 *
 * 相比 createEphemeralUser 的优势：
 *   - 用户写入发生在被测后端的 supabase 连接上，避免「测试进程直连 Supabase 与
 *     后端连接（pooler/replica）可见性不一致」导致的 profile 查询不一致
 *     外键冲突。
 *   - 顺带覆盖 /api/users 这条业务路径。
 *
 * @param {import('./api-client.js').createApiClient} adminClient 已携带 admin token 的客户端
 * @param {object} opts
 * @param {('admin'|'user')=} opts.role 默认 'user'
 * @param {string=} opts.tag 日志定位
 * @param {number=} opts.maxInstances 默认 5
 */
export async function createEphemeralUserViaApi(adminClient, opts = {}) {
  const role = opts.role || 'user'
  const tag = (opts.tag || Math.random().toString(36).slice(2, 8)).toLowerCase()
  const username = `${entityPrefix}user-${tag}`
  const email = `${username}@test.local`
  const password = `Pwd!${tag}-${Date.now()}`

  const res = await adminClient.post('/api/users', {
    email,
    password,
    username,
    role,
    maxInstances: opts.maxInstances || 5,
    authProvider: 'email',
  })
  if (res.status !== 200 || res.body?.success === false) {
    throw new Error(
      `[auth] via /api/users 创建临时用户失败: HTTP ${res.status} ${JSON.stringify(res.body)}`,
    )
  }
  const userId = res.body?.user?.id || res.body?.id || res.body?.data?.id
  if (!userId) {
    throw new Error(`[auth] /api/users 返回未找到 user id: ${JSON.stringify(res.body)}`)
  }

  const token = await signInWithPassword(email, password)

  const cleanup = async () => {
    await adminClient.delete(`/api/users/${userId}`).catch(() => {})
  }

  return { userId, email, username, password, token, cleanup }
}
