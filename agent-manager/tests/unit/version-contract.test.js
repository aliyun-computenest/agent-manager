import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appDir = join(__dirname, '../..')
const versionPath = join(appDir, 'version.json')
const versionsDir = join(appDir, 'migrations/versions')
const dockerfilePath = join(appDir, 'Dockerfile')
const SEMVER_RE = /^\d+\.\d+\.\d+$/

function compareSemver(a, b) {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i]
  }
  return 0
}

function readLatestMigrationVersion() {
  return readdirSync(versionsDir)
    .filter((name) => SEMVER_RE.test(name))
    .filter((name) => statSync(join(versionsDir, name)).isDirectory())
    .sort(compareSemver)
    .at(-1)
}

describe('application version contract', () => {
  it('keeps version.json aligned with the latest release migration', () => {
    const versionInfo = JSON.parse(readFileSync(versionPath, 'utf8'))
    const latestMigrationVersion = readLatestMigrationVersion()

    expect(versionInfo.version).toMatch(SEMVER_RE)
    expect(
      compareSemver(versionInfo.version, latestMigrationVersion),
      `version.json ${versionInfo.version} is older than migrations/versions/${latestMigrationVersion}`,
    ).toBeGreaterThanOrEqual(0)
  })

  it('ships version.json in the production Docker image for /api/version', () => {
    const dockerfile = readFileSync(dockerfilePath, 'utf8')
    const productionStage = dockerfile.slice(dockerfile.lastIndexOf('FROM node:20-alpine'))

    expect(productionStage).toContain('COPY version.json ./version.json')
  })

  it('ships the PostgreSQL client in the production Docker image for pod-side maintenance', () => {
    const dockerfile = readFileSync(dockerfilePath, 'utf8')
    const productionStage = dockerfile.slice(dockerfile.lastIndexOf('FROM node:20-alpine'))

    expect(productionStage).toContain('postgresql-client')
  })
})
