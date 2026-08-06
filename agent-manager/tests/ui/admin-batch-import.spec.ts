import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const adminEmail = process.env.OPENCLAW_ADMIN_EMAIL || 'e2e-admin-fwx1y2@openclaw.local'
const adminPassword = process.env.OPENCLAW_ADMIN_PASSWORD || 'admin123'

function sanitizeFileName(value: string) {
  return value.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase()
}

async function saveStepScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const filePath = testInfo.outputPath(`screenshots/${sanitizeFileName(name)}.png`)
  await mkdir(dirname(filePath), { recursive: true })
  await page.screenshot({ fullPage: true, path: filePath })
  return filePath
}

async function waitForUsersLoaded(page: Page) {
  await page.waitForURL(/\/admin\/(dashboard|users)/)
  await expect(page.getByRole('link', { name: '用户管理' })).toBeVisible()
  await page.getByRole('link', { name: '用户管理' }).click()
  await page.waitForURL(/\/admin\/users/)
  await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible()
  await expect(page.getByRole('button', { name: '批量导入' })).toBeVisible()
}

async function openBatchModal(page: Page) {
  await page.getByRole('button', { name: '批量导入' }).click()
  await expect(page.getByRole('heading', { name: '批量导入用户' })).toBeVisible()
  return page.locator('div').filter({ has: page.getByRole('heading', { name: '批量导入用户' }) }).last()
}

async function searchUser(page: Page, email: string) {
  const searchInput = page.getByPlaceholder('搜索用户...')
  await searchInput.fill(email)
  await expect(page.getByText(email)).toBeVisible({ timeout: 10_000 })
}

async function saveFailureContext(
  page: Page,
  context: BrowserContext,
  testInfo: TestInfo,
  dialogs: string[],
  consoleMessages: string[],
  pageErrors: string[],
) {
  await writeFile(testInfo.outputPath('failure-page.html'), await page.content(), 'utf-8')
  await context.storageState({ path: testInfo.outputPath('storage-state.json') })
  await writeFile(testInfo.outputPath('console.log'), consoleMessages.join('\n'), 'utf-8')
  await writeFile(testInfo.outputPath('page-errors.log'), pageErrors.join('\n'), 'utf-8')
  await writeFile(testInfo.outputPath('dialogs.json'), JSON.stringify(dialogs, null, 2), 'utf-8')
}

test('管理员批量导入用户回归', async ({ page, context }, testInfo) => {
  test.slow()

  const unique = Date.now().toString()
  const csvEmail = `browser-csv-${unique}@example.com`
  const jsonEmail = `browser-json-${unique}@openclaw.local`
  const duplicateEmail = `browser-duplicate-${unique}@example.com`
  const dialogs: string[] = []
  const consoleMessages: string[] = []
  const pageErrors: string[] = []
  const screenshots: string[] = []

  page.setDefaultTimeout(30_000)

  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message())
    await dialog.accept()
  })

  page.on('console', (message) => {
    consoleMessages.push(`[${message.type()}] ${message.text()}`)
  })

  page.on('pageerror', (error) => {
    pageErrors.push(error.message)
  })

  try {
    await test.step('打开首页并进入管理员登录页', async () => {
      await page.goto('/', { waitUntil: 'networkidle' })
      screenshots.push(await saveStepScreenshot(page, testInfo, '01-homepage'))
      await page.getByRole('button', { name: '管理员登录' }).click()
      await page.waitForURL(/\/admin\/login/)
      screenshots.push(await saveStepScreenshot(page, testInfo, '02-admin-login'))
    })

    await test.step('管理员登录并进入用户管理页', async () => {
      await page.getByPlaceholder('管理员邮箱').fill(adminEmail)
      await page.getByPlaceholder('密码').fill(adminPassword)
      await page.locator('form').getByRole('button', { name: '登录', exact: true }).click()
      await expect(page).toHaveURL(/\/admin\/(dashboard|users)/)
      await waitForUsersLoaded(page)
      screenshots.push(await saveStepScreenshot(page, testInfo, '03-user-management'))
    })

    await test.step('通过文件上传执行 CSV 导入', async () => {
      const modal = await openBatchModal(page)
      const csvPayload = [
        'email,password,username,role,maxInstances,authProvider',
        `${csvEmail},Test123456!,BrowserCsvUser,user,5,email`,
      ].join('\n')

      await modal.locator('input[type="file"]').setInputFiles({
        name: 'batch-import.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(csvPayload, 'utf-8'),
      })
      screenshots.push(await saveStepScreenshot(page, testInfo, '04-csv-upload-ready'))

      await modal.getByRole('button', { name: '开始导入' }).click()
      await expect(page.getByText('导入结果')).toBeVisible()
      await expect(page.getByText('总数: 1')).toBeVisible()
      await expect(page.getByText('成功: 1')).toBeVisible()
      await expect(page.getByText('失败: 0')).toBeVisible()
      screenshots.push(await saveStepScreenshot(page, testInfo, '05-csv-import-result'))

      await modal.getByRole('button', { name: '关闭' }).click()
      await searchUser(page, csvEmail)
      screenshots.push(await saveStepScreenshot(page, testInfo, '06-csv-search-verified'))
    })

    await test.step('通过 JSON 粘贴执行 SAML 导入', async () => {
      const modal = await openBatchModal(page)
      const jsonPayload = JSON.stringify(
        [
          {
            email: jsonEmail,
            username: 'BrowserJsonSaml',
            role: 'user',
            maxInstances: 5,
            authProvider: 'saml',
          },
        ],
        null,
        2,
      )

      await modal.locator('textarea').fill(jsonPayload)
      screenshots.push(await saveStepScreenshot(page, testInfo, '07-json-payload-ready'))

      await modal.getByRole('button', { name: '开始导入' }).click()
      await expect(page.getByText('导入结果')).toBeVisible()
      await expect(page.getByText('总数: 1')).toBeVisible()
      await expect(page.getByText('成功: 1')).toBeVisible()
      await expect(page.getByText('失败: 0')).toBeVisible()
      screenshots.push(await saveStepScreenshot(page, testInfo, '08-json-import-result'))

      await modal.getByRole('button', { name: '关闭' }).click()
      await searchUser(page, jsonEmail)
      screenshots.push(await saveStepScreenshot(page, testInfo, '09-json-search-verified'))
    })

    await test.step('验证重复导入的部分失败结果', async () => {
      const modal = await openBatchModal(page)
      const duplicatePayload = [
        'email,password,username,role,maxInstances,authProvider',
        `${duplicateEmail},Test123456!,BrowserDuplicateUser,user,5,email`,
        `${duplicateEmail},Test123456!,BrowserDuplicateUser,user,5,email`,
      ].join('\n')

      await modal.locator('textarea').fill(duplicatePayload)
      await modal.getByRole('button', { name: '开始导入' }).click()
      await expect(page.getByText('总数: 2')).toBeVisible()
      await expect(page.getByText('成功: 1')).toBeVisible()
      await expect(page.getByText('失败: 1')).toBeVisible()
      await expect(page.getByText('失败详情:')).toBeVisible()
      screenshots.push(await saveStepScreenshot(page, testInfo, '10-duplicate-import-result'))
    })
  } catch (error) {
    await saveFailureContext(page, context, testInfo, dialogs, consoleMessages, pageErrors)
    throw error
  } finally {
    await writeFile(
      testInfo.outputPath('summary.json'),
      JSON.stringify(
        {
          adminEmail,
          csvEmail,
          jsonEmail,
          duplicateEmail,
          dialogs,
          screenshots,
          consoleMessages,
          pageErrors,
        },
        null,
        2,
      ),
      'utf-8',
    )
  }
})