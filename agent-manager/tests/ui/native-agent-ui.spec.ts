/**
 * 原生 Agent UI 工作台的 Playwright 回归测试。
 * 覆盖管理员/用户入口、预览会话、多实例隔离、响应式布局和错误状态。
 */
import { expect, test, type Page } from '@playwright/test'
import { buildNativeAgentUiPreviewBootstrap } from '../../server/utils/native-agent-ui.js'

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111'
const ADMIN_ID = '22222222-2222-4222-8222-222222222222'
const SUPABASE_URL = 'https://stub.supabase.local'
const STORAGE_KEY = 'sb-stub-auth-token'
const MANAGER_ORIGIN = (process.env.OPENCLAW_FRONTEND_URL || 'http://localhost:5173')
  .replace(/\/+$/, '')
const NATIVE_UI_URL = `${MANAGER_ORIGIN}/_preview/`
const previewSessionUrl = (key: string) => `${NATIVE_UI_URL}${key}/`

function nowIso() {
  return new Date().toISOString()
}

function sessionFixture() {
  return {
    access_token: 'admin-access-token',
    refresh_token: 'refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: {
      id: ADMIN_ID,
      aud: 'authenticated',
      role: 'authenticated',
      email: 'admin@stub.local',
      app_metadata: { provider: 'email' },
      user_metadata: { name: 'Stub Admin' },
      created_at: nowIso(),
      updated_at: nowIso(),
    },
  }
}

function instanceFixture(instanceId = INSTANCE_ID, name = 'OpenClaw', agentTypeCode = 'openclaw') {
  return {
    id: instanceId,
    principal_id: ADMIN_ID,
    name,
    description: 'native agent UI fixture',
    status: 'running',
    sandbox_id: 'sbx-native',
    sandboxStatus: 'running',
    e2bHost: '18789-sbx-native.agent-vpc.internal',
    hostsEntries: null,
    total_tokens_used: 0,
    created_at: nowIso(),
    last_active_at: nowIso(),
    config_json: {},
    agent_image: 'openclaw:test',
    agent_version: 'test',
    agent_type_id: 'agent-type-openclaw',
    ai_models: { id: 'model-1', name: 'qwen-plus', provider: 'bailian' },
    agent_type: {
      id: 'agent-type-openclaw',
      code: agentTypeCode,
      name,
      sandbox_template_id: 'openclaw',
      supports_channels: false,
      supports_modify_model: false,
      supports_modify_channel: false,
      user_terminal_enabled: true,
    },
    sandbox_upgrade: null,
    instance_channel_configs: [],
    username: 'stub-admin',
  }
}

interface StubOptions {
  nativeUiEnabled?: boolean
  previewAvailable?: boolean
  instanceId?: string
  name?: string
  agentTypeCode?: string
}

async function setupStubs(page: Page, {
  nativeUiEnabled = true,
  previewAvailable = true,
  instanceId = INSTANCE_ID,
  name = 'OpenClaw',
  agentTypeCode = 'openclaw',
}: StubOptions = {}) {
  const session = sessionFixture()
  const nativeUrl = new URL(NATIVE_UI_URL)
  let nativeUiLoads = 0
  let previewSessions = 0
  const consoleErrors: string[] = []
  const failedRequests: string[] = []

  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('requestfailed', request => {
    if (request.failure()?.errorText === 'net::ERR_ABORTED') return
    failedRequests.push(`${request.method()} ${request.url()} (${request.failure()?.errorText || 'unknown'})`)
  })

  await page.route('**/env-config.js', route => route.fulfill({
    contentType: 'application/javascript',
    body: `window.__ENV__ = ${JSON.stringify({
      VITE_SUPABASE_URL: SUPABASE_URL,
      VITE_SUPABASE_ANON_KEY: 'test-anon-key',
      VITE_API_URL: '',
      VITE_NATIVE_AGENT_UI_ENABLED: String(nativeUiEnabled),
    })};`,
  }))

  await page.addInitScript(({ storageKey, sessionPayload, supabaseUrl, nativeUiEnabled }) => {
    localStorage.setItem(storageKey, JSON.stringify(sessionPayload))
    localStorage.setItem('i18nextLng', 'zh-CN')
    ;(window as unknown as { __ENV__?: Record<string, string> }).__ENV__ = {
      VITE_SUPABASE_URL: supabaseUrl,
      VITE_SUPABASE_ANON_KEY: 'test-anon-key',
      VITE_API_URL: '',
      VITE_NATIVE_AGENT_UI_ENABLED: String(nativeUiEnabled),
    }
  }, {
    storageKey: STORAGE_KEY,
    sessionPayload: session,
    supabaseUrl: SUPABASE_URL,
    nativeUiEnabled,
  })

  await page.route(`${SUPABASE_URL}/auth/v1/**`, route => {
    const path = new URL(route.request().url()).pathname
    route.fulfill({ json: path.endsWith('/user') ? session.user : session })
  })
  await page.route(`${SUPABASE_URL}/rest/v1/**`, route => route.fulfill({ json: [] }))
  await page.route(`${SUPABASE_URL}/rest/v1/principal_profiles**`, route => route.fulfill({
    json: {
      id: ADMIN_ID,
      username: 'stub-admin',
      email: 'admin@stub.local',
      role: 'admin',
      status: 'active',
      max_agent_instances: 5,
    },
  }))

  await page.route(`**/api/instances/${instanceId}/backups`, route => route.fulfill({
    json: { success: true, items: [] },
  }))
  await page.route(`**/api/instances/${instanceId}/preview-session`, route => {
    previewSessions += 1
    expect(route.request().method()).toBe('POST')
    expect(route.request().headers().authorization).toBe('Bearer admin-access-token')
    if (!previewAvailable) {
      return route.fulfill({
        status: 409,
        json: { success: false, error: 'Native Agent UI preview is unavailable' },
      })
    }
    route.fulfill({
      json: {
        success: true,
        previewUrl: previewSessionUrl(String(previewSessions).padStart(24, 'a')),
      },
    })
  })
  await page.route(`**/api/instances/${instanceId}`, route => route.fulfill({
    json: { success: true, instance: instanceFixture(instanceId, name, agentTypeCode) },
  }))
  await page.route('**/api/models', route => route.fulfill({
    json: { success: true, models: [] },
  }))
  await page.route(`${nativeUrl.origin}${nativeUrl.pathname}**`, route => {
    nativeUiLoads += 1
    const requestUrl = new URL(route.request().url())
    const match = requestUrl.pathname.match(/^(\/_preview\/[A-Za-z0-9_-]{24})(?:\/.*)?$/)
    const proxyBasePath = match?.[1] || '/_preview/invalid'
    const bootstrap = buildNativeAgentUiPreviewBootstrap({ proxyBasePath })
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><script>${bootstrap}</script></head><body style="margin:0;background:#111827;color:white;font-family:sans-serif"><main data-testid="openclaw-native-content" style="padding:32px"><h1>${name} Native UI</h1><p data-testid="native-path">${requestUrl.pathname}</p><a data-testid="native-skills-link" href="/skills">Skills</a><button data-testid="native-reload" onclick="location.reload()">Reload</button></main></body></html>`,
    })
  })

  return {
    getNativeUiLoads: () => nativeUiLoads,
    getPreviewSessions: () => previewSessions,
    consoleErrors,
    failedRequests,
  }
}

test.describe('native Agent UI preview', () => {
  test('opens the full native UI in an immersive Manager workspace and supports refresh and back', async ({ page }) => {
    const stubs = await setupStubs(page)

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/admin/instances/${INSTANCE_ID}`)
    const accessSection = page.getByTestId('instance-app-access')
    await expect(accessSection.getByText('应用访问链接', { exact: true })).toBeVisible()
    await expect(accessSection.getByTestId('instance-e2b-host'))
      .toHaveText('18789-sbx-native.agent-vpc.internal')
    await expect(accessSection.getByText('47.238.91.225:8080')).toHaveCount(0)
    await expect(accessSection.getByTestId('native-agent-ui-open')).toContainText('进入工作台')
    await expect(page.getByText('runtime-token')).toHaveCount(0)
    await accessSection.getByTestId('native-agent-ui-open').click()

    await expect(page).toHaveURL(new RegExp(`/admin/instances/${INSTANCE_ID}/native-ui$`))
    await expect(page.getByText('Agent Manager', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'OpenClaw 工作台' })).toBeVisible()
    await expect(page.getByTestId('native-agent-ui-toolbar')).toBeVisible()
    await expect(page.getByRole('link', { name: '仪表盘' })).toHaveCount(0)
    const frame = page.frameLocator('[data-testid="native-agent-ui-frame"]')
    await expect(page.getByTestId('native-agent-ui-frame'))
      .toHaveAttribute('src', previewSessionUrl('aaaaaaaaaaaaaaaaaaaaaaa1'))
    await expect(frame.getByTestId('openclaw-native-content')).toContainText('OpenClaw Native UI')
    await expect.poll(stubs.getNativeUiLoads).toBe(1)
    await expect.poll(stubs.getPreviewSessions).toBe(1)

    const desktopFrameBox = await page.getByTestId('native-agent-ui-frame').boundingBox()
    expect(desktopFrameBox?.width).toBeGreaterThanOrEqual(1438)
    expect(desktopFrameBox?.height).toBeGreaterThanOrEqual(850)

    await page.getByTestId('native-agent-ui-refresh').click()
    await expect.poll(stubs.getNativeUiLoads).toBe(2)
    await expect.poll(stubs.getPreviewSessions).toBe(2)
    await expect(page.getByTestId('native-agent-ui-frame'))
      .toHaveAttribute('src', previewSessionUrl('aaaaaaaaaaaaaaaaaaaaaaa2'))
    await expect(frame.getByTestId('openclaw-native-content')).toContainText('/')

    await page.setViewportSize({ width: 390, height: 844 })
    const mobileFrameBox = await page.getByTestId('native-agent-ui-frame').boundingBox()
    expect(mobileFrameBox?.width).toBeGreaterThanOrEqual(388)
    expect(mobileFrameBox?.height).toBeGreaterThanOrEqual(794)
    await expect.poll(() => page.evaluate(() => (
      document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2
    ))).toBe(true)

    await page.getByTestId('native-agent-ui-back').click()
    await expect(page).toHaveURL(new RegExp(`/admin/instances/${INSTANCE_ID}$`))
    expect(stubs.consoleErrors).toEqual([])
    expect(stubs.failedRequests).toEqual([])
  })

  test('shows only the Agent entry in the user view', async ({ page }) => {
    await setupStubs(page)

    await page.goto(`/user/instances/${INSTANCE_ID}`)

    const accessSection = page.getByTestId('instance-app-access')
    await expect(accessSection.getByTestId('native-agent-ui-open')).toContainText('进入工作台')
    await expect(accessSection.getByTestId('instance-e2b-host')).toHaveCount(0)
    await expect(accessSection.getByText('应用访问链接', { exact: true })).toHaveCount(0)
    await expect(accessSection.getByText('18789-sbx-native.agent-vpc.internal')).toHaveCount(0)
  })

  test('shows the workspace entry for a configured custom Agent', async ({ page }) => {
    await setupStubs(page, { name: 'Custom Agent', agentTypeCode: 'custom-agent' })

    await page.goto(`/admin/instances/${INSTANCE_ID}`)

    await expect(page.getByTestId('native-agent-ui-open')).toContainText('进入工作台')
  })

  test('hides the native UI entry when the feature flag is disabled', async ({ page }) => {
    await setupStubs(page, { nativeUiEnabled: false })

    await page.goto(`/admin/instances/${INSTANCE_ID}`)

    await expect(page.getByTestId('native-agent-ui-open')).toHaveCount(0)
  })

  test('shows an error when preview access is unavailable', async ({ page }) => {
    await setupStubs(page, { previewAvailable: false })

    await page.goto(`/admin/instances/${INSTANCE_ID}/native-ui`)

    await expect(page.getByTestId('native-agent-ui-error')).toBeVisible()
    await expect(page.getByTestId('native-agent-ui-frame')).toHaveCount(0)
    await expect(page.getByTestId('native-agent-ui-refresh')).toBeDisabled()
  })

  test('keeps the preview key across Agent navigation and full-page reload', async ({ page }) => {
    const stubs = await setupStubs(page)
    await page.goto(`/admin/instances/${INSTANCE_ID}/native-ui`)

    const frame = page.frameLocator('[data-testid="native-agent-ui-frame"]')
    await expect(frame.getByTestId('openclaw-native-content')).toBeVisible()
    await frame.getByTestId('native-skills-link').click()
    await expect.poll(stubs.getNativeUiLoads).toBe(2)
    await expect(frame.getByTestId('native-path')).toContainText('/skills')

    await frame.getByTestId('native-reload').click()
    await expect.poll(stubs.getNativeUiLoads).toBe(3)
    await expect(frame.getByTestId('openclaw-native-content')).toBeVisible()
    await expect.poll(stubs.getPreviewSessions).toBe(1)
    expect(stubs.failedRequests).toEqual([])
  })

})
