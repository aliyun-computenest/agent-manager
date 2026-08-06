import { expect, test, type Page } from '@playwright/test'

const USER_ID = '22222222-2222-4222-8222-222222222222'
const SUPABASE_URL = 'https://stub.supabase.local'
const STORAGE_KEY = 'sb-stub-auth-token'

function sessionFixture() {
  const now = new Date().toISOString()
  return {
    access_token: 'admin-access-token',
    refresh_token: 'refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: {
      id: USER_ID,
      aud: 'authenticated',
      role: 'authenticated',
      email: 'admin@stub.local',
      app_metadata: { provider: 'email' },
      user_metadata: { name: 'Stub Admin' },
      created_at: now,
      updated_at: now,
    },
  }
}

async function setupStubs(page: Page) {
  const session = sessionFixture()
  const createBodies: Record<string, unknown>[] = []
  const runtimeIssues: string[] = []

  page.on('console', message => {
    if (message.type() === 'error') runtimeIssues.push(`console: ${message.text()}`)
  })
  page.on('pageerror', error => runtimeIssues.push(`pageerror: ${error.message}`))
  page.on('requestfailed', request => runtimeIssues.push(`requestfailed: ${request.method()} ${new URL(request.url()).pathname}`))

  await page.route('**/env-config.js', route => route.fulfill({
    contentType: 'application/javascript',
    body: `window.__ENV__ = ${JSON.stringify({
      VITE_SUPABASE_URL: SUPABASE_URL,
      VITE_SUPABASE_ANON_KEY: 'test-anon-key',
      VITE_API_URL: '',
    })};`,
  }))

  await page.addInitScript(({ storageKey, sessionPayload, supabaseUrl }) => {
    localStorage.setItem(storageKey, JSON.stringify(sessionPayload))
    localStorage.setItem('i18nextLng', 'zh-CN')
    ;(window as unknown as { __ENV__?: Record<string, string> }).__ENV__ = {
      VITE_SUPABASE_URL: supabaseUrl,
      VITE_SUPABASE_ANON_KEY: 'test-anon-key',
      VITE_API_URL: '',
    }
  }, { storageKey: STORAGE_KEY, sessionPayload: session, supabaseUrl: SUPABASE_URL })

  await page.route(`${SUPABASE_URL}/auth/v1/**`, route => {
    const path = new URL(route.request().url()).pathname
    route.fulfill({ json: path.endsWith('/user') ? session.user : session })
  })
  await page.route(`${SUPABASE_URL}/rest/v1/**`, route => route.fulfill({ json: [] }))
  await page.route(`${SUPABASE_URL}/rest/v1/principal_profiles**`, route => route.fulfill({
    json: { id: USER_ID, username: 'stub-admin', email: 'admin@stub.local', role: 'admin', status: 'active' },
  }))

  await page.route('**/api/**', route => route.fulfill({ json: { success: true } }))
  await page.route('**/api/agent-types', async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      createBodies.push(body)
      await route.fulfill({ json: { success: true, agentType: { id: 'agent-type-created', ...body } } })
      return
    }
    await route.fulfill({ json: { success: true, agentTypes: [] } })
  })
  await page.route('**/api/sandboxsets**', route => route.fulfill({ json: { success: true, items: [] } }))

  return { createBodies, runtimeIssues }
}

test('submits the configured Skill install path when creating an Agent Type', async ({ page }) => {
  const { createBodies, runtimeIssues } = await setupStubs(page)
  await page.goto('/admin/agent-types')

  await expect(page.getByRole('heading', { name: 'Agent 配置管理', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '新增 Agent 配置' }).click()
  await page.getByPlaceholder('例如: my-agent').fill('custom-skill-agent')
  await page.getByPlaceholder('例如: 我的 Agent').fill('Custom Skill Agent')

  const skillPath = page.getByPlaceholder('例如: /home/node/.agents/skills')
  await expect(skillPath).toHaveValue('/home/node/.agents/skills')
  await skillPath.fill('/opt/custom-agent/skills')
  await page.getByRole('button', { name: '创建', exact: true }).click()

  await expect.poll(() => createBodies.length).toBe(1)
  expect(createBodies[0].skillPath).toBe('/opt/custom-agent/skills')
  expect(runtimeIssues).toEqual([])
})
