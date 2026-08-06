import { expect, test, type Page } from '@playwright/test'

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111'
const ADMIN_USER_ID = '22222222-2222-4222-8222-222222222222'
const SUPABASE_URL = 'https://stub.supabase.local'
const STORAGE_KEY = 'sb-stub-auth-token'
const TRANSCRIPT_KEY = `openclaw-terminal:${INSTANCE_ID}:transcript`
const TERMINAL_USER = 'claude'

function nowIso(offsetSec = 0) {
  return new Date(Date.now() + offsetSec * 1000).toISOString()
}

type StubRole = 'admin' | 'user'

interface StubOptions {
  role?: StubRole
  userTerminalEnabled?: boolean
}

function fakeSession() {
  return {
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: {
      id: ADMIN_USER_ID,
      aud: 'authenticated',
      role: 'authenticated',
      email: 'admin@stub.local',
      app_metadata: { provider: 'email' },
      user_metadata: { name: 'Stub Admin' },
      created_at: nowIso(-3600),
      updated_at: nowIso(),
    },
  }
}

function instanceFixture(options: StubOptions = {}) {
  const userTerminalEnabled = options.userTerminalEnabled ?? true

  return {
    id: INSTANCE_ID,
    principal_id: ADMIN_USER_ID,
    name: 'stub-running-instance',
    description: 'fixture for terminal regression',
    status: 'running',
    sandbox_id: 'sbx-stub-terminal',
    sandboxStatus: 'running',
    hostsEntries: null,
    total_tokens_used: 0,
    created_at: nowIso(-3600),
    last_active_at: nowIso(-60),
    config_json: {},
    agent_image: 'stub-image:latest',
    agent_version: 'v0.0.1',
    agent_type_id: 'agent-type-stub',
    ai_models: { id: 'm-1', name: 'gpt-4o', provider: 'openai' },
    agent_type: {
      id: 'agent-type-stub',
      code: 'stub-agent',
      name: 'Stub Agent',
      sandbox_template_id: 'tpl-1',
      supports_channels: false,
      supports_modify_model: false,
      supports_modify_channel: false,
      user_terminal_enabled: userTerminalEnabled,
    },
    sandbox_upgrade: null,
    instance_channel_configs: [],
    username: 'stub-admin',
  }
}

async function setupCommonStubs(page: Page, options: StubOptions = {}) {
  const role = options.role ?? 'admin'
  const session = fakeSession()
  let instanceCallCount = 0

  await page.addInitScript(
    ({ storageKey, sessionPayload, supabaseUrl, transcriptKey }) => {
      localStorage.setItem(storageKey, JSON.stringify(sessionPayload))
      localStorage.setItem('i18nextLng', 'zh-CN')
      localStorage.removeItem('openclaw-terminal:restore-dock-enabled')
      sessionStorage.removeItem('openclaw-terminal:restore-dock-enabled')
      sessionStorage.removeItem('openclaw-terminal:dock-session')
      sessionStorage.removeItem(transcriptKey)
      ;(window as unknown as { __ENV__?: Record<string, string> }).__ENV__ = {
        VITE_SUPABASE_URL: supabaseUrl,
        VITE_SUPABASE_ANON_KEY: 'test-anon-key',
        VITE_API_URL: '',
        VITE_APP_ID: 'public',
      }
    },
    {
      storageKey: STORAGE_KEY,
      sessionPayload: session,
      supabaseUrl: SUPABASE_URL,
      transcriptKey: TRANSCRIPT_KEY,
    },
  )

  await page.route(`${SUPABASE_URL}/auth/v1/**`, (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/user')) {
      route.fulfill({ json: session.user })
      return
    }
    if (url.pathname.endsWith('/token')) {
      route.fulfill({ json: fakeSession() })
      return
    }
    route.fulfill({ json: {} })
  })

  await page.route(`${SUPABASE_URL}/rest/v1/**`, (route) => {
    route.fulfill({ json: [] })
  })

  await page.route(`${SUPABASE_URL}/rest/v1/principal_profiles**`, (route) => {
    route.fulfill({
      json: {
        id: ADMIN_USER_ID,
        username: 'stub-admin',
        email: 'admin@stub.local',
        role,
        status: 'active',
        max_agent_instances: 5,
      },
    })
  })

  await page.route('**/api/instances?**', (route) => {
    route.fulfill({
      json: {
        success: true,
        instances: [instanceFixture(options)],
        pagination: {
          page: 1,
          pageSize: 20,
          total: 1,
          totalPages: 1,
        },
      },
    })
  })

  await page.route('**/api/instances', (route) => {
    route.fulfill({
      json: {
        success: true,
        instances: [instanceFixture(options)],
        pagination: {
          page: 1,
          pageSize: 20,
          total: 1,
          totalPages: 1,
        },
      },
    })
  })

  await page.route('**/api/admin/instances?**', (route) => {
    route.fulfill({
      json: {
        success: true,
        instances: [instanceFixture(options)],
        pagination: {
          page: 1,
          pageSize: 20,
          total: 1,
          totalPages: 1,
        },
      },
    })
  })

  await page.route('**/api/models', (route) => {
    route.fulfill({ json: { success: true, models: [] } })
  })

  await page.route('**/api/channel-templates**', (route) => {
    route.fulfill({ json: { success: true, templates: [] } })
  })

  await page.route(`**/api/instances/${INSTANCE_ID}`, (route) => {
    instanceCallCount += 1
    route.fulfill({ json: { success: true, instance: instanceFixture(options) } })
  })

  return {
    getInstanceCallCount: () => instanceCallCount,
  }
}

test.describe('sandbox terminal lifecycle', () => {
  test('shows terminal login user on agent type cards even when user terminal is disabled', async ({
    page,
  }) => {
    await setupCommonStubs(page)

    await page.route('**/api/agent-types', (route) => {
      route.fulfill({
        json: {
          success: true,
          agentTypes: [
            {
              id: 'agent-type-hermes',
              code: 'hermes',
              name: 'Hermes',
              description: 'Hermes fixture',
              icon: 'bot',
              category: 'builtin',
              sandbox_template_id: 'hermes',
              sandbox_timeout: 300,
              config_write_path: '/opt/data/.env',
              startup_command: null,
              sandbox_user: 'node',
              terminal_user: 'user',
              supports_channels: true,
              supports_env_vars: false,
              supports_skills: true,
              user_terminal_enabled: false,
              is_enabled: true,
              sort_order: 20,
              created_at: nowIso(-3600),
            },
            {
              id: 'agent-type-qwenpaw',
              code: 'qwenpaw',
              name: 'QwenPaw',
              description: 'QwenPaw fixture',
              icon: 'bot',
              category: 'builtin',
              sandbox_template_id: 'qwenpaw',
              sandbox_timeout: 300,
              config_write_path: '/opt/data/.env',
              startup_command: null,
              sandbox_user: 'node',
              terminal_user: 'node',
              supports_channels: true,
              supports_env_vars: true,
              supports_skills: true,
              user_terminal_enabled: false,
              is_enabled: true,
              sort_order: 30,
              created_at: nowIso(-3600),
            },
          ],
        },
      })
    })

    await page.goto('/admin/agent-types')

    const hermesCard = page.locator('.card').filter({ hasText: 'hermes' })
    const qwenPawCard = page.locator('.card').filter({ hasText: 'qwenpaw' })

    await expect(hermesCard.getByText(/终端登录用户:\s*user/)).toBeVisible()
    await expect(qwenPawCard.getByText(/终端登录用户:\s*node/)).toBeVisible()
    await expect(hermesCard.getByText('用户终端')).toHaveCount(0)
    await expect(qwenPawCard.getByText('用户终端')).toHaveCount(0)
  })

  test('disables terminal for normal users when the agent type opts out', async ({
    page,
  }) => {
    await setupCommonStubs(page, { role: 'user', userTerminalEnabled: false })

    await page.goto(`/user/instances/${INSTANCE_ID}`)

    const terminalButton = page.getByRole('button', { name: '打开终端' })
    await expect(terminalButton).toBeDisabled()
    await expect(terminalButton).toHaveAttribute('title', '当前 Agent 未开放用户侧终端')
    await expect(page.locator('.xterm')).toHaveCount(0)
  })

  test('opens terminal dock and keeps detail stable after browser tab switch', async ({
    page,
  }) => {
    const stubs = await setupCommonStubs(page)

    let sessionCallCount = 0
    let websocketCount = 0

    await page.route(`**/api/instances/${INSTANCE_ID}/terminal/session`, (route) => {
      sessionCallCount += 1
      route.fulfill({
        json: {
          success: true,
          data: {
            wsUrl: 'ws://127.0.0.1:5173/api/instances/terminal/ws',
            wsToken: `terminal-session-${sessionCallCount}`,
            terminalUser: TERMINAL_USER,
            sandboxId: 'sbx-stub-terminal',
            expiresAt: nowIso(60),
          },
        },
      })
    })

    await page.routeWebSocket('ws://127.0.0.1:5173/api/instances/terminal/ws', (ws) => {
      websocketCount += 1
      ws.onMessage((message) => {
        const payload = JSON.parse(String(message))
        if (payload.type !== 'stdin') return
        ws.send(
          JSON.stringify({
            type: 'stdout',
            data: payload.data,
          }),
        )
      })
      ws.send(
        JSON.stringify({
          type: 'ready',
          terminalUser: TERMINAL_USER,
        }),
      )
    })

    await page.goto(`/admin/instances/${INSTANCE_ID}`)
    await page.getByRole('button', { name: '打开终端' }).click()

    await expect(page.getByText(`已连接：${TERMINAL_USER}`)).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.openclaw-terminal .xterm')).toBeVisible()
    await page.getByRole('button', { name: '悬浮' }).click()
    await expect(page.locator('div.fixed.bottom-4.right-4 .xterm')).toBeVisible()
    const initialSessionCalls = sessionCallCount
    const initialWebsockets = websocketCount
    const initialInstanceCalls = stubs.getInstanceCallCount()

    const otherPage = await page.context().newPage()
    await otherPage.goto('about:blank')
    await otherPage.bringToFront()
    await page.bringToFront()
    await otherPage.close()
    await expect
      .poll(() => sessionCallCount, { timeout: 1_000 })
      .toBe(initialSessionCalls)
    expect(websocketCount).toBe(initialWebsockets)
    expect(stubs.getInstanceCallCount()).toBe(initialInstanceCalls)

    const detachedSessionCalls = sessionCallCount
    const detachedWebsockets = websocketCount
    await page.locator('a[href="/admin/instances"]').click()
    await expect(page).toHaveURL(/\/admin\/instances$/)
    await expect(page.locator('div.fixed.bottom-4.right-4 .xterm')).toBeVisible()
    await expect(page.getByText(`已连接：${TERMINAL_USER}`)).toBeVisible()
    expect(sessionCallCount).toBe(detachedSessionCalls)
    expect(websocketCount).toBe(detachedWebsockets)
  })
})
