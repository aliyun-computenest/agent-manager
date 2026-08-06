#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveInputPath } from './lib/path-guard.mjs'
import { manifestDigest, parseStageBinding } from './lib/stage-binding.mjs'
import { testDefinitionFor, validateStageOutput } from './check-stage-output.mjs'

function parseArgs(argv) {
  const args = { harnessBin: 'harness' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--stage') {
      args.stage = argv[++i]
    } else if (arg === '--task-id' || arg === '--task') {
      args.taskId = argv[++i]
    } else if (arg === '--work-item-id' || arg === '--work-item') {
      args.workItemId = argv[++i]
    } else if (arg === '--output') {
      args.output = argv[++i]
    } else if (arg === '--manifest') {
      args.manifest = argv[++i]
    } else if (arg === '--test-id') {
      args.testId = argv[++i]
    } else if (arg === '--harness-bin') {
      args.harnessBin = argv[++i]
    } else if (arg === '--dry-run') {
      args.dryRun = true
    } else if (arg === '--no-write-harness') {
      args.noWriteHarness = true
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
    if (argv[i] === undefined && !['--dry-run', '--no-write-harness', '--help', '-h'].includes(arg)) {
      throw new Error(`${arg} requires a value`)
    }
  }
  return args
}

function usage() {
  return `Usage:
  node harness/scripts/complete-stage.mjs --stage <stage> --task-id <task_id> --output <stage-output.json>
  node harness/scripts/complete-stage.mjs --stage test_e2e --work-item-id <work_item_id> --task-id <task_id> --output <stage-output.json>
  node harness/scripts/complete-stage.mjs --stage <stage> --task-id <task_id> --output <stage-output.json> --dry-run --no-write-harness

This is the only supported way for Harness agents to mark a stage done.
It validates the intended output first; if validation fails, it keeps the task
in_progress and never writes done.`
}

function parseOutputValue(value) {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!text) return value
  try {
    return JSON.parse(text)
  } catch {
    return value
  }
}

async function readJson(path, label = 'Stage output') {
  if (!path) throw new Error(`${label} path is required`)
  const fullPath = resolveInputPath(path, label)
  const text = await readFile(fullPath, 'utf8')
  try {
    return parseOutputValue(JSON.parse(text))
  } catch (error) {
    throw new Error(`Failed to parse ${label} JSON ${path}: ${error.message}`)
  }
}

function errorSummary(errors) {
  return errors.map((error) => `${error.path}: ${error.message}`)
}

function buildBlockedOutput(stage, output, errors) {
  const base = output && typeof output === 'object' && !Array.isArray(output)
    ? { ...output }
    : { rawOutput: output }
  const diagnostics = Array.isArray(base.diagnostics) ? base.diagnostics.slice() : []
  diagnostics.push(...errorSummary(errors))
  return {
    ...base,
    state: 'awaiting_human',
    waitType: base.waitType || 'stage_output_guard',
    reason: base.reason || `${stage} output did not pass completion guard`,
    resumeCriteria: base.resumeCriteria || 'Fix the missing or failed evidence and rerun complete-stage.mjs.',
    diagnostics,
  }
}

function buildCompletedOutput(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output
  return {
    ...output,
    reason: null,
    waitType: null,
    resumeCriteria: null,
    blockedNextStages: [],
  }
}

function normalizeCredential(entry) {
  const apiKey = entry?.apiKey || entry?.api_key
  const serverUrl = entry?.serverUrl || entry?.server_url
  if (!apiKey || !serverUrl) return null
  return {
    apiKey,
    serverUrl: String(serverUrl).replace(/\/$/, ''),
    agentName: entry?.agentName || entry?.agent_name,
    agentId: entry?.agentId || entry?.agent_id,
  }
}

function loadHarnessCredentials() {
  if (process.env.HARNESS_API_KEY) {
    return {
      apiKey: process.env.HARNESS_API_KEY,
      serverUrl: (process.env.HARNESS_SERVER_URL || 'https://harness.alibaba-inc.com').replace(/\/$/, ''),
    }
  }

  const home = homedir()
  const credentialPaths = [
    join(home, '.harness', 'credentials.json'),
    join(home, '.agents', 'skills', 'harness', 'credentials.json'),
    join(process.cwd(), 'skills', 'harness', 'credentials.json'),
  ]
  const activeAgentPath = join(home, '.harness', 'active-agent')
  const activeAgent = process.env.HARNESS_AGENT_NAME
    || (existsSync(activeAgentPath) ? readFileSync(activeAgentPath, 'utf8').trim() : '')

  for (const path of credentialPaths) {
    if (!existsSync(path)) continue
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      const entries = (Array.isArray(raw) ? raw : [raw]).map(normalizeCredential).filter(Boolean)
      if (entries.length === 0) continue
      if (activeAgent) {
        const active = entries.find((entry) => entry.agentName === activeAgent || entry.agentId === activeAgent)
        if (active) return active
      }
      return entries[0]
    } catch {
      // Try the next credential source.
    }
  }
  return null
}

async function patchTaskViaApi(taskId, status, output) {
  const credentials = loadHarnessCredentials()
  if (!credentials) throw new Error('Harness credentials not found')

  const response = await fetch(`${credentials.serverUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${credentials.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status, output }),
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { success: false, message: text || `HTTP ${response.status}` }
  }
  if (!response.ok || body.success === false) {
    throw new Error(body.error || body.message || body.hint || `Harness API update failed (${response.status})`)
  }
  return body
}

async function fetchWorkItemContext(workItemId) {
  const credentials = loadHarnessCredentials()
  if (!credentials) throw new Error('Harness credentials not found')
  const response = await fetch(
    `${credentials.serverUrl}/api/v1/work-items/${encodeURIComponent(workItemId)}/context`,
    { headers: { Authorization: `Bearer ${credentials.apiKey}` } },
  )
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { success: false, message: text || `HTTP ${response.status}` }
  }
  if (!response.ok || body.success === false) {
    throw new Error(body.error || body.message || body.hint || `Harness context lookup failed (${response.status})`)
  }
  return body
}

function taskStage(task) {
  const stage = String(task?.stage || task?.type || '').trim()
  return stage === 'plan' ? 'dev_orchestration' : stage
}

async function resolvePlatformTestDefinition(args, contextLoader = fetchWorkItemContext) {
  if (!args.workItemId) throw new Error('--work-item-id is required for platform-bound test_e2e completion')
  if (!args.taskId) throw new Error('--task-id is required for platform-bound test_e2e completion')
  const context = await contextLoader(args.workItemId)
  const workItem = context?.work_item || context?.workItem
  if (!workItem || String(workItem.id) !== String(args.workItemId)) {
    throw new Error('Harness context does not match --work-item-id')
  }
  const task = (workItem.tasks || []).find((item) => String(item.id || item.taskId) === String(args.taskId))
  if (!task) throw new Error(`task ${args.taskId} does not belong to work item ${args.workItemId}`)
  if (taskStage(task) !== args.stage) {
    throw new Error(`task ${args.taskId} belongs to stage ${taskStage(task) || '(missing)'}, not ${args.stage}`)
  }

  const hints = (context.workflow_hints || context.workflowHints || [])
    .filter((item) => taskStage(item) === args.stage)
  const bindings = []
  for (const hint of hints) {
    const agentHints = hint.agent_hints || hint.agentHints || ''
    if (!String(agentHints).includes('HARNESS_STAGE_BINDING_V1:')) continue
    bindings.push(parseStageBinding(agentHints))
  }
  if (bindings.length === 0) throw new Error(`platform template has no stage binding for ${args.stage}`)
  if (bindings.length > 1) throw new Error(`platform template has multiple stage bindings for ${args.stage}`)
  const binding = bindings[0]
  if (binding.stage !== args.stage) {
    throw new Error(`platform binding belongs to stage ${binding.stage}, not ${args.stage}`)
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(binding.featureId)) {
    throw new Error('platform binding featureId is invalid')
  }
  if (args.testId && String(args.testId) !== String(binding.testId)) {
    throw new Error(`--test-id ${args.testId} does not match platform-bound test ${binding.testId}`)
  }

  const manifestPath = fileURLToPath(new URL(`../manifests/${binding.featureId}.json`, import.meta.url))
  if (args.manifest && resolveInputPath(args.manifest, 'Manifest') !== manifestPath) {
    throw new Error(`--manifest cannot replace platform-bound manifest ${binding.featureId}.json`)
  }
  const manifest = await readJson(manifestPath, 'Platform-bound manifest')
  if (manifest.featureId !== binding.featureId) {
    throw new Error(`platform-bound manifest featureId must be ${binding.featureId}`)
  }
  if (manifestDigest(manifest) !== binding.manifestDigest) {
    throw new Error(`platform-bound manifest ${binding.featureId}.json does not match the published template digest`)
  }
  return testDefinitionFor(manifest, { stage: args.stage, testId: binding.testId })
}

async function runHarnessUpdate({ args, status, output }) {
  if (args.noWriteHarness) return
  if (!args.taskId) throw new Error('--task-id is required unless --no-write-harness is set')
  const payload = JSON.stringify(output)
  if (args.dryRun) {
    console.log(`[dry-run] PATCH /api/v1/tasks/${args.taskId} status=${status} outputBytes=${Buffer.byteLength(payload)}`)
    return
  }
  try {
    await patchTaskViaApi(args.taskId, status, output)
    console.log(`✓ Task updated via Harness API: ${args.taskId} → ${status}`)
    return
  } catch (apiError) {
    if (payload.length > 20000) {
      throw new Error(`Harness API update failed and output is too large for CLI fallback: ${apiError.message}`)
    }
    console.warn(`Harness API update failed, falling back to CLI: ${apiError.message}`)
  }
  execFileSync(args.harnessBin, ['task', 'update', args.taskId, status, '--output', payload], {
    stdio: 'inherit',
  })
}

function printErrors(stage, errors) {
  console.error(`Stage completion blocked: ${stage}`)
  for (const error of errors) {
    console.error(`- ${error.path}: ${error.message}`)
  }
  console.error('Not marking task done.')
}

export async function completeStage(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv)
  if (args.help) {
    console.log(usage())
    return { skipped: true }
  }
  if (!args.stage) throw new Error('--stage is required')
  const output = await readJson(args.output)
  let testDefinition
  let testDefinitionError
  if (args.stage === 'test_e2e') {
    try {
      testDefinition = await resolvePlatformTestDefinition(args, options.contextLoader)
    } catch (error) {
      testDefinitionError = error
    }
  }
  const result = validateStageOutput(args.stage, output, { taskId: args.taskId, testDefinition })
  if (testDefinitionError) {
    result.errors.unshift({ path: 'manifest', message: testDefinitionError.message })
  }
  if (result.errors.length > 0) {
    printErrors(result.stage, result.errors)
    const blockedOutput = buildBlockedOutput(result.stage, output, result.errors)
    await runHarnessUpdate({ args, status: 'in_progress', output: blockedOutput })
    process.exitCode = 1
    return { ok: false, stage: result.stage, errors: result.errors, output: blockedOutput }
  }
  console.log(`Stage output check passed: ${result.stage}`)
  const completedOutput = buildCompletedOutput(output)
  await runHarnessUpdate({ args, status: 'done', output: completedOutput })
  return { ok: true, stage: result.stage, output: completedOutput }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  completeStage().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
