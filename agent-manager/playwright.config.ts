import { existsSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

function detectBrowserPath() {
  if (process.env.OPENCLAW_BROWSER_PATH) {
    return process.env.OPENCLAW_BROWSER_PATH
  }

  const candidatesByPlatform = {
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
    win32: [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ],
  }

  const candidates = candidatesByPlatform[process.platform as keyof typeof candidatesByPlatform] || []
  return candidates.find((candidate) => existsSync(candidate))
}

const browserPath = detectBrowserPath()

export default defineConfig({
  testDir: './tests/ui',
  timeout: 60_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  outputDir: 'test-results/batch-import-ui',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report/batch-import-ui' }],
    ['json', { outputFile: 'test-results/batch-import-ui/report.json' }],
  ],
  use: {
    baseURL: process.env.OPENCLAW_FRONTEND_URL || 'http://localhost:5173',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    launchOptions: browserPath ? { executablePath: browserPath } : {},
  },
  projects: [
    {
      name: 'local-chromium',
      use: {
        browserName: 'chromium',
        headless: !process.argv.includes('--headed'),
      },
    },
  ],
})
