import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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

function createGitPreflightHandler(options = {}) {
  const branch = options.branch || 'harness/test'
  const yamlPath = options.yamlPath || '.aoneci/harness_env_create.yaml'
  let remoteExists = options.remoteExists ?? true
  let remoteHasYaml = options.remoteHasYaml ?? true
  const headHasYaml = options.headHasYaml ?? true
  const currentBranch = options.currentBranch || branch

  return async (command, args) => {
    if (command !== 'git') return undefined
    if (args[0] === 'ls-remote') {
      if (!remoteExists) throw new Error(`remote branch not found: ${branch}`)
      return { stdout: `0000000000000000000000000000000000000000\trefs/heads/${branch}\n` }
    }
    if (args.join(' ') === 'branch --show-current') {
      return { stdout: `${currentBranch}\n` }
    }
    if (args[0] === 'cat-file' && args[1] === '-e') {
      if (args[2] === `HEAD:${yamlPath}` && headHasYaml) return { stdout: '' }
      if (args[2] === `refs/remotes/origin/${branch}:${yamlPath}` && remoteHasYaml) return { stdout: '' }
      throw new Error(`missing git path: ${args[2]}`)
    }
    if (args[0] === 'push') {
      if (options.pushFails) throw new Error('push rejected')
      remoteExists = true
      remoteHasYaml = headHasYaml
      return { stdout: '' }
    }
    if (args[0] === 'fetch') {
      if (!remoteExists) throw new Error(`cannot fetch missing branch: ${branch}`)
      return { stdout: '' }
    }
    return undefined
  }
}

test('validate-rules accepts the checked-in Harness rules pack', async () => {
  const { stdout } = await runNode([
    'harness/scripts/validate-rules.mjs',
    '--allow-missing-source-paths',
  ])

  assert.match(stdout, /Harness rules validation passed/)
  assert.match(stdout, /checkpoint-backup/)
})

test('validate-rules rejects a manifest with a cyclic DAG', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-manager-harness-'))
  const manifestPath = join(dir, 'bad-manifest.json')
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        schemaVersion: '1.0',
        featureId: 'bad-cycle',
        title: 'Bad Cycle',
        sources: { designDocs: [], uiArtifacts: [] },
        platformInputs: { required: ['workItemId'], optional: [] },
        stages: ['clarify', 'dev_orchestration'],
        tasks: [
          { id: 'a', stage: 'clarify', dependsOn: ['b'], resources: [], writeScope: [] },
          { id: 'b', stage: 'dev_orchestration', dependsOn: ['a'], resources: [], writeScope: [] },
        ],
        testMatrix: [],
        evidence: [],
        humanGates: [],
      },
      null,
      2,
    ),
  )

  await assert.rejects(
    () => runNode(['harness/scripts/validate-rules.mjs', '--manifest', manifestPath]),
    (error) => {
      assert.match(error.stderr, /cyclic dependency/)
      return true
    },
  )

  await rm(dir, { recursive: true, force: true })
})

test('validate-rules rejects a manifest with missing source paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-manager-harness-'))
  const manifestPath = join(dir, 'bad-source.json')
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        schemaVersion: '1.0',
        featureId: 'bad-source',
        title: 'Bad Source',
        sources: {
          designDocs: ['docs/design/does-not-exist.md'],
          uiArtifacts: [],
        },
        platformInputs: { required: ['workItemId'], optional: [] },
        stages: ['clarify'],
        tasks: [],
        testMatrix: [],
        evidence: [],
        humanGates: [],
      },
      null,
      2,
    ),
  )

  await assert.rejects(
    () => runNode(['harness/scripts/validate-rules.mjs', '--manifest', manifestPath]),
    (error) => {
      assert.match(error.stderr, /source path does not exist/)
      return true
    },
  )

  await rm(dir, { recursive: true, force: true })
})

test('validate-rules rejects post-action readback without assertion and target contract', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-manager-harness-'))
  const manifestPath = join(dir, 'bad-post-action.json')
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        schemaVersion: '1.0',
        featureId: 'bad-post-action',
        title: 'Bad post-action contract',
        sources: { designDocs: [], uiArtifacts: [] },
        platformInputs: { required: [], optional: [] },
        stages: ['test_e2e'],
        tasks: [],
        testMatrix: [
          {
            id: 'browser',
            stage: 'test_e2e',
            command: 'npx playwright test',
            resources: [],
            evidence: ['screenshot'],
            requiresPostActionReadback: true,
          },
        ],
        evidence: [],
        humanGates: [],
      },
      null,
      2,
    ),
  )

  await assert.rejects(
    () => runNode(['harness/scripts/validate-rules.mjs', '--manifest', manifestPath]),
    (error) => {
      assert.match(error.stderr, /requires at least one requiredAssertions id/)
      assert.match(error.stderr, /requires a postActionReadback contract/)
      return true
    },
  )

  await rm(dir, { recursive: true, force: true })
})

test('render-platform-template emits Harness CLI waiting protocol and feature evidence', async () => {
  const { stdout } = await runNode([
    'harness/scripts/render-platform-template.mjs',
    '--manifest',
    'harness/manifests/checkpoint-backup.json',
  ])

  assert.match(stdout, /harness ask <work_item_id>/)
  assert.match(stdout, /harness milestone blocker <task_id>/)
  assert.match(stdout, /plan-parallel-waves\.mjs/)
  assert.match(stdout, /harness_env_create\.yaml/)
  assert.match(stdout, /harness_build_deploy\.yaml/)
  assert.match(stdout, /harness_env_cleanup\.yaml/)
  assert.match(stdout, /node harness\/scripts\/aone-lifecycle\.mjs deploy-image/)
  assert.doesNotMatch(stdout, /a1 ci pipeline run <build_deploy_pipeline_id>/)
  assert.match(stdout, /TEST_CHECKPOINT_BACKUP_CREATE_CANCEL=true/)
  assert.match(stdout, /tests\/ui\/checkpoint-backup-admin\.spec\.ts/)
  assert.match(stdout, /OOS execution record/)
  assert.match(stdout, /Checkpoint\/ConfigMap readback/)
})

test('render-platform-package emits a publishable Harness task template package', async () => {
  const { stdout } = await runNode([
    'harness/scripts/render-platform-package.mjs',
    '--manifest',
    'harness/manifests/harness-autodev-kit.json',
    '--skill-catalog',
    'harness/tests/fixtures/cloud-skill-publish-result.json',
  ])
  const pkg = JSON.parse(stdout)

  assert.equal(pkg.schema, 'harness.task-template.v1')
  assert.equal(pkg.template.name, 'agent-manager-auto-dev-v1')
  assert.equal(pkg.template.requiresWorkspace, true)
  assert.match(pkg.template.instructions, /AutoDev Workflow v2：隔离环境自动开发/)
  assert.deepEqual(
    pkg.template.tasks.map((task) => task.type),
    [
      'clarify',
      'dev_orchestration',
      'env_prepare',
      'develop',
      'test_unit',
      'deploy_ephemeral',
      'test_api',
      'test_e2e',
      'integration_live',
      'code_review',
      'deploy',
    ],
  )
  assert.ok(pkg.template.tasks.every((task) => /harness task update/.test(task.agentHints)))
  assert.ok(pkg.template.tasks.every((task) => task.skillIds.length === 2))
  assert.ok(pkg.template.tasks.every((task) => task.skillIds[0] === '00000000-0000-4000-8000-000000000001'))
  assert.equal(new Set(pkg.template.tasks.flatMap((task) => task.skillIds)).size, 12)
  assert.match(
    pkg.template.tasks.find((task) => task.type === 'env_prepare')?.agentHints || '',
    /harness_env_create\.yaml/,
  )
  assert.match(
    pkg.template.tasks.find((task) => task.type === 'deploy_ephemeral')?.agentHints || '',
    /harness_build_deploy\.yaml/,
  )
  assert.match(
    pkg.template.tasks.find((task) => task.type === 'deploy_ephemeral')?.agentHints || '',
    /node harness\/scripts\/aone-lifecycle\.mjs deploy-image/,
  )
  const e2eHints = pkg.template.tasks.find((task) => task.type === 'test_e2e')?.agentHints || ''
  assert.match(e2eHints, /feature-postcondition-visible-in-target-ui/)
  assert.match(e2eHints, /assertionResults/)
  assert.match(e2eHints, /phase=post_action_readback/)
  assert.match(e2eHints, /HARNESS_STAGE_BINDING_V1:/)
  assert.match(e2eHints, /--work-item-id <work_item_id>/)
  assert.doesNotMatch(e2eHints, /--manifest /)
  assert.ok(pkg.template.tasks.every((task) => !/a1 ci pipeline run/.test(task.agentHints)))
  assert.match(
    pkg.template.tasks.find((task) => task.type === 'deploy')?.agentHints || '',
    /harness_env_cleanup\.yaml/,
  )
})

test('render-platform-package fails closed when a declared cloud skill is missing', async () => {
  const catalog = JSON.parse(await readFile(
    new URL('fixtures/cloud-skill-publish-result.json', import.meta.url),
    'utf8',
  ))
  catalog.skills = catalog.skills.filter(
    (item) => item.skill.slug !== 'agent-manager-harness-e2e-test',
  )
  const { dir, filePath } = await writeTempJson('agent-manager-cloud-skills-', catalog)
  try {
    await assert.rejects(
      () => runNode([
        'harness/scripts/render-platform-package.mjs',
        '--manifest',
        'harness/manifests/harness-autodev-kit.json',
        '--skill-catalog',
        filePath,
      ]),
      (error) => {
        assert.match(error.stderr, /agent-manager-harness-e2e-test/)
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('check-cloud-template-publish rejects dropped stage skills', async () => {
  const result = await writeTempJson('agent-manager-cloud-template-', {
    success: true,
    template: { id: 'template-1', name: 'agent-manager-auto-dev-v1' },
    droppedSkillIds: ['skill-missing'],
  })
  try {
    await assert.rejects(
      () => runNode([
        'harness/scripts/check-cloud-template-publish.mjs',
        '--result',
        result.filePath,
      ]),
      (error) => {
        assert.match(error.stderr, /dropped unattached cloud skills/)
        return true
      },
    )
  } finally {
    await rm(result.dir, { recursive: true, force: true })
  }
})

test('package-cloud-skills includes every configured cloud skill and excludes the legacy bundle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-manager-cloud-skill-zip-'))
  const zipPath = join(dir, 'skills.zip')
  try {
    await runNode([
      'harness/scripts/package-cloud-skills.mjs',
      '--out',
      zipPath,
    ])
    const { stdout } = await execFileAsync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
    const skillFiles = stdout
      .split('\n')
      .filter((path) => path.endsWith('/SKILL.md'))
    assert.equal(skillFiles.length, 12)
    assert.ok(skillFiles.includes('agent-manager-harness-core/SKILL.md'))
    assert.ok(skillFiles.includes('agent-manager-harness-e2e-test/SKILL.md'))
    assert.ok(!skillFiles.includes('agent-manager-harness-autodev/SKILL.md'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('check-platform-workflow accepts a work item bound to the environment-isolated template', async () => {
  const tasks = [
    'clarify',
    'dev_orchestration',
    'env_prepare',
    'develop',
    'test_unit',
    'deploy_ephemeral',
    'test_api',
    'test_e2e',
    'integration_live',
    'code_review',
    'deploy',
  ].map((type, index) => ({
    id: `task-${index}`,
    type,
    status: 'pending',
  }))
  const workItem = await writeTempJson('agent-manager-platform-workflow-', {
    workItem: {
      id: 'wi-v1',
      taskTemplate: 'agent-manager-auto-dev-v1',
      tasks,
    },
  })
  const context = await writeTempJson('agent-manager-platform-context-', {
    task_template: 'agent-manager-auto-dev-v1',
    task_template_label: 'Agent Manager 自动开发轮转 v2（隔离环境）',
    workflow_hints: [
      {
        type: 'clarify',
        description: 'Harness WORKFLOW awaiting_human gate',
        agent_hints: 'Use harness ask and keep awaiting_human tasks in_progress.',
      },
    ],
  })
  try {
    const { stdout } = await runNode([
      'harness/scripts/check-platform-workflow.mjs',
      '--work-item',
      workItem.filePath,
      '--context',
      context.filePath,
      '--expected-template-name',
      'Agent Manager 自动开发轮转 v2（隔离环境）',
    ])
    const result = JSON.parse(stdout)

    assert.equal(result.status, 'ready')
    assert.equal(result.platformAcceptance.claimedPlatformComplete, false)
  } finally {
    await rm(workItem.dir, { recursive: true, force: true })
    await rm(context.dir, { recursive: true, force: true })
  }
})

test('check-platform-workflow rejects the builtin general template', async () => {
  const workItem = await writeTempJson('agent-manager-platform-workflow-', {
    workItem: {
      id: 'wi-general',
      taskTemplate: 'general',
      tasks: [
        { id: 'task-execute', type: 'execute', status: 'pending' },
      ],
    },
  })
  try {
    await assert.rejects(
      () => runNode([
        'harness/scripts/check-platform-workflow.mjs',
        '--work-item',
        workItem.filePath,
        '--expected-template-name',
        'agent-manager-auto-dev-v1',
      ]),
      (error) => {
        const result = JSON.parse(error.stdout)
        assert.equal(result.status, 'awaiting_human')
        assert.match(result.errors.join('\n'), /builtin general template/)
        assert.match(result.errors.join('\n'), /missing expected task type: clarify/)
        return true
      },
    )
  } finally {
    await rm(workItem.dir, { recursive: true, force: true })
  }
})

test('plan-test-environment emits deterministic isolated names', async () => {
  const { stdout } = await runNode([
    'harness/scripts/plan-test-environment.mjs',
    '--work-item',
    'WI-HARNESS-DELIVERY-KIT',
    '--task',
    'TASK-HARNESS-DELIVERY-KIT',
    '--feature',
    'harness-autodev-kit',
  ])
  const plan = JSON.parse(stdout)

  assert.equal(plan.runId, 'harness-autodev-kit-0bfc8bed787d')
  assert.equal(plan.isolated, true)
  assert.equal(plan.namespace, 'am-harness-0bfc8bed787d')
  assert.equal(plan.serviceName, 'openclaw-platform')
  assert.equal(plan.baseUrl, 'http://127.0.0.1:<port-forward-0bfc8bed787d>')
  assert.equal(plan.imageTag, 'harness-autodev-kit-0bfc8bed787d')
  assert.equal(plan.dbPrefix, 'it_0bfc8bed787d_')
  assert.equal(plan.ci.repo, 'acs-automation/agent-manager')
  assert.equal(plan.ci.envCreate.pipelinePath, '.aoneci/harness_env_create.yaml')
  assert.equal(plan.ci.buildDeploy.pipelinePath, '.aoneci/harness_build_deploy.yaml')
  assert.equal(plan.ci.envCleanup.pipelinePath, '.aoneci/harness_env_cleanup.yaml')
  assert.equal(plan.ci.envCreate.parameters.computenest_region, 'ap-southeast-1')
  assert.equal(plan.ci.envCreate.parameters.deploy_region_id, 'cn-hongkong')
  assert.equal(plan.ci.envCreate.parameters.acs_service_id, 'service-731298a621304868a3a4')
  assert.equal(plan.ci.envCreate.parameters.acs_cluster_id, 'c2aa8f25b3d9443d28012b53cf7482920')
  assert.equal(plan.ci.envCreate.parameters.vpc_id, 'vpc-j6c11tziiynqsicwit1gv')
  assert.equal(plan.ci.envCreate.parameters.vswitch_id, 'vsw-j6ceq555bjkzfgmm5kewl')
  assert.equal(plan.ci.envCreate.parameters.zone_id, 'cn-hongkong-d')
  assert.equal(plan.ci.envCreate.parameters.skillhub_oss_bucket, 'skillhub-pre-test-intl')
  assert.equal(plan.ci.envCreate.parameters.skillhub_oss_region, 'cn-hongkong')
  assert.equal(plan.ci.envCreate.parameters.agent_manager_artifact_id, 'artifact-d17025551f9b40a6a3ec')
  assert.equal(plan.ci.envCreate.parameters.agent_manager_artifact_region, 'ap-southeast-1')
  assert.equal(plan.ci.envCreate.parameters.ros_template_path, 'template/platform_template.yaml')
  assert.equal(plan.ci.buildDeploy.parameters.container_name, 'openclaw-platform')
  assert.match(plan.ci.envCreate.runCommand, /a1 ci pipeline run <env_create_pipeline_id>/)
  assert.match(
    plan.ci.envCreate.resolveCommand,
    /--code-file-url https:\/\/code\.alibaba-inc\.com\/acs-automation\/agent-manager\/blob\/<remote-branch>\/\.aoneci\/harness_env_create\.yaml/,
  )
  assert.match(plan.ci.envCreate.runCommand, /--param computenest_region='ap-southeast-1'/)
  assert.match(plan.ci.envCreate.runCommand, /--param deploy_region_id='cn-hongkong'/)
  assert.match(plan.ci.envCreate.runCommand, /--param acs_service_id='service-731298a621304868a3a4'/)
  assert.match(plan.ci.envCreate.runCommand, /--param acs_cluster_id='c2aa8f25b3d9443d28012b53cf7482920'/)
  assert.match(plan.ci.envCreate.runCommand, /--param skillhub_oss_bucket='skillhub-pre-test-intl'/)
  assert.match(plan.ci.envCreate.runCommand, /--param agent_manager_artifact_id='artifact-d17025551f9b40a6a3ec'/)
  assert.match(plan.ci.buildDeploy.runCommand, /--param image_tag='harness-autodev-kit-0bfc8bed787d'/)
  assert.match(plan.ci.envCleanup.runCommand, /--param namespace='am-harness-0bfc8bed787d'/)
  assert.match(plan.localAccess.portForwardCommand, /kubectl -n am-harness-0bfc8bed787d port-forward/)
})

test('validate-delivery-run accepts the Harness delivery kit full dry run', async () => {
  const { stdout } = await runNode([
    'harness/scripts/validate-delivery-run.mjs',
    '--manifest',
    'harness/manifests/harness-autodev-kit.json',
    '--run',
    'harness/tests/fixtures/delivery-run-pass.json',
  ])

  assert.match(stdout, /Harness delivery run validation passed/)
  assert.match(stdout, /Feature: harness-autodev-kit/)
  assert.match(stdout, /Platform acceptance: evidence_boundary/)
})

test('validate-delivery-run accepts the checkpoint backup real development flow sample', async () => {
  const fixture = JSON.parse(
    await readFile(new URL('fixtures/checkpoint-backup-delivery-run-pass.json', import.meta.url), 'utf8'),
  )
  const envCreate = fixture.tests.find((item) => item.id === 'env-create-checkpoint')
  const unit = fixture.tests.find((item) => item.id === 'unit-backup')
  const ui = fixture.tests.find((item) => item.id === 'ui-backup')
  const integration = fixture.tests.find((item) => item.id === 'integration-checkpoint-backup')

  assert.match(envCreate.command, /--param computenest_region=ap-southeast-1/)
  assert.match(envCreate.command, /--param deploy_region_id=cn-hongkong/)
  assert.match(envCreate.command, /--param acs_cluster_id=c2aa8f25b3d9443d28012b53cf7482920/)
  assert.match(envCreate.command, /--param skillhub_oss_bucket=skillhub-pre-test-intl/)
  assert.match(JSON.stringify(envCreate.readback), /DeployRegionId/)
  assert.equal(unit.testsPassed, 36)
  assert.match(ui.command, /playwright test tests\/ui\/checkpoint-backup-admin\.spec\.ts/)
  assert.ok(ui.screenshots.some((item) => /checkpoint backup admin/.test(item.target)))
  assert.ok(integration.liveEvidence.some((item) => item.kind === 'checkpoint-cr-readback'))
  assert.equal(fixture.platformAcceptance.claimedPlatformComplete, false)

  const { stdout } = await runNode([
    'harness/scripts/validate-delivery-run.mjs',
    '--manifest',
    'harness/manifests/checkpoint-backup.json',
    '--run',
    'harness/tests/fixtures/checkpoint-backup-delivery-run-pass.json',
    '--allow-missing-artifact-paths',
  ])

  assert.match(stdout, /Harness delivery run validation passed/)
  assert.match(stdout, /Feature: checkpoint-backup/)
  assert.match(stdout, /Platform acceptance: evidence_boundary/)
})

test('validate-delivery-run rejects missing isolation, evidence, review, and platform inputs', async () => {
  await assert.rejects(
    () => runNode([
      'harness/scripts/validate-delivery-run.mjs',
      '--manifest',
      'harness/manifests/harness-autodev-kit.json',
      '--run',
      'harness/tests/fixtures/delivery-run-fail.json',
    ]),
    (error) => {
      assert.match(error.stderr, /Harness delivery run validation failed/)
      assert.match(error.stderr, /run.environment.isolated/)
      assert.match(error.stderr, /review.blockingFindings/)
      assert.match(error.stderr, /platformAcceptance.milestoneId/)
      return true
    },
  )
})

test('validate-delivery-run rejects a task marked done while awaiting human input', async () => {
  const run = await readPassDeliveryRun()
  run.waiting = [
    {
      taskId: 'clarify-delivery-inputs',
      waitType: 'clarification',
      state: 'awaiting_human',
      reason: 'Need the human to choose whether to run live Harness acceptance.',
      resumeCriteria: 'Human selects a live verification policy.',
      blockedNextStages: ['dev_orchestration', 'env_prepare', 'develop', 'deploy_ephemeral', 'test_api', 'test_e2e'],
    },
  ]

  const { dir, filePath } = await writeTempJson('agent-manager-harness-waiting-', run)
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
        assert.match(error.stderr, /tasks\.clarify-delivery-inputs\.status/)
        assert.match(error.stderr, /must remain in_progress while awaiting human input/)
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('validate-delivery-run rejects incomplete awaiting-human metadata', async () => {
  const run = await readPassDeliveryRun()
  run.tasks = run.tasks.map((task) => {
    if (task.id === 'clarify-delivery-inputs') {
      return {
        ...task,
        status: 'in_progress',
        output: {
          state: 'awaiting_human',
          waitType: 'clarification',
          reason: 'Need the human to choose whether live validation is allowed.',
        },
      }
    }
    return { ...task, status: 'skipped', skippedReason: 'Blocked behind human clarification' }
  })
  run.waiting = [
    {
      taskId: 'clarify-delivery-inputs',
      waitType: 'clarification',
      state: 'awaiting_human',
      reason: 'Need the human to choose whether live validation is allowed.',
    },
  ]

  const { dir, filePath } = await writeTempJson('agent-manager-harness-waiting-', run)
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
        assert.match(error.stderr, /waiting\[0\]\.resumeCriteria/)
        assert.match(error.stderr, /tasks\.clarify-delivery-inputs\.output\.blockedNextStages/)
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('validate-delivery-run rejects completed output while platform task is still in progress', async () => {
  const run = await readPassDeliveryRun()
  const task = run.tasks.find((item) => item.id === 'api-delivery-check')
  task.status = 'in_progress'
  task.output = {
    state: 'completed',
    summary: 'API evidence exists but platform status did not become done.',
  }

  const { dir, filePath } = await writeTempJson('agent-manager-status-mismatch-', run)
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
        assert.match(error.stderr, /tasks\.api-delivery-check\.status/)
        assert.match(error.stderr, /must be done when output\.state is completed/)
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('review-delivery-scope accepts files inside manifest writeScope', async () => {
  const { stdout } = await runNode([
    'harness/scripts/review-delivery-scope.mjs',
    '--manifest',
    'harness/manifests/harness-autodev-kit.json',
    '--changed-files',
    'harness/tests/fixtures/delivery-changed-files-pass.txt',
  ])
  const result = JSON.parse(stdout)

  assert.equal(result.status, 'passed')
  assert.deepEqual(result.outOfScopeFiles, [])
})

test('plan-parallel-waves serializes independent tasks that share a resource lock', async () => {
  const { stdout } = await runNode([
    'harness/scripts/plan-parallel-waves.mjs',
    '--manifest',
    'harness/manifests/harness-autodev-kit.json',
  ])
  const result = JSON.parse(stdout)

  const waveFor = (taskId) => result.waves.find((wave) => wave.tasks.includes(taskId))?.index
  assert.notEqual(waveFor('build-skill-package'), waveFor('build-delivery-tools'))
  assert.ok(
    result.serializedByLocks.some((item) => (
      item.taskId === 'build-delivery-tools'
      && item.blockedBy === 'build-skill-package'
      && item.resourceLocks.includes('file:harness')
    )),
  )
})

test('plan-parallel-waves keeps disjoint ready tasks in the same wave', async () => {
  const manifest = {
    schemaVersion: '1.0',
    featureId: 'parallel-fixture',
    title: 'Parallel Fixture',
    tasks: [
      {
        id: 'dev_orchestration',
        stage: 'dev_orchestration',
        dependsOn: [],
        resources: [],
        writeScope: [],
      },
      {
        id: 'backend',
        stage: 'develop',
        dependsOn: ['dev_orchestration'],
        resources: ['file:backend'],
        writeScope: ['agent-manager/server/routes/example.js'],
      },
      {
        id: 'frontend',
        stage: 'develop',
        dependsOn: ['dev_orchestration'],
        resources: ['file:frontend'],
        writeScope: ['agent-manager/src/components/Example.tsx'],
      },
    ],
  }
  const { dir, filePath } = await writeTempJson('agent-manager-harness-parallel-', manifest)
  try {
    const { stdout } = await runNode([
      'harness/scripts/plan-parallel-waves.mjs',
      '--manifest',
      filePath,
    ])
    const result = JSON.parse(stdout)
    const waveFor = (taskId) => result.waves.find((wave) => wave.tasks.includes(taskId))?.index

    assert.equal(waveFor('backend'), waveFor('frontend'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('run-parallel-flow-trial passes a trial with overlapping disjoint tasks', async () => {
  const { stdout } = await runNode([
    'harness/scripts/run-parallel-flow-trial.mjs',
    '--manifest',
    'harness/tests/fixtures/parallel-flow-trial.json',
    '--trial',
    'harness/tests/fixtures/parallel-flow-trial.json',
  ])
  const result = JSON.parse(stdout)

  assert.equal(result.status, 'passed')

  const waves = result.waves || []
  const concurrentWave = waves.find((wave) => (wave.tasks || []).length >= 2)
  assert.ok(concurrentWave, 'expected at least one wave with two concurrent tasks')

  assert.ok(
    (result.parallelism?.observedMax || 0) >= 2,
    'expected observedMax to be calculated from overlapping task intervals',
  )
  const taskIntervals = concurrentWave.tasks
    .map((task) => (
      typeof task === 'string'
        ? result.tasks?.find?.((record) => record.taskId === task) || result.tasks?.[task]
        : task
    ))
    .filter(Boolean)
  const hasOverlappingIntervals = taskIntervals.some((left, leftIndex) => taskIntervals.some((right, rightIndex) => {
    if (leftIndex >= rightIndex) return false
    const leftEnd = left.finishedAt || left.endedAt
    const rightEnd = right.finishedAt || right.endedAt
    if (!left.startedAt || !leftEnd || !right.startedAt || !rightEnd) return false
    return new Date(left.startedAt) < new Date(rightEnd)
      && new Date(right.startedAt) < new Date(leftEnd)
  }))

  assert.ok(hasOverlappingIntervals, 'expected overlapping task time intervals')
  assert.ok(result.tasks.some((record) => record.stdout?.includes('api route done')))
  assert.ok(result.tasks.some((record) => record.stdout?.includes('ui panel done')))
})

test('run-parallel-flow-trial runs checkpoint backup backend and frontend work in parallel', async () => {
  const { stdout } = await runNode([
    'harness/scripts/run-parallel-flow-trial.mjs',
    '--manifest',
    'harness/manifests/checkpoint-backup.json',
    '--trial',
    'harness/tests/fixtures/checkpoint-backup-parallel-trial.json',
  ])
  const result = JSON.parse(stdout)
  const waveFor = (taskId) => result.waves.find((wave) => wave.tasks.includes(taskId))?.index

  assert.equal(result.status, 'passed')
  assert.equal(waveFor('backend-backup-api'), waveFor('frontend-backup-ui'))
  assert.ok((result.parallelism?.observedMax || 0) >= 2)
  assert.ok(result.tasks.some((record) => record.stdout?.includes('checkpoint backend done')))
  assert.ok(result.tasks.some((record) => record.stdout?.includes('checkpoint frontend done')))
})

test('run-parallel-flow-trial rejects a trial with same-wave lock conflicts', async () => {
  await assert.rejects(
    () => runNode([
      'harness/scripts/run-parallel-flow-trial.mjs',
      '--manifest',
      'harness/tests/fixtures/parallel-flow-lock-conflict.json',
      '--trial',
      'harness/tests/fixtures/parallel-flow-lock-conflict.json',
    ]),
    (error) => {
      assert.match(`${error.stdout}\n${error.stderr}`, /conflict/i)
      return true
    },
  )
})

test('check-platform-readiness passes when the current agent owns the work item task', async () => {
  const { stdout } = await runNode([
    'harness/scripts/check-platform-readiness.mjs',
    '--input',
    'harness/tests/fixtures/platform-readiness-owned.json',
  ])
  const result = JSON.parse(stdout)

  assert.equal(result.status, 'ready')
  assert.equal(result.taskUpdateAllowed, true)
  assert.equal(result.currentAgentId, 'agent-current')
  assert.equal(result.assignedAgentId, 'agent-current')
  assert.match(result.nextCommands.startTask, /harness task update 'task-dev-orchestration' in_progress/)
})

test('check-platform-readiness blocks when the work item is assigned elsewhere', async () => {
  await assert.rejects(
    () => runNode([
      'harness/scripts/check-platform-readiness.mjs',
      '--input',
      'harness/tests/fixtures/platform-readiness-assigned-elsewhere.json',
      '--report-task-id',
      'owned-report-task',
    ]),
    (error) => {
      const result = JSON.parse(error.stdout)
      assert.equal(result.status, 'awaiting_human')
      assert.equal(result.taskUpdateAllowed, false)
      assert.equal(result.platformAcceptance.claimedPlatformComplete, false)
      assert.match(result.waitingOutput.reason, /assigned to agent-other/)
      assert.deepEqual(result.waitingOutput.blockedNextStages, [
        'dev_orchestration',
        'env_prepare',
        'develop',
        'test_unit',
        'deploy_ephemeral',
        'test_api',
        'test_e2e',
        'integration_live',
        'code_review',
        'deploy',
      ])
      assert.match(result.reportingCommands.blockerMilestone, /owned-report-task/)
      assert.match(result.reportingCommands.ask, /重新指派给当前 agent/)
      return true
    },
  )
})

test('check-platform-readiness rejects unsafe command identifiers', async () => {
  const payload = {
    agent: { agentId: 'agent-current' },
    workItem: {
      id: 'wi-owned',
      status: 'in_progress',
      assigneeAgentId: 'agent-current',
      tasks: [
        {
          id: 'task-dev-orchestration;rm',
          type: 'dev_orchestration',
          status: 'pending',
          agentId: 'agent-current',
        },
      ],
    },
  }
  const { dir, filePath } = await writeTempJson('agent-manager-harness-platform-', payload)
  try {
    await assert.rejects(
      () => runNode([
        'harness/scripts/check-platform-readiness.mjs',
        '--input',
        filePath,
      ]),
      (error) => {
        assert.match(error.stderr, /task id contains unsafe characters/)
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('check-platform-readiness does not treat work-item assignee fields as current agent identity', async () => {
  const workItemPayload = {
    id: 'wi-owned',
    status: 'in_progress',
    assigneeAgentId: 'agent-other',
    tasks: [
      {
        id: 'task-dev-orchestration',
        type: 'dev_orchestration',
        status: 'pending',
        agentId: 'agent-other',
      },
    ],
  }
  const agentPayload = {
    assigneeAgentId: 'agent-other',
  }
  const workItem = await writeTempJson('agent-manager-harness-work-item-', workItemPayload)
  const agent = await writeTempJson('agent-manager-harness-agent-', agentPayload)
  try {
    await assert.rejects(
      () => runNode([
        'harness/scripts/check-platform-readiness.mjs',
        '--work-item',
        workItem.filePath,
        '--agent',
        agent.filePath,
      ]),
      (error) => {
        assert.match(error.stderr, /current agent id is required/)
        return true
      },
    )
  } finally {
    await rm(workItem.dir, { recursive: true, force: true })
    await rm(agent.dir, { recursive: true, force: true })
  }
})

test('check-platform-readiness rejects input paths outside the repository and tmp', async () => {
  await assert.rejects(
    () => runNode([
      'harness/scripts/check-platform-readiness.mjs',
      '--input',
      '../../../../etc/passwd',
    ]),
    (error) => {
      assert.match(error.stderr, /Input path must stay inside the repository or \/tmp/)
      return true
    },
  )
})

test('review-delivery-scope rejects files outside manifest writeScope', async () => {
  await assert.rejects(
    () => runNode([
      'harness/scripts/review-delivery-scope.mjs',
      '--manifest',
      'harness/manifests/harness-autodev-kit.json',
      '--changed-files',
      'harness/tests/fixtures/delivery-changed-files-fail.txt',
    ]),
    (error) => {
      assert.match(error.stdout, /"status": "failed"/)
      assert.match(error.stdout, /agent-manager\/src\/App\.tsx/)
      return true
    },
  )
})

test('render-delivery-report emits a compact feature report', async () => {
  const { stdout } = await runNode([
    'harness/scripts/render-delivery-report.mjs',
    '--run',
    'harness/tests/fixtures/delivery-run-pass.json',
  ])

  assert.match(stdout, /Harness Delivery Report: harness-autodev-kit/)
  assert.match(stdout, /build-skill-package/)
  assert.match(stdout, /unit-harness-delivery-tools/)
  assert.match(stdout, /## 隔离环境/)
  assert.match(stdout, /## 浏览器证据/)
  assert.match(stdout, /体验入口/)
  assert.match(stdout, /## 集成测试/)
  assert.match(stdout, /evidence_boundary/)
})

test('classify-integration-failure auto-continues only external-only failures', async () => {
  const failures = await writeTempJson('agent-manager-integration-failures-', {
    failures: [
      {
        name: 'hermes-upgrade live retention',
        message: 'Failed to connect to E2B API api.agent-vpc.infra: The operation was aborted due to timeout',
      },
      {
        name: 'checkpoint scheduled backup',
        message: 'OOS backup template not configured in this environment',
      },
    ],
  })
  try {
    const { stdout } = await runNode([
      'harness/scripts/classify-integration-failure.mjs',
      '--input',
      failures.filePath,
      '--feature-id',
      'runtime-diagnostics',
    ])
    const result = JSON.parse(stdout)

    assert.equal(result.status, 'external_only_auto_continue')
    assert.equal(result.recommendedAction, 'continue_downstream')
    assert.equal(result.relatedFailures, 0)
    assert.equal(result.unrelatedFailures, 0)
    assert.equal(result.externalFailures, 2)
  } finally {
    await rm(failures.dir, { recursive: true, force: true })
  }
})

test('classify-integration-failure treats missing OOS template as external before feature matching', async () => {
  const failures = await writeTempJson('agent-manager-integration-failures-', {
    failures: [
      {
        name: 'checkpoint scheduled backup',
        message: 'OOS backup template not configured in this environment',
      },
    ],
  })
  try {
    const { stdout } = await runNode([
      'harness/scripts/classify-integration-failure.mjs',
      '--input',
      failures.filePath,
      '--feature-id',
      'checkpoint-backup',
    ])
    const result = JSON.parse(stdout)

    assert.equal(result.status, 'external_only_auto_continue')
    assert.equal(result.recommendedAction, 'continue_downstream')
    assert.equal(result.relatedFailures, 0)
    assert.equal(result.externalFailures, 1)
    assert.match(result.samples.external.join('\n'), /oos_template_missing/)
  } finally {
    await rm(failures.dir, { recursive: true, force: true })
  }
})

test('classify-integration-failure waits when unrelated failures are mixed in', async () => {
  const failures = await writeTempJson('agent-manager-integration-failures-', {
    failures: [
      {
        name: 'skill-injection',
        message: 'adminClient.get is not a function',
      },
      {
        name: 'instance lifecycle',
        message: 'Failed to connect to E2B API api.agent-vpc.infra',
      },
    ],
  })
  try {
    const { stdout } = await runNode([
      'harness/scripts/classify-integration-failure.mjs',
      '--input',
      failures.filePath,
      '--feature-id',
      'runtime-diagnostics',
    ])
    const result = JSON.parse(stdout)

    assert.equal(result.status, 'unrelated_failures_require_triage')
    assert.equal(result.recommendedAction, 'await_human')
    assert.deepEqual(result.blockedNextStages, ['code_review', 'deploy'])
  } finally {
    await rm(failures.dir, { recursive: true, force: true })
  }
})

test('validate-delivery-run accepts external-only integration auto-continue evidence', async () => {
  const run = await readPassDeliveryRun()
  const integrationTest = run.tests.find((test) => test.stage === 'integration_live')
  integrationTest.exitCode = 1
  integrationTest.testsPassed = 177
  integrationTest.totalTests = 191
  delete integrationTest.liveEvidence
  integrationTest.reportUrl = 'harness://artifacts/harness-autodev-kit/integration-failure.md'
  integrationTest.failureClassification = {
    schemaVersion: '1.0',
    featureId: 'runtime-diagnostics',
    status: 'external_only_auto_continue',
    recommendedAction: 'continue_downstream',
    relatedFailures: 0,
    externalFailures: 2,
    unrelatedFailures: 0,
    relatedToFeature: false,
    externalOnlyAutoContinue: true,
  }

  const { dir, filePath } = await writeTempJson('agent-manager-integration-auto-', run)
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

test('validate-delivery-run rejects generic browser evidence for feature E2E', async () => {
  const run = await readPassDeliveryRun()
  const e2e = run.tests.find((test) => test.stage === 'test_e2e')
  e2e.experienceUrl = 'https://openclaw-platform.example.invalid/login'
  e2e.featureAssertions = ['登录页可以打开']
  e2e.screenshots = [
    {
      kind: 'screenshot',
      target: 'login page',
      targetPath: '/login',
      url: 'https://harness.example.invalid/artifacts/harness-autodev-kit/login.png',
    },
  ]
  e2e.artifacts = []

  const { dir, filePath } = await writeTempJson('agent-manager-e2e-generic-', run)
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
        assert.match(error.stderr, /tests\.e2e-delivery-report\.evidence/)
        assert.match(error.stderr, /must mention the feature harness-autodev-kit/)
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('validate-delivery-run rejects missing manifest-required post-action readback', async () => {
  const run = await readPassDeliveryRun()
  const e2e = run.tests.find((test) => test.id === 'e2e-delivery-report')
  for (const screenshot of e2e.screenshots) delete screenshot.phase

  const { dir, filePath } = await writeTempJson('agent-manager-e2e-post-action-', run)
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
        assert.match(error.stderr, /post_action_readback/)
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('check-workflow-completion blocks downstream work while integration awaits human', async () => {
  const run = await readPassDeliveryRun()
  const integrationTask = run.tasks.find((task) => task.stage === 'integration_live')
  integrationTask.status = 'in_progress'
  integrationTask.output = {
    state: 'awaiting_human',
    waitType: 'clarification',
    reason: 'Unrelated integration failures require triage.',
    resumeCriteria: 'Human chooses continue, rerun, or loop back.',
    blockedNextStages: ['code_review', 'deploy'],
  }
  run.waiting = [
    {
      taskId: integrationTask.id,
      waitType: 'clarification',
      state: 'awaiting_human',
      reason: integrationTask.output.reason,
      resumeCriteria: integrationTask.output.resumeCriteria,
      blockedNextStages: integrationTask.output.blockedNextStages,
    },
  ]
  const integrationTest = run.tests.find((test) => test.stage === 'integration_live')
  integrationTest.exitCode = 1
  integrationTest.failureClassification = {
    schemaVersion: '1.0',
    featureId: 'runtime-diagnostics',
    status: 'unrelated_failures_require_triage',
    recommendedAction: 'await_human',
    relatedFailures: 0,
    externalFailures: 1,
    unrelatedFailures: 1,
    relatedToFeature: false,
  }

  const { dir, filePath } = await writeTempJson('agent-manager-workflow-completion-', run)
  try {
    await assert.rejects(
      () => runNode([
        'harness/scripts/check-workflow-completion.mjs',
        '--manifest',
        'harness/manifests/harness-autodev-kit.json',
        '--run',
        filePath,
      ]),
      (error) => {
        const result = JSON.parse(error.stdout)
        assert.equal(result.status, 'blocked')
        assert.match(result.errors.join('\n'), /integration_live awaits human/)
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('check-workflow-completion blocks task status and output state mismatch', async () => {
  const run = await readPassDeliveryRun()
  const task = run.tasks.find((item) => item.id === 'api-delivery-check')
  task.status = 'in_progress'
  task.output = {
    state: 'completed',
    summary: 'API evidence exists but platform status did not become done.',
  }

  const { dir, filePath } = await writeTempJson('agent-manager-workflow-status-mismatch-', run)
  try {
    await assert.rejects(
      () => runNode([
        'harness/scripts/check-workflow-completion.mjs',
        '--manifest',
        'harness/manifests/harness-autodev-kit.json',
        '--run',
        filePath,
      ]),
      (error) => {
        const result = JSON.parse(error.stdout)
        assert.equal(result.status, 'blocked')
        assert.match(result.errors.join('\n'), /api-delivery-check output\.state is completed but task status is in_progress/)
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('check-workflow-completion accepts the checked-in successful delivery run', async () => {
  const { stdout } = await runNode([
    'harness/scripts/check-workflow-completion.mjs',
    '--manifest',
    'harness/manifests/harness-autodev-kit.json',
    '--run',
    'harness/tests/fixtures/delivery-run-pass.json',
  ])
  const result = JSON.parse(stdout)

  assert.equal(result.status, 'passed')
})

test('check-workflow-completion rejects a missing manifest-declared E2E test', async () => {
  const run = await readPassDeliveryRun()
  run.tests = run.tests.filter((test) => test.id !== 'e2e-delivery-report')

  const { dir, filePath } = await writeTempJson('agent-manager-workflow-missing-e2e-', run)
  try {
    await assert.rejects(
      () => runNode([
        'harness/scripts/check-workflow-completion.mjs',
        '--manifest',
        'harness/manifests/harness-autodev-kit.json',
        '--run',
        filePath,
      ]),
      (error) => {
        const result = JSON.parse(error.stdout)
        assert.equal(result.status, 'blocked')
        assert.match(result.errors.join('\n'), /required test e2e-delivery-report is missing/)
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('check-workflow-completion rejects a manifest test reported under another stage', async () => {
  const run = await readPassDeliveryRun()
  const e2e = run.tests.find((test) => test.id === 'e2e-delivery-report')
  e2e.stage = 'test_unit'
  delete e2e.screenshots
  delete e2e.assertionResults
  delete e2e.actionResults

  const { dir, filePath } = await writeTempJson('agent-manager-workflow-wrong-stage-', run)
  try {
    await assert.rejects(
      () => runNode([
        'harness/scripts/check-workflow-completion.mjs',
        '--manifest',
        'harness/manifests/harness-autodev-kit.json',
        '--run',
        filePath,
      ]),
      (error) => {
        const result = JSON.parse(error.stdout)
        assert.equal(result.status, 'blocked')
        assert.match(result.errors.join('\n'), /belongs to stage test_e2e, but the delivery run reports test_unit/)
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('check-workflow-completion blocks generic E2E screenshots before final completion', async () => {
  const run = await readPassDeliveryRun()
  const e2e = run.tests.find((test) => test.stage === 'test_e2e')
  e2e.experienceUrl = 'https://openclaw-platform.example.invalid/login'
  e2e.featureAssertions = ['登录页可以打开']
  e2e.screenshots = [
    {
      kind: 'screenshot',
      target: 'login page',
      targetPath: '/login',
      url: 'https://harness.example.invalid/artifacts/harness-autodev-kit/login.png',
    },
  ]
  e2e.artifacts = []

  const { dir, filePath } = await writeTempJson('agent-manager-workflow-e2e-generic-', run)
  try {
    await assert.rejects(
      () => runNode([
        'harness/scripts/check-workflow-completion.mjs',
        '--manifest',
        'harness/manifests/harness-autodev-kit.json',
        '--run',
        filePath,
      ]),
      (error) => {
        const result = JSON.parse(error.stdout)
        assert.equal(result.status, 'blocked')
        assert.match(result.errors.join('\n'), /evidence does not mention the feature harness-autodev-kit/)
        assert.equal(result.nextAction, 'fix_blocking_gate_before_downstream')
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('check-workflow-completion blocks a missing required post-action readback screenshot', async () => {
  const run = await readPassDeliveryRun()
  const e2e = run.tests.find((test) => test.id === 'e2e-delivery-report')
  for (const screenshot of e2e.screenshots) delete screenshot.phase

  const { dir, filePath } = await writeTempJson('agent-manager-workflow-post-action-', run)
  try {
    await assert.rejects(
      () => runNode([
        'harness/scripts/check-workflow-completion.mjs',
        '--manifest',
        'harness/manifests/harness-autodev-kit.json',
        '--run',
        filePath,
      ]),
      (error) => {
        const result = JSON.parse(error.stdout)
        assert.equal(result.status, 'blocked')
        assert.match(result.errors.join('\n'), /post_action_readback/)
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('aone-lifecycle dry-run renders a safe wrapper command without secrets', async () => {
  const { stdout } = await runNode([
    'harness/scripts/aone-lifecycle.mjs',
    'env-create',
    '--work-item',
    'WI-TEST',
    '--task-id',
    'TASK-TEST',
    '--branch',
    'harness/test',
    '--namespace',
    'am-harness-test',
    '--pipeline-id',
    '237756',
    '--dry-run',
    '--no-write-harness',
  ])
  const result = JSON.parse(stdout)

  assert.equal(result.stage, 'env_prepare')
  assert.equal(result.state, 'dry_run')
  assert.equal(result.ci.pipelineId, '237756')
  const commandText = Array.isArray(result.plannedCommand)
    ? result.plannedCommand.join(' ')
    : result.ci.command
  assert.match(commandText, /a1 ci pipeline run 237756/)
  assert.doesNotMatch(JSON.stringify(result), /AutoPilotSecret|owner-token|kubeconfig/i)
})

test('aone-lifecycle deploy-image resolves the build-deploy pipeline path', async () => {
  const { executeLifecycle } = await import('../scripts/aone-lifecycle.mjs')
  const calls = []
  const gitPreflight = createGitPreflightHandler({ yamlPath: '.aoneci/harness_build_deploy.yaml' })
  const runner = async (command, args) => {
    calls.push([command, args])
    const gitResult = await gitPreflight(command, args)
    if (gitResult) return gitResult
    if (command === 'a1' && args.join(' ') === 'ci pipeline list --repo acs-automation/agent-manager --format json') {
      return {
        stdout: JSON.stringify({
          pipelines: [{ id: '237838', yamlPath: '.aoneci/harness_build_deploy.yaml' }],
        }),
      }
    }
    if (command === 'a1' && args.slice(0, 3).join(' ') === 'ci run list') {
      return { stdout: JSON.stringify({ runs: [] }) }
    }
    if (command === 'a1' && args.slice(0, 3).join(' ') === 'ci pipeline run') {
      return {
        stdout: JSON.stringify({
          runId: '51330001',
          status: 'SUCCESS',
          url: 'https://code.alibaba-inc.com/example/run/51330001',
          outputs: {
            PlatformUrl: 'https://am-harness-test.example.invalid',
            ApiHealthUrl: 'https://am-harness-test.example.invalid/api/health',
            Namespace: 'am-harness-test',
            ServiceName: 'openclaw-platform',
            StackName: 'harness-test',
            AgentManagerImage: 'registry.example.invalid/agent-manager:test',
          },
        }),
      }
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  }

  const result = await executeLifecycle('deploy-image', {
    workItemId: 'WI-TEST',
    taskId: 'TASK-DEPLOY',
    branch: 'harness/test',
    namespace: 'am-harness-test',
    noWriteHarness: true,
  }, {
    runner,
    domain: {
      ciPipelines: {
        repo: 'acs-automation/agent-manager',
        lifecycle: {},
      },
    },
    now: () => '2026-07-08T00:00:00.000Z',
  })

  assert.equal(result.state, 'completed')
  assert.equal(result.ci.pipelineId, '237838')
  assert.ok(calls.some(([command, args]) => (
    command === 'a1'
      && args.join(' ') === 'ci pipeline run 237838 --repo acs-automation/agent-manager --branch harness/test --param work_item_id=WI-TEST --param image_tag=wi-test-harness-test --param namespace=am-harness-test --param service_name=openclaw-platform --param ros_region=cn-hongkong --param ros_template_path=template/platform_template.yaml --watch --format json'
  )))
})

test('aone-lifecycle normalizes legacy hm namespace before triggering AOneCI', async () => {
  const { executeLifecycle } = await import('../scripts/aone-lifecycle.mjs')
  const calls = []
  const gitPreflight = createGitPreflightHandler({ branch: 'harness/test' })
  const runner = async (command, args) => {
    calls.push([command, args])
    const gitResult = await gitPreflight(command, args)
    if (gitResult) return gitResult
    if (command === 'a1' && args.join(' ') === 'ci pipeline list --repo acs-automation/agent-manager --format json') {
      return {
        stdout: JSON.stringify({
          pipelines: [{ id: '237756', yamlPath: '.aoneci/harness_env_create.yaml' }],
        }),
      }
    }
    if (command === 'a1' && args.slice(0, 3).join(' ') === 'ci run list') {
      return { stdout: JSON.stringify({ runs: [] }) }
    }
    if (command === 'a1' && args.slice(0, 3).join(' ') === 'ci pipeline run') {
      return {
        stdout: JSON.stringify({
          runId: '51340001',
          status: 'SUCCESS',
          url: 'https://code.alibaba-inc.com/example/run/51340001',
          outputs: {
            PlatformUrl: 'https://am-harness-b712b3db089d.example.invalid',
            ApiHealthUrl: 'https://am-harness-b712b3db089d.example.invalid/api/health',
            Namespace: 'am-harness-b712b3db089d',
            ServiceName: 'openclaw-platform',
            StackName: 'harness-test',
          },
        }),
      }
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  }

  const result = await executeLifecycle('env-create', {
    workItemId: 'WI-TEST',
    taskId: 'TASK-ENV',
    branch: 'harness/test',
    namespace: 'hm-b712b3db089d',
    noWriteHarness: true,
  }, {
    runner,
    domain: {
      ciPipelines: {
        repo: 'acs-automation/agent-manager',
        lifecycle: {},
      },
    },
    now: () => '2026-07-08T00:00:00.000Z',
  })

  assert.equal(result.state, 'completed')
  assert.equal(result.environment.namespace, 'am-harness-b712b3db089d')
  assert.ok(calls.some(([command, args]) => (
    command === 'a1'
      && args.includes('--param')
      && args.includes('namespace=am-harness-b712b3db089d')
  )))
  assert.ok(!calls.some(([command, args]) => (
    command === 'a1'
      && args.includes('namespace=hm-b712b3db089d')
  )))
})

test('aone-lifecycle reuses an explicit run id without triggering another pipeline', async () => {
  const { executeLifecycle } = await import('../scripts/aone-lifecycle.mjs')
  const calls = []
  const runner = async (command, args) => {
    calls.push([command, args])
    if (command === 'a1' && args.join(' ') === 'ci pipeline list --repo acs-automation/agent-manager --format json') {
      return {
        stdout: JSON.stringify({
          pipelines: [{ id: '237756', yamlPath: '.aoneci/harness_env_create.yaml' }],
        }),
      }
    }
    if (command === 'a1' && args.join(' ') === 'ci run get 51543540 --repo acs-automation/agent-manager --format json') {
      return {
        stdout: JSON.stringify({
          id: 51543540,
          pipelineId: 237756,
          status: 'SUCCESS',
          branch: 'harness/test',
          url: 'https://code.alibaba-inc.com/example/run/51543540',
          outputs: {},
        }),
      }
    }
    if (command === 'a1' && args.join(' ') === 'ci run log 51543540 --repo acs-automation/agent-manager --all --format plain') {
      return {
        stdout: `
Harness 隔离环境创建完成
namespace: am-harness-b712b3db089d
service:   openclaw-platform
baseUrl:   http://8.217.143.106:8080
apiHealth: http://8.217.143.106:8080/api/health
ros:       harness-test / 623f1381-ca7e-4ce7-8292-9f53d7c25d46
`,
      }
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  }

  const result = await executeLifecycle('env-create', {
    workItemId: 'WI-TEST',
    taskId: 'TASK-ENV',
    branch: 'harness/test',
    namespace: 'hm-b712b3db089d',
    runId: '51543540',
    noWriteHarness: true,
  }, {
    runner,
    domain: {
      ciPipelines: {
        repo: 'acs-automation/agent-manager',
        lifecycle: {},
      },
    },
    now: () => '2026-07-08T00:00:00.000Z',
  })

  assert.equal(result.state, 'completed')
  assert.equal(result.ci.runId, 51543540)
  assert.equal(result.environment.namespace, 'am-harness-b712b3db089d')
  assert.equal(result.environment.baseUrl, 'http://8.217.143.106:8080')
  assert.match(result.diagnostics.join('\n'), /reused explicit AOneCI run 51543540/)
  assert.ok(!calls.some(([command, args]) => (
    command === 'a1' && args.slice(0, 3).join(' ') === 'ci pipeline run'
  )))
})

test('aone-lifecycle does not recover a run by querying the pipeline id as run id', async () => {
  const { executeLifecycle } = await import('../scripts/aone-lifecycle.mjs')
  const calls = []
  const gitPreflight = createGitPreflightHandler({ yamlPath: '.aoneci/harness_build_deploy.yaml' })
  const runner = async (command, args) => {
    calls.push([command, args])
    const gitResult = await gitPreflight(command, args)
    if (gitResult) return gitResult
    if (command === 'a1' && args.join(' ') === 'ci pipeline list --repo acs-automation/agent-manager --format json') {
      return {
        stdout: JSON.stringify({
          pipelines: [{ id: '237838', yamlPath: '.aoneci/harness_build_deploy.yaml' }],
        }),
      }
    }
    if (command === 'a1' && args.slice(0, 3).join(' ') === 'ci run list') {
      return { stdout: JSON.stringify({ runs: [] }) }
    }
    if (command === 'a1' && args.slice(0, 3).join(' ') === 'ci pipeline get') {
      return { stdout: JSON.stringify({}) }
    }
    if (command === 'a1' && args.slice(0, 3).join(' ') === 'ci pipeline run') {
      const error = new Error('a1-server error: {"status":403,"instance":"/openapi/v1/projects/3871761/runs/237838"}')
      error.stderr = 'Access Denied'
      throw error
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  }

  const result = await executeLifecycle('deploy-image', {
    workItemId: 'WI-TEST',
    taskId: 'TASK-DEPLOY',
    branch: 'harness/test',
    namespace: 'am-harness-test',
    noWriteHarness: true,
  }, {
    runner,
    domain: {
      ciPipelines: {
        repo: 'acs-automation/agent-manager',
        lifecycle: {},
      },
    },
    now: () => '2026-07-08T00:00:00.000Z',
  })

  assert.equal(result.state, 'failed')
  assert.match(result.diagnostics.join('\n'), /ignored extracted run id 237838 because it matches pipeline id 237838/)
  assert.ok(!calls.some(([command, args]) => (
    command === 'a1' && args.join(' ') === 'ci run get 237838 --repo acs-automation/agent-manager --format json'
  )))
})

test('aone-lifecycle success writes task output and log without creating a milestone gate', async () => {
  const { executeLifecycle } = await import('../scripts/aone-lifecycle.mjs')
  const calls = []
  const completedPayloads = []
  const gitPreflight = createGitPreflightHandler()
  const runner = async (command, args) => {
    calls.push([command, args])
    const gitResult = await gitPreflight(command, args)
    if (gitResult) return gitResult
    if (command === 'a1' && args.join(' ') === 'ci pipeline list --repo acs-automation/agent-manager --format json') {
      return {
        stdout: JSON.stringify({
          pipelines: [{ id: '237756', yamlPath: '.aoneci/harness_env_create.yaml' }],
        }),
      }
    }
    if (command === 'a1' && args.slice(0, 3).join(' ') === 'ci run list') {
      return { stdout: JSON.stringify({ runs: [] }) }
    }
    if (command === 'a1' && args.slice(0, 3).join(' ') === 'ci pipeline run') {
      return {
        stdout: JSON.stringify({
          runId: '51297984',
          status: 'SUCCESS',
          url: 'https://code.alibaba-inc.com/example/run/51297984',
          outputs: {
            PlatformUrl: 'https://am-harness-test.example.invalid',
            ApiHealthUrl: 'https://am-harness-test.example.invalid/api/health',
            Namespace: 'am-harness-test',
            ServiceName: 'openclaw-platform',
            StackName: 'harness-test',
            AgentManagerImage: 'registry.example.invalid/agent-manager:test',
          },
        }),
      }
    }
    if (command === process.execPath && args[0] === 'harness/scripts/complete-stage.mjs') {
      const outputPath = args[args.indexOf('--output') + 1]
      completedPayloads.push(JSON.parse(await readFile(outputPath, 'utf8')))
      return { stdout: 'Stage output check passed: env_prepare\n' }
    }
    if (command === 'harness') return { stdout: '{}' }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  }

  const result = await executeLifecycle('env-create', {
    workItemId: 'WI-TEST',
    taskId: 'TASK-TEST',
    branch: 'harness/test',
    namespace: 'am-harness-test',
  }, {
    runner,
    domain: {
      ciPipelines: {
        repo: 'acs-automation/agent-manager',
        lifecycle: {
          envCreate: { yamlPath: '.aoneci/harness_env_create.yaml' },
        },
      },
    },
    now: () => '2026-07-08T00:00:00.000Z',
  })

  assert.equal(result.state, 'completed')
  assert.equal(result.ci.runId, '51297984')
  const completeCalls = calls.filter(([command, args]) => (
    command === process.execPath && args[0] === 'harness/scripts/complete-stage.mjs'
  )).map(([, args]) => args)
  assert.equal(completeCalls.length, 1)
  assert.deepEqual(completeCalls[0].slice(0, 5), [
    'harness/scripts/complete-stage.mjs',
    '--stage',
    'env_prepare',
    '--task-id',
    'TASK-TEST',
  ])
  assert.equal(completedPayloads.length, 1)
  assert.equal(completedPayloads[0].state, 'completed')
  assert.equal(completedPayloads[0].environment.baseUrl, 'https://am-harness-test.example.invalid')
  assert.ok(JSON.stringify(completedPayloads[0]).length < 12000)
  const harnessCalls = calls.filter(([command]) => command === 'harness').map(([, args]) => args)
  assert.deepEqual(harnessCalls[0].slice(0, 2), ['log', 'TASK-TEST'])
  assert.ok(!harnessCalls.some((args) => args[0] === 'milestone'))
})

test('aone-lifecycle cleanup mirrors cleanup evidence into ci before completing deploy', async () => {
  const { executeLifecycle } = await import('../scripts/aone-lifecycle.mjs')
  const calls = []
  const completedPayloads = []
  const gitPreflight = createGitPreflightHandler({ yamlPath: '.aoneci/harness_env_cleanup.yaml' })
  const runner = async (command, args) => {
    calls.push([command, args])
    const gitResult = await gitPreflight(command, args)
    if (gitResult) return gitResult
    if (command === 'a1' && args.join(' ') === 'ci pipeline list --repo acs-automation/agent-manager --format json') {
      return {
        stdout: JSON.stringify({
          pipelines: [{ id: '237755', yamlPath: '.aoneci/harness_env_cleanup.yaml' }],
        }),
      }
    }
    if (command === 'a1' && args.slice(0, 3).join(' ') === 'ci run list') {
      return { stdout: JSON.stringify({ runs: [] }) }
    }
    if (command === 'a1' && args.slice(0, 3).join(' ') === 'ci pipeline run') {
      return {
        stdout: JSON.stringify({
          runId: '51557685',
          status: 'SUCCESS',
          url: 'https://code.alibaba-inc.com/acs-automation/agent-manager/ci/jobs?pipelineId=237755&pipelineRunId=51557685&createType=yaml',
          outputs: {
            Namespace: 'am-harness-test',
            StackName: 'harness-test',
          },
        }),
      }
    }
    if (command === process.execPath && args[0] === 'harness/scripts/complete-stage.mjs') {
      const outputPath = args[args.indexOf('--output') + 1]
      completedPayloads.push(JSON.parse(await readFile(outputPath, 'utf8')))
      return { stdout: 'Stage output check passed: deploy\n' }
    }
    if (command === 'harness') return { stdout: '{}' }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  }

  const result = await executeLifecycle('cleanup', {
    workItemId: 'WI-TEST',
    taskId: 'TASK-DEPLOY',
    branch: 'harness/test',
    namespace: 'am-harness-test',
  }, {
    runner,
    domain: {
      ciPipelines: {
        repo: 'acs-automation/agent-manager',
        lifecycle: {
          envCleanup: { yamlPath: '.aoneci/harness_env_cleanup.yaml' },
        },
      },
    },
    now: () => '2026-07-08T00:00:00.000Z',
  })

  assert.equal(result.stage, 'deploy')
  assert.equal(result.action, 'cleanup')
  assert.equal(result.ci.runId, '51557685')
  assert.equal(result.cleanup.runId, '51557685')
  assert.equal(result.ci.status, 'SUCCESS')
  assert.equal(result.cleanup.status, 'SUCCESS')
  assert.equal(completedPayloads.length, 1)
  assert.equal(completedPayloads[0].ci.runId, '51557685')
  assert.equal(completedPayloads[0].ci.status, 'SUCCESS')
  assert.equal(completedPayloads[0].cleanup.runId, '51557685')
  assert.equal(completedPayloads[0].cleanup.status, 'SUCCESS')
  assert.ok(calls.some(([command, args]) => (
    command === process.execPath
      && args.join(' ').startsWith('harness/scripts/complete-stage.mjs --stage deploy --task-id TASK-DEPLOY')
  )))
  assert.ok(!calls.some(([command, args]) => command === 'harness' && args[0] === 'task' && args[1] === 'update' && args[3] === 'done'))
})

test('aone-lifecycle pushes a missing remote branch before triggering AOneCI', async () => {
  const { executeLifecycle } = await import('../scripts/aone-lifecycle.mjs')
  const calls = []
  const gitPreflight = createGitPreflightHandler({ remoteExists: false, remoteHasYaml: false })
  const runner = async (command, args) => {
    calls.push([command, args])
    const gitResult = await gitPreflight(command, args)
    if (gitResult) return gitResult
    if (command === 'a1' && args.join(' ') === 'ci pipeline list --repo acs-automation/agent-manager --format json') {
      return {
        stdout: JSON.stringify({
          pipelines: [{ id: '237756', yamlPath: '.aoneci/harness_env_create.yaml' }],
        }),
      }
    }
    if (command === 'a1' && args.slice(0, 3).join(' ') === 'ci run list') {
      return { stdout: JSON.stringify({ runs: [] }) }
    }
    if (command === 'a1' && args.slice(0, 3).join(' ') === 'ci pipeline run') {
      return {
        stdout: JSON.stringify({
          runId: '51530001',
          status: 'SUCCESS',
          url: 'https://code.alibaba-inc.com/example/run/51530001',
          outputs: {
            PlatformUrl: 'https://am-harness-test.example.invalid',
            ApiHealthUrl: 'https://am-harness-test.example.invalid/api/health',
            Namespace: 'am-harness-test',
            ServiceName: 'openclaw-platform',
          },
        }),
      }
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  }

  const result = await executeLifecycle('env-create', {
    workItemId: 'WI-TEST',
    taskId: 'TASK-TEST',
    branch: 'harness/test',
    namespace: 'am-harness-test',
    noWriteHarness: true,
  }, {
    runner,
    domain: {
      ciPipelines: {
        repo: 'acs-automation/agent-manager',
        lifecycle: {
          envCreate: { yamlPath: '.aoneci/harness_env_create.yaml' },
        },
      },
    },
    now: () => '2026-07-08T00:00:00.000Z',
  })

  assert.equal(result.state, 'completed')
  assert.match(result.diagnostics.join('\n'), /pushed local HEAD to origin\/harness\/test/)
  assert.ok(calls.some(([command, args]) => (
    command === 'git' && args.join(' ') === 'push -u origin HEAD:refs/heads/harness/test'
  )))
  assert.ok(calls.some(([command, args]) => (
    command === 'a1' && args.slice(0, 3).join(' ') === 'ci pipeline run'
  )))
})

test('aone-lifecycle blocks before AOneCI when the remote branch lacks the pipeline file', async () => {
  const { executeLifecycle } = await import('../scripts/aone-lifecycle.mjs')
  const calls = []
  const gitPreflight = createGitPreflightHandler({ remoteHasYaml: false })
  const runner = async (command, args) => {
    calls.push([command, args])
    const gitResult = await gitPreflight(command, args)
    if (gitResult) return gitResult
    if (command === 'a1' && args.join(' ') === 'ci pipeline list --repo acs-automation/agent-manager --format json') {
      return {
        stdout: JSON.stringify({
          pipelines: [{ id: '237756', yamlPath: '.aoneci/harness_env_create.yaml' }],
        }),
      }
    }
    if (command === 'a1' && args.slice(0, 3).join(' ') === 'ci run list') {
      return { stdout: JSON.stringify({ runs: [] }) }
    }
    if (command === 'a1' && args.slice(0, 3).join(' ') === 'ci pipeline get') {
      return { stdout: JSON.stringify({}) }
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  }

  const result = await executeLifecycle('env-create', {
    workItemId: 'WI-TEST',
    taskId: 'TASK-TEST',
    branch: 'harness/test',
    namespace: 'am-harness-test',
    noWriteHarness: true,
    autoPushBranch: false,
  }, {
    runner,
    domain: {
      ciPipelines: {
        repo: 'acs-automation/agent-manager',
        lifecycle: {
          envCreate: { yamlPath: '.aoneci/harness_env_create.yaml' },
        },
      },
    },
    now: () => '2026-07-08T00:00:00.000Z',
  })

  assert.equal(result.state, 'failed')
  assert.match(result.diagnostics.join('\n'), /Remote branch harness\/test does not contain \.aoneci\/harness_env_create\.yaml/)
  assert.ok(!calls.some(([command, args]) => (
    command === 'a1' && args.slice(0, 3).join(' ') === 'ci pipeline run'
  )))
})

test('aone-lifecycle recovers env evidence from AOneCI logs when run outputs are empty', async () => {
  const { executeLifecycle } = await import('../scripts/aone-lifecycle.mjs')
  const calls = []
  const gitPreflight = createGitPreflightHandler({ branch: 'harness/7677372a' })
  const runner = async (command, args) => {
    calls.push([command, args])
    const gitResult = await gitPreflight(command, args)
    if (gitResult) return gitResult
    if (command === 'a1' && args.join(' ') === 'ci pipeline list --repo acs-automation/agent-manager --format json') {
      return {
        stdout: JSON.stringify({
          pipelines: [{ id: '237756', yamlPath: '.aoneci/harness_env_create.yaml' }],
        }),
      }
    }
    if (command === 'a1' && args.slice(0, 3).join(' ') === 'ci run list') {
      return { stdout: JSON.stringify({ runs: [] }) }
    }
    if (command === 'a1' && args.slice(0, 3).join(' ') === 'ci pipeline run') {
      return {
        stdout: JSON.stringify({
          runId: '51524200',
          status: 'SUCCESS',
          url: 'https://code.alibaba-inc.com/acs-automation/agent-manager/ci/jobs?pipelineId=237756&pipelineRunId=51524200&createType=yaml',
          outputs: null,
        }),
      }
    }
    if (command === 'a1' && args.join(' ') === 'ci run log 51524200 --repo acs-automation/agent-manager --all --format plain') {
      return {
        stdout: `
NAME                TYPE           CLUSTER-IP      EXTERNAL-IP     PORT(S)          AGE   SELECTOR
openclaw-platform   LoadBalancer   172.16.36.153   47.243.22.211   8080:32341/TCP   12s   app=openclaw-platform
==========================================
Harness 隔离环境创建完成
namespace: am-harness-7677372a
service:   openclaw-platform
baseUrl:   http://127.0.0.1:18080
internal:  http://openclaw-platform.am-harness-7677372a.svc.cluster.local
ros:       harness-7677372a / 995875f1-cd74-469d-b6ae-084cda996146
==========================================
`,
      }
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  }

  const result = await executeLifecycle('env-create', {
    workItemId: '7677372a-d747-41e5-970d-b97ba1cdbcc1',
    taskId: 'TASK-ENV',
    branch: 'harness/7677372a',
    namespace: 'am-harness-7677372a',
    noWriteHarness: true,
  }, {
    runner,
    domain: {
      ciPipelines: {
        repo: 'acs-automation/agent-manager',
        lifecycle: {
          envCreate: { yamlPath: '.aoneci/harness_env_create.yaml' },
        },
      },
    },
    now: () => '2026-07-08T00:00:00.000Z',
  })

  assert.equal(result.state, 'completed')
  assert.equal(result.ci.pipelinePath, '.aoneci/harness_env_create.yaml')
  assert.equal(result.environment.namespace, 'am-harness-7677372a')
  assert.equal(result.environment.serviceName, 'openclaw-platform')
  assert.equal(result.environment.baseUrl, 'http://47.243.22.211:8080')
  assert.equal(result.environment.apiHealthUrl, 'http://47.243.22.211:8080/api/health')
  assert.match(result.diagnostics.join('\n'), /recovered environment evidence from AOneCI run log 51524200/)
  assert.ok(calls.some(([command, args]) => (
    command === 'a1' && args.join(' ') === 'ci run log 51524200 --repo acs-automation/agent-manager --all --format plain'
  )))
})
