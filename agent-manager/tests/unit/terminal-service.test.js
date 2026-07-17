import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  agentInstances: [],
  agentTypes: [],
  sandbox: null
}))

vi.mock('@e2b/code-interpreter', () => ({
  Sandbox: {
    connect: vi.fn(async () => fixture.sandbox)
  }
}))

vi.mock('../../server/node_modules/@e2b/code-interpreter/dist/index.js', () => ({
  Sandbox: {
    connect: vi.fn(async () => fixture.sandbox)
  }
}))

vi.mock('../../server/config/index.js', () => {
  function rowsFor(table) {
    if (table === 'agent_instances') return fixture.agentInstances
    if (table === 'agent_types') return fixture.agentTypes
    return []
  }

  function createQuery(table) {
    const filters = []
    return {
      select() {
        return this
      },
      eq(column, value) {
        filters.push({ column, value })
        return this
      },
      async single() {
        const row = rowsFor(table).find(item => filters.every(filter => item[filter.column] === filter.value))
        if (!row) return { data: null, error: { message: 'not found' } }
        return { data: row, error: null }
      }
    }
  }

  return {
    E2B_API_KEY: 'test-e2b-key',
    TERMINAL_IDLE_TIMEOUT_SECONDS: 60,
    TERMINAL_MAX_SESSIONS_PER_INSTANCE: 1,
    TERMINAL_MAX_SESSIONS_PER_USER: 3,
    TERMINAL_OUTPUT_BUFFER_BYTES: 1024 * 1024,
    TERMINAL_SESSION_MAX_LIFETIME_SECONDS: 300,
    TERMINAL_SESSION_SECRET: 'test-terminal-session-secret',
    TERMINAL_SESSION_TTL_SECONDS: 60,
    supabaseAdmin: {
      from: vi.fn(createQuery)
    }
  }
})

function resetFixture(agentType = {}) {
  fixture.agentInstances = [{
    id: 'instance-1',
    principal_id: 'user-1',
    status: 'running',
    sandbox_id: 'default--agent-manager-openclaw-test',
    agent_type_id: 'agent-type-1',
    name: 'terminal-test'
  }]
  fixture.agentTypes = [{
    id: 'agent-type-1',
    user_terminal_enabled: true,
    sandbox_user: 'root',
    terminal_user: 'node',
    ...agentType
  }]
  fixture.sandbox = {
    pty: {
      create: vi.fn(async () => ({ pid: 42 })),
      sendInput: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn()
    }
  }
}

function makeReq() {
  const query = table => ({
    select() {
      return this
    },
    eq() {
      return this
    },
    async single() {
      if (table === 'agent_instances') return { data: fixture.agentInstances[0], error: null }
      return { data: null, error: { message: 'not found' } }
    }
  })

  return {
    headers: { host: 'manager.example.com' },
    secure: false,
    user: { id: 'user-1' },
    userProfile: { id: 'user-1', role: 'user' },
    supabase: {
      from: vi.fn(query)
    }
  }
}

function makeWs() {
  const ws = new EventEmitter()
  ws.readyState = 1
  ws.bufferedAmount = 0
  ws.sent = []
  ws.send = vi.fn(payload => ws.sent.push(JSON.parse(payload)))
  ws.close = vi.fn(() => {
    ws.readyState = 3
    ws.emit('close')
  })
  ws.ping = vi.fn()
  return ws
}

async function loadTerminalService() {
  vi.resetModules()
  return import('../../server/services/terminal.js')
}

function createLegacySessionId(payload) {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = crypto
    .createHmac('sha256', 'test-terminal-session-secret')
    .update(encodedPayload)
    .digest('base64url')
  return `${encodedPayload}.${signature}`
}

describe('terminal service', () => {
  beforeEach(() => {
    resetFixture()
    vi.clearAllMocks()
  })

  it('builds a secure websocket URL when the browser page origin is HTTPS', async () => {
    const { buildTerminalWsUrl } = await loadTerminalService()
    const req = makeReq()
    req.headers = {
      host: 'manager.example.com',
      origin: 'https://manager.example.com'
    }

    const wsUrl = buildTerminalWsUrl(req, 'instance-1', 'session-1')

    expect(wsUrl).toBe('wss://manager.example.com/api/instances/instance-1/terminal/ws?sessionId=session-1')
  })

  it('does not downgrade HTTPS browser sessions when an inner proxy reports http', async () => {
    const { buildTerminalWsUrl } = await loadTerminalService()
    const req = makeReq()
    req.headers = {
      host: 'manager.example.com',
      origin: 'https://manager.example.com',
      'x-forwarded-proto': 'http'
    }

    const wsUrl = buildTerminalWsUrl(req, 'instance-1', 'session-1')

    expect(wsUrl).toBe('wss://manager.example.com/api/instances/instance-1/terminal/ws?sessionId=session-1')
  })

  it('uses an HTTPS referer as a websocket protocol fallback', async () => {
    const { buildTerminalWsUrl } = await loadTerminalService()
    const req = makeReq()
    req.headers = {
      host: 'manager.example.com',
      referer: 'https://manager.example.com/instances/instance-1'
    }

    const wsUrl = buildTerminalWsUrl(req, 'instance-1', 'session-1')

    expect(wsUrl).toBe('wss://manager.example.com/api/instances/instance-1/terminal/ws?sessionId=session-1')
  })

  it('uses the browser origin host when an inner proxy rewrites Host', async () => {
    const { buildTerminalWsUrl } = await loadTerminalService()
    const req = makeReq()
    req.headers = {
      host: 'openclaw-platform:3001',
      origin: 'https://manager.example.com'
    }

    const wsUrl = buildTerminalWsUrl(req, 'instance-1', 'session-1')

    expect(wsUrl).toBe('wss://manager.example.com/api/instances/instance-1/terminal/ws?sessionId=session-1')
  })

  it('uses the browser origin host when x-forwarded-host is internal', async () => {
    const { buildTerminalWsUrl } = await loadTerminalService()
    const req = makeReq()
    req.headers = {
      host: 'openclaw-platform:3001',
      origin: 'https://manager.example.com',
      'x-forwarded-host': '127.0.0.1:8080'
    }

    const wsUrl = buildTerminalWsUrl(req, 'instance-1', 'session-1')

    expect(wsUrl).toBe('wss://manager.example.com/api/instances/instance-1/terminal/ws?sessionId=session-1')
  })

  it('uses terminal_user for browser terminal PTY instead of sandbox_user', async () => {
    const { attachTerminalWebSocket, createTerminalSession } = await loadTerminalService()

    const session = await createTerminalSession({
      instanceId: 'instance-1',
      req: makeReq()
    })

    expect(session.terminalUser).toBe('node')
    const ws = makeWs()

    await attachTerminalWebSocket({
      ws,
      instanceId: 'instance-1',
      sessionId: session.sessionId
    })

    expect(fixture.sandbox.pty.create).toHaveBeenCalledWith(expect.objectContaining({
      user: 'node'
    }))
    expect(ws.sent).toContainEqual(expect.objectContaining({
      type: 'ready',
      terminalUser: 'node'
    }))
  })

  it('passes custom valid terminal_user values through to E2B PTY', async () => {
    resetFixture({ terminal_user: 'guest' })
    const { attachTerminalWebSocket, createTerminalSession } = await loadTerminalService()

    const session = await createTerminalSession({
      instanceId: 'instance-1',
      req: makeReq()
    })
    const ws = makeWs()

    await attachTerminalWebSocket({
      ws,
      instanceId: 'instance-1',
      sessionId: session.sessionId
    })

    expect(fixture.sandbox.pty.create).toHaveBeenCalledWith(expect.objectContaining({
      user: 'guest'
    }))
    expect(ws.sent).toContainEqual(expect.objectContaining({
      type: 'ready',
      terminalUser: 'guest'
    }))
  })

  it('falls back to node for pre-migration agent types without terminal_user', async () => {
    resetFixture({ terminal_user: undefined })
    const { createTerminalSession } = await loadTerminalService()

    const session = await createTerminalSession({
      instanceId: 'instance-1',
      req: makeReq()
    })

    expect(session.terminalUser).toBe('node')
  })

  it('reconstructs legacy signed sessions with node instead of root', async () => {
    const { attachTerminalWebSocket } = await loadTerminalService()
    const sessionId = createLegacySessionId({
      v: 1,
      nonce: 'legacy-session',
      instanceId: 'instance-1',
      userId: 'user-1',
      sandboxId: 'default--agent-manager-openclaw-test',
      terminalUser: 'root',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000
    })
    const ws = makeWs()

    await attachTerminalWebSocket({
      ws,
      instanceId: 'instance-1',
      sessionId
    })

    expect(fixture.sandbox.pty.create).toHaveBeenCalledWith(expect.objectContaining({
      user: 'node'
    }))
    expect(ws.sent).toContainEqual(expect.objectContaining({
      type: 'ready',
      terminalUser: 'node'
    }))
  })
})
