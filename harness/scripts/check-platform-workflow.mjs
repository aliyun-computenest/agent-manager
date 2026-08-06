#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolveInputPath } from './lib/path-guard.mjs'

const defaultExpectedStages = [
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
]

function parseArgs(argv) {
  const args = {
    expectedStages: defaultExpectedStages,
    requireAgentHints: true,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--work-item') {
      args.workItem = argv[++i]
    } else if (arg === '--context') {
      args.context = argv[++i]
    } else if (arg === '--expected-template-id') {
      args.expectedTemplateId = argv[++i]
    } else if (arg === '--expected-template-name') {
      args.expectedTemplateName = argv[++i]
    } else if (arg === '--expected-stages') {
      args.expectedStages = argv[++i].split(',').map((item) => item.trim()).filter(Boolean)
    } else if (arg === '--allow-missing-agent-hints') {
      args.requireAgentHints = false
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
    if (argv[i] === undefined && arg !== '--help' && arg !== '-h' && arg !== '--allow-missing-agent-hints') {
      throw new Error(`${arg} requires a value`)
    }
  }
  return args
}

function printHelp() {
  console.log(`Usage: node harness/scripts/check-platform-workflow.mjs --work-item <json> [--context <json>]

Checks that a Harness work item is bound to the expected Agent Manager
environment-isolated auto-development template instead of the builtin general
template.`)
}

async function readJson(path) {
  return JSON.parse(await readFile(resolveInputPath(path, 'JSON path'), 'utf8'))
}

function unwrapWorkItem(payload) {
  return payload?.workItem || payload?.work_item || payload
}

function taskTypes(workItem) {
  return (Array.isArray(workItem?.tasks) ? workItem.tasks : [])
    .map((task) => task.type)
    .filter(Boolean)
}

function templateName(workItem, context) {
  return workItem?.taskTemplate
    || workItem?.task_template
    || context?.task_template
    || null
}

function templateLabel(context) {
  return context?.task_template_label || null
}

function collectContextHints(context) {
  const hints = []
  for (const hint of context?.workflow_hints || []) {
    hints.push(hint.description || '')
    hints.push(hint.agent_hints || '')
    hints.push(hint.skill_hints || '')
  }
  return hints.filter(Boolean).join('\n')
}

function checkWorkflow({ workItem, context, args }) {
  const errors = []
  const actualTemplate = templateName(workItem, context)
  if (!actualTemplate) {
    errors.push('work item does not expose a task template')
  }
  if (actualTemplate === 'general') {
    errors.push('work item is using builtin general template, not Agent Manager auto-development workflow')
  }
  if (args.expectedTemplateId && actualTemplate !== args.expectedTemplateId) {
    errors.push(`task template id/name mismatch: expected ${args.expectedTemplateId}, got ${actualTemplate}`)
  }
  if (args.expectedTemplateName && actualTemplate !== args.expectedTemplateName && templateLabel(context) !== args.expectedTemplateName) {
    errors.push(`task template name mismatch: expected ${args.expectedTemplateName}, got ${actualTemplate}`)
  }

  const types = new Set(taskTypes(workItem))
  for (const stage of args.expectedStages) {
    if (!types.has(stage)) errors.push(`missing expected task type: ${stage}`)
  }

  if (args.requireAgentHints && context) {
    const hints = collectContextHints(context)
    if (!/Harness|harness|awaiting_human|WORKFLOW/.test(hints)) {
      errors.push('context workflow hints do not contain Harness workflow instructions')
    }
  }

  return errors
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  if (!args.workItem) throw new Error('--work-item is required')

  const workItem = unwrapWorkItem(await readJson(args.workItem))
  const context = args.context ? await readJson(args.context) : null
  const errors = checkWorkflow({ workItem, context, args })
  const result = {
    schemaVersion: '1.0',
    status: errors.length === 0 ? 'ready' : 'awaiting_human',
    workItemId: workItem.id || null,
    taskTemplate: templateName(workItem, context),
    taskTemplateLabel: templateLabel(context),
    taskTypes: taskTypes(workItem),
    expectedStages: args.expectedStages,
    platformAcceptance: {
      claimedPlatformComplete: false,
      reason: errors.length === 0
        ? 'Workflow binding is ready, but platform acceptance still requires task evidence and acceptance command.'
        : 'Workflow binding is incomplete.',
    },
    errors,
  }
  console.log(JSON.stringify(result, null, 2))
  if (errors.length > 0) process.exitCode = 2
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
