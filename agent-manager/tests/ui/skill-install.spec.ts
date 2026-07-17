import { expect, test, type Page } from '@playwright/test'

test.describe.configure({ timeout: 150_000 })

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '33333333-3333-4333-8333-333333333333'
const SUPABASE_URL = 'https://stub.supabase.local'
const STORAGE_KEY = 'sb-stub-auth-token'

const officialSkills = [
  { skillId: 'official-one', skillName: 'UI/UX 设计大师', skillDescription: '专业 UI/UX 设计智能助手', skillSpaceId: 'official', skillLabels: ['category:frontend-development'] },
  { skillId: 'official-two', skillName: '代码质量助手', skillDescription: '代码质量检查和测试建议', skillSpaceId: 'official', skillLabels: ['category:code-quality-testing'] },
]

const privateSkills = [
  { skillId: 'private-one', skillName: '团队设计规范', skillDescription: '团队内部设计规范', skillSpaceId: 'ss-team', skillLabels: [] },
  { skillId: 'private-two', skillName: '发布检查清单', skillDescription: '团队发布前检查清单', skillSpaceId: 'ss-team', skillLabels: [] },
]

function nowIso() {
  return new Date().toISOString()
}

function sessionFixture() {
  return {
    access_token: 'user-access-token',
    refresh_token: 'refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: {
      id: USER_ID,
      aud: 'authenticated',
      role: 'authenticated',
      email: 'user@stub.local',
      app_metadata: { provider: 'email' },
      user_metadata: { name: 'Stub User' },
      created_at: nowIso(),
      updated_at: nowIso(),
    },
  }
}

function instanceFixture() {
  return {
    id: INSTANCE_ID,
    principal_id: USER_ID,
    name: '设计 Agent',
    description: 'skill install ui fixture',
    status: 'running',
    sandbox_id: 'default--skill-install-agent',
    sandboxStatus: 'running',
    sandboxUrl: null,
    hostsEntries: null,
    total_tokens_used: 0,
    created_at: nowIso(),
    last_active_at: nowIso(),
    config_json: {},
    // Online installation is independent from the instance creation-time
    // Skill snapshot. An empty snapshot must not hide spaces or instances.
    skill_config: [],
    agent_type_id: 'agent-type-openclaw',
    ai_models: { id: 'model-1', name: 'qwen-plus', provider: 'bailian' },
    agent_type: {
      id: 'agent-type-openclaw',
      code: 'openclaw',
      name: 'OpenClaw',
      sandbox_template_id: 'agent-manager-openclaw',
      supports_channels: false,
      supports_modify_model: false,
      supports_modify_channel: false,
      // supports_skills only controls Agent Type Skill configuration. Keeping
      // it false proves that market download and instance installation remain available.
      supports_skills: false,
      user_terminal_enabled: true,
    },
    sandbox_upgrade: null,
    instance_channel_configs: [],
  }
}

async function setupStubs(page: Page, {
  role = 'user',
  officialSkillsFixture = officialSkills,
  installError = null,
}: {
  role?: 'user' | 'admin'
  officialSkillsFixture?: typeof officialSkills
  installError?: { code: string; error: string } | null
} = {}) {
  const session = sessionFixture()
  const installBodies: unknown[] = []
  const runtimeIssues: string[] = []

  page.on('console', message => {
    if (message.type() === 'error') runtimeIssues.push(`console: ${message.text()}`)
  })
  page.on('pageerror', error => runtimeIssues.push(`pageerror: ${error.message}`))
  page.on('requestfailed', request => {
    runtimeIssues.push(`requestfailed: ${request.method()} ${new URL(request.url()).pathname}`)
  })

  // Production serves env-config.js before the Vite bundle. Intercept it so
  // deployed-bundle tests keep the same isolated Supabase fixture as local Vite.
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
    json: { id: USER_ID, username: 'stub-user', email: 'user@stub.local', role, status: 'active', max_agent_instances: 5 },
  }))

  await page.route('**/api/skill-hub-config', route => route.fulfill({
    json: { success: true, configured: true, hubConfig: { ossBucketName: 'stub-bucket', ossRegionId: 'cn-hangzhou' } },
  }))
  await page.route('**/api/official-skills?**', route => route.fulfill({
    json: { success: true, skills: officialSkillsFixture, nextToken: null, totalCount: officialSkillsFixture.length },
  }))
  await page.route('**/api/skill-spaces?**', route => route.fulfill({
    json: { success: true, skillSpaces: [{ skillSpaceId: 'ss-team', skillSpaceName: '团队 Skills', skillSpaceDescription: '团队私有 Skill 空间' }], nextToken: null, totalCount: 1 },
  }))
  await page.route('**/api/skill-spaces/ss-team/skills?**', route => route.fulfill({
    json: { success: true, skills: privateSkills, nextToken: null, totalCount: privateSkills.length },
  }))
  await page.route('**/api/instances?**', route => route.fulfill({
    json: { success: true, instances: [instanceFixture()], pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 } },
  }))
  await page.route('**/api/admin/instances?**', route => route.fulfill({
    json: { success: true, instances: [instanceFixture()], pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 } },
  }))
  await page.route(`**/api/instances/${INSTANCE_ID}`, route => route.fulfill({ json: { success: true, instance: instanceFixture() } }))
  await page.route(`**/api/instances/${INSTANCE_ID}/backups`, route => route.fulfill({ json: { success: true, items: [] } }))
  await page.route('**/api/models', route => route.fulfill({ json: { success: true, models: [] } }))

  await page.route(`**/api/instances/${INSTANCE_ID}/install-skills`, async route => {
    const body = route.request().postDataJSON()
    installBodies.push(body)
    if (installError) {
      await route.fulfill({
        status: 409,
        json: { success: false, ...installError },
      })
      return
    }
    route.fulfill({
      json: {
        success: true,
        results: body.skills.map((skill: { skillId: string }) => ({
          skillId: skill.skillId,
          status: 'succeeded',
          errorCode: null,
          errorMessage: null,
        })),
      },
    })
  })

  return { installBodies, runtimeIssues }
}

test('用户 Skill 市场可选择运行中实例并安装官方 Skill', async ({ page }, testInfo) => {
  const { installBodies, runtimeIssues } = await setupStubs(page)
  await page.goto('/user/skill-market', { waitUntil: 'domcontentloaded', timeout: 90_000 })

  await expect(page.getByRole('heading', { name: 'Skill 市场', level: 2 })).toBeVisible()
  await expect(page.getByTitle('UI/UX 设计大师')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('user-skill-market.png'), fullPage: true })
  await page.getByRole('button', { name: '安装到实例' }).first().click()
  await expect(page.getByRole('heading', { name: '选择目标实例' })).toBeVisible()
  await page.getByRole('button', { name: /设计 Agent/ }).click()
  await page.screenshot({ path: testInfo.outputPath('market-target-instance.png'), fullPage: true })
  await page.getByRole('button', { name: '安装', exact: true }).click()

  await expect(page.getByText('安装成功')).toBeVisible()
  expect(installBodies).toEqual([{ skills: [{ skillId: 'official-one' }] }])
  expect(runtimeIssues).toEqual([])
})

test('实例详情可在同一个 Skill 空间多选安装', async ({ page }, testInfo) => {
  const { installBodies, runtimeIssues } = await setupStubs(page)
  await page.goto(`/user/instances/${INSTANCE_ID}`, { waitUntil: 'domcontentloaded', timeout: 90_000 })

  await expect(page.getByRole('button', { name: '安装 Skill' })).toBeVisible()
  await page.getByRole('button', { name: '安装 Skill' }).click()
  await expect(page.getByRole('heading', { name: '选择 Skill' })).toBeVisible()
  await page.getByRole('button', { name: 'Skill 空间' }).click()
  await expect(page.getByText('团队设计规范')).toBeVisible()
  await page.getByRole('button', { name: /团队设计规范/ }).click()
  await page.getByRole('button', { name: /发布检查清单/ }).click()
  await expect(page.getByText('已选择 2 个')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('instance-skill-space-picker.png'), fullPage: true })
  await page.getByRole('button', { name: '安装', exact: true }).click()

  await expect(page.getByText('安装成功')).toHaveCount(2)
  expect(installBodies).toEqual([{
    skills: [
      { skillId: 'private-one', skillSpaceId: 'ss-team' },
      { skillId: 'private-two', skillSpaceId: 'ss-team' },
    ],
  }])
  expect(runtimeIssues).toEqual([])
})

test('实例镜像缺少安装工具时弹出服务端错误', async ({ page }) => {
  const error = '当前 Agent 镜像未预装可用的 Skill 安装工具，请升级到支持 Skill 的镜像，或基于官方 Dockerfile 重新构建镜像'
  const { runtimeIssues } = await setupStubs(page, {
    installError: { code: 'SKILL_CLI_UNAVAILABLE', error },
  })
  await page.goto(`/user/instances/${INSTANCE_ID}`, { waitUntil: 'domcontentloaded', timeout: 90_000 })

  await page.getByRole('button', { name: '安装 Skill' }).click()
  await page.getByRole('button', { name: /UI\/UX 设计大师/ }).click()
  await page.getByRole('button', { name: '安装', exact: true }).click()

  await expect(page.getByRole('status').getByText(error)).toBeVisible()
  await expect(page.getByText(error)).toHaveCount(2)
  expect(runtimeIssues).toEqual(['console: Failed to load resource: the server responded with a status of 409 (Conflict)'])
})

test('Skill 市场安装失败时弹出服务端错误', async ({ page }) => {
  const error = '当前 Agent 镜像未预装可用的 Skill 安装工具，请升级到支持 Skill 的镜像，或基于官方 Dockerfile 重新构建镜像'
  const { runtimeIssues } = await setupStubs(page, {
    installError: { code: 'SKILL_CLI_UNAVAILABLE', error },
  })
  await page.goto('/user/skill-market', { waitUntil: 'domcontentloaded', timeout: 90_000 })

  await page.getByRole('button', { name: '安装到实例' }).first().click()
  await page.getByRole('button', { name: /设计 Agent/ }).click()
  await page.getByRole('button', { name: '安装', exact: true }).click()

  await expect(page.getByRole('status').getByText(error)).toBeVisible()
  await expect(page.getByText(error)).toHaveCount(2)
  expect(runtimeIssues).toEqual(['console: Failed to load resource: the server responded with a status of 409 (Conflict)'])
})

test('实例详情最多选择 10 个 Skill', async ({ page }) => {
  const limitSkills = Array.from({ length: 12 }, (_, index) => ({
    skillId: `limit-${index + 1}`,
    skillName: `限额 Skill ${String(index + 1).padStart(2, '0')}`,
    skillDescription: '用于验证批量安装上限',
    skillSpaceId: 'official',
    skillLabels: [],
  }))
  const { installBodies, runtimeIssues } = await setupStubs(page, { officialSkillsFixture: limitSkills })
  await page.goto(`/user/instances/${INSTANCE_ID}`, { waitUntil: 'domcontentloaded', timeout: 90_000 })

  await page.getByRole('button', { name: '安装 Skill' }).click()
  await expect(page.getByText('限额 Skill 01')).toBeVisible()
  await page.getByRole('button', { name: '全选' }).click()

  await expect(page.getByText('已选择 10 个')).toBeVisible()
  await expect(page.getByText('每次最多安装 10 个 Skill').first()).toBeVisible()
  await page.getByRole('button', { name: /限额 Skill 11/ }).click()
  await expect(page.getByText('已选择 10 个')).toBeVisible()

  await page.getByRole('button', { name: '安装', exact: true }).click()
  await expect(page.getByText('安装成功')).toHaveCount(10)
  expect(installBodies).toHaveLength(1)
  expect((installBodies[0] as { skills: unknown[] }).skills).toHaveLength(10)
  expect(runtimeIssues).toEqual([])
})

test('服务商 Skill 市场可安装官方 Skill 到目标实例', async ({ page }) => {
  const { installBodies, runtimeIssues } = await setupStubs(page, { role: 'admin' })
  await page.goto('/admin/skill-spaces', { waitUntil: 'domcontentloaded', timeout: 90_000 })

  await expect(page.getByRole('heading', { name: 'Skill 市场', level: 2 })).toBeVisible()
  await page.getByTitle('UI/UX 设计大师').hover()
  await page.getByRole('button', { name: '安装到实例' }).first().click()
  await page.getByRole('button', { name: /设计 Agent/ }).click()
  await page.getByRole('button', { name: '安装', exact: true }).click()

  await expect(page.getByText('安装成功')).toBeVisible()
  expect(installBodies).toEqual([{ skills: [{ skillId: 'official-one' }] }])
  expect(runtimeIssues).toEqual([])
})
