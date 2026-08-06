#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { resolveStageSkillBindings } from './lib/cloud-skill-bindings.mjs'
import { resolveInputPath, resolveOutputPath } from './lib/path-guard.mjs'
import { manifestDigest, renderStageBinding } from './lib/stage-binding.mjs'

const defaultStageTitles = {
  clarify: '需求澄清',
  dev_orchestration: '实施编排',
  env_prepare: '隔离环境准备',
  develop: '代码开发',
  test_unit: '单元测试',
  deploy_ephemeral: '发布隔离环境',
  test_api: '隔离环境 API 测试',
  test_e2e: '隔离环境浏览器功能测试',
  integration_live: '真实集成验证',
  code_review: 'Code Review',
  deploy: '发布部署',
}

function parseArgs(argv) {
  const args = {
    name: 'agent-manager-auto-dev-v1',
    label: 'Agent Manager 自动开发轮转 v2（隔离环境）',
    mode: 'core',
    workflow: 'harness/platform/WORKFLOW.md',
    skillConfig: 'harness/config/stage-skills.json',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--manifest') {
      args.manifest = argv[++i]
    } else if (arg === '--name') {
      args.name = argv[++i]
    } else if (arg === '--label') {
      args.label = argv[++i]
    } else if (arg === '--mode') {
      args.mode = argv[++i]
    } else if (arg === '--workflow') {
      args.workflow = argv[++i]
    } else if (arg === '--skill-config') {
      args.skillConfig = argv[++i]
    } else if (arg === '--skill-catalog') {
      args.skillCatalog = argv[++i]
    } else if (arg === '--out') {
      args.out = argv[++i]
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
    if (argv[i] === undefined && arg !== '--help' && arg !== '-h') {
      throw new Error(`${arg} requires a value`)
    }
  }
  return args
}

async function readJson(path) {
  return JSON.parse(await readFile(resolveInputPath(path, 'JSON path'), 'utf8'))
}

async function readText(path) {
  return readFile(resolveInputPath(path, 'Text path'), 'utf8')
}

function renderHelp() {
  console.log(`Usage: node harness/scripts/render-platform-package.mjs --manifest <path> [options]

Options:
  --name <name>       Template machine name (default: agent-manager-auto-dev-v1)
  --label <label>     Template label (default: Agent Manager 自动开发轮转 v2（隔离环境）)
  --mode core|manifest
                      core renders all v1 stages; manifest renders only stages in the manifest
  --workflow <path>   WORKFLOW.md instructions path
  --skill-config <path>
                      Stage-to-cloud-skill mapping (default: harness/config/stage-skills.json)
  --skill-catalog <path>
                      Required cloud publish result/catalog used to resolve slugs to IDs
  --out <path>        Write JSON package to a file instead of stdout

The output is consumable by:
  harness publish template <package.json> --wsid <workspace-id>`)
}

function stageTasks(core, manifest, domain, mode, skillBindings) {
  const stageIds = mode === 'manifest' ? manifest.stages : core.stages.map((stage) => stage.id)
  const known = new Map(core.stages.map((stage) => [stage.id, stage]))
  return stageIds.map((stageId, index) => {
    const stage = known.get(stageId) || { id: stageId, taskType: stageId, doneWhen: '', gate: '' }
    return {
      type: stage.taskType || stage.id,
      title: defaultStageTitles[stage.id] || stage.id,
      description: stage.doneWhen || `Execute ${stage.id}.`,
      sortOrder: index,
      agentHints: renderAgentHints(stage, manifest, domain),
      skillIds: skillBindings.get(stage.id).skillIds,
    }
  })
}

function ciHintsForStage(stageId, domain) {
  const lifecycle = domain?.ciPipelines?.lifecycle || {}
  const wrapper = wrapperCommandForStage(stageId)
  return Object.entries(lifecycle)
    .filter(([, pipeline]) => pipeline.stage === stageId)
    .map(([key, pipeline]) => [
      `- ${key}:`,
      wrapper ? `  - 主路径: \`${wrapper}\`` : null,
      wrapper ? '  - Agent 只调用主路径 wrapper；不得直接执行底层 AOneCI 命令。' : null,
      `  - YAML: \`${pipeline.yamlPath}\``,
      `  - 解析: \`${pipeline.resolveCommand}\``,
      `  - 证据: ${(pipeline.evidence || []).join(', ') || 'AOneCI run id'}`,
    ].filter(Boolean).join('\n'))
}

function wrapperCommandForStage(stageId) {
  const commands = {
    env_prepare: 'node harness/scripts/aone-lifecycle.mjs env-create --work-item <work_item_id> --task-id <task_id> --branch <remote-branch> --namespace <namespace>',
    deploy_ephemeral: 'node harness/scripts/aone-lifecycle.mjs deploy-image --work-item <work_item_id> --task-id <task_id> --branch <remote-branch> --namespace <namespace>',
    test_api: 'node harness/scripts/aone-lifecycle.mjs smoke-api --work-item <work_item_id> --task-id <task_id> --branch <remote-branch> --base-url <baseUrl>',
    integration_live: 'node harness/scripts/aone-lifecycle.mjs integration --work-item <work_item_id> --task-id <task_id> --branch <remote-branch> --base-url <baseUrl> --namespace <namespace>',
    deploy: 'node harness/scripts/aone-lifecycle.mjs cleanup --work-item <work_item_id> --task-id <task_id> --branch <remote-branch> --namespace <namespace>',
  }
  return commands[stageId] || ''
}

function renderAgentHints(stage, manifest, domain) {
  const stageTests = (manifest.testMatrix || []).filter((test) => test.stage === stage.id)
  if (stage.id === 'test_e2e' && stageTests.length !== 1) {
    throw new Error(`Platform test_e2e stage requires exactly one manifest test, found ${stageTests.length}`)
  }
  const taskIds = (manifest.tasks || [])
    .filter((task) => task.stage === stage.id)
    .map((task) => `- ${task.id}: ${task.description || 'No description'}`)
  const stageWrapper = wrapperCommandForStage(stage.id)
  const tests = stageTests
    .map((test) => {
      if (/^\s*a1\s+ci\s+pipeline\s+run\b/.test(test.command || '')) {
        return stageWrapper ? `- 由主路径 wrapper 执行：\`${stageWrapper}\`` : null
      }
      const lines = [
        `- ${test.id}: \`${test.command}\``,
        `  - 证据: ${(test.evidence || []).join(', ') || '结构化测试输出'}`,
      ]
      if ((test.requiredAssertions || []).length > 0) {
        lines.push(`  - 必需断言 ID: ${test.requiredAssertions.join(', ')}`)
        lines.push('  - 输出 assertionResults，并在对应截图的 assertionIds 中关联同一 ID。')
      }
      if (test.requiresPostActionReadback === true) {
        lines.push('  - 必须提供 phase=post_action_readback 的目标系统终态截图；操作前页面或提交弹窗不能代替。')
      }
      return lines.join('\n')
    })
    .filter(Boolean)
  const ciHints = ciHintsForStage(stage.id, domain)
  const completionCommand = stage.id === 'test_e2e'
    ? 'node harness/scripts/complete-stage.mjs --stage test_e2e --work-item-id <work_item_id> --task-id <task_id> --output <stage-output.json>'
    : `node harness/scripts/complete-stage.mjs --stage ${stage.id} --task-id <task_id> --output <stage-output.json>`
  const binding = stage.id === 'test_e2e'
    ? renderStageBinding({
        version: 1,
        stage: stage.id,
        featureId: manifest.featureId,
        testId: stageTests[0].id,
        manifestDigest: manifestDigest(manifest),
      })
    : null
  return [
    `阶段: ${stage.id}`,
    binding,
    '',
    `完成条件: ${stage.doneWhen || '满足本阶段要求。'}`,
    `卡点: ${stage.gate || '无'}`,
    '',
    '必需 Harness 行为:',
    '- 先执行 `harness task update <task_id> in_progress`。',
    '- 用 `harness log` 记录简洁进展。',
    '- 需要人工选择时用 `harness ask`，并在等待期间停止下游阶段。',
    '- awaiting task 保持 `in_progress`，不得启动被阻塞的下游阶段。',
    '- 不得直接执行 `harness task update <task_id> done`；只能通过 complete-stage 守卫完成。',
    `- 完成命令: \`${completionCommand}\``,
    '',
    '本阶段 manifest 任务:',
    taskIds.length ? taskIds.join('\n') : '- 本功能未声明。',
    '',
    '本阶段测试命令:',
    tests.length ? tests.join('\n') : '- 本功能未声明。',
    '',
    '本阶段 AOneCI 生命周期:',
    ciHints.length ? ciHints.join('\n') : '- 本阶段不直接触发 AOneCI 生命周期流水线。',
  ].join('\n')
}

function outputRecommendations(core) {
  const result = {}
  for (const stage of core.stages) {
    result[stage.id] = {
      state: 'completed|awaiting_human|skipped',
      evidence: ['command output, artifact id, screenshot, trace, or explicit N/A reason'],
      testsPassed: stage.id === 'test_unit' ? '<number>' : undefined,
      totalTests: stage.id === 'test_unit' ? '<number>' : undefined,
    }
  }
  return result
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    renderHelp()
    return
  }
  if (!args.manifest) throw new Error('--manifest is required')
  if (!args.skillCatalog) throw new Error('--skill-catalog is required; platform templates must bind published cloud skills')
  if (!['core', 'manifest'].includes(args.mode)) throw new Error('--mode must be core or manifest')

  const [core, manifest, domain, workflow, skillConfig, skillCatalog] = await Promise.all([
    readJson('harness/rules/core.json'),
    readJson(args.manifest),
    readJson('harness/domains/agent-manager.json'),
    readText(args.workflow),
    readJson(args.skillConfig),
    readJson(args.skillCatalog),
  ])
  const skillBindings = resolveStageSkillBindings(
    skillConfig,
    core.stages.map((stage) => stage.id),
    skillCatalog,
  )

  const pkg = {
    schema: 'harness.task-template.v1',
    template: {
      name: args.name,
      label: args.label,
      description: [
        'Agent Manager 隔离环境自动开发工作流。',
        `功能清单: ${manifest.featureId}。`,
        '通过 Harness CLI 写回等待、隔离环境、API/浏览器证据和平台验收卡点。',
      ].join(' '),
      requiresWorkspace: true,
      maxLoopIterations: 3,
      instructions: workflow,
      tasks: stageTasks(core, manifest, domain, args.mode, skillBindings),
      outputRecommendations: outputRecommendations(core),
    },
  }

  const text = `${JSON.stringify(pkg, null, 2)}\n`
  if (args.out) {
    await writeFile(resolveOutputPath(args.out), text)
  } else {
    process.stdout.write(text)
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
