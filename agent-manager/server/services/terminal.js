import crypto from 'crypto'
import { Sandbox } from '@e2b/code-interpreter'
import {
  E2B_API_KEY,
  TERMINAL_IDLE_TIMEOUT_SECONDS,
  TERMINAL_MAX_SESSIONS_PER_INSTANCE,
  TERMINAL_MAX_SESSIONS_PER_USER,
  TERMINAL_OUTPUT_BUFFER_BYTES,
  TERMINAL_SESSION_MAX_LIFETIME_SECONDS,
  TERMINAL_SESSION_SECRET,
  TERMINAL_SESSION_TTL_SECONDS,
  supabaseAdmin
} from '../config/index.js'
import { appLogger } from '../utils/logger.js'
import {
  canAccessInstanceRecord,
  getActiveGroupMemberships,
  isPlatformAdminProfile
} from './principal-access.js'

const sessions = new Map()
const encoder = new TextEncoder()
const TERMINAL_SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000
const DEFAULT_TERMINAL_USER = 'node'

export class TerminalError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'TerminalError'
    this.status = status
    this.code = code
  }
}

function now() {
  return Date.now()
}

function signSessionPayload(encodedPayload) {
  return crypto
    .createHmac('sha256', TERMINAL_SESSION_SECRET)
    .update(encodedPayload)
    .digest('base64url')
}

function safeEqualString(left, right) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

function createSessionId(session) {
  const payload = {
    v: 2,
    nonce: crypto.randomBytes(16).toString('base64url'),
    instanceId: session.instanceId,
    userId: session.userId,
    sandboxId: session.sandboxId,
    terminalUser: session.terminalUser,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt
  }
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = signSessionPayload(encodedPayload)
  return `${encodedPayload}.${signature}`
}

function parseSessionId(sessionId) {
  const [encodedPayload, signature] = String(sessionId || '').split('.')
  if (!encodedPayload || !signature) {
    throw new TerminalError(401, 'TERMINAL_SESSION_INVALID', 'Terminal session is invalid')
  }

  const expectedSignature = signSessionPayload(encodedPayload)
  if (!safeEqualString(signature, expectedSignature)) {
    throw new TerminalError(401, 'TERMINAL_SESSION_INVALID', 'Terminal session is invalid')
  }

  let payload
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'))
  } catch {
    throw new TerminalError(401, 'TERMINAL_SESSION_INVALID', 'Terminal session is invalid')
  }

  if (
    ![1, 2].includes(payload?.v)
    || typeof payload.instanceId !== 'string'
    || typeof payload.userId !== 'string'
    || typeof payload.sandboxId !== 'string'
    || typeof payload.createdAt !== 'number'
    || typeof payload.expiresAt !== 'number'
  ) {
    throw new TerminalError(401, 'TERMINAL_SESSION_INVALID', 'Terminal session is invalid')
  }

  return {
    id: sessionId,
    instanceId: payload.instanceId,
    userId: payload.userId,
    sandboxId: payload.sandboxId,
    terminalUser: payload.v >= 2
      ? validateTerminalUser(payload.terminalUser) || DEFAULT_TERMINAL_USER
      : DEFAULT_TERMINAL_USER,
    status: 'pending',
    createdAt: payload.createdAt,
    lastActivityAt: payload.createdAt,
    expiresAt: payload.expiresAt,
    ptyPid: null
  }
}

function isWsOpen(ws) {
  return ws.readyState === 1
}

function sendJson(ws, payload) {
  if (!isWsOpen(ws)) return false
  if (ws.bufferedAmount > TERMINAL_OUTPUT_BUFFER_BYTES) {
    throw new TerminalError(429, 'TERMINAL_OUTPUT_BACKPRESSURE', 'Terminal output is too large')
  }
  ws.send(JSON.stringify(payload))
  return true
}

function cleanupStaleSessions() {
  const ts = now()
  for (const [sessionId, session] of sessions.entries()) {
    if (session.status === 'pending' && session.expiresAt <= ts) {
      sessions.delete(sessionId)
      continue
    }

    if (ts - session.createdAt > TERMINAL_SESSION_MAX_LIFETIME_SECONDS * 1000) {
      closeSession(session, 'error', 'TERMINAL_SESSION_EXPIRED')
      continue
    }

    if (session.status === 'connecting' && session.expiresAt <= ts) {
      closeSession(session, 'error', 'TERMINAL_SESSION_EXPIRED')
      continue
    }

    if (session.status === 'open' && session.ws && !isWsOpen(session.ws)) {
      closeSession(session, 'closed')
      continue
    }

    const idleDeadline = (session.lastActivityAt || session.createdAt)
      + TERMINAL_IDLE_TIMEOUT_SECONDS * 1000
      + TERMINAL_SESSION_CLEANUP_INTERVAL_MS
    if ((session.status === 'connecting' || session.status === 'open') && idleDeadline <= ts) {
      closeSession(session, 'error', 'TERMINAL_IDLE_TIMEOUT')
    }
  }
}

const sessionCleanupTimer = setInterval(cleanupStaleSessions, TERMINAL_SESSION_CLEANUP_INTERVAL_MS)
sessionCleanupTimer.unref?.()

function countSessions(predicate) {
  cleanupStaleSessions()
  let count = 0
  for (const session of sessions.values()) {
    if (session.status !== 'closed' && session.status !== 'error' && predicate(session)) {
      count += 1
    }
  }
  return count
}

function closeSession(session, status = 'closed', errorCode = null) {
  if (!session) return
  if (typeof session.close === 'function') {
    try {
      Promise.resolve(session.close(status, errorCode)).catch(error => {
        console.warn(`Failed to close terminal session ${session.id}: ${error.message}`)
      })
    } catch (error) {
      console.warn(`Failed to close terminal session ${session.id}: ${error.message}`)
    }
    return
  }
  session.status = status
  session.errorCode = errorCode
  sessions.delete(session.id)
}

function closeSessions(predicate, status = 'closed', errorCode = null) {
  cleanupStaleSessions()
  for (const session of Array.from(sessions.values())) {
    if (session.status !== 'closed' && session.status !== 'error' && predicate(session)) {
      closeSession(session, status, errorCode)
    }
  }
}

function replaceUserInstanceSessions({ userId, instanceId, exceptSessionId = null }) {
  closeSessions(
    session => session.userId === userId && session.instanceId === instanceId && session.id !== exceptSessionId,
    'closed',
    'TERMINAL_REPLACED'
  )
}

function assertSessionLimits({ userId, instanceId }) {
  const userCount = countSessions(session => session.userId === userId)
  if (userCount >= TERMINAL_MAX_SESSIONS_PER_USER) {
    throw new TerminalError(429, 'TERMINAL_SESSION_LIMIT', 'User terminal session limit reached')
  }

  const instanceCount = countSessions(session => session.instanceId === instanceId)
  if (instanceCount >= TERMINAL_MAX_SESSIONS_PER_INSTANCE) {
    throw new TerminalError(429, 'TERMINAL_SESSION_LIMIT', 'Instance terminal session limit reached')
  }
}

export function validateTerminalUser(user) {
  if (!user) return null
  const normalized = String(user).trim()
  if (!normalized) return null
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(normalized)) {
    throw new TerminalError(409, 'TERMINAL_USER_INVALID', 'Invalid terminal user')
  }
  return normalized
}

function getHeaderValue(headers, name) {
  const value = headers?.[name]
  const raw = Array.isArray(value) ? value[0] : value
  return raw ? String(raw).split(',')[0].trim() : ''
}

function getUrlProto(value) {
  if (!value) return ''
  try {
    const protocol = new URL(value).protocol
    if (protocol === 'https:' || protocol === 'http:') return protocol.slice(0, -1)
  } catch {
    return ''
  }
  return ''
}

function getUrlHost(value) {
  if (!value) return ''
  try {
    return new URL(value).host
  } catch {
    return ''
  }
}

function getBrowserHeaderValue(req) {
  return getHeaderValue(req.headers, 'origin') || getHeaderValue(req.headers, 'referer')
}

function getRequestProto(req) {
  const browserProto = getUrlProto(getBrowserHeaderValue(req))
  if (browserProto === 'https') return 'https'

  const proto = getHeaderValue(req.headers, 'x-forwarded-proto')
  if (proto) return proto
  return req.secure ? 'https' : 'http'
}

export function buildTerminalWsUrl(req, instanceId, sessionId) {
  const host = getUrlHost(getBrowserHeaderValue(req)) ||
    getHeaderValue(req.headers, 'x-forwarded-host') ||
    getHeaderValue(req.headers, 'host')
  const proto = getRequestProto(req) === 'https' ? 'wss' : 'ws'
  const path = `/api/instances/${encodeURIComponent(instanceId)}/terminal/ws?sessionId=${encodeURIComponent(sessionId)}`
  return `${proto}://${host}${path}`
}

async function loadTerminalTarget({ instanceId, user, userProfile, userSupabase }) {
  const isAdmin = isPlatformAdminProfile(userProfile)

  const { data: instance, error } = await supabaseAdmin
    .from('agent_instances')
    .select('id, principal_id, status, sandbox_id, agent_type_id, name')
    .eq('id', instanceId)
    .single()

  if (error || !instance) {
    throw new TerminalError(404, 'INSTANCE_NOT_FOUND', 'Instance not found or access denied')
  }

  const memberships = await getActiveGroupMemberships(user.id)
  const allowed = canAccessInstanceRecord(instance, user.id, memberships, userProfile)
  if (!allowed) {
    throw new TerminalError(404, 'INSTANCE_NOT_FOUND', 'Instance not found or access denied')
  }

  let agentType = null
  if (instance.agent_type_id) {
    const { data } = await supabaseAdmin
      .from('agent_types')
      .select('*')
      .eq('id', instance.agent_type_id)
      .single()
    agentType = data || null
  }

  if (!isAdmin && agentType?.user_terminal_enabled !== true) {
    throw new TerminalError(403, 'TERMINAL_DISABLED', 'Terminal is disabled for this Agent')
  }

  if (instance.status !== 'running') {
    throw new TerminalError(409, 'INSTANCE_NOT_RUNNING', 'Instance is not running')
  }

  if (!instance.sandbox_id) {
    throw new TerminalError(409, 'TERMINAL_NOT_READY', 'Instance sandbox is not ready')
  }

  if (!E2B_API_KEY) {
    throw new TerminalError(502, 'TERMINAL_START_FAILED', 'E2B API key is not configured')
  }

  const terminalUser = validateTerminalUser(agentType?.terminal_user || DEFAULT_TERMINAL_USER)
  return { instance, agentType, terminalUser }
}

export async function createTerminalSession({ instanceId, req }) {
  const { instance, terminalUser } = await loadTerminalTarget({
    instanceId,
    user: req.user,
    userProfile: req.userProfile,
    userSupabase: req.supabase
  })

  replaceUserInstanceSessions({ userId: req.user.id, instanceId: instance.id })
  assertSessionLimits({ userId: req.user.id, instanceId: instance.id })

  const createdAt = now()
  const expiresAt = createdAt + TERMINAL_SESSION_TTL_SECONDS * 1000
  const session = {
    id: null,
    instanceId: instance.id,
    userId: req.user.id,
    sandboxId: instance.sandbox_id,
    terminalUser,
    status: 'pending',
    createdAt,
    lastActivityAt: createdAt,
    expiresAt,
    ptyPid: null
  }

  const sessionId = createSessionId(session)
  session.id = sessionId
  sessions.set(sessionId, session)
  appLogger.info('Terminal session created', {
    userId: session.userId,
    instanceId: session.instanceId,
    sandboxId: session.sandboxId,
    terminalUser: session.terminalUser
  })

  return {
    sessionId,
    wsUrl: buildTerminalWsUrl(req, instance.id, sessionId),
    sandboxId: instance.sandbox_id,
    terminalUser,
    expiresAt: new Date(expiresAt).toISOString()
  }
}

function takePendingSession({ instanceId, sessionId }) {
  cleanupStaleSessions()
  const session = sessions.get(sessionId) || parseSessionId(sessionId)
  if (session.instanceId !== instanceId) {
    throw new TerminalError(401, 'TERMINAL_SESSION_INVALID', 'Terminal session is invalid')
  }
  if (session.status !== 'pending') {
    throw new TerminalError(409, 'TERMINAL_SESSION_LIMIT', 'Terminal session is already attached')
  }
  if (session.expiresAt <= now()) {
    sessions.delete(sessionId)
    throw new TerminalError(401, 'TERMINAL_SESSION_EXPIRED', 'Terminal session expired')
  }
  if (!sessions.has(sessionId)) {
    replaceUserInstanceSessions({
      userId: session.userId,
      instanceId: session.instanceId,
      exceptSessionId: sessionId
    })
    assertSessionLimits({ userId: session.userId, instanceId: session.instanceId })
    sessions.set(sessionId, session)
  }
  session.status = 'connecting'
  session.lastActivityAt = now()
  return session
}

function mapPtyError(error) {
  const message = String(error?.message || error || '')
  if (/user|uid|not found|no such/i.test(message)) return 'TERMINAL_USER_INVALID'
  return 'TERMINAL_START_FAILED'
}

function decodePtyData(data, decoder) {
  if (typeof data === 'string') return data
  if (data instanceof Uint8Array) return decoder.decode(data, { stream: true })
  if (data instanceof ArrayBuffer) return decoder.decode(new Uint8Array(data), { stream: true })
  return String(data ?? '')
}

function parseClientMessage(raw) {
  const text = typeof raw === 'string'
    ? raw
    : Buffer.isBuffer(raw)
      ? raw.toString('utf8')
      : String(raw ?? '')
  return JSON.parse(text)
}

export async function attachTerminalWebSocket({ ws, instanceId, sessionId }) {
  let session
  let sandbox
  let terminal
  let idleTimer
  let heartbeatTimer
  let closed = false
  const decoder = new TextDecoder()

  const finish = async (status = 'closed', errorCode = null) => {
    if (closed) return
    closed = true
    clearTimeout(idleTimer)
    clearInterval(heartbeatTimer)

    if (session) {
      session.status = status
      session.errorCode = errorCode
      sessions.delete(session.id)
    }

    if (sandbox && session?.ptyPid) {
      try {
        await sandbox.pty.kill(session.ptyPid)
      } catch (error) {
        console.warn(`Failed to kill terminal PTY ${session.ptyPid}: ${error.message}`)
      }
    }

    if (isWsOpen(ws)) {
      ws.close(status === 'error' ? 1011 : 1000)
    }
  }

  const fail = async (error) => {
    const terminalError = error instanceof TerminalError
      ? error
      : new TerminalError(1011, mapPtyError(error), error.message || 'Terminal connection failed')
    appLogger.warn('Terminal session failed', {
      code: terminalError.code,
      status: terminalError.status,
      message: terminalError.message,
      instanceId,
      userId: session?.userId ?? null,
      sandboxId: session?.sandboxId ?? null,
      terminalUser: session?.terminalUser ?? null,
      err: error instanceof Error ? error : undefined
    })
    try {
      sendJson(ws, {
        type: 'error',
        error: terminalError.code,
        message: terminalError.message
      })
    } catch {
      // Ignore send failures while closing the socket.
    }
    await finish('error', terminalError.code)
  }

  const resetIdleTimer = () => {
    if (session) session.lastActivityAt = now()
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      fail(new TerminalError(408, 'TERMINAL_IDLE_TIMEOUT', 'Terminal idle timeout'))
    }, TERMINAL_IDLE_TIMEOUT_SECONDS * 1000)
  }

  try {
    session = takePendingSession({ instanceId, sessionId })
    session.close = (status = 'closed', errorCode = null) => finish(status, errorCode)
    session.ws = ws
    resetIdleTimer()

    sandbox = await Sandbox.connect(session.sandboxId)
    const terminalUser = validateTerminalUser(session.terminalUser) || DEFAULT_TERMINAL_USER
    terminal = await sandbox.pty.create({
      cols: 80,
      rows: 24,
      timeoutMs: 0,
      user: terminalUser,
      onData: data => {
        try {
          resetIdleTimer()
          sendJson(ws, { type: 'stdout', data: decodePtyData(data, decoder) })
        } catch (error) {
          fail(error)
        }
      }
    })

    session.status = 'open'
    session.ptyPid = terminal.pid
    appLogger.info('Terminal session opened', {
      userId: session.userId,
      instanceId: session.instanceId,
      sandboxId: session.sandboxId,
      terminalUser,
      ptyPid: terminal.pid
    })
    sendJson(ws, {
      type: 'ready',
      sessionId: session.id,
      terminalUser,
      pid: terminal.pid
    })

    if (typeof terminal.wait === 'function') {
      terminal.wait().then(result => {
        if (!closed) {
          sendJson(ws, { type: 'exit', exitCode: result?.exitCode ?? 0 })
          finish('closed')
        }
      }).catch(error => {
        if (!closed) fail(error)
      })
    }

    ws.on('message', async raw => {
      if (closed || !session?.ptyPid) return
      resetIdleTimer()
      try {
        const message = parseClientMessage(raw)
        if (message.type === 'stdin') {
          await sandbox.pty.sendInput(session.ptyPid, encoder.encode(String(message.data ?? '')))
        } else if (message.type === 'resize') {
          const cols = Number(message.cols)
          const rows = Number(message.rows)
          if (Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
            await sandbox.pty.resize(session.ptyPid, { cols: Math.floor(cols), rows: Math.floor(rows) })
          }
        } else if (message.type === 'heartbeat') {
          sendJson(ws, { type: 'heartbeat' })
        }
      } catch (error) {
        console.warn(`Terminal client message failed: ${error.message}`)
        sendJson(ws, { type: 'error', error: 'TERMINAL_CLIENT_MESSAGE_INVALID', message: error.message })
      }
    })

    ws.on('close', () => {
      finish('closed')
    })
    ws.on('error', error => {
      fail(error)
    })

    heartbeatTimer = setInterval(() => {
      if (isWsOpen(ws)) ws.ping()
    }, 30_000)
  } catch (error) {
    await fail(error)
  }
}

export function getTerminalSessionSnapshot() {
  cleanupStaleSessions()
  return Array.from(sessions.values()).map(session => ({
    id: session.id,
    instanceId: session.instanceId,
    userId: session.userId,
    sandboxId: session.sandboxId,
    status: session.status,
    terminalUser: session.terminalUser,
    createdAt: session.createdAt,
    lastActivityAt: session.lastActivityAt,
    expiresAt: session.expiresAt,
    ptyPid: session.ptyPid
  }))
}
