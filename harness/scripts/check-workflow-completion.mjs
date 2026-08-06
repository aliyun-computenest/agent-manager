#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolveInputPath } from './lib/path-guard.mjs'
import { validateRequiredE2eEvidence } from './lib/e2e-evidence-guard.mjs'

const BLOCKING_STATES = new Set(['in_progress', 'awaiting_human', 'blocked'])
const GENERIC_SCREENSHOT_RE = /(login|登录|home|首页|landing|welcome|auth)/i

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--manifest') {
      args.manifest = argv[++i]
    } else if (arg === '--run') {
      args.run = argv[++i]
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
    if (argv[i] === undefined && !['--help', '-h'].includes(arg)) {
      throw new Error(`${arg} requires a value`)
    }
  }
  return args
}

async function readJson(path) {
  return JSON.parse(await readFile(resolveInputPath(path, 'JSON path'), 'utf8'))
}

function byId(items = []) {
  return new Map(items.map((item) => [item.id, item]))
}

function byStage(items = []) {
  const result = new Map()
  for (const item of items) {
    if (!result.has(item.stage)) result.set(item.stage, [])
    result.get(item.stage).push(item)
  }
  return result
}

function taskStage(task) {
  return task.stage || task.type
}

function taskState(task) {
  return task.output?.state || task.status
}

function featureTokens(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3)
}

function matchesFeature(text, tokens) {
  const haystack = String(text || '').toLowerCase()
  return tokens.length === 0 || tokens.some((token) => haystack.includes(token))
}

function findStageTasks(run, stage) {
  return (run.tasks || []).filter((task) => taskStage(task) === stage)
}

function downstreamStages(manifest, stage) {
  const stages = manifest.stages || []
  const index = stages.indexOf(stage)
  return index < 0 ? [] : stages.slice(index + 1)
}

function collectErrors(manifest, run) {
  const errors = []
  const manifestTasks = byId(manifest.tasks || [])
  const manifestTests = byId(manifest.testMatrix || [])
  const runTasks = byId(run.tasks || [])
  const runTests = byId(run.tests || [])
  const testsByStage = byStage(run.tests || [])
  const tokens = featureTokens(run.featureId || manifest.featureId)

  for (const task of run.tasks || []) {
    const state = taskState(task)
    if (task.output?.state === 'completed' && task.status !== 'done') {
      errors.push(`${task.id} output.state is completed but task status is ${task.status}`)
    }
    if (task.status === 'done' && ['awaiting_human', 'blocked', 'failed'].includes(task.output?.state)) {
      errors.push(`${task.id} is done but output.state is ${task.output.state}`)
    }
    const blockedNextStages = task.output?.blockedNextStages || []
    if (BLOCKING_STATES.has(state) && blockedNextStages.length > 0) {
      for (const blockedStage of blockedNextStages) {
        for (const downstream of findStageTasks(run, blockedStage)) {
          if (downstream.status === 'done') {
            errors.push(`stage ${blockedStage} is done while ${task.id} is ${state}`)
          }
        }
      }
    }
  }

  for (const task of manifest.tasks || []) {
    const current = runTasks.get(task.id)
    if (!current || current.status !== 'done') continue
    for (const dep of task.dependsOn || []) {
      const depTask = runTasks.get(dep)
      if (!depTask || depTask.status !== 'done') {
        errors.push(`${task.id} is done before dependency ${dep} is done`)
      }
    }
  }

  for (const expected of manifest.testMatrix || []) {
    const current = runTests.get(expected.id)
    if (!current) {
      errors.push(`required test ${expected.id} is missing from the delivery run`)
      continue
    }
    if (taskStage(current) !== expected.stage) {
      errors.push(`required test ${expected.id} belongs to stage ${expected.stage}, but the delivery run reports ${taskStage(current) || '(missing)'}`)
    }
  }

  for (const integrationTask of findStageTasks(run, 'integration_live')) {
    const state = taskState(integrationTask)
    const downstream = downstreamStages(manifest, 'integration_live')
    const downstreamDone = downstream
      .flatMap((stage) => findStageTasks(run, stage))
      .filter((task) => task.status === 'done')
    if (BLOCKING_STATES.has(state) && downstreamDone.length > 0) {
      errors.push(`integration_live is ${state} but downstream tasks are done: ${downstreamDone.map((task) => task.id).join(', ')}`)
    }
  }

  for (const test of testsByStage.get('integration_live') || []) {
    if (test.exitCode === 0) continue
    const classification = test.failureClassification || test.classification
    if (!classification) {
      errors.push(`integration_live test ${test.id} failed without failureClassification`)
      continue
    }
    if (classification.recommendedAction === 'await_human') {
      const downstreamDone = downstreamStages(manifest, 'integration_live')
        .flatMap((stage) => findStageTasks(run, stage))
        .filter((task) => task.status === 'done')
      if (downstreamDone.length > 0) {
        errors.push(`integration_live awaits human but downstream tasks are done: ${downstreamDone.map((task) => task.id).join(', ')}`)
      }
    }
    if (classification.recommendedAction === 'loop_to_develop') {
      errors.push(`integration_live found feature-related failures and must loop to develop`)
    }
  }

  for (const test of testsByStage.get('test_e2e') || []) {
    const expected = manifestTests.get(test.id) || {}
    if (!test.experienceUrl) errors.push(`test_e2e ${test.id} is missing experienceUrl`)
    if (!Array.isArray(test.featureAssertions) || test.featureAssertions.length === 0) {
      errors.push(`test_e2e ${test.id} is missing featureAssertions`)
    }
    const screenshots = test.screenshots || []
    if (screenshots.length === 0 && (test.artifacts || []).length === 0) {
      errors.push(`test_e2e ${test.id} has no screenshot/trace/artifact`)
    }
    const evidenceItems = [...screenshots, ...(test.artifacts || [])]
    const evidenceText = [
      test.experienceUrl,
      ...(test.featureAssertions || []),
      ...evidenceItems.map((item) => [item.target, item.targetUrl, item.targetPath].filter(Boolean).join(' ')),
    ].join(' ')
    if (!matchesFeature(evidenceText, tokens) && !evidenceItems.some((item) => item.featureSpecific === true)) {
      errors.push(`test_e2e ${test.id} evidence does not mention the feature ${run.featureId || manifest.featureId}`)
    }
    for (const screenshot of screenshots) {
      const text = [screenshot.target, screenshot.targetUrl, screenshot.targetPath, screenshot.url].filter(Boolean).join(' ')
      if (GENERIC_SCREENSHOT_RE.test(text) && !/runtime-diagnostics|checkpoint|backup|sandbox|instance|diagnostic|诊断|备份|实例/.test(text)) {
        errors.push(`test_e2e ${test.id} screenshot looks generic instead of feature-specific: ${text}`)
      }
    }
    validateRequiredE2eEvidence({
      value: test,
      items: evidenceItems,
      requirements: expected,
      path: `test_e2e ${test.id}`,
      push: (target, path, message) => target.push(`${path}: ${message}`),
      errors,
    })
  }

  return errors
}

function printHelp() {
  console.log(`Usage: node harness/scripts/check-workflow-completion.mjs \\
  --manifest harness/manifests/<feature>.json \\
  --run <delivery-run.json>

Performs hard workflow gate checks before final completion. It is read-only and
does not update Harness task state.`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  if (!args.manifest) throw new Error('--manifest is required')
  if (!args.run) throw new Error('--run is required')

  const [manifest, run] = await Promise.all([readJson(args.manifest), readJson(args.run)])
  const errors = collectErrors(manifest, run)
  const result = {
    schemaVersion: '1.0',
    status: errors.length === 0 ? 'passed' : 'blocked',
    featureId: manifest.featureId,
    workItemId: run.workItemId || null,
    nextAction: errors.length === 0 ? 'continue_or_finish' : 'fix_blocking_gate_before_downstream',
    errors,
  }
  console.log(JSON.stringify(result, null, 2))
  if (errors.length > 0) process.exitCode = 2
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
