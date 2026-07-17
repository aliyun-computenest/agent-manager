/**
 * Vitest globalSetup：
 * - 拨测后端 /api/health 保证目标环境可达
 * - 确保测试管理员存在且 role=admin（幂等）
 * - 注入稳定的 TEST_RUN_ID 供所有 worker 复用
 *
 * 注意：globalSetup 运行在独立进程，不会共享 setupFiles 的 env，需要自行加载。
 */
import dotenv from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import { resolveEnvFile } from './resolve-env-file.js'

const { path: envPath, origin: envOrigin } = resolveEnvFile()
if (envPath) {
  dotenv.config({ path: envPath })
  if (process.env.TEST_ENV_VERBOSE === 'true') {
    console.log(`[globalSetup] 加载环境变量文件 (${envOrigin}): ${envPath}`)
  }
}

function requireEnv(name) {
  const value = process.env[name]
  if (!value) {
    // 收集所有 TEST_ 开头 key 的"存在/长度"作为诊断，绝不打印值
    const keys = Object.keys(process.env)
      .filter((k) => k.startsWith('TEST_'))
      .sort()
      .map((k) => `${k}(len=${(process.env[k] || '').length})`)
    throw new Error(
      `[globalSetup] 缺少环境变量 ${name}\n` +
      `  加载的 env 文件: ${envPath || '(未找到)'}  来源: ${envOrigin}\n` +
      `  已加载 TEST_* 键: ${keys.length ? keys.join(', ') : '(空)'}\n` +
      `  排查思路: 若 envPath 指向 .env.test.pre 但 TEST_* 键很少 → 文件里确实缺该 key；` +
      `若键齐全但 ${name} 为空 → 该行的值被留空。`,
    )
  }
  return value
}

async function findAuthUserByEmail(admin, email) {
  const normalizedEmail = email.toLowerCase()
  let page = 1
  const perPage = 1000

  while (page <= 10) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage })
    if (error) throw new Error(`[globalSetup] 查询测试管理员 Auth 用户失败: ${error.message}`)

    const user = (data?.users || []).find(item => item.email?.toLowerCase() === normalizedEmail)
    if (user) return user
    if (!data?.users || data.users.length < perPage) return null
    page += 1
  }

  return null
}

export default async function globalSetup() {
  const baseUrl = requireEnv('TEST_BASE_URL').replace(/\/+$/, '')
  const supabaseUrl = requireEnv('TEST_VITE_SUPABASE_URL').replace(/\/+$/, '')
  const serviceRoleKey = requireEnv('TEST_SERVICE_ROLE_KEY')
  const adminEmail = requireEnv('TEST_ADMIN_EMAIL')
  const adminPassword = requireEnv('TEST_ADMIN_PASSWORD')

  // 注入稳定 runId
  const runId = process.env.TEST_RUN_ID || Date.now().toString(36)
  process.env.TEST_RUN_ID = runId
  console.log(`[globalSetup] TEST_RUN_ID=${runId}`)
  console.log(`[globalSetup] TEST_BASE_URL=${baseUrl}`)

  // 1) 健康检查
  const healthUrl = `${baseUrl}/api/health`
  let healthOk = false
  let healthError = null
  for (let i = 0; i < 3 && !healthOk; i += 1) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(10_000) })
      if (res.ok) {
        const body = await res.json().catch(() => ({}))
        console.log(`[globalSetup] health ok: version=${body.version ?? '?'}`)
        healthOk = true
      } else {
        healthError = `HTTP ${res.status}`
      }
    } catch (err) {
      healthError = err.message
    }
    if (!healthOk) await new Promise((r) => setTimeout(r, 2000))
  }
  if (!healthOk) {
    throw new Error(`[globalSetup] 后端健康检查失败 ${healthUrl}: ${healthError}`)
  }

  // 2) 确保测试管理员存在（幂等）
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data: existingProfile } = await admin
    .from('principal_profiles')
    .select('id, role')
    .eq('email', adminEmail)
    .maybeSingle()

  let adminUserId = existingProfile?.id ?? null

  if (!adminUserId) {
    const existingAuthUser = await findAuthUserByEmail(admin, adminEmail)
    if (existingAuthUser) {
      adminUserId = existingAuthUser.id
      console.log(`[globalSetup] 复用已有测试管理员 Auth 用户 ${adminEmail}`)
    } else {
      const { data, error } = await admin.auth.admin.createUser({
        email: adminEmail,
        password: adminPassword,
        email_confirm: true,
        user_metadata: { username: 'it-admin', role: 'admin' },
      })
      if (error) throw new Error(`[globalSetup] 创建测试管理员失败: ${error.message}`)
      adminUserId = data.user.id
      console.log(`[globalSetup] 已创建测试管理员 ${adminEmail}`)
    }
    const { error: updateErr } = await admin.auth.admin.updateUserById(adminUserId, {
      password: adminPassword,
      email_confirm: true,
      ban_duration: 'none',
    })
    if (updateErr) console.warn(`[globalSetup] 同步管理员密码警告: ${updateErr.message}`)
  } else {
    // 强制同步密码，避免 .env.test 改动后登录失败
    const { error: updateErr } = await admin.auth.admin.updateUserById(adminUserId, {
      password: adminPassword,
      email_confirm: true,
      ban_duration: 'none',
    })
    if (updateErr) console.warn(`[globalSetup] 同步管理员密码警告: ${updateErr.message}`)
  }

  // 确保 principal_profiles 存在且 role=admin / status=active
  const { data: profile } = await admin
    .from('principal_profiles')
    .select('id')
    .eq('id', adminUserId)
    .maybeSingle()

  if (!profile) {
    const { error: insertErr } = await admin.from('principal_profiles').insert({
      id: adminUserId,
      name: 'it-admin',
      email: adminEmail,
      role: 'admin',
      status: 'active',
      max_agent_instances: 100,
    })
    if (insertErr) throw new Error(`[globalSetup] 创建管理员档案失败: ${insertErr.message}`)
  } else {
    const { error: updErr } = await admin
      .from('principal_profiles')
      .update({
        name: 'it-admin',
        role: 'admin',
        status: 'active',
        updated_at: new Date().toISOString(),
      })
      .eq('id', adminUserId)
    if (updErr) throw new Error(`[globalSetup] 修复管理员档案失败: ${updErr.message}`)
  }

  console.log(`[globalSetup] 测试管理员就绪: ${adminEmail} (id=${adminUserId})`)

  // 返回值在 Vitest 1.x 可作为 teardown 函数
  return async () => {
    console.log(`[globalTeardown] TEST_RUN_ID=${runId} 执行完毕`)
  }
}
