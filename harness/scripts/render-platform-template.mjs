#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolveInputPath } from './lib/path-guard.mjs'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--manifest') {
      const value = argv[i + 1]
      if (!value) throw new Error('--manifest requires a path')
      args.manifest = value
      i += 1
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return args
}

async function readJson(path) {
  const fullPath = resolveInputPath(path, 'JSON path')
  return JSON.parse(await readFile(fullPath, 'utf8'))
}

function bulletList(items) {
  if (!items || items.length === 0) return '- None'
  return items.map((item) => `- ${item}`).join('\n')
}

function renderTask(task) {
  return [
    `### ${task.id}`,
    '',
    `- 阶段: \`${task.stage}\``,
    `- 依赖: ${task.dependsOn?.length ? task.dependsOn.map((dep) => `\`${dep}\``).join(', ') : '无'}`,
    `- 资源锁: ${task.resources?.length ? task.resources.map((resource) => `\`${resource}\``).join(', ') : '无'}`,
    `- 写入范围: ${task.writeScope?.length ? task.writeScope.map((scope) => `\`${scope}\``).join(', ') : '无'}`,
    `- 可并发子包: ${task.agentPacket ? '是' : '否'}`,
    task.description ? `- 描述: ${task.description}` : '',
  ].filter(Boolean).join('\n')
}

function renderTest(item) {
  const wrapper = wrapperCommandForStage(item.stage)
  const command = /^\s*a1\s+ci\s+pipeline\s+run\b/.test(item.command || '') && wrapper
    ? `${wrapper}  # 由 wrapper 内部触发 AOneCI`
    : item.command
  return [
    `### ${item.id}`,
    '',
    `- 阶段: \`${item.stage}\``,
    `- 命令: \`${command}\``,
    `- 资源锁: ${item.resources?.length ? item.resources.map((resource) => `\`${resource}\``).join(', ') : '无'}`,
    '- 证据:',
    bulletList(item.evidence || []),
    item.requiresHumanInput ? '- 运行前可能需要人工提供真实环境或凭证输入。' : '',
  ].filter(Boolean).join('\n')
}

function renderCiPipeline(key, pipeline) {
  const wrapper = wrapperCommandForStage(pipeline.stage)
  return [
    `### ${key}`,
    '',
    `- 阶段: \`${pipeline.stage}\``,
    wrapper ? `- 主路径: \`${wrapper}\`` : null,
    wrapper ? '- Agent 只调用主路径 wrapper；不得直接执行底层 AOneCI 命令。' : null,
    `- YAML: \`${pipeline.yamlPath}\``,
    `- 用途: ${pipeline.purpose}`,
    `- 解析: \`${pipeline.resolveCommand}\``,
    '- 必需参数:',
    bulletList(pipeline.requiredParams || []),
    '- 必需 Secret/凭证:',
    bulletList(pipeline.requiredSecrets || []),
    '- 完成证据:',
    bulletList(pipeline.evidence || []),
  ].filter(Boolean).join('\n')
}

function wrapperCommandForStage(stage) {
  const commands = {
    env_prepare: 'node harness/scripts/aone-lifecycle.mjs env-create --work-item <work_item_id> --task-id <task_id> --branch <remote-branch> --namespace <namespace>',
    deploy_ephemeral: 'node harness/scripts/aone-lifecycle.mjs deploy-image --work-item <work_item_id> --task-id <task_id> --branch <remote-branch> --namespace <namespace>',
    test_api: 'node harness/scripts/aone-lifecycle.mjs smoke-api --work-item <work_item_id> --task-id <task_id> --branch <remote-branch> --base-url <baseUrl>',
    integration_live: 'node harness/scripts/aone-lifecycle.mjs integration --work-item <work_item_id> --task-id <task_id> --branch <remote-branch> --base-url <baseUrl> --namespace <namespace>',
    deploy: 'node harness/scripts/aone-lifecycle.mjs cleanup --work-item <work_item_id> --task-id <task_id> --branch <remote-branch> --namespace <namespace>',
  }
  return commands[stage] || ''
}

function renderCiLifecycle(domain) {
  const ci = domain.ciPipelines
  const entries = Object.entries(ci?.lifecycle || {})
  if (!ci || entries.length === 0) return '- 未声明 AOneCI 生命周期。'
  return [
    `- 仓库: \`${ci.repo}\``,
    `- 分支占位: \`${ci.branchPlaceholder}\``,
    `- Pipeline id 策略: ${ci.pipelineIdPolicy}`,
    '',
    entries.map(([key, pipeline]) => renderCiPipeline(key, pipeline)).join('\n\n'),
  ].join('\n')
}

function printHelp() {
  console.log(`Usage: node harness/scripts/render-platform-template.mjs --manifest <path>

Renders a Harness work-item template from the repository rules pack. The command
is read-only and does not call the Harness platform.`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  if (!args.manifest) throw new Error('--manifest is required')

  const [core, domain, manifest] = await Promise.all([
    readJson('harness/rules/core.json'),
    readJson('harness/domains/agent-manager.json'),
    readJson(args.manifest),
  ])

  const liveEvidence = manifest.evidence?.length ? manifest.evidence : []
  const output = [
    `# Harness 工作项模板：${manifest.title}`,
    '',
    `功能 id：\`${manifest.featureId}\``,
    '',
    '## 平台输入',
    '',
    '必需：',
    bulletList(manifest.platformInputs?.required || []),
    '',
    '可选：',
    bulletList(manifest.platformInputs?.optional || []),
    '',
    '## 阶段顺序',
    '',
    bulletList(manifest.stages?.map((stage) => `\`${stage}\``) || []),
    '',
    '## 实施编排与并行派发',
    '',
    '给并行 Agent 派发前，先生成安全 DAG wave：',
    '',
    '```bash',
    `node harness/scripts/plan-parallel-waves.mjs --manifest ${args.manifest}`,
    '```',
    '',
    'Harness daemon 可以并发派发同一 wave 中没有资源冲突的任务。不同 wave 的任务，或因为共享资源锁被串行化的任务，必须等待前序 wave 完成。',
    '',
    '## AOneCI 隔离环境生命周期',
    '',
    renderCiLifecycle(domain),
    '',
    '## Harness CLI 等待协议',
    '',
    '需要人工决策时，当前 task 保持 `in_progress`，并使用结构化 ask：',
    '',
    '```bash',
    'harness ask <work_item_id> --task-id <task_id> \\',
    '  --question "<question>" \\',
    '  --option "id=<id>;label=<label>;recommended" \\',
    '  --option "id=<id>;label=<label>"',
    '```',
    '',
    '同时记录 blocker milestone：',
    '',
    '```bash',
    'harness milestone blocker <task_id> "等待人工回复：<原因>" --require-ack',
    '```',
    '',
    '写入 awaiting output，并且不要启动被阻塞的下游阶段：',
    '',
    '```json',
    JSON.stringify(core.waitingProtocol.awaitingOutput, null, 2),
    '```',
    '',
    '平台记录回复或确认后：',
    '',
    '```bash',
    'harness comment list <work_item_id> --limit 20',
    'harness log <task_id> "收到人工回复，恢复执行：<summary>"',
    '```',
    '',
    '## 任务',
    '',
    manifest.tasks.map(renderTask).join('\n\n'),
    '',
    '## 测试矩阵',
    '',
    manifest.testMatrix.map(renderTest).join('\n\n'),
    '',
    '## 功能证据',
    '',
    bulletList(liveEvidence),
    '',
    '## 领域真实证据链',
    '',
    'Checkpoint backup：',
    bulletList(domain.liveEvidenceChains.checkpointBackup),
    '',
    'Sandbox upgrade：',
    bulletList(domain.liveEvidenceChains.sandboxUpgrade),
    '',
    'Instance lifecycle：',
    bulletList(domain.liveEvidenceChains.instanceLifecycle),
    '',
    '## 人工卡点',
    '',
    bulletList((manifest.humanGates || []).map((gate) => `${gate.stage}: ${gate.type} - ${gate.reason}`)),
    '',
  ].join('\n')

  console.log(output)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
