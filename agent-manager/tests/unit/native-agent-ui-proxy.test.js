/**
 * 原生 Agent UI 私网代理的单元测试。
 * 通过模拟上游 HTTPS/E2B，验证 HTTP 与 WebSocket 的鉴权、转发和异常处理。
 */
import express from 'express'
import { createServer } from 'http'
import net from 'net'
import { PassThrough } from 'stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  authenticateToken: vi.fn(),
  canAccessInstanceRecord: vi.fn(),
  getActiveGroupMemberships: vi.fn(),
  httpsRequest: vi.fn(),
  maybeSingle: vi.fn(),
  resolveAgentPort: vi.fn()
}))

vi.mock('https', () => ({
  default: { request: mocks.httpsRequest }
}))
vi.mock('../../server/config/index.js', () => ({
  E2B_DOMAIN: 'agent-vpc.internal',
  NATIVE_AGENT_UI_ENABLED: true,
  PLATFORM_PUBLIC_URL: 'http://manager.example.com:8080',
  supabaseAdmin: {
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: mocks.maybeSingle
      }
      return query
    }
  }
}))
vi.mock('../../server/middleware/auth.js', () => ({
  authenticateToken: mocks.authenticateToken
}))
vi.mock('../../server/services/agent-runtime.js', () => ({
  buildE2BUpstreamHost: ({ agentPort, sandboxId }) =>
    `${agentPort}-${sandboxId}.agent-vpc.internal`,
  resolveAgentPort: mocks.resolveAgentPort
}))
vi.mock('../../server/services/principal-access.js', () => ({
  canAccessInstanceRecord: mocks.canAccessInstanceRecord,
  getActiveGroupMemberships: mocks.getActiveGroupMemberships
}))

const { registerNativeAgentUiProxy } = await import('../../server/native-agent-ui-proxy.js')
const PREVIEW_KEY = 'abcdefghijklmnopqrstuvwx'
const TARGET_COOKIE = `__agent_manager_preview_target=${PREVIEW_KEY}%3A8088%3Asandbox-a`

let server

afterEach(async () => {
  vi.clearAllMocks()
  if (!server?.listening) return
  await new Promise(resolve => server.close(resolve))
})

async function listen() {
  const app = express()
  server = createServer(app)
  registerNativeAgentUiProxy(app, server)
  app.use((_req, res) => res.status(418).end())
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

function mockRuntimeAccess({
  agentPort,
  agentTypeId,
  sandboxId,
  runtimeToken
}) {
  mocks.authenticateToken.mockResolvedValue({
    user: { id: 'user-a' },
    userProfile: { role: 'user' }
  })
  mocks.maybeSingle.mockResolvedValue({
    data: {
      id: 'instance-a',
      principal_id: 'user-a',
      sandbox_id: sandboxId,
      status: 'running',
      token: runtimeToken,
      agent_type_id: agentTypeId,
      agent_type: { code: agentTypeId }
    },
    error: null
  })
  mocks.getActiveGroupMemberships.mockResolvedValue([])
  mocks.canAccessInstanceRecord.mockReturnValue(true)
  mocks.resolveAgentPort.mockResolvedValue(agentPort)
}

function mockJsonUpstream() {
  mocks.httpsRequest.mockImplementation((_options, callback) => {
    const request = new PassThrough()
    request.setTimeout = vi.fn()
    const upstream = new PassThrough()
    upstream.statusCode = 200
    upstream.headers = { 'content-type': 'application/json' }
    queueMicrotask(() => {
      callback(upstream)
      upstream.end('{}')
    })
    return request
  })
}

describe('native Agent UI backend proxy ownership', () => {
  it('handles keyed preview HTTP requests in the backend without an internal API', async () => {
    const port = await listen()
    const response = await fetch(`http://127.0.0.1:${port}/_preview/${PREVIEW_KEY}/`, {
      headers: { Cookie: TARGET_COOKIE }
    })

    expect(response.status).toBe(401)
    expect(await response.text()).toBe('Unauthorized')
  })

  it('leaves Manager-owned paths to the normal route stack', async () => {
    const port = await listen()
    const response = await fetch(`http://127.0.0.1:${port}/api/health`)

    expect(response.status).toBe(418)
  })

  it('handles keyed preview WebSocket upgrades in the backend', async () => {
    const port = await listen()
    const response = await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write([
          `GET /_preview/${PREVIEW_KEY}/socket HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          `Cookie: ${TARGET_COOKIE}`,
          '',
          ''
        ].join('\r\n'))
      })
      socket.once('data', chunk => {
        resolve(chunk.toString('utf8'))
        socket.destroy()
      })
      socket.once('error', reject)
    })

    expect(response).toContain('HTTP/1.1 401 Unauthorized')
  })

  it('replaces Manager authorization with the OpenClaw runtime token for HTTP APIs', async () => {
    mockRuntimeAccess({
      agentPort: 18789,
      agentTypeId: 'openclaw',
      sandboxId: 'sandbox-openclaw',
      runtimeToken: 'openclaw-runtime-token'
    })
    mockJsonUpstream()

    const port = await listen()
    const targetCookie = `__agent_manager_preview_target=${PREVIEW_KEY}%3A18789%3Asandbox-openclaw`
    const response = await fetch(
      `http://127.0.0.1:${port}/_preview/${PREVIEW_KEY}/__openclaw/control-ui-config.json`,
      {
        headers: {
          Authorization: 'Bearer manager-oauth-token',
          Cookie: `${targetCookie}; __agent_manager_preview=preview-oauth-token`
        }
      }
    )

    expect(response.status).toBe(200)
    expect(mocks.httpsRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer openclaw-runtime-token'
        })
      }),
      expect.any(Function)
    )
  })

  it('does not add an OpenClaw authorization header to other Agent types', async () => {
    mockRuntimeAccess({
      agentPort: 8088,
      agentTypeId: 'qwenpaw',
      sandboxId: 'sandbox-qwenpaw',
      runtimeToken: 'qwenpaw-runtime-token'
    })
    mockJsonUpstream()

    const port = await listen()
    const targetCookie = `__agent_manager_preview_target=${PREVIEW_KEY}%3A8088%3Asandbox-qwenpaw`
    const response = await fetch(
      `http://127.0.0.1:${port}/_preview/${PREVIEW_KEY}/api/version`,
      {
        headers: {
          Authorization: 'Bearer manager-oauth-token',
          Cookie: `${targetCookie}; __agent_manager_preview=preview-oauth-token`
        }
      }
    )

    expect(response.status).toBe(200)
    const [options] = mocks.httpsRequest.mock.calls[0]
    expect(options.headers).not.toHaveProperty('authorization')
  })

  it('rejects transformed text responses larger than the buffer limit', async () => {
    mockRuntimeAccess({
      agentPort: 8088,
      agentTypeId: 'qwenpaw',
      sandboxId: 'sandbox-a',
      runtimeToken: 'runtime-token'
    })
    mocks.httpsRequest.mockImplementation((_options, callback) => {
      const request = new PassThrough()
      request.setTimeout = vi.fn()
      const upstream = new PassThrough()
      upstream.statusCode = 200
      upstream.headers = {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(32 * 1024 * 1024 + 1)
      }
      queueMicrotask(() => callback(upstream))
      return request
    })

    const port = await listen()
    const response = await fetch(`http://127.0.0.1:${port}/_preview/${PREVIEW_KEY}/`, {
      headers: {
        Cookie: `${TARGET_COOKIE}; __agent_manager_preview=oauth-token`
      }
    })

    expect(response.status).toBe(502)
    expect(await response.text()).toBe('Runtime response too large')
  })
})
