/**
 * 轻量 HTTP 客户端：对被测后端发起 /api/* 请求。
 * 统一注入 Authorization、超时控制与错误包装。
 */
import { testEnv } from '../setup/test-env.js'

/**
 * @param {object} opts
 * @param {string=} opts.baseUrl
 * @param {string=} opts.token
 * @param {number=} opts.timeoutMs
 */
export function createApiClient(opts = {}) {
  const baseUrl = (opts.baseUrl || testEnv.baseUrl).replace(/\/+$/, '')
  const timeoutMs = opts.timeoutMs || testEnv.requestTimeoutMs
  let token = opts.token || null

  const request = async (method, path, body, extraHeaders = {}, requestOpts = {}) => {
    const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`
    const headers = {
      accept: 'application/json',
      ...extraHeaders,
    }
    if (body !== undefined && body !== null) {
      headers['content-type'] = headers['content-type'] || 'application/json'
    }
    if (token) headers.authorization = `Bearer ${token}`

    const effectiveTimeoutMs = requestOpts.timeoutMs || timeoutMs

    let res
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined || body === null
          ? undefined
          : typeof body === 'string'
            ? body
            : JSON.stringify(body),
        signal: AbortSignal.timeout(effectiveTimeoutMs),
      })
    } catch (err) {
      throw new Error(`[api] ${method} ${path} 网络错误: ${err.message}`)
    }

    const rawText = await res.text()
    let parsed = null
    if (rawText) {
      try {
        parsed = JSON.parse(rawText)
      } catch (_) {
        parsed = rawText
      }
    }
    return {
      status: res.status,
      ok: res.ok,
      body: parsed,
      headers: Object.fromEntries(res.headers.entries()),
    }
  }

  return {
    get baseUrl() { return baseUrl },
    get token() { return token },
    setToken(next) { token = next || null },
    get: (p, headers, opts) => request('GET', p, null, headers, opts),
    post: (p, body, headers, opts) => request('POST', p, body, headers, opts),
    put: (p, body, headers, opts) => request('PUT', p, body, headers, opts),
    patch: (p, body, headers, opts) => request('PATCH', p, body, headers, opts),
    delete: (p, headers, opts) => request('DELETE', p, null, headers, opts),
    request,
  }
}

/**
 * 对返回结果做状态码断言并返回 body。用例里简化成：
 *   const body = await expectOk(client.get('/api/users'))
 */
export async function expectOk(promise, expectedStatus = 200) {
  const res = await promise
  if (res.status !== expectedStatus) {
    throw new Error(
      `[api] 预期 ${expectedStatus}，实际 ${res.status}，body=${JSON.stringify(res.body)}`,
    )
  }
  return res.body
}
