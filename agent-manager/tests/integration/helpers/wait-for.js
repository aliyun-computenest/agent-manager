/**
 * 通用轮询器：每隔 intervalMs 调用 probe，直到返回非空值或超时
 *
 * @template T
 * @param {() => Promise<T|null|undefined>} probe
 * @param {object} opts
 * @param {number=} opts.timeoutMs
 * @param {number=} opts.intervalMs
 * @param {string=} opts.label
 */
export async function waitFor(probe, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60_000
  const intervalMs = opts.intervalMs ?? 2_000
  const label = opts.label ?? 'condition'
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (err) {
      lastError = err
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  const detail = lastError ? ` 最后错误: ${lastError.message}` : ''
  throw new Error(`[waitFor] 等待 ${label} 超时 (${timeoutMs}ms).${detail}`)
}
