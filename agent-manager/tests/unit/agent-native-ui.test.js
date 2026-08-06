/**
 * 原生 Agent UI 无状态工具函数的单元测试。
 * 覆盖预览 URL/Cookie、浏览器启动脚本、根路径改写和凭据隔离。
 */
import { describe, expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import {
  allowNativeAgentUiEmbedding,
  buildNativeAgentUiProxyUrl,
  buildNativeAgentUiPreviewTarget,
  buildNativeAgentUiPreviewBootstrap,
  buildNativeAgentUiUpstreamHeaders,
  appendNativeAgentUiUpstreamToken,
  parseNativeAgentUiProxyPath,
  readNativeAgentUiPreviewTarget,
  readNativeAgentUiPreviewToken,
  rewriteNativeAgentUiLocation,
  rewriteNativeAgentUiText
} from '../../server/utils/native-agent-ui.js'

const PREVIEW_KEY = 'abcdefghijklmnopqrstuvwx'

describe('native agent UI preview proxy URLs', () => {
  it('uses the reserved Manager preview path while the target stays in an HttpOnly cookie', () => {
    for (const agentPort of [18789, 8088, 9119, 12345]) {
      expect(buildNativeAgentUiProxyUrl({
        managerOrigin: 'http://47.76.243.150:8080',
        e2bDomain: 'agent-vpc.infra',
        agentPort,
        sandboxId: 'sandbox-a'
      })).toBe('http://47.76.243.150:8080/_preview/')
    }

    expect(buildNativeAgentUiProxyUrl({
      managerOrigin: 'https://manager.example.com',
      e2bDomain: 'agent-vpc.infra',
      agentPort: 8088,
      sandboxId: 'sandbox-b'
    })).toBe('https://manager.example.com/_preview/')
  })

  it('keeps the browser URL free of the runtime token', () => {
    const url = buildNativeAgentUiProxyUrl({
      managerOrigin: 'https://manager.example.com',
      e2bDomain: 'agent-vpc.infra',
      agentPort: 9119,
      sandboxId: 'sandbox-hermes',
      token: 'token with/?&='
    })

    expect(url).toBe('https://manager.example.com/_preview/')
  })

  it('builds an isolated path for a preview session key', () => {
    expect(buildNativeAgentUiProxyUrl({
      managerOrigin: 'https://manager.example.com',
      e2bDomain: 'agent-vpc.infra',
      agentPort: 9119,
      sandboxId: 'sandbox-hermes',
      previewKey: PREVIEW_KEY
    })).toBe(`https://manager.example.com/_preview/${PREVIEW_KEY}/`)

    expect(buildNativeAgentUiProxyUrl({
      managerOrigin: 'https://manager.example.com',
      e2bDomain: 'agent-vpc.infra',
      agentPort: 9119,
      sandboxId: 'sandbox-hermes',
      previewKey: 'too-short'
    })).toBeNull()
  })

  it('rejects invalid sandbox identifiers and ports', () => {
    expect(buildNativeAgentUiProxyUrl({
      managerOrigin: 'https://manager.example.com',
      e2bDomain: 'agent-vpc.infra',
      agentPort: 0,
      sandboxId: 'sandbox-a'
    })).toBeNull()
    expect(buildNativeAgentUiProxyUrl({
      managerOrigin: 'https://manager.example.com/path',
      e2bDomain: 'agent-vpc.infra',
      agentPort: 18789,
      sandboxId: 'sandbox-a'
    })).toBeNull()
    expect(buildNativeAgentUiProxyUrl({
      managerOrigin: 'https://manager.example.com',
      e2bDomain: '',
      agentPort: 18789,
      sandboxId: 'sandbox-a'
    })).toBeNull()
  })

  it('normalizes an explicit default Manager port', () => {
    expect(buildNativeAgentUiProxyUrl({
      managerOrigin: 'https://manager.example.com:443',
      e2bDomain: 'agent-vpc.infra',
      agentPort: 18789,
      sandboxId: 'sandbox-a'
    })).toBe('https://manager.example.com/_preview/')
  })

  it('parses only a keyed preview path before proxying upstream', () => {
    expect(parseNativeAgentUiProxyPath(`/_preview/${PREVIEW_KEY}`)).toEqual({
      previewKey: PREVIEW_KEY,
      proxyBasePath: `/_preview/${PREVIEW_KEY}`,
      upstreamPath: '/'
    })
    expect(parseNativeAgentUiProxyPath(`/_preview/${PREVIEW_KEY}/api/skills?enabled=true`)).toEqual({
      previewKey: PREVIEW_KEY,
      proxyBasePath: `/_preview/${PREVIEW_KEY}`,
      upstreamPath: '/api/skills?enabled=true'
    })
    expect(parseNativeAgentUiProxyPath('/_preview/api/skills')).toBeNull()
    expect(parseNativeAgentUiProxyPath('/api/instances')).toBeNull()
    expect(parseNativeAgentUiProxyPath('/_preview-other/api')).toBeNull()
  })

  it('reads only the Manager OAuth preview cookie', () => {
    expect(readNativeAgentUiPreviewToken('other=x; __agent_manager_preview=oauth%20token')).toBe('oauth token')
    expect(readNativeAgentUiPreviewToken('other=x')).toBeNull()
    expect(readNativeAgentUiPreviewToken('__agent_manager_preview=%E0%A4%A')).toBeNull()
  })

  it('validates the selected runtime target cookie', () => {
    expect(buildNativeAgentUiPreviewTarget({
      previewKey: PREVIEW_KEY,
      agentPort: 12345,
      sandboxId: 'default--custom-a'
    })).toBe(`${PREVIEW_KEY}:12345:default--custom-a`)
    expect(readNativeAgentUiPreviewTarget(
      `x=1; __agent_manager_preview_target=${PREVIEW_KEY}%3A9119%3Adefault--hermes-a`
    )).toEqual({ previewKey: PREVIEW_KEY, agentPort: 9119, sandboxId: 'default--hermes-a' })
    expect(readNativeAgentUiPreviewTarget('__agent_manager_preview_target=3001%3Asandbox-a')).toBeNull()
    expect(readNativeAgentUiPreviewTarget(
      `__agent_manager_preview_target=${PREVIEW_KEY}%3A8088%3Asandbox%2Fa`
    )).toBeNull()
    expect(readNativeAgentUiPreviewTarget(
      `__agent_manager_preview_target=${PREVIEW_KEY}%3A8088%3Asandbox.example`
    )).toBeNull()
    expect(readNativeAgentUiPreviewTarget(
      `__agent_manager_preview_target=${PREVIEW_KEY}%3A8088%3Asandbox%3Aother`
    )).toBeNull()
    expect(readNativeAgentUiPreviewTarget('__agent_manager_preview_target=%E0%A4%A')).toBeNull()
  })

  it('replaces browser token input with the server-side runtime token', () => {
    expect(appendNativeAgentUiUpstreamToken('/chat?token=attacker&tab=main', 'runtime token'))
      .toBe('/chat?tab=main&token=runtime+token')
  })

  it('does not forward Manager credentials to the Agent', () => {
    expect(buildNativeAgentUiUpstreamHeaders({
      authorization: 'Bearer manager-oauth-token',
      cookie: 'manager-session=secret',
      origin: 'https://manager.example.com',
      referer: 'https://manager.example.com/admin/instances/1',
      connection: 'keep-alive'
    }, '18789-sandbox-a.agent-vpc.internal', {
      upstreamAuthorization: 'agent-runtime-token'
    })).toEqual({
      host: '18789-sandbox-a.agent-vpc.internal',
      'accept-encoding': 'identity',
      authorization: 'Bearer agent-runtime-token',
      origin: 'https://18789-sandbox-a.agent-vpc.internal',
      referer: 'https://18789-sandbox-a.agent-vpc.internal/'
    })
  })

  it('keeps redirects and text resources inside the current preview path', () => {
    const target = {
      proxyBasePath: `/_preview/${PREVIEW_KEY}`,
      upstreamHost: '8088-sandbox-a.agent-vpc.internal'
    }
    const headers = {
      location: 'https://8088-sandbox-a.agent-vpc.internal/skills?token=runtime&tab=all'
    }

    rewriteNativeAgentUiLocation(headers, target)

    expect(headers.location).toBe(`/_preview/${PREVIEW_KEY}/skills?tab=all`)
    expect(rewriteNativeAgentUiText(
      '<html><head></head><body><img src="/logo.png"></body></html>',
      target,
      'text/html'
    )).toContain(`<base href="/_preview/${PREVIEW_KEY}/">`)
    expect(rewriteNativeAgentUiText(
      'body { background: url("/wallpaper.png") }',
      target,
      'text/css'
    )).toContain(`url("/_preview/${PREVIEW_KEY}/wallpaper.png")`)
    expect(rewriteNativeAgentUiText(
      'import "/assets/app.js"',
      target,
      'application/javascript'
    )).toBe(`import "/_preview/${PREVIEW_KEY}/assets/app.js"`)
  })

  it('allows only the configured Manager origin to embed Agent HTML', () => {
    const headers = {
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'; script-src 'self'",
      'x-frame-options': 'DENY'
    }

    allowNativeAgentUiEmbedding(headers, 'http://manager.example.com:8080')

    expect(headers).toEqual({
      'content-security-policy': "default-src 'self'; script-src 'self'; frame-ancestors http://manager.example.com:8080",
      'x-frame-options': 'SAMEORIGIN'
    })
  })

  it('does not clear shared browser storage when another preview opens', () => {
    let storageAccesses = 0
    const context = {
      window: {}
    }
    for (const name of ['localStorage', 'sessionStorage']) {
      Object.defineProperty(context, name, {
        get() {
          storageAccesses += 1
          return {}
        }
      })
    }
    const bootstrap = buildNativeAgentUiPreviewBootstrap({
      gatewayUrl: `wss://manager.example.com/_preview/${PREVIEW_KEY}`,
      token: 'runtime token',
      proxyBasePath: `/_preview/${PREVIEW_KEY}`
    })

    runInNewContext(bootstrap, context)
    expect(storageAccesses).toBe(0)
    expect(context.window.__OPENCLAW_NATIVE_CONTROL_AUTH__).toEqual({
      gatewayUrl: `wss://manager.example.com/_preview/${PREVIEW_KEY}`,
      token: 'runtime token'
    })
    expect(context.window.__OPENCLAW_CONTROL_UI_BASE_PATH__)
      .toBe(`/_preview/${PREVIEW_KEY}`)
  })

  it('scopes same-origin HTTP and WebSocket root paths under the preview path', async () => {
    const fetchedUrls = []
    const socketUrls = []
    function WebSocket(url) {
      socketUrls.push(url)
    }
    const context = {
      URL,
      window: {
        location: {
          href: `https://manager.example.com/_preview/${PREVIEW_KEY}/`,
          host: 'manager.example.com'
        },
        fetch: url => {
          fetchedUrls.push(url)
          return Promise.resolve()
        },
        WebSocket
      }
    }
    const bootstrap = buildNativeAgentUiPreviewBootstrap({
      proxyBasePath: `/_preview/${PREVIEW_KEY}`
    })

    runInNewContext(bootstrap, context)
    await context.window.fetch('/api/skills')
    await context.window.fetch('https://outside.example/api/skills')
    new context.window.WebSocket('wss://manager.example.com/socket')
    new context.window.WebSocket('wss://outside.example/socket')

    expect(fetchedUrls).toEqual([
      `https://manager.example.com/_preview/${PREVIEW_KEY}/api/skills`,
      'https://outside.example/api/skills'
    ])
    expect(socketUrls).toEqual([
      `wss://manager.example.com/_preview/${PREVIEW_KEY}/socket`,
      'wss://outside.example/socket'
    ])
  })

  it('hides the transport prefix when full-page navigation can restore it', () => {
    const replacedUrls = []
    const context = {
      URL,
      window: {
        location: {
          href: `https://manager.example.com/_preview/${PREVIEW_KEY}/skills?tab=all#enabled`,
          host: 'manager.example.com',
          pathname: `/_preview/${PREVIEW_KEY}/skills`,
          search: '?tab=all',
          hash: '#enabled'
        },
        history: {
          state: { from: 'preview' },
          replaceState: (state, unused, url) => replacedUrls.push({ state, unused, url })
        },
        navigation: {
          addEventListener: () => {}
        }
      }
    }

    runInNewContext(buildNativeAgentUiPreviewBootstrap({
      proxyBasePath: `/_preview/${PREVIEW_KEY}`
    }), context)

    expect(replacedUrls).toEqual([{
      state: { from: 'preview' },
      unused: '',
      url: '/skills?tab=all#enabled'
    }])
  })

  it('keeps the transport prefix when the Navigation API is unavailable', () => {
    const replacedUrls = []
    const context = {
      URL,
      window: {
        location: {
          href: `https://manager.example.com/_preview/${PREVIEW_KEY}/skills`,
          host: 'manager.example.com',
          pathname: `/_preview/${PREVIEW_KEY}/skills`,
          search: '',
          hash: ''
        },
        history: {
          state: null,
          replaceState: (...args) => replacedUrls.push(args)
        }
      }
    }

    runInNewContext(buildNativeAgentUiPreviewBootstrap({
      proxyBasePath: `/_preview/${PREVIEW_KEY}`
    }), context)

    expect(replacedUrls).toEqual([])
  })

  it('restores the transport prefix before a full-page navigation', () => {
    let navigateListener
    let intercepted
    let replacedUrl
    const context = {
      URL,
      window: {
        location: {
          href: 'https://manager.example.com/skills',
          host: 'manager.example.com',
          pathname: '/skills',
          search: '',
          hash: '',
          replace: value => {
            replacedUrl = value
          }
        },
        history: {
          state: null,
          replaceState: () => {}
        },
        navigation: {
          addEventListener: (_type, listener) => {
            navigateListener = listener
          }
        }
      }
    }

    runInNewContext(buildNativeAgentUiPreviewBootstrap({
      proxyBasePath: `/_preview/${PREVIEW_KEY}`
    }), context)
    navigateListener({
      canIntercept: true,
      destination: {
        sameDocument: false,
        url: 'https://manager.example.com/skills'
      },
      intercept: options => {
        intercepted = options
      }
    })
    intercepted.handler()

    expect(replacedUrl).toBe(
      `https://manager.example.com/_preview/${PREVIEW_KEY}/skills`
    )
  })

  it('scopes dynamically assigned resource URLs under the preview path', () => {
    class FakeScript {
      get src() {
        return this.value
      }

      set src(value) {
        this.value = value
      }
    }
    const context = {
      URL,
      window: {
        location: {
          href: 'https://manager.example.com/',
          host: 'manager.example.com',
          pathname: '/',
          search: '',
          hash: ''
        },
        HTMLScriptElement: FakeScript
      }
    }

    runInNewContext(buildNativeAgentUiPreviewBootstrap({
      proxyBasePath: `/_preview/${PREVIEW_KEY}`
    }), context)
    const script = new FakeScript()
    script.src = '/dashboard-plugins/kanban/dist/index.js'

    expect(script.src).toBe(
      `https://manager.example.com/_preview/${PREVIEW_KEY}/dashboard-plugins/kanban/dist/index.js`
    )
  })
})
