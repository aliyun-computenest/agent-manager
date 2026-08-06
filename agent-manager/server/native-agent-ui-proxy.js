/**
 * 原生 Agent UI 的私网代理入口。
 * 在 Manager 同源路径下鉴权并转发 Agent 的 HTTP/WebSocket，
 * 同时按需改写文本响应，使原生界面的根路径资源能够正常加载。
 */
import { createHash } from 'crypto'
import https from 'https'
import tls from 'tls'
import {
  E2B_DOMAIN,
  NATIVE_AGENT_UI_ENABLED,
  PLATFORM_PUBLIC_URL,
  supabaseAdmin
} from './config/index.js'
import { authenticateToken } from './middleware/auth.js'
import { buildE2BUpstreamHost, resolveAgentPort } from './services/agent-runtime.js'
import {
  canAccessInstanceRecord,
  getActiveGroupMemberships
} from './services/principal-access.js'
import {
  allowNativeAgentUiEmbedding,
  appendNativeAgentUiUpstreamToken,
  buildNativeAgentUiPreviewBootstrap,
  buildNativeAgentUiUpstreamHeaders,
  NATIVE_AGENT_UI_BOOTSTRAP_PATH,
  parseNativeAgentUiProxyPath,
  readNativeAgentUiPreviewTarget,
  readNativeAgentUiPreviewToken,
  rewriteNativeAgentUiLocation,
  rewriteNativeAgentUiText
} from './utils/native-agent-ui.js'

const PREVIEW_ENABLED = NATIVE_AGENT_UI_ENABLED
  && Boolean(PLATFORM_PUBLIC_URL)
  && Boolean(E2B_DOMAIN)
const UPSTREAM_CONNECT_TIMEOUT_MS = 30_000
const MAX_TRANSFORMED_RESPONSE_BYTES = 32 * 1024 * 1024
const RUNTIME_VALIDATION_CACHE_TTL_MS = 3_000
const RUNTIME_VALIDATION_CACHE_MAX_ENTRIES = 1_000
const runtimeValidationCache = new Map()

/**
 * HTTP 和 WebSocket 共用的唯一鉴权入口。
 * 顺序固定为：校验标签页绑定 -> 校验 Manager OAuth -> 复核实例权限和真实上游。
 */
async function authorizeRuntimeRequest(req, { requireSameOrigin = false } = {}) {
  // URL key 只标识当前标签页；目标 Cookie 负责把 key 绑定到 Sandbox。
  // 两者必须一致，避免一个标签页借用另一个标签页的代理路径。
  const selected = readNativeAgentUiPreviewTarget(req.headers.cookie)
  const previewPath = parseNativeAgentUiProxyPath(req.url)
  if (!selected || !previewPath || selected.previewKey !== previewPath.previewKey) {
    return { ok: false, status: 404, body: 'Not Found' }
  }

  const upstreamHost = buildE2BUpstreamHost({
    agentPort: selected.agentPort,
    sandboxId: selected.sandboxId
  })
  if (!upstreamHost) return { ok: false, status: 404, body: 'Not Found' }

  const target = {
    ...selected,
    ...previewPath,
    upstreamHost
  }

  // WebSocket 握手必须来自当前 Manager Origin，拒绝跨站复用预览 Cookie。
  if (requireSameOrigin && req.headers.origin) {
    const expectedOrigin = `${runtimeBrowserScheme(req)}://${req.headers.host}`
    if (req.headers.origin !== expectedOrigin) return { ok: false, status: 403 }
  }

  const token = readNativeAgentUiPreviewToken(req.headers.cookie)
  if (!token) return { ok: false, status: 401 }

  const tokenHash = createHash('sha256').update(token).digest('base64url')
  // preview key 只做标签页隔离，不影响权限；缓存键只包含“用户凭证 + 实际目标”。
  const key = `${tokenHash}:${target.agentPort}:${target.sandboxId}`
  const cached = runtimeValidationCache.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    // 缓存只复用鉴权结果，当前请求路径仍使用本标签页解析出的 target。
    const validation = await cached.promise
    return validation.ok ? { ...validation, target } : validation
  }
  if (cached) runtimeValidationCache.delete(key)

  // HTTP 资源和 WebSocket 会在短时间内并发请求，短缓存用于合并重复鉴权，
  // 不保存会话状态；失败结果立即移除。
  const promise = (async () => {
    const auth = await authenticateToken(token)
    if (!auth) return { ok: false, status: 401 }

    // 目标 Cookie 来自浏览器，只能作为查找提示。实例归属、运行状态和真实
    // Agent 端口都必须重新从服务端数据校验，不能直接信任 Cookie。
    const { data: instance, error } = await supabaseAdmin
      .from('agent_instances')
      .select('id,principal_id,sandbox_id,status,token,agent_type_id,agent_type:agent_types(code)')
      .eq('sandbox_id', target.sandboxId)
      .maybeSingle()
    if (error || !instance) return { ok: false, status: 404 }

    const memberships = await getActiveGroupMemberships(auth.user.id)
    if (!canAccessInstanceRecord(instance, auth.user.id, memberships, auth.userProfile)) {
      return { ok: false, status: 404 }
    }
    if (instance.status !== 'running') return { ok: false, status: 409 }

    const agentPort = await resolveAgentPort(
      instance.agent_type_id,
      'native preview validation port lookup'
    )
    if (agentPort !== target.agentPort) return { ok: false, status: 404 }

    // 使用服务端确认过的端口和 sandbox_id 重建 host，阻止 Cookie 指向任意私网地址。
    const verifiedHost = buildE2BUpstreamHost({
      agentPort,
      sandboxId: instance.sandbox_id
    })
    if (verifiedHost !== target.upstreamHost || !instance.token) {
      return { ok: false, status: 409 }
    }

    return {
      ok: true,
      upstreamToken: String(instance.token),
      // OpenClaw 的 HTTP API 使用 Bearer token；其他内置或自定义 Agent
      // 保持自身协议，不能仅凭端口推断认证方式。
      upstreamAuthorization: instance.agent_type?.code === 'openclaw'
        ? String(instance.token)
        : ''
    }
  })()

  if (runtimeValidationCache.size >= RUNTIME_VALIDATION_CACHE_MAX_ENTRIES) {
    const oldestKey = runtimeValidationCache.keys().next().value
    if (oldestKey) runtimeValidationCache.delete(oldestKey)
  }
  runtimeValidationCache.set(key, {
    expiresAt: Date.now() + RUNTIME_VALIDATION_CACHE_TTL_MS,
    promise
  })

  try {
    const result = await promise
    if (!result.ok) runtimeValidationCache.delete(key)
    return result.ok ? { ...result, target } : result
  } catch (error) {
    runtimeValidationCache.delete(key)
    throw error
  }
}

function runtimeBrowserScheme(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  if (forwardedProto === 'https') return 'https'
  return req.socket.encrypted ? 'https' : 'http'
}

/**
 * HTTP 只做三件事：鉴权、转发、按需改写文本响应。
 * 运行时 token 仅在这一服务端链路使用，不把 Manager OAuth 传给 Agent。
 */
async function proxyRuntimeHttp(req, res) {
  const access = await authorizeRuntimeRequest(req)
  if (!access.ok) {
    res.writeHead(access.status)
    res.end(access.body || (
      access.status === 401 ? 'Unauthorized' : 'Native Agent preview unavailable'
    ))
    return
  }
  const { target } = access

  const upstreamPathname = new URL(target.upstreamPath, 'https://runtime.invalid').pathname
  if (upstreamPathname === NATIVE_AGENT_UI_BOOTSTRAP_PATH) {
    // 启动脚本按请求动态生成，其中包含当前实例的短期运行时 token，禁止缓存。
    res.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/javascript; charset=utf-8',
      'X-Content-Type-Options': 'nosniff'
    })
    const wsScheme = runtimeBrowserScheme(req) === 'https' ? 'wss' : 'ws'
    res.end(buildNativeAgentUiPreviewBootstrap({
      gatewayUrl: `${wsScheme}://${req.headers.host}${target.proxyBasePath}/`,
      token: access.upstreamToken,
      proxyBasePath: target.proxyBasePath
    }))
    return
  }

  const upstreamPath = appendNativeAgentUiUpstreamToken(
    target.upstreamPath,
    access.upstreamToken
  )
  const proxy = https.request({
    hostname: target.upstreamHost,
    port: 443,
    path: upstreamPath,
    method: req.method,
    headers: buildNativeAgentUiUpstreamHeaders(req.headers, target.upstreamHost, {
      // OpenClaw WebSocket 仍由启动脚本在 connect 消息中携带 token。
      upstreamAuthorization: access.upstreamAuthorization
    })
  }, proxyRes => {
    proxy.setTimeout(0)
    const headers = { ...proxyRes.headers }
    // Agent 的 Cookie 属于上游自身，不能覆盖 Manager Origin 下的登录/预览 Cookie。
    delete headers['set-cookie']
    rewriteNativeAgentUiLocation(headers, target)
    const contentType = String(headers['content-type'] || '').toLowerCase()
    // 二进制资源直接流式转发；只有必须改写路径的文本资源才缓冲处理。
    const isTextResponse = contentType.includes('text/html')
      || contentType.includes('javascript')
      || contentType.includes('text/css')
    if (!isTextResponse) {
      res.writeHead(proxyRes.statusCode || 502, headers)
      proxyRes.pipe(res)
      return
    }

    let responseEnded = false
    let receivedBytes = 0
    const endTooLarge = () => {
      if (responseEnded) return
      responseEnded = true
      proxyRes.destroy()
      if (!res.headersSent) {
        res.writeHead(502, {
          'Cache-Control': 'no-store',
          'Content-Type': 'text/plain; charset=utf-8'
        })
      }
      if (!res.writableEnded) res.end('Runtime response too large')
    }
    const declaredLength = Number(headers['content-length'])
    if (Number.isFinite(declaredLength) && declaredLength > MAX_TRANSFORMED_RESPONSE_BYTES) {
      endTooLarge()
      return
    }

    const chunks = []
    proxyRes.on('data', chunk => {
      if (responseEnded) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      receivedBytes += buffer.length
      if (receivedBytes > MAX_TRANSFORMED_RESPONSE_BYTES) {
        endTooLarge()
        return
      }
      chunks.push(buffer)
    })
    proxyRes.on('end', () => {
      if (responseEnded) return
      responseEnded = true
      const source = Buffer.concat(chunks).toString('utf8')
      const transformed = rewriteNativeAgentUiText(source, target, contentType)
      delete headers['content-length']
      delete headers['content-encoding']
      delete headers.etag
      headers['cache-control'] = 'no-store'
      if (contentType.includes('text/html')) {
        allowNativeAgentUiEmbedding(headers, PLATFORM_PUBLIC_URL)
      }
      res.writeHead(proxyRes.statusCode || 502, headers)
      res.end(transformed)
    })
  })

  proxy.setTimeout(UPSTREAM_CONNECT_TIMEOUT_MS, () => proxy.destroy())
  proxy.on('error', () => {
    if (res.writableEnded) return
    if (!res.headersSent) res.writeHead(502)
    res.end('Runtime unavailable')
  })
  req.pipe(proxy)
}

function rejectUpgrade(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

/**
 * WebSocket 沿用同一套目标和权限校验，校验完成后再做透明双向管道。
 */
async function proxyRuntimeUpgrade(req, socket, head) {
  const access = await authorizeRuntimeRequest(req, { requireSameOrigin: true })
  if (!access.ok) {
    const statusText = access.status === 401
      ? 'Unauthorized'
      : access.status === 403
        ? 'Forbidden'
        : access.status === 404
        ? 'Not Found'
        : 'Conflict'
    return rejectUpgrade(socket, access.status, statusText)
  }
  const { target } = access

  const upstreamPath = appendNativeAgentUiUpstreamToken(
    target.upstreamPath,
    access.upstreamToken
  )
  const upstream = tls.connect({
    host: target.upstreamHost,
    port: 443,
    servername: target.upstreamHost,
    ALPNProtocols: ['http/1.1'],
    timeout: UPSTREAM_CONNECT_TIMEOUT_MS
  }, () => {
    upstream.setTimeout(0)
    // WebSocket 与 HTTP 共用同一条鉴权链，只在校验通过后建立私网上游连接。
    const headers = buildNativeAgentUiUpstreamHeaders(
      req.headers,
      target.upstreamHost,
      { upgrade: true }
    )
    upstream.write(`${req.method} ${upstreamPath} HTTP/${req.httpVersion}\r\n`)
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue
      upstream.write(`${name}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`)
    }
    upstream.write('\r\n')
    if (head?.length) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })

  upstream.on('error', () => {
    if (!socket.destroyed) rejectUpgrade(socket, 502, 'Bad Gateway')
  })
  upstream.on('timeout', () => upstream.destroy())
  socket.on('error', () => upstream.destroy())
}

export function registerNativeAgentUiProxy(app, server) {
  // 只接管保留的 /_preview/<key> 路径，其余页面和 API 继续走原有 Express 路由。
  app.use((req, res, next) => {
    if (parseNativeAgentUiProxyPath(req.url) === null) return next()
    if (!PREVIEW_ENABLED) return res.status(404).end('Not Found')
    void proxyRuntimeHttp(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(502)
      res.end('Runtime unavailable')
    })
  })

  server.on('upgrade', (req, socket, head) => {
    if (parseNativeAgentUiProxyPath(req.url) === null) return
    req.nativeAgentUiUpgradeHandled = true
    if (!PREVIEW_ENABLED) return rejectUpgrade(socket, 404, 'Not Found')
    void proxyRuntimeUpgrade(req, socket, head).catch(() => {
      if (!socket.destroyed) rejectUpgrade(socket, 502, 'Bad Gateway')
    })
  })
}
