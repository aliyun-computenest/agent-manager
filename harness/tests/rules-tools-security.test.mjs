import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import assert from 'node:assert/strict'

const execFileAsync = promisify(execFile)
const repoRoot = new URL('../..', import.meta.url)

async function runNode(args, options = {}) {
  return execFileAsync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    ...options,
  })
}

async function readPassDeliveryRun() {
  return JSON.parse(await readFile(new URL('fixtures/delivery-run-pass.json', import.meta.url), 'utf8'))
}

async function writeTempJson(prefix, value) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const filePath = join(dir, 'payload.json')
  await writeFile(filePath, JSON.stringify(value, null, 2))
  return { dir, filePath }
}

test('validate-rules rejects manifest paths outside the repository and tmp', async () => {
  await assert.rejects(
    () => runNode([
      'harness/scripts/validate-rules.mjs',
      '--manifest',
      '../../../../etc/passwd',
    ]),
    (error) => {
      assert.match(error.stderr, /JSON path must stay inside the repository or \/tmp/)
      return true
    },
  )
})

test('Harness instructions use repository-local scripts', async () => {
  const files = [
    'harness/rules/core.json',
    'harness/scripts/render-platform-package.mjs',
    'harness/skills/agent-manager-harness-api-test/SKILL.md',
    'harness/skills/agent-manager-harness-core/SKILL.md',
    'harness/skills/agent-manager-harness-env-prepare/SKILL.md',
    'harness/skills/agent-manager-harness-ephemeral-deploy/SKILL.md',
  ]

  for (const file of files) {
    const source = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /harness-agent-manager|~\/\.harness\/kits/)
  }
})

test('render-platform-package rejects output paths outside the repository and tmp', async () => {
  await assert.rejects(
    () => runNode([
      'harness/scripts/render-platform-package.mjs',
      '--manifest',
      'harness/manifests/harness-autodev-kit.json',
      '--skill-catalog',
      'harness/tests/fixtures/cloud-skill-publish-result.json',
      '--out',
      join(homedir(), 'agent-manager-bak-outside.json'),
    ]),
    (error) => {
      assert.match(error.stderr, /Output path must stay inside the repository or \/tmp/)
      return true
    },
  )
})

test('validate-delivery-run accepts Harness artifact locators', async () => {
  const run = await readPassDeliveryRun()
  run.outputs.push({
    taskId: 'capture-delivery-evidence',
    state: 'completed',
    summary: 'Uploaded evidence to Harness artifact storage.',
    artifacts: [
      {
        kind: 'report',
        url: 'harness://artifacts/harness-autodev-kit/report.md',
      },
    ],
  })

  const { dir, filePath } = await writeTempJson('agent-manager-harness-artifact-', run)
  try {
    const { stdout } = await runNode([
      'harness/scripts/validate-delivery-run.mjs',
      '--manifest',
      'harness/manifests/harness-autodev-kit.json',
      '--run',
      filePath,
    ])

    assert.match(stdout, /Harness delivery run validation passed/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('validate-delivery-run requires an explicit completion claim when platform acceptance passed', async () => {
  const run = await readPassDeliveryRun()
  run.platformAcceptance = {
    status: 'passed',
    claimedPlatformComplete: false,
    workItemId: 'WI-HARNESS-DELIVERY-KIT',
    milestoneId: 'MS-HARNESS-DELIVERY-KIT',
    acceptanceCommand: 'harness milestone complete MS-HARNESS-DELIVERY-KIT',
    evidence: [
      {
        kind: 'acceptance',
        url: 'harness://artifacts/harness-autodev-kit/acceptance.json',
      },
    ],
  }

  const { dir, filePath } = await writeTempJson('agent-manager-harness-acceptance-', run)
  try {
    await assert.rejects(
      () => runNode([
        'harness/scripts/validate-delivery-run.mjs',
        '--manifest',
        'harness/manifests/harness-autodev-kit.json',
        '--run',
        filePath,
      ]),
      (error) => {
        assert.match(error.stderr, /platformAcceptance\.claimedPlatformComplete/)
        assert.match(error.stderr, /must be true when platform acceptance passed/)
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('review-delivery-scope accepts single-star wildcard writeScope patterns', async () => {
  const manifest = {
    schemaVersion: '1.0',
    featureId: 'wildcard-scope',
    title: 'Wildcard Scope',
    tasks: [
      {
        id: 'backend-backup-route',
        stage: 'develop',
        dependsOn: [],
        resources: [],
        writeScope: ['agent-manager/server/routes/*backup*.js'],
      },
    ],
  }
  const manifestFile = await writeTempJson('agent-manager-harness-scope-', manifest)
  const changedDir = await mkdtemp(join(tmpdir(), 'agent-manager-harness-scope-files-'))
  const changedFiles = join(changedDir, 'changed-files.txt')
  await writeFile(changedFiles, 'agent-manager/server/routes/checkpoint-backups.js\n')
  try {
    const { stdout } = await runNode([
      'harness/scripts/review-delivery-scope.mjs',
      '--manifest',
      manifestFile.filePath,
      '--changed-files',
      changedFiles,
    ])
    const result = JSON.parse(stdout)

    assert.equal(result.status, 'passed')
    assert.deepEqual(result.outOfScopeFiles, [])
  } finally {
    await rm(manifestFile.dir, { recursive: true, force: true })
    await rm(changedDir, { recursive: true, force: true })
  }
})

test('check-platform-readiness treats an explicitly selected done task as already complete', async () => {
  const payload = {
    agent: { agentId: 'agent-current' },
    workItem: {
      id: 'wi-owned',
      status: 'in_progress',
      assigneeAgentId: 'agent-other',
      tasks: [
        {
          id: 'task-dev-orchestration',
          type: 'dev_orchestration',
          status: 'done',
          agentId: 'agent-other',
        },
      ],
    },
  }
  const { dir, filePath } = await writeTempJson('agent-manager-harness-platform-', payload)
  try {
    const { stdout } = await runNode([
      'harness/scripts/check-platform-readiness.mjs',
      '--input',
      filePath,
      '--task-id',
      'task-dev-orchestration',
    ])
    const result = JSON.parse(stdout)

    assert.equal(result.status, 'already_complete')
    assert.equal(result.taskId, 'task-dev-orchestration')
    assert.equal(result.taskUpdateAllowed, false)
    assert.match(result.reason, /already done/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
