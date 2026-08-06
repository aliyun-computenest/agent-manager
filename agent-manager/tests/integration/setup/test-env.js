/**
 * 集成测试环境变量加载入口
 * - 由 vitest setupFiles 在每个测试 worker 启动时执行
 * - 加载优先级（与 globalSetup 共用 resolveEnvFile）：
 *     1. TEST_ENV_FILE 指定的文件
 *     2. CI=true → 先 .env.test.pre，回退 .env.test
 *     3. 本地 → 先 .env.test，回退 .env.test.pre
 * - dotenv 默认不覆盖已有 process.env，因此 export 的变量（如 CI params）优先级最高
 * - 缺必填项会抛错
 */
import dotenv from 'dotenv'
import { resolveEnvFile, platformRoot } from './resolve-env-file.js'

const { path: envPath, origin: envOrigin } = resolveEnvFile()

if (envPath) {
  dotenv.config({ path: envPath })
  if (process.env.TEST_ENV_VERBOSE === 'true') {
    console.log(`[integration] 加载环境变量文件 (${envOrigin}): ${envPath}`)
  }
}

const REQUIRED = [
  'TEST_BASE_URL',
  'TEST_VITE_SUPABASE_URL',
  'TEST_SERVICE_ROLE_KEY',
  'TEST_VITE_SUPABASE_ANON_KEY',
  'TEST_ADMIN_EMAIL',
  'TEST_ADMIN_PASSWORD',
]

const missing = REQUIRED.filter((k) => !process.env[k])
if (missing.length > 0) {
  const hint = envPath
    ? `请在 ${envPath} 中补全以下变量`
    : `未找到 .env.test 或 .env.test.pre（在 ${platformRoot} 下），请参考 .env.test.example 创建并填写`
  throw new Error(`[integration] 缺少必填环境变量: ${missing.join(', ')}。${hint}`)
}

// 稳定的 runId：优先取环境变量，其次取 globalThis（由 global-setup 注入），最后现场生成
if (!process.env.TEST_RUN_ID) {
  process.env.TEST_RUN_ID = globalThis.__TEST_RUN_ID__ || Date.now().toString(36)
}

export const testEnv = {
  baseUrl: process.env.TEST_BASE_URL.replace(/\/+$/, ''),
  supabaseUrl: process.env.TEST_VITE_SUPABASE_URL.replace(/\/+$/, ''),
  serviceRoleKey: process.env.TEST_SERVICE_ROLE_KEY,
  anonKey: process.env.TEST_VITE_SUPABASE_ANON_KEY,
  adminEmail: process.env.TEST_ADMIN_EMAIL,
  adminPassword: process.env.TEST_ADMIN_PASSWORD,
  runId: process.env.TEST_RUN_ID,
  requestTimeoutMs: Number(process.env.TEST_REQUEST_TIMEOUT_MS || 30_000),
  instanceReadyTimeoutMs: Number(process.env.TEST_INSTANCE_READY_TIMEOUT_MS || 180_000),
  cleanOnFailure: (process.env.TEST_CLEAN_ON_FAILURE || 'true') !== 'false',
  skipE2b: process.env.TEST_SKIP_E2B === 'true',
  skipSandboxUpgrade: process.env.TEST_SKIP_SANDBOX_UPGRADE === 'true',
  sandboxUpgradeAgentTypeId: process.env.TEST_SANDBOX_UPGRADE_AGENT_TYPE_ID || '',
}

/** 命名前缀，供 factory 使用 */
export const entityPrefix = `it-${testEnv.runId}-`
