import { expect, test, type Page } from '@playwright/test'

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111'
const INSTANCE_ID_2 = '22222222-2222-4222-8222-222222222222'
const RESTORED_INSTANCE_ID = '44444444-4444-4444-8444-444444444444'
const USER_ID = '33333333-3333-4333-8333-333333333333'
const SUPABASE_URL = 'https://stub.supabase.local'
const STORAGE_KEY = 'sb-stub-auth-token'

function nowIso(offsetSec = 0) {
  return new Date(Date.now() + offsetSec * 1000).toISOString()
}

function fakeSession(role: 'admin' | 'user' = 'admin') {
  return {
    access_token: `${role}-access-token`,
    refresh_token: 'test-refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: {
      id: USER_ID,
      aud: 'authenticated',
      role: 'authenticated',
      email: `${role}@stub.local`,
      app_metadata: { provider: 'email' },
      user_metadata: { name: role === 'admin' ? 'Stub Admin' : 'Stub User' },
      created_at: nowIso(-3600),
      updated_at: nowIso(),
    },
  }
}

function instanceFixture(id = INSTANCE_ID, name = '测试实例') {
  return {
    id,
    principal_id: USER_ID,
    name,
    description: 'checkpoint backup ui fixture',
    status: 'running',
    sandbox_id: `default--sandbox-${id.slice(0, 8)}`,
    sandboxStatus: 'running',
    hostsEntries: null,
    total_tokens_used: 0,
    created_at: nowIso(-3600),
    last_active_at: nowIso(-60),
    config_json: {},
    agent_image: 'stub-image:latest',
    agent_version: 'v0.0.1',
    agent_type_id: 'agent-type-openclaw',
    ai_models: { id: 'm-1', name: 'qwen3.5-plus', provider: 'bailian' },
    agent_type: {
      id: 'agent-type-openclaw',
      code: 'openclaw',
      name: 'OpenClaw',
      sandbox_template_id: 'agent-manager-openclaw',
      supports_channels: false,
      supports_modify_model: false,
      supports_modify_channel: false,
      user_terminal_enabled: true,
    },
    group: { id: 'group-prod', name: '生产分组' },
    sandbox_upgrade: null,
    instance_channel_configs: [],
    username: 'stub-user',
  }
}

function restoringInstanceFixture() {
  return {
    ...instanceFixture(RESTORED_INSTANCE_ID, '测试实例-backup-abcd12'),
    status: 'starting',
    sandbox_id: null,
    sandboxStatus: null,
    config_json: {
      checkpointRestore: {
        backupId: 'ocb-11111111-ready',
        sourceInstanceId: INSTANCE_ID,
        status: 'restoring',
        startedAt: nowIso(-10),
      },
    },
  }
}

async function setupStubs(page: Page, role: 'admin' | 'user' = 'admin') {
  const session = fakeSession(role)
  const createInstanceBodies: unknown[] = []
  const executions = [
    {
      executionId: 'exec-scheduled-001',
      oosRegionId: 'cn-hongkong',
      runMode: 'scheduled',
      scope: 'all',
      cronExpression: 'cron(0 0 3 * * ? *)',
      retentionCount: 5,
      status: 'Running',
      nextRunAt: '2026-06-24T03:00:00Z',
      startedAt: '2026-06-23T03:00:00Z',
      message: '16 成功 / 1 跳过 / 0 失败',
    },
  ]

  await page.addInitScript(
    ({ storageKey, sessionPayload, supabaseUrl }) => {
      localStorage.setItem(storageKey, JSON.stringify(sessionPayload))
      localStorage.setItem('i18nextLng', 'zh-CN')
      ;(window as unknown as { __ENV__?: Record<string, string> }).__ENV__ = {
        VITE_SUPABASE_URL: supabaseUrl,
        VITE_SUPABASE_ANON_KEY: 'test-anon-key',
        VITE_API_URL: '',
        VITE_OOS_CONSOLE_BASE_URL: 'https://oos.console.aliyun.com',
        VITE_OOS_REGION_ID: 'cn-hangzhou',
      }
    },
    {
      storageKey: STORAGE_KEY,
      sessionPayload: session,
      supabaseUrl: SUPABASE_URL,
    },
  )

  await page.route(`${SUPABASE_URL}/auth/v1/**`, (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/user')) {
      route.fulfill({ json: session.user })
      return
    }
    if (url.pathname.endsWith('/token')) {
      route.fulfill({ json: session })
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
        id: USER_ID,
        username: role === 'admin' ? 'stub-admin' : 'stub-user',
        email: `${role}@stub.local`,
        role,
        status: 'active',
        max_agent_instances: 5,
      },
    })
  })

  await page.route('**/api/admin/backups/executions?**', (route) => {
    route.fulfill({ json: { success: true, items: executions, nextToken: null } })
  })

  await page.route('**/api/admin/backups/executions', async (route) => {
    if (route.request().method() === 'GET') {
      route.fulfill({ json: { success: true, items: executions, nextToken: null } })
      return
    }
    executions.unshift({
      executionId: 'mock-oos-execution-created',
      oosRegionId: 'cn-hongkong',
      runMode: 'immediate',
      scope: 'instances:11111111-1111-4111-8111-111111111111',
      cronExpression: null,
      retentionCount: 5,
      status: 'Success',
      nextRunAt: null,
      startedAt: nowIso(),
      message: '1 成功 / 0 跳过 / 0 失败',
    })
    route.fulfill({
      status: 201,
      json: {
        success: true,
        executionId: 'mock-oos-execution-created',
        runMode: 'immediate',
        targetCount: 1,
        skippedCount: 0,
      },
    })
  })

  await page.route('**/api/admin/backups/executions/*/records?**', (route) => {
    route.fulfill({
      json: {
        success: true,
        items: [
          { status: 'Success', startedAt: '2026-06-23T03:00:00Z', message: '16 成功 / 1 跳过 / 0 失败，清理 5 个旧备份' },
        ],
        nextToken: null,
      },
    })
  })

  await page.route('**/api/admin/instances?**', (route) => {
    route.fulfill({
      json: {
        success: true,
        instances: [instanceFixture(INSTANCE_ID, '测试实例'), instanceFixture(INSTANCE_ID_2, '测试实例 2')],
        pagination: { page: 1, pageSize: 100, total: 2, totalPages: 1 },
      },
    })
  })

  await page.route('**/api/instances?**', (route) => {
    route.fulfill({
      json: {
        success: true,
        instances: [instanceFixture()],
        pagination: { page: 1, pageSize: 10, total: 1, totalPages: 1 },
      },
    })
  })

  await page.route('**/api/instances', (route) => {
    if (route.request().method() === 'POST') {
      createInstanceBodies.push(route.request().postDataJSON())
      route.fulfill({
        status: 202,
        json: {
          success: true,
          instance: {
            id: RESTORED_INSTANCE_ID,
            name: '测试实例-backup-abcd12',
            sandboxId: null,
            status: 'starting',
            createdAt: nowIso(),
          },
        },
      })
      return
    }
    route.fallback()
  })

  await page.route('**/api/models', (route) => {
    route.fulfill({ json: { success: true, models: [] } })
  })

  await page.route('**/api/channel-templates**', (route) => {
    route.fulfill({ json: { success: true, templates: [] } })
  })

  await page.route(`**/api/instances/${INSTANCE_ID}`, (route) => {
    route.fulfill({ json: { success: true, instance: instanceFixture() } })
  })

  await page.route(`**/api/instances/${RESTORED_INSTANCE_ID}`, (route) => {
    route.fulfill({ json: { success: true, instance: restoringInstanceFixture() } })
  })

  await page.route(`**/api/instances/${INSTANCE_ID}/backups`, (route) => {
    if (route.request().method() === 'POST') {
      route.fulfill({
        status: 202,
        json: { success: true, backupId: 'ocb-11111111-20260701t100000z-abcd1234' },
      })
      return
    }
    route.fulfill({
      json: {
        success: true,
        items: [
          { backupId: 'ocb-11111111-ready', createdAt: '2026-06-23T03:00:00Z', status: 'Ready' },
        ],
        latestOperation: null,
      },
    })
  })

  return { createInstanceBodies }
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(async () => page.evaluate(() => (
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  ))).toBeLessThanOrEqual(2)
}

test.describe('checkpoint backup UI', () => {
  test('admin can browse and create backup executions', async ({ page }) => {
    await setupStubs(page, 'admin')

    await page.goto('/admin/backups')
    await expect(page.getByRole('main').getByRole('heading', { name: '实例备份' })).toBeVisible()
    await expectNoHorizontalOverflow(page)
    await expect(page.getByRole('tab', { name: /全部\s+1/ })).toBeVisible()
    await expect(page.getByRole('tab', { name: /周期执行\s+1/ })).toBeVisible()
    await expect(page.getByText('周期性重复执行')).toBeVisible()
    await expect(page.getByText('全部实例')).toBeVisible()
    await expect(page.getByText('16 成功 / 1 跳过 / 0 失败')).toBeVisible()
    await page.setViewportSize({ width: 420, height: 900 })
    await expect(page.getByRole('tablist', { name: '备份执行类型' })).toBeVisible()
    await expectNoHorizontalOverflow(page)
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.getByRole('tab', { name: /立即执行\s+0/ }).click()
    await expect(page.getByText('暂无立即执行备份执行')).toBeVisible()
    await page.getByRole('tab', { name: /周期执行\s+1/ }).click()
    await expect(page.getByText('exec-scheduled-001')).toBeVisible()

    await page.getByRole('button', { name: '查看' }).click()
    await expect(page).toHaveURL(/\/admin\/backups\/exec-scheduled-001$/)
    const popupPromise = page.waitForEvent('popup')
    await page.getByRole('button', { name: '查看详情' }).click()
    const popup = await popupPromise
    await popup.waitForLoadState('domcontentloaded')
    expect(decodeURIComponent(popup.url())).toContain('oos.console.aliyun.com/cn-hongkong/execution/detail/exec-scheduled-001')
    await popup.close()

    await page.getByRole('button', { name: '返回备份执行' }).click()
    await page.getByRole('button', { name: '创建备份执行' }).click()
    await expect(page).toHaveURL(/\/admin\/backups\/create$/)
    await page.getByLabel('周期性重复执行').check()
    await expect(page.locator('input[value="香港 / 北京时间 (UTC+8)"]')).toBeVisible()
    await expect(page.getByRole('link', { name: /Cron 帮助/ })).toHaveAttribute('href', /configure-cron-expressions/)
    await page.getByRole('button', { name: '执行计划预览' }).hover()
    await expect(page.locator('#cron-schedule-preview')).toBeVisible()
    await expect(page.locator('#cron-schedule-preview')).toContainText('cron(0 0 3 * * ? *)')
    await page.getByLabel('立即执行').check()
    await page.getByRole('button', { name: /部分实例/ }).click()
    await page.getByRole('button', { name: '选择实例' }).click()
    await page.getByRole('row', { name: new RegExp(`测试实例 ${INSTANCE_ID} OpenClaw 生产分组 运行中`) }).locator('input[type="checkbox"]').check()
    await page.getByRole('button', { name: '确认选择' }).click()
    await expect(page.getByText('已选择 1 个实例')).toBeVisible()
    await page.getByRole('button', { name: '创建备份执行' }).click()
    await expect(page).toHaveURL(/\/admin\/backups$/)
    await expect(page.getByRole('tab', { name: /全部\s+2/ })).toBeVisible()
    await expect(page.getByRole('tab', { name: /立即执行\s+1/ })).toBeVisible()
    await page.getByRole('tab', { name: /立即执行\s+1/ }).click()
    await expect(page.getByRole('table').getByText('立即执行')).toBeVisible()
    await expect(page.getByText('部分实例 · 1 个')).toBeVisible()
    await expect(page.getByText('1 成功 / 0 跳过 / 0 失败')).toBeVisible()
  })

  test('user backup starts only after confirmation', async ({ page }) => {
    await setupStubs(page, 'user')
    let postCount = 0
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith(`/api/instances/${INSTANCE_ID}/backups`)) {
        postCount += 1
      }
    })

    await page.goto(`/user/instances/${INSTANCE_ID}`)
    await page.getByRole('button', { name: '发起备份' }).click()
    await expect(page).toHaveURL(new RegExp(`/user/instances/${INSTANCE_ID}/backups/new$`))
    await page.getByRole('button', { name: '发起备份' }).click()
    await expect(page.getByRole('heading', { name: '确认发起备份' })).toBeVisible()
    expect(postCount).toBe(0)
    await page.getByRole('button', { name: '确认发起' }).click()
    await expect(page).toHaveURL(new RegExp(`/user/instances/${INSTANCE_ID}$`))
    expect(postCount).toBe(1)
  })

  test('user enters restored instance detail page with progress after creating from backup', async ({ page }) => {
    const stubs = await setupStubs(page, 'user')

    await page.goto(`/user/instances/${INSTANCE_ID}`)
    await page.getByRole('button', { name: '从备份创建' }).click()
    await expect(page.getByRole('heading', { name: '从备份创建新实例' })).toBeVisible()
    await expect(page.getByLabel('新实例名称')).toBeVisible()
    await page.getByLabel('新实例名称').fill('自定义恢复实例')
    await page.getByRole('button', { name: '创建新实例' }).click()

    await expect(page).toHaveURL(new RegExp(`/user/instances/${RESTORED_INSTANCE_ID}$`))
    expect(stubs.createInstanceBodies).toHaveLength(1)
    expect(stubs.createInstanceBodies[0]).toMatchObject({
      name: '自定义恢复实例',
      backupId: 'ocb-11111111-ready',
      async: true,
    })
    expect(stubs.createInstanceBodies[0]).not.toHaveProperty('sourceInstanceId')
    await expect(page.getByRole('heading', { name: '正在从备份恢复实例' })).toBeVisible()
    await expect(page.getByText('正在创建恢复用 Sandbox / Pod')).toBeVisible()
    await expect(page.getByText('ocb-11111111-ready')).not.toBeVisible()
    await page.reload()
    await expect(page.getByRole('heading', { name: '正在从备份恢复实例' })).toBeVisible()
    await expect(page.getByText('正在创建恢复用 Sandbox / Pod')).toBeVisible()
    await expect(page.getByText('ocb-11111111-ready')).not.toBeVisible()
    await expectNoHorizontalOverflow(page)
  })

  test('source instance keeps backup clone pending state after refresh', async ({ page }) => {
    await setupStubs(page, 'user')
    await page.addInitScript(({ instanceId }) => {
      localStorage.setItem(`openclaw:checkpoint-clone-pending:${instanceId}`, JSON.stringify({
        sourceInstanceId: instanceId,
        backupId: 'ocb-11111111-ready',
        startedAt: Date.now(),
      }))
    }, { instanceId: INSTANCE_ID })

    await page.goto(`/user/instances/${INSTANCE_ID}`)
    await expect(page.getByRole('button', { name: '创建中' })).toBeVisible()
    await expect(page.getByRole('button', { name: '创建中' })).toBeDisabled()

    await page.reload()
    await expect(page.getByRole('button', { name: '创建中' })).toBeVisible()
    await expect(page.getByRole('button', { name: '创建中' })).toBeDisabled()
    await expect(page.getByText('ocb-11111111-ready')).not.toBeVisible()
  })
})
