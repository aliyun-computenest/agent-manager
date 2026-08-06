import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import assert from 'node:assert/strict'
import { manifestDigest, renderStageBinding } from '../scripts/lib/stage-binding.mjs'

const execFileAsync = promisify(execFile)
const repoRoot = new URL('../..', import.meta.url)

async function runNode(args, options = {}) {
  return execFileAsync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    ...options,
  })
}

async function withTempJson(value, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-manager-stage-output-'))
  const filePath = join(dir, 'payload.json')
  await writeFile(filePath, JSON.stringify(value, null, 2))
  try {
    return await fn(filePath)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('check-stage-output rejects dev_orchestration usage-only output', async () => {
  await withTempJson(
    {
      usage: { inputTokens: 104000 },
      sessionId: 'codex-session',
      durationMs: 12345,
    },
    async (filePath) => {
      await assert.rejects(
        () => runNode(['harness/scripts/check-stage-output.mjs', '--stage', 'dev_orchestration', '--output', filePath]),
        (error) => {
          assert.match(error.stderr, /Stage output check failed: dev_orchestration/)
          assert.match(error.stderr, /allowlist/)
          assert.match(error.stderr, /dag/)
          assert.match(error.stderr, /resourceLocks/)
          return true
        },
      )
    },
  )
})

test('check-stage-output rejects env_prepare debug localhost output', async () => {
  await withTempJson(
    {
      ok: true,
      state: 'debug_urls',
      runUrl: 'https://code.alibaba-inc.com/ci/runs/50476358',
      baseUrl: 'http://127.0.0.1:18080',
    },
    async (filePath) => {
      await assert.rejects(
        () => runNode(['harness/scripts/check-stage-output.mjs', '--stage', 'env_prepare', '--output', filePath]),
        (error) => {
          assert.match(error.stderr, /Stage output check failed: env_prepare/)
          assert.match(error.stderr, /schemaVersion/)
          assert.match(error.stderr, /state/)
          assert.match(error.stderr, /localhost|127\.0\.0\.1/)
          return true
        },
      )
    },
  )
})

test('check-stage-output accepts valid dev_orchestration output', async () => {
  await withTempJson(
    {
      state: 'completed',
      summary: '基于已评审设计和 UI 输入发布实施编排。',
      allowlist: ['agent-manager/server/routes/checkpoints.js', 'agent-manager/tests/checkpoints.test.js'],
      denylist: ['agent-manager/migrations/versions/*.sql'],
      dag: { waves: [['env_prepare', 'develop'], ['test_unit'], ['deploy_ephemeral', 'test_api', 'test_e2e']] },
      parallelWaves: [['env_prepare', 'develop'], ['test_unit']],
      resourceLocks: [{ name: 'git-branch', mode: 'exclusive' }, { name: 'namespace', mode: 'exclusive' }],
      environmentPlan: { namespace: 'am-harness-wi-test', serviceName: 'openclaw-platform' },
      testMatrix: [{ stage: 'test_unit', command: 'make test' }],
      evidenceRequirements: ['AOneCI run 链接', '浏览器截图', 'API 报告'],
      scopeGuardCommand: 'git diff --name-only origin/develop...HEAD',
    },
    async (filePath) => {
      const { stdout } = await runNode([
        'harness/scripts/check-stage-output.mjs',
        '--stage',
        'dev_orchestration',
        '--output',
        filePath,
      ])
      assert.match(stdout, /Stage output check passed: dev_orchestration/)
    },
  )
})

test('check-stage-output accepts valid env_prepare lifecycle output', async () => {
  await withTempJson(
    {
      schemaVersion: '1.0',
      action: 'env-create',
      stage: 'env_prepare',
      state: 'completed',
      workItemId: 'WI-TEST',
      taskId: 'TASK-TEST',
      ci: {
        pipelineId: '237756',
        pipelineSource: 'a1-list',
        pipelinePath: '.aoneci/harness_env_create.yaml',
        runId: '50476358',
        status: 'SUCCESS',
        url: 'https://code.alibaba-inc.com/ci/runs/50476358',
      },
      environment: {
        namespace: 'am-harness-wi-test',
        serviceName: 'openclaw-platform',
        baseUrl: 'https://am-harness-wi-test.example.invalid',
        apiHealthUrl: 'https://am-harness-wi-test.example.invalid/api/health',
        rosStackName: 'harness-wi-test',
      },
      diagnostics: [],
      reportMarkdown: '# AOneCI 生命周期报告：env_prepare',
    },
    async (filePath) => {
      const { stdout } = await runNode([
        'harness/scripts/check-stage-output.mjs',
        '--stage',
        'env_prepare',
        '--output',
        filePath,
      ])
      assert.match(stdout, /Stage output check passed: env_prepare/)
    },
  )
})

test('complete-stage refuses invalid env_prepare done output', async () => {
  await withTempJson(
    {
      schemaVersion: '1.0',
      action: 'env-create',
      stage: 'env_prepare',
      state: 'awaiting_human',
      ci: {
        pipelineId: '237756',
        pipelinePath: '.aoneci/harness_env_create.yaml',
        status: 'FAILED',
      },
      environment: {
        namespace: 'am-harness-wi-test',
        serviceName: 'openclaw-platform',
        baseUrl: null,
        rosStackName: 'harness-wi-test',
      },
      reportMarkdown: '# blocked',
    },
    async (filePath) => {
      await assert.rejects(
        () => runNode([
          'harness/scripts/complete-stage.mjs',
          '--stage',
          'env_prepare',
          '--task-id',
          'TASK-TEST',
          '--output',
          filePath,
          '--dry-run',
          '--no-write-harness',
        ]),
        (error) => {
          assert.match(error.stderr, /Stage completion blocked: env_prepare/)
          assert.match(error.stderr, /ci\.status/)
          assert.match(error.stderr, /environment\.baseUrl/)
          assert.match(error.stderr, /Not marking task done/)
          return true
        },
      )
    },
  )
})

test('complete-stage dry run accepts valid env_prepare output', async () => {
  await withTempJson(
    {
      schemaVersion: '1.0',
      action: 'env-create',
      stage: 'env_prepare',
      state: 'completed',
      ci: {
        pipelineId: '237756',
        pipelinePath: '.aoneci/harness_env_create.yaml',
        runId: '50476358',
        status: 'SUCCESS',
        url: 'https://code.alibaba-inc.com/ci/runs/50476358',
      },
      environment: {
        namespace: 'am-harness-wi-test',
        serviceName: 'openclaw-platform',
        baseUrl: 'https://am-harness-wi-test.example.invalid',
        apiHealthUrl: 'https://am-harness-wi-test.example.invalid/api/health',
        rosStackName: 'harness-wi-test',
      },
      reportMarkdown: '# AOneCI 生命周期报告：env_prepare',
    },
    async (filePath) => {
      const { stdout } = await runNode([
        'harness/scripts/complete-stage.mjs',
        '--stage',
        'env_prepare',
        '--task-id',
        'TASK-TEST',
        '--output',
        filePath,
        '--dry-run',
      ])
      assert.match(stdout, /Stage output check passed: env_prepare/)
      assert.match(stdout, /\[dry-run\] PATCH \/api\/v1\/tasks\/TASK-TEST status=done outputBytes=\d+/)
      assert.doesNotMatch(stdout, /AOneCI 生命周期报告/)
    },
  )
})

test('complete-stage clears stale waiting fields when completing a stage', async () => {
  const { completeStage } = await import(new URL('../scripts/complete-stage.mjs', import.meta.url))
  await withTempJson(
    {
      schemaVersion: '1.0',
      action: 'env-create',
      stage: 'env_prepare',
      state: 'completed',
      reason: 'previous write failed',
      waitType: 'platform_session_rebind',
      resumeCriteria: 'manual retry',
      blockedNextStages: ['develop'],
      ci: {
        pipelineId: '237756',
        pipelinePath: '.aoneci/harness_env_create.yaml',
        runId: '50476358',
        status: 'SUCCESS',
        url: 'https://code.alibaba-inc.com/ci/runs/50476358',
      },
      environment: {
        namespace: 'am-harness-wi-test',
        serviceName: 'openclaw-platform',
        baseUrl: 'https://am-harness-wi-test.example.invalid',
        apiHealthUrl: 'https://am-harness-wi-test.example.invalid/api/health',
        rosStackName: 'harness-wi-test',
      },
      reportMarkdown: '# AOneCI 生命周期报告：env_prepare',
    },
    async (filePath) => {
      const result = await completeStage([
        '--stage',
        'env_prepare',
        '--task-id',
        'TASK-TEST',
        '--output',
        filePath,
        '--no-write-harness',
      ])
      assert.equal(result.ok, true)
      assert.equal(result.output.reason, null)
      assert.equal(result.output.waitType, null)
      assert.equal(result.output.resumeCriteria, null)
      assert.deepEqual(result.output.blockedNextStages, [])
    },
  )
})

test('complete-stage binds test_e2e evidence to the platform task manifest', async () => {
  const { completeStage } = await import(new URL('../scripts/complete-stage.mjs', import.meta.url))
  const manifest = JSON.parse(await readFile(new URL('../manifests/harness-autodev-kit.json', import.meta.url), 'utf8'))
  const run = JSON.parse(await readFile(new URL('fixtures/delivery-run-pass.json', import.meta.url), 'utf8'))
  const output = run.tests.find((item) => item.id === 'e2e-delivery-report')
  output.state = 'completed'
  output.summary = 'Harness 交付报告终态已在隔离环境中读回。'
  output.screenshots = output.screenshots.slice(0, 1)
  const binding = renderStageBinding({
    version: 1,
    stage: 'test_e2e',
    featureId: manifest.featureId,
    testId: 'e2e-delivery-report',
    manifestDigest: manifestDigest(manifest),
  })
  const context = {
    work_item: {
      id: 'WI-BOUND',
      tasks: [{ id: 'TASK-E2E', type: 'test_e2e', status: 'in_progress' }],
    },
    workflow_hints: [{ type: 'test_e2e', agent_hints: binding }],
  }

  await withTempJson(output, async (outputPath) => {
    const accepted = await completeStage([
      '--stage', 'test_e2e',
      '--work-item-id', 'WI-BOUND',
      '--task-id', 'TASK-E2E',
      '--output', outputPath,
      '--no-write-harness',
    ], { contextLoader: async () => context })
    assert.equal(accepted.ok, true)

    const rejected = await completeStage([
      '--stage', 'test_e2e',
      '--work-item-id', 'WI-BOUND',
      '--task-id', 'TASK-E2E',
      '--output', outputPath,
      '--manifest', 'harness/manifests/checkpoint-backup.json',
      '--test-id', 'ui-backup',
      '--no-write-harness',
    ], { contextLoader: async () => context })
    assert.equal(rejected.ok, false)
    assert.match(rejected.errors.map((item) => item.message).join('\n'), /does not match platform-bound test|cannot replace platform-bound manifest/)
    process.exitCode = undefined
  })
})

test('check-stage-output rejects build-image-only deploy_ephemeral output', async () => {
  await withTempJson(
    {
      schemaVersion: '1.0',
      action: 'build-image',
      stage: 'deploy_ephemeral',
      state: 'completed',
      ci: {
        pipelineId: '237800',
        runId: '50444123',
        status: 'SUCCESS',
        url: 'https://code.alibaba-inc.com/ci/runs/50444123',
      },
      environment: {
        image: 'registry.example.invalid/agent-manager:test',
      },
      reportMarkdown: '# image build',
    },
    async (filePath) => {
      await assert.rejects(
        () => runNode(['harness/scripts/check-stage-output.mjs', '--stage', 'deploy_ephemeral', '--output', filePath]),
        (error) => {
          assert.match(error.stderr, /Stage output check failed: deploy_ephemeral/)
          assert.match(error.stderr, /action/)
          assert.match(error.stderr, /build-image alone cannot complete deploy_ephemeral/)
          return true
        },
      )
    },
  )
})

test('check-stage-output accepts valid deploy-image lifecycle output', async () => {
  await withTempJson(
    {
      schemaVersion: '1.0',
      action: 'deploy-image',
      stage: 'deploy_ephemeral',
      state: 'completed',
      workItemId: 'WI-TEST',
      taskId: 'TASK-DEPLOY',
      ci: {
        pipelineId: '237838',
        pipelineSource: 'a1-list',
        pipelinePath: '.aoneci/harness_build_deploy.yaml',
        runId: '50444436',
        status: 'SUCCESS',
        url: 'https://code.alibaba-inc.com/ci/runs/50444436',
      },
      environment: {
        namespace: 'am-harness-wi-test',
        serviceName: 'openclaw-platform',
        baseUrl: 'https://am-harness-wi-test.example.invalid',
        apiHealthUrl: 'https://am-harness-wi-test.example.invalid/api/health',
        rosStackName: 'harness-wi-test',
        image: 'registry.example.invalid/agent-manager:test',
      },
      reportMarkdown: '# AOneCI 生命周期报告：deploy_ephemeral\n\n- /api/health: HTTP 200',
    },
    async (filePath) => {
      const { stdout } = await runNode([
        'harness/scripts/check-stage-output.mjs',
        '--stage',
        'deploy_ephemeral',
        '--output',
        filePath,
      ])
      assert.match(stdout, /Stage output check passed: deploy_ephemeral/)
    },
  )
})

test('check-stage-output rejects summary-only final deploy output', async () => {
  await withTempJson(
    {
      summary: 'Workflow completion check passed. Now let me run the cleanup pipeline.',
      buildId: 'legacy-build-id',
    },
    async (filePath) => {
      await assert.rejects(
        () => runNode(['harness/scripts/check-stage-output.mjs', '--stage', 'deploy', '--output', filePath]),
        (error) => {
          assert.match(error.stderr, /Stage output check failed: deploy/)
          assert.match(error.stderr, /state/)
          assert.match(error.stderr, /action/)
          assert.match(error.stderr, /cleanup/)
          return true
        },
      )
    },
  )
})

test('check-stage-output accepts valid final deploy cleanup output', async () => {
  await withTempJson(
    {
      schemaVersion: '1.0',
      action: 'cleanup',
      stage: 'deploy',
      state: 'completed',
      workItemId: 'WI-TEST',
      taskId: 'TASK-DEPLOY',
      ci: {
        pipelineId: '237755',
        runId: '50506690',
        status: 'SUCCESS',
        url: 'https://code.alibaba-inc.com/acs-automation/agent-manager/ci/jobs?pipelineId=237755&pipelineRunId=50506690&createType=yaml',
        pipelinePath: '.aoneci/harness_env_cleanup.yaml',
      },
      environment: {
        namespace: 'am-harness-wi-test',
        rosStackName: 'harness-wi-test',
      },
      reportMarkdown: '# deploy 阶段报告\n\n- cleanup: SUCCESS',
    },
    async (filePath) => {
      const { stdout } = await runNode([
        'harness/scripts/check-stage-output.mjs',
        '--stage',
        'deploy',
        '--output',
        filePath,
      ])
      assert.match(stdout, /Stage output check passed: deploy/)
    },
  )
})

test('check-stage-output rejects deploy cleanup success when top-level ci is stale', async () => {
  await withTempJson(
    {
      schemaVersion: '1.0',
      action: 'cleanup',
      stage: 'deploy',
      state: 'completed',
      workItemId: 'WI-TEST',
      taskId: 'TASK-DEPLOY',
      ci: {
        pipelineId: '237755',
        runId: '',
        status: 'PENDING',
        pipelinePath: '.aoneci/harness_env_cleanup.yaml',
      },
      cleanup: {
        runId: '51557685',
        status: 'SUCCESS',
        url: 'https://code.alibaba-inc.com/acs-automation/agent-manager/ci/jobs?pipelineId=237755&pipelineRunId=51557685&createType=yaml',
        pipelinePath: '.aoneci/harness_env_cleanup.yaml',
      },
      environment: {
        namespace: 'am-harness-wi-test',
        rosStackName: 'harness-wi-test',
      },
      reportMarkdown: '# AOneCI 生命周期报告：deploy\n\n- Run：无\n- Run 状态：PENDING',
    },
    async (filePath) => {
      await assert.rejects(
        () => runNode(['harness/scripts/check-stage-output.mjs', '--stage', 'deploy', '--output', filePath]),
        (error) => {
          assert.match(error.stderr, /Stage output check failed: deploy/)
          assert.match(error.stderr, /ci\.status/)
          assert.match(error.stderr, /ci\.runId/)
          return true
        },
      )
    },
  )
})

test('check-stage-output rejects browser evidence that is only local paths', async () => {
  await withTempJson(
    {
      schemaVersion: '1.0',
      stage: 'test_e2e',
      state: 'completed',
      summary: '浏览器验证通过，但截图只在本机。',
      baseUrl: 'https://am-harness-wi-test.example.invalid',
      experienceUrl: 'https://am-harness-wi-test.example.invalid/admin/checkpoints',
      screenshots: [
        {
          kind: 'screenshot',
          target: 'checkpoint backup admin list',
          targetUrl: 'https://am-harness-wi-test.example.invalid/admin/checkpoints',
          path: '/tmp/checkpoint-admin-list.png',
        },
      ],
      consoleErrors: [],
      failedNetwork: [],
      layoutOverflow: { desktop: 0, mobile: 0 },
    },
    async (filePath) => {
      await assert.rejects(
        () => runNode(['harness/scripts/check-stage-output.mjs', '--stage', 'test_e2e', '--output', filePath]),
        (error) => {
          assert.match(error.stderr, /Stage output check failed: test_e2e/)
          assert.match(error.stderr, /platform-visible uploaded URL/)
          return true
        },
      )
    },
  )
})

test('check-stage-output rejects browser output without an experience URL', async () => {
  await withTempJson(
    {
      schemaVersion: '1.0',
      stage: 'test_e2e',
      state: 'completed',
      summary: '浏览器验证通过，但没有体验入口。',
      baseUrl: 'https://am-harness-wi-test.example.invalid',
      screenshots: [
        {
          kind: 'screenshot',
          target: 'checkpoint backup admin list',
          targetUrl: 'https://am-harness-wi-test.example.invalid/admin/checkpoints',
          url: 'https://harness.example.invalid/artifacts/checkpoint-admin-list.png',
        },
      ],
      consoleErrors: [],
      failedNetwork: [],
      layoutOverflow: { desktop: 0, mobile: 0 },
    },
    async (filePath) => {
      await assert.rejects(
        () => runNode(['harness/scripts/check-stage-output.mjs', '--stage', 'test_e2e', '--output', filePath]),
        (error) => {
          assert.match(error.stderr, /experienceUrl/)
          assert.match(error.stderr, /clickable experience URL/)
          return true
        },
      )
    },
  )
})

test('check-stage-output accepts browser output with platform-visible evidence and experience URL', async () => {
  const manifest = {
    testMatrix: [{ id: 'checkpoint-browser', stage: 'test_e2e' }],
  }
  await withTempJson(
    {
      schemaVersion: '1.0',
      stage: 'test_e2e',
      state: 'completed',
      summary: '浏览器验证通过，截图和报告已上传。',
      baseUrl: 'https://am-harness-wi-test.example.invalid',
      experienceUrl: 'https://am-harness-wi-test.example.invalid/admin/checkpoints',
      featureAssertions: [
        '已打开 checkpoint backup 管理列表',
        '已验证备份详情和创建弹窗均可见',
      ],
      screenshots: [
        {
          kind: 'screenshot',
          target: 'checkpoint backup admin list/detail/create flow',
          targetUrl: 'https://am-harness-wi-test.example.invalid/admin/checkpoints',
          url: 'https://harness.example.invalid/artifacts/checkpoint-admin-list-detail-create.png',
          domText: '备份管理列表、备份详情抽屉和创建备份弹窗均已展示，包含策略状态和创建按钮',
        },
      ],
      artifacts: [
        {
          kind: 'playwright-report',
          target: 'checkpoint backup Playwright report',
          url: 'harness://artifacts/checkpoint-backup/playwright-report',
        },
      ],
      consoleErrors: [],
      failedNetwork: [],
      layoutOverflow: { desktop: 0, mobile: 0 },
    },
    async (filePath) => {
      await withTempJson(manifest, async (manifestPath) => {
        const { stdout } = await runNode([
          'harness/scripts/check-stage-output.mjs',
          '--stage',
          'test_e2e',
          '--output',
          filePath,
          '--manifest',
          manifestPath,
          '--test-id',
          'checkpoint-browser',
        ])
        assert.match(stdout, /Stage output check passed: test_e2e/)
      })
    },
  )
})

test('check-stage-output rejects E2E completion when manifest is omitted', async () => {
  await withTempJson(
    {
      stage: 'test_e2e',
      state: 'completed',
      summary: '浏览器功能验证完成。',
      baseUrl: 'https://agent-manager.example.invalid',
      experienceUrl: 'https://agent-manager.example.invalid/user/skill-market',
      featureAssertions: ['Skill 市场页面和实例安装入口可见。'],
      screenshots: [
        {
          kind: 'screenshot',
          target: 'Skill 市场',
          targetUrl: 'https://agent-manager.example.invalid/user/skill-market',
          url: 'https://harness.example.invalid/artifacts/skill-market.png',
          domText: 'Skill 市场 官方 Skills 安装到实例',
        },
      ],
    },
    async (filePath) => {
      await assert.rejects(
        () => runNode(['harness/scripts/check-stage-output.mjs', '--stage', 'test_e2e', '--output', filePath]),
        (error) => {
          assert.match(error.stderr, /manifest-aware test definition is required/)
          return true
        },
      )
    },
  )
})

test('check-stage-output rejects a write flow without manifest-required post-action readback', async () => {
  const manifest = {
    testMatrix: [
      {
        id: 'install-skill-browser',
        stage: 'test_e2e',
        requiredAssertions: ['installed-skill-visible-in-agent-ui'],
        requiresPostActionReadback: true,
        postActionReadback: {
          targetPathPattern: '^/instance-1/skills/?$',
          resultMatchFields: ['instanceId', 'skillName'],
          evidenceTextFields: ['skillName'],
          requiredEvidenceText: ['Skills', 'Installed skills'],
          actionResultMatchFields: ['instanceId', 'skillName'],
          actionResultStatuses: ['succeeded'],
        },
      },
    ],
  }
  const output = {
    schemaVersion: '1.0',
    stage: 'test_e2e',
    state: 'completed',
    summary: 'Skill 安装提交弹窗验证通过。',
    baseUrl: 'https://agent-manager.example.invalid',
    experienceUrl: 'https://agent-manager.example.invalid/user/skill-market',
    featureAssertions: ['已从 Skill 市场选择实例并提交安装。'],
    assertionResults: [{
      id: 'installed-skill-visible-in-agent-ui',
      passed: true,
      instanceId: 'instance-1',
      skillName: 'docx',
    }],
    actionResults: [{
      status: 'succeeded',
      instanceId: 'instance-1',
      skillName: 'docx',
    }],
    screenshots: [
      {
        kind: 'screenshot',
        phase: 'post_action_readback',
        target: 'Skill 安装确认弹窗',
        targetUrl: 'https://agent-manager.example.invalid/user/skill-market',
        url: 'https://harness.example.invalid/artifacts/skill-install-modal.png',
        assertionIds: ['installed-skill-visible-in-agent-ui'],
        instanceId: 'instance-1',
        skillName: 'docx',
        domText: '选择目标实例并点击安装 docx',
      },
    ],
  }

  await withTempJson(manifest, async (manifestPath) => {
    await withTempJson(output, async (outputPath) => {
      await assert.rejects(
        () => runNode([
          'harness/scripts/check-stage-output.mjs',
          '--stage',
          'test_e2e',
          '--output',
          outputPath,
          '--manifest',
          manifestPath,
          '--test-id',
          'install-skill-browser',
        ]),
        (error) => {
          assert.match(error.stderr, /target pattern|Installed skills/)
          return true
        },
      )
    })
  })
})

test('check-stage-output accepts a manifest-required Agent UI post-action readback', async () => {
  const manifest = {
    testMatrix: [
      {
        id: 'install-skill-browser',
        stage: 'test_e2e',
        requiredAssertions: ['installed-skill-visible-in-agent-ui'],
        requiresPostActionReadback: true,
        postActionReadback: {
          targetPathPattern: '^/instance-1/skills/?$',
          resultMatchFields: ['instanceId', 'skillName'],
          evidenceTextFields: ['skillName'],
          requiredEvidenceText: ['Skills', 'Installed skills'],
          actionResultMatchFields: ['instanceId', 'skillName'],
          actionResultStatuses: ['succeeded'],
        },
      },
    ],
  }
  const output = {
    schemaVersion: '1.0',
    stage: 'test_e2e',
    state: 'completed',
    summary: 'Skill 安装后在目标 Agent 技能页读回成功。',
    baseUrl: 'https://agent-manager.example.invalid',
    experienceUrl: 'https://agent.example.invalid/instance-1/skills',
    featureAssertions: ['安装后的 docx Skill 在目标 Agent 技能页中可见并启用。'],
    assertionResults: [
      {
        id: 'installed-skill-visible-in-agent-ui',
        passed: true,
        instanceId: 'instance-1',
        skillName: 'docx',
        summary: '目标 Agent 技能页搜索 docx 后显示一条已启用结果。',
      },
    ],
    actionResults: [
      {
        status: 'succeeded',
        instanceId: 'instance-1',
        skillName: 'docx',
      },
    ],
    screenshots: [
      {
        kind: 'screenshot',
        phase: 'post_action_readback',
        target: '目标 Agent 技能页安装结果',
        targetUrl: 'https://agent.example.invalid/instance-1/skills',
        url: 'https://harness.example.invalid/artifacts/agent-skill-docx.png',
        assertionIds: ['installed-skill-visible-in-agent-ui'],
        instanceId: 'instance-1',
        skillName: 'docx',
        domText: '技能 Skills Installed skills 1 shown docx 已启用',
      },
    ],
  }

  await withTempJson(manifest, async (manifestPath) => {
    await withTempJson(output, async (outputPath) => {
      const { stdout } = await runNode([
        'harness/scripts/check-stage-output.mjs',
        '--stage',
        'test_e2e',
        '--output',
        outputPath,
        '--manifest',
        manifestPath,
        '--test-id',
        'install-skill-browser',
      ])
      assert.match(stdout, /Stage output check passed: test_e2e/)
    })
  })
})

test('check-stage-output matches post-action routes by URL pathname instead of query text', async () => {
  const manifest = {
    testMatrix: [{
      id: 'install-skill-browser',
      stage: 'test_e2e',
      requiredAssertions: ['installed-skill-visible-in-agent-ui'],
      requiresPostActionReadback: true,
      postActionReadback: {
        targetPathPattern: '^/instance-1/skills/?$',
        resultMatchFields: ['instanceId', 'skillName'],
        evidenceTextFields: ['skillName'],
        requiredEvidenceText: ['Skills', 'Installed skills'],
        actionResultMatchFields: ['instanceId', 'skillName'],
        actionResultStatuses: ['succeeded'],
      },
    }],
  }
  const output = {
    stage: 'test_e2e',
    state: 'completed',
    summary: '伪造的安装后回读。',
    baseUrl: 'https://agent-manager.example.invalid',
    experienceUrl: 'https://agent-manager.example.invalid/user/skill-market?return=/instance-1/skills',
    featureAssertions: ['安装后的 docx Skill 在目标 Agent 技能页中可见。'],
    assertionResults: [{
      id: 'installed-skill-visible-in-agent-ui',
      passed: true,
      instanceId: 'instance-1',
      skillName: 'docx',
    }],
    actionResults: [{ status: 'succeeded', instanceId: 'instance-1', skillName: 'docx' }],
    screenshots: [{
      kind: 'screenshot',
      phase: 'post_action_readback',
      targetUrl: 'https://agent-manager.example.invalid/user/skill-market?return=/instance-1/skills',
      url: 'https://harness.example.invalid/artifacts/spoofed-skill.png',
      assertionIds: ['installed-skill-visible-in-agent-ui'],
      instanceId: 'instance-1',
      skillName: 'docx',
      domText: 'Skills Installed skills docx',
    }],
  }

  await withTempJson(manifest, async (manifestPath) => {
    await withTempJson(output, async (outputPath) => {
      await assert.rejects(
        () => runNode([
          'harness/scripts/check-stage-output.mjs',
          '--stage',
          'test_e2e',
          '--output',
          outputPath,
          '--manifest',
          manifestPath,
          '--test-id',
          'install-skill-browser',
        ]),
        (error) => {
          assert.match(error.stderr, /pathname \/user\/skill-market must match/)
          return true
        },
      )
    })
  })
})

test('check-stage-output requires allowed action statuses for action correlation', async () => {
  const manifest = {
    testMatrix: [{
      id: 'install-skill-browser',
      stage: 'test_e2e',
      requiredAssertions: ['installed-skill-visible-in-agent-ui'],
      requiresPostActionReadback: true,
      postActionReadback: {
        targetPathPattern: '^/instance-1/skills/?$',
        resultMatchFields: ['instanceId', 'skillName'],
        actionResultMatchFields: ['instanceId', 'skillName'],
      },
    }],
  }
  const output = {
    stage: 'test_e2e',
    state: 'completed',
    summary: '失败动作不能被当作成功安装。',
    baseUrl: 'https://agent-manager.example.invalid',
    experienceUrl: 'https://agent.example.invalid/instance-1/skills',
    featureAssertions: ['安装后的 docx Skill 在目标 Agent 技能页中可见。'],
    assertionResults: [{
      id: 'installed-skill-visible-in-agent-ui',
      passed: true,
      instanceId: 'instance-1',
      skillName: 'docx',
    }],
    actionResults: [{ status: 'failed', instanceId: 'instance-1', skillName: 'docx' }],
    screenshots: [{
      kind: 'screenshot',
      phase: 'post_action_readback',
      targetUrl: 'https://agent.example.invalid/instance-1/skills',
      url: 'https://harness.example.invalid/artifacts/agent-skill-docx.png',
      assertionIds: ['installed-skill-visible-in-agent-ui'],
      instanceId: 'instance-1',
      skillName: 'docx',
      domText: 'Skills Installed skills docx',
    }],
  }

  await withTempJson(manifest, async (manifestPath) => {
    await withTempJson(output, async (outputPath) => {
      await assert.rejects(
        () => runNode([
          'harness/scripts/check-stage-output.mjs',
          '--stage',
          'test_e2e',
          '--output',
          outputPath,
          '--manifest',
          manifestPath,
          '--test-id',
          'install-skill-browser',
        ]),
        (error) => {
          assert.match(error.stderr, /actionResultStatuses/)
          return true
        },
      )
    })
  })
})

test('check-stage-output rejects loading-state browser screenshots', async () => {
  await withTempJson(
    {
      schemaVersion: '1.0',
      stage: 'test_e2e',
      state: 'completed',
      summary: '错误地把加载态截图当成浏览器功能验证。',
      baseUrl: 'https://am-harness-wi-test.example.invalid',
      experienceUrl: 'https://am-harness-wi-test.example.invalid/system/runtime-diagnostics',
      featureAssertions: [
        '已验证运行时诊断状态页展示 API 状态、版本、更新时间和 Supabase/E2B 配置状态',
      ],
      screenshots: [
        {
          kind: 'screenshot',
          target: 'runtime diagnostics loading state',
          targetUrl: 'https://am-harness-wi-test.example.invalid/system/runtime-diagnostics',
          url: 'https://harness.example.invalid/artifacts/runtime-diagnostics-loading.png',
          pageTitle: '运行时诊断',
          screenshotText: '运行时诊断 加载中...',
        },
      ],
      artifacts: [
        {
          kind: 'playwright-report',
          target: 'runtime diagnostics Playwright report',
          url: 'harness://artifacts/runtime-diagnostics/playwright-report',
        },
      ],
      consoleErrors: [],
      failedNetwork: [],
      layoutOverflow: { desktop: 0, mobile: 0 },
    },
    async (filePath) => {
      await assert.rejects(
        () => runNode(['harness/scripts/check-stage-output.mjs', '--stage', 'test_e2e', '--output', filePath]),
        (error) => {
          assert.match(error.stderr, /Stage output check failed: test_e2e/)
          assert.match(error.stderr, /loading|blank/)
          return true
        },
      )
    },
  )
})

test('check-stage-output rejects login page screenshots as E2E completion evidence', async () => {
  await withTempJson(
    {
      schemaVersion: '1.0',
      stage: 'test_e2e',
      state: 'completed',
      summary: '错误地把登录页截图当成浏览器功能验证。',
      baseUrl: 'https://am-harness-wi-test.example.invalid',
      experienceUrl: 'https://am-harness-wi-test.example.invalid/login',
      featureAssertions: [
        '已验证 checkpoint backup 管理列表、详情和创建弹窗',
      ],
      screenshots: [
        {
          kind: 'screenshot',
          target: 'login page',
          targetUrl: 'https://am-harness-wi-test.example.invalid/login',
          url: 'https://harness.example.invalid/artifacts/login-page.png',
        },
      ],
      artifacts: [
        {
          kind: 'playwright-report',
          target: 'checkpoint backup Playwright report',
          url: 'harness://artifacts/checkpoint-backup/playwright-report',
        },
      ],
      consoleErrors: [],
      failedNetwork: [],
      layoutOverflow: { desktop: 0, mobile: 0 },
    },
    async (filePath) => {
      await assert.rejects(
        () => runNode(['harness/scripts/check-stage-output.mjs', '--stage', 'test_e2e', '--output', filePath]),
        (error) => {
          assert.match(error.stderr, /Stage output check failed: test_e2e/)
          assert.match(error.stderr, /login, auth, homepage/)
          return true
        },
      )
    },
  )
})

test('check-stage-output rejects browser evidence without feature assertions', async () => {
  await withTempJson(
    {
      schemaVersion: '1.0',
      stage: 'test_e2e',
      state: 'completed',
      summary: '截图可见但没有说明覆盖了哪个功能断言。',
      baseUrl: 'https://am-harness-wi-test.example.invalid',
      experienceUrl: 'https://am-harness-wi-test.example.invalid/admin/checkpoints',
      screenshots: [
        {
          kind: 'screenshot',
          target: 'checkpoint backup admin list/detail/create flow',
          targetUrl: 'https://am-harness-wi-test.example.invalid/admin/checkpoints',
          url: 'https://harness.example.invalid/artifacts/checkpoint-admin-list-detail-create.png',
        },
      ],
      artifacts: [
        {
          kind: 'playwright-report',
          target: 'checkpoint backup Playwright report',
          url: 'harness://artifacts/checkpoint-backup/playwright-report',
        },
      ],
      consoleErrors: [],
      failedNetwork: [],
      layoutOverflow: { desktop: 0, mobile: 0 },
    },
    async (filePath) => {
      await assert.rejects(
        () => runNode(['harness/scripts/check-stage-output.mjs', '--stage', 'test_e2e', '--output', filePath]),
        (error) => {
          assert.match(error.stderr, /featureAssertions/)
          assert.match(error.stderr, /feature-specific/)
          return true
        },
      )
    },
  )
})
