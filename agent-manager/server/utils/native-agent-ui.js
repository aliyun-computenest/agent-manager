/**
 * 原生 Agent UI 预览的无状态转换工具。
 * 负责预览 URL/Cookie 解析、浏览器启动脚本和代理请求/响应改写，
 * 不执行数据库查询或网络请求。
 */
export const NATIVE_AGENT_UI_PROXY_BASE_PATH = '/_preview'
export const NATIVE_AGENT_UI_PREVIEW_COOKIE = '__agent_manager_preview'
export const NATIVE_AGENT_UI_PREVIEW_TARGET_COOKIE = '__agent_manager_preview_target'
export const NATIVE_AGENT_UI_BOOTSTRAP_PATH = '/__agent_manager_preview_bootstrap.js'

const SANDBOX_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i
const PREVIEW_KEY_PATTERN = /^[A-Za-z0-9_-]{24}$/

function normalizePort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}

/**
 * 在现有 Manager Origin 下生成浏览器预览地址。
 * Sandbox 目标只保存在 HttpOnly Cookie 中，不暴露在 URL 和浏览器历史里。
 */
export function buildNativeAgentUiProxyUrl({
  managerOrigin,
  e2bDomain,
  agentPort,
  sandboxId,
  previewKey = '',
  proxyBasePath = NATIVE_AGENT_UI_PROXY_BASE_PATH
} = {}) {
  const port = normalizePort(agentPort)
  if (!port || proxyBasePath !== NATIVE_AGENT_UI_PROXY_BASE_PATH
      || !String(e2bDomain || '').trim()
      || !SANDBOX_ID_PATTERN.test(String(sandboxId || ''))
      || (previewKey && !PREVIEW_KEY_PATTERN.test(String(previewKey)))) return null

  try {
    const url = new URL(String(managerOrigin || '').trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash) return null
    url.pathname = previewKey ? `${proxyBasePath}/${previewKey}/` : `${proxyBasePath}/`
    url.search = ''
    return url.toString()
  } catch {
    return null
  }
}

/**
 * 解析每个标签页独立的 preview key，并得到转发给 Agent 的原始路径。
 * 非 /_preview 路径返回 null，继续由 Manager 自身路由处理。
 */
export function parseNativeAgentUiProxyPath(requestPath = '/') {
  try {
    const parsed = new URL(String(requestPath || '/'), 'http://manager.invalid')
    const match = parsed.pathname.match(/^\/_preview\/([A-Za-z0-9_-]{24})(\/.*)?$/)
    if (!match) return null
    const previewKey = match[1]
    const proxyBasePath = `${NATIVE_AGENT_UI_PROXY_BASE_PATH}/${previewKey}`
    const upstreamPath = `${match[2] || '/'}${parsed.search}`
    return { previewKey, proxyBasePath, upstreamPath }
  } catch {
    return null
  }
}

export function buildNativeAgentUiPreviewTarget({ previewKey, agentPort, sandboxId } = {}) {
  const port = normalizePort(agentPort)
  const key = String(previewKey || '')
  const id = String(sandboxId || '')
  if (!PREVIEW_KEY_PATTERN.test(key) || !port || !SANDBOX_ID_PATTERN.test(id)) return null
  return `${key}:${port}:${id}`
}

function readCookie(cookieHeader, cookieName) {
  // 同名预览 Cookie 按 /_preview/<key>/ 分 Path 保存；浏览器会把当前路径
  // 最匹配的 Cookie 排在前面，因此这里只读取第一个同名值。
  for (const part of String(cookieHeader || '').split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0 || part.slice(0, separator).trim() !== cookieName) continue
    try {
      return decodeURIComponent(part.slice(separator + 1).trim()) || null
    } catch {
      return null
    }
  }
  return null
}

export function readNativeAgentUiPreviewTarget(cookieHeader = '') {
  const value = readCookie(cookieHeader, NATIVE_AGENT_UI_PREVIEW_TARGET_COOKIE)
  if (!value) return null
  const parts = value.split(':')
  if (parts.length !== 3) return null
  const [previewKey, portValue, sandboxId] = parts
  const agentPort = normalizePort(portValue)
  if (!PREVIEW_KEY_PATTERN.test(previewKey) || !agentPort
      || !SANDBOX_ID_PATTERN.test(sandboxId)) return null
  return { previewKey, agentPort, sandboxId }
}

/** 从短期预览 Cookie 中读取 Manager OAuth token。 */
export function readNativeAgentUiPreviewToken(cookieHeader = '') {
  return readCookie(cookieHeader, NATIVE_AGENT_UI_PREVIEW_COOKIE)
}

function installNativeAgentUiPreview({ gatewayUrl, token, proxyBasePath }) {
  const base = proxyBasePath
  const navigation = window.navigation
  const canInterceptNavigation = navigation
    && typeof navigation.addEventListener === 'function'
  // Agent 常把 /api、/assets 和 WebSocket 写成根路径；统一补上当前标签页的 key。
  const scope = (value, ws = false) => {
    try {
      const url = new URL(String(value), window.location.href)
      const supported = ws
        ? url.protocol === 'ws:' || url.protocol === 'wss:'
        : url.protocol === 'http:' || url.protocol === 'https:'
      if (!supported || url.host !== window.location.host
          || url.pathname === base || url.pathname.startsWith(base + '/')) return value
      url.pathname = base + (url.pathname.startsWith('/') ? url.pathname : '/' + url.pathname)
      return url.toString()
    } catch {
      return value
    }
  }

  try {
    // 传输层需要 /_preview/<key>，但 Agent 自己的前端路由仍应看到 /skills 等原始路径。
    // 只有能在整页导航前恢复前缀时才隐藏它；Safari/Firefox 保留前缀，避免刷新后落到 Manager。
    const path = window.location.pathname
    if (canInterceptNavigation && (path === base || path.startsWith(base + '/'))) {
      const agentPath = path.slice(base.length) || '/'
      window.history.replaceState(
        window.history.state,
        '',
        agentPath + window.location.search + window.location.hash
      )
    }
  } catch {}

  if (canInterceptNavigation) {
    // SPA 内部跳转保持原路径；整页刷新、前进或后退在发出请求前补回传输前缀。
    navigation.addEventListener('navigate', event => {
      if (!event.canIntercept || event.destination.sameDocument) return
      const destination = event.destination.url
      const scoped = scope(destination)
      if (scoped === destination) return
      event.intercept({
        handler: () => window.location.replace(scoped)
      })
    })
  }

  if (typeof window.fetch === 'function') {
    // 覆盖 fetch 和 XHR，兼容 React/Vue 应用发出的根路径 API 请求。
    const original = window.fetch.bind(window)
    window.fetch = (input, init) => {
      if (window.Request && input instanceof window.Request) {
        return original(new window.Request(scope(input.url), input), init)
      }
      return original(scope(input), init)
    }
  }
  if (window.XMLHttpRequest) {
    const original = window.XMLHttpRequest.prototype.open
    window.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      return original.call(this, method, scope(url), ...rest)
    }
  }
  if (window.WebSocket) {
    // 保留原生 WebSocket 原型和状态常量，仅改写连接地址。
    const Native = window.WebSocket
    const Scoped = function (url, protocols) {
      return protocols === undefined
        ? new Native(scope(url, true))
        : new Native(scope(url, true), protocols)
    }
    Scoped.prototype = Native.prototype
    for (const name of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Scoped[name] = Native[name]
    window.WebSocket = Scoped
  }

  const patchUrlProperty = (ctor, name) => {
    if (!ctor) return
    const descriptor = Object.getOwnPropertyDescriptor(ctor.prototype, name)
    if (!descriptor || typeof descriptor.get !== 'function'
        || typeof descriptor.set !== 'function') return
    Object.defineProperty(ctor.prototype, name, {
      ...descriptor,
      set(value) {
        descriptor.set.call(this, scope(value))
      }
    })
  }
  for (const [ctor, name] of [
    [window.HTMLScriptElement, 'src'],
    [window.HTMLLinkElement, 'href'],
    [window.HTMLImageElement, 'src']
  ]) patchUrlProperty(ctor, name)

  if (window.document) {
    // Hermes 等页面使用根路径链接；点击时在跳转前补回 preview key。
    window.document.addEventListener('click', event => {
      if (event.defaultPrevented || event.button !== 0
          || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const anchor = event.target && event.target.closest
        ? event.target.closest('a[href]')
        : null
      if (!anchor || anchor.target || anchor.hasAttribute('download')) return
      const scoped = scope(anchor.href)
      if (scoped === anchor.href) return
      event.preventDefault()
      window.location.assign(scoped)
    })
  }

  // OpenClaw 启动时会读取这两个全局值建立自己的控制 WebSocket。
  // token 只存在于代理返回的 no-store 启动脚本中，不写入 URL 或持久化存储。
  window.__OPENCLAW_NATIVE_CONTROL_AUTH__ = { gatewayUrl, token }
  window.__OPENCLAW_CONTROL_UI_BASE_PATH__ = base
}

/**
 * 生成注入页面的浏览器适配脚本。
 * 适配逻辑保持为普通函数，仅在返回 HTML 时序列化，避免维护大段模板字符串。
 */
export function buildNativeAgentUiPreviewBootstrap({
  gatewayUrl = '',
  token = '',
  proxyBasePath = NATIVE_AGENT_UI_PROXY_BASE_PATH
} = {}) {
  const config = JSON.stringify({
    gatewayUrl: String(gatewayUrl),
    token: String(token),
    proxyBasePath: String(proxyBasePath)
  }).replace(/</g, '\\u003c')
  return `;(${installNativeAgentUiPreview.toString()})(${config})\n`
}

/**
 * Agent 运行时 token 只添加到 Manager -> Sandbox 的服务端请求。
 * 先删除浏览器传入的同名参数，避免用户伪造或覆盖真实运行时凭证。
 */
export function appendNativeAgentUiUpstreamToken(upstreamPath = '/', upstreamToken = '') {
  const parsed = new URL(String(upstreamPath || '/'), 'https://runtime.invalid')
  parsed.searchParams.delete('token')
  if (upstreamToken) parsed.searchParams.set('token', String(upstreamToken))
  return `${parsed.pathname}${parsed.search}`
}

/**
 * 构造 Manager -> Sandbox 的请求头。
 * Manager OAuth、浏览器 Cookie 和逐跳头绝不透传；OpenClaw 所需的 Bearer
 * token 由服务端显式传入，避免两套身份凭证混在同一个请求里。
 */
export function buildNativeAgentUiUpstreamHeaders(headers, upstreamHost, {
  upgrade = false,
  upstreamAuthorization = ''
} = {}) {
  const next = { ...headers, host: upstreamHost, 'accept-encoding': 'identity' }
  for (const name of [
    'authorization',
    'cookie',
    'proxy-authorization',
    'proxy-connection',
    'keep-alive',
    'te',
    'trailer',
    'transfer-encoding'
  ]) {
    delete next[name]
  }
  if (!upgrade) {
    delete next.connection
    delete next.upgrade
  }
  if (upstreamAuthorization) next.authorization = `Bearer ${upstreamAuthorization}`
  if (next.origin) next.origin = `https://${upstreamHost}`
  if (next.referer) next.referer = `https://${upstreamHost}/`
  return next
}

/**
 * 把 Agent 返回的站内跳转收敛到当前 preview key。
 * 外站跳转保持原样，站内跳转中的运行时 token 必须从浏览器地址中移除。
 */
export function rewriteNativeAgentUiLocation(headers, target) {
  const location = headers.location
  if (!location) return
  try {
    const resolved = new URL(location, `https://${target.upstreamHost}`)
    if (resolved.origin !== `https://${target.upstreamHost}`) return
    resolved.searchParams.delete('token')
    headers.location = `${target.proxyBasePath}${resolved.pathname}${resolved.search}${resolved.hash}`
  } catch {
    // 上游 Location 非法时保持原值，不猜测或构造新的跳转地址。
  }
}

/**
 * 只替换 iframe 相关响应头，其余 CSP 指令原样保留。
 * Agent 页面与 Manager 页面使用同一个 Origin，因此使用 SAMEORIGIN 即可。
 */
export function allowNativeAgentUiEmbedding(headers, managerOrigin) {
  let origin
  try {
    origin = new URL(managerOrigin).origin
  } catch {
    return
  }

  const directives = String(headers['content-security-policy'] || '')
    .split(';')
    .map(value => value.trim())
    .filter(Boolean)
    .filter(value => !value.toLowerCase().startsWith('frame-ancestors '))
  directives.push(`frame-ancestors ${origin}`)
  headers['content-security-policy'] = directives.join('; ')
  headers['x-frame-options'] = 'SAMEORIGIN'
}

/**
 * 给必须缓冲的文本响应补 preview 前缀。
 * HTML 负责初始资源，CSS/JS 负责浏览器 API 无法拦截的静态根路径引用；
 * fetch、XHR、WebSocket 等运行时请求由 bootstrap 脚本继续处理。
 */
export function rewriteNativeAgentUiText(source, target, contentType = '') {
  if (contentType.includes('text/html')) {
    // <base> 处理普通相对路径，bootstrap 处理运行时动态生成的根路径请求。
    const bootstrap = `<script src="${target.proxyBasePath}${NATIVE_AGENT_UI_BOOTSTRAP_PATH}"></script>`
    const base = `<base href="${target.proxyBasePath}/">`
    const rewritten = source
      .replace(/(\b(?:src|href|action|poster)\s*=\s*["'])\/(?!\/)/gi, `$1${target.proxyBasePath}/`)
    return /<head(?:\s[^>]*)?>/i.test(rewritten)
      ? rewritten.replace(/<head(?:\s[^>]*)?>/i, match => `${match}${base}${bootstrap}`)
      : `${base}${bootstrap}${rewritten}`
  }

  if (contentType.includes('text/css')) {
    return source.replace(/(url\(\s*["']?)\/(?!\/)/gi, `$1${target.proxyBasePath}/`)
  }

  return source
    .replace(/(import\s+["'])\/(?!\/)/g, `$1${target.proxyBasePath}/`)
    .replace(/(import\s*\(\s*["'])\/(?!\/)/g, `$1${target.proxyBasePath}/`)
    .replace(/(from\s+["'])\/(?!\/)/g, `$1${target.proxyBasePath}/`)
    .replace(/(new\s+URL\(\s*["'])\/(?!\/)/g, `$1${target.proxyBasePath}/`)
}
