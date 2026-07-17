import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')
const playwrightBin = join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'playwright.cmd' : 'playwright',
)

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

  const candidates = candidatesByPlatform[process.platform] || []
  return candidates.find((candidate) => existsSync(candidate))
}

const args = ['test', 'tests/ui/admin-batch-import.spec.ts', ...process.argv.slice(2)]
const browserPath = detectBrowserPath()

const child = spawn(playwrightBin, args, {
  cwd: projectRoot,
  env: {
    ...process.env,
    ...(browserPath ? { OPENCLAW_BROWSER_PATH: browserPath } : {}),
  },
  stdio: 'inherit',
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  process.exit(code ?? 1)
})
