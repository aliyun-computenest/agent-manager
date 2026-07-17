/**
 * 按优先级选择集成测试的 env 文件：
 *   1. TEST_ENV_FILE（绝对路径或相对 agent-manager/）
 *   2. CI 环境（process.env.CI === 'true' | '1'）：优先 .env.test.pre，回退 .env.test
 *   3. 本地：优先 .env.test，回退 .env.test.pre
 * 供 globalSetup 与 setupFiles 两端共用，保持加载行为一致。
 */
import { fileURLToPath } from 'node:url'
import { dirname, resolve, isAbsolute } from 'node:path'
import { existsSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
// 指向 agent-manager/
export const platformRoot = resolve(__dirname, '..', '..', '..')

export function resolveEnvFile() {
  const explicit = process.env.TEST_ENV_FILE
  if (explicit) {
    const p = isAbsolute(explicit) ? explicit : resolve(platformRoot, explicit)
    return { path: p, origin: `TEST_ENV_FILE=${explicit}` }
  }
  const local = resolve(platformRoot, '.env.test')
  const ci = resolve(platformRoot, '.env.test.pre')
  const isCi = process.env.CI === 'true' || process.env.CI === '1'
  const order = isCi ? [ci, local] : [local, ci]
  for (const p of order) {
    if (existsSync(p)) return { path: p, origin: isCi ? 'CI' : 'local' }
  }
  return { path: null, origin: isCi ? 'CI' : 'local' }
}
