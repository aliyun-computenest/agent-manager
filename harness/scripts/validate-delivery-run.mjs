#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises'
import { isRemoteArtifactLocator, resolveInputPath } from './lib/path-guard.mjs'
import { validateRequiredE2eEvidence } from './lib/e2e-evidence-guard.mjs'

const SUCCESS_TASK_STATES = new Set(['done', 'skipped'])
const LARGE_OUTPUT_KEYS = new Set(['rawLog', 'stdout', 'stderr', 'trace', 'video', 'screenshotBase64'])

function parseArgs(argv) {
  const args = { allowMissingArtifactPaths: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--manifest') {
      args.manifest = argv[i + 1]
      i += 1
    } else if (arg === '--run') {
      args.run = argv[i + 1]
      i += 1
    } else if (arg === '--allow-missing-artifact-paths') {
      args.allowMissingArtifactPaths = true
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return args
}

async function readJson(path) {
  if (!path) throw new Error('JSON path is required')
  const fullPath = resolveInputPath(path, 'JSON path')
  try {
    return JSON.parse(await readFile(fullPath, 'utf8'))
  } catch (error) {
    throw new Error(`Failed to read JSON ${path}: ${error.message}`)
  }
}

function push(errors, path, message) {
  errors.push({ path, message })
}

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function featureTokens(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3)
}

function textMatchesFeature(text, tokens) {
  const haystack = String(text || '').toLowerCase()
  return tokens.length === 0 || tokens.some((token) => haystack.includes(token))
}

function byId(items = []) {
  return new Map(items.map((item) => [item.id, item]))
}

function ancestorsFor(taskId, manifestTasks, memo = new Map()) {
  if (memo.has(taskId)) return memo.get(taskId)
  const task = manifestTasks.get(taskId)
  const ancestors = new Set()
  for (const dep of task?.dependsOn || []) {
    ancestors.add(dep)
    for (const parent of ancestorsFor(dep, manifestTasks, memo)) ancestors.add(parent)
  }
  memo.set(taskId, ancestors)
  return ancestors
}

async function localPathExists(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  if (isRemoteArtifactLocator(value)) return true
  const fullPath = resolveInputPath(value, 'Artifact path')
  try {
    await access(fullPath)
    return true
  } catch {
    return false
  }
}

function collectArtifacts(value, out = []) {
  if (!value || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    for (const item of value) collectArtifacts(item, out)
    return out
  }
  if (value.url || value.path) out.push(value)
  for (const item of Object.values(value)) collectArtifacts(item, out)
  return out
}

function inspectLargeInlinePayloads(value, path, errors) {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectLargeInlinePayloads(item, `${path}[${index}]`, errors))
    return
  }
  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${path}.${key}`
    if (LARGE_OUTPUT_KEYS.has(key) && typeof item === 'string' && item.length > 1000) {
      push(errors, itemPath, 'large inline payload must be uploaded as an artifact')
    }
    if (item && typeof item === 'object') inspectLargeInlinePayloads(item, itemPath, errors)
  }
}

function validateEnvironment(run, manifest, errors) {
  const env = run.environment
  if (!env || typeof env !== 'object') {
    push(errors, 'run.environment', 'isolated environment plan is required')
    return
  }
  for (const key of ['runId', 'namespace', 'serviceName', 'baseUrl', 'imageTag', 'dbPrefix', 'artifactDir']) {
    if (!env[key]) push(errors, `run.environment.${key}`, 'is required')
  }
  if (env.isolated !== true && env.humanApprovalForSharedEnv !== true) {
    push(errors, 'run.environment.isolated', 'must be true unless humanApprovalForSharedEnv is true')
  }
  if (env.namespace && !/^[a-z][a-z0-9-]{1,39}-[a-z0-9]{12}$/.test(env.namespace)) {
    push(errors, 'run.environment.namespace', 'must be a deterministic namespace like <prefix>-<12 char hash>')
  }
  if (env.dbPrefix && !/^it_[a-z0-9]+_$/.test(env.dbPrefix)) {
    push(errors, 'run.environment.dbPrefix', 'must be an isolated prefix like it_<hash>_')
  }
  const featureSlug = slug(manifest.featureId).slice(0, 16)
  if (featureSlug && env.runId && !env.runId.includes(featureSlug)) {
    push(errors, 'run.environment.runId', 'should include the feature id for traceability')
  }
}

function validateTasks(run, manifest, errors) {
  const runTasks = byId(run.tasks || [])
  const manifestTasks = byId(manifest.tasks || [])

  for (const task of manifest.tasks || []) {
    const runTask = runTasks.get(task.id)
    if (!runTask) {
      push(errors, `tasks.${task.id}`, 'missing task output in delivery run')
      continue
    }
    if (!runTask.status) push(errors, `tasks.${task.id}.status`, 'is required')
    if (runTask.output?.state === 'completed' && runTask.status !== 'done') {
      push(errors, `tasks.${task.id}.status`, 'must be done when output.state is completed')
    }
    if (runTask.status === 'done' && ['awaiting_human', 'blocked', 'failed'].includes(runTask.output?.state)) {
      push(errors, `tasks.${task.id}.output.state`, 'cannot be awaiting_human, blocked, or failed when task status is done')
    }
    if (runTask.stage && runTask.stage !== task.stage) {
      push(errors, `tasks.${task.id}.stage`, `must match manifest stage ${task.stage}`)
    }
    if (runTask.status === 'skipped' && !runTask.skippedReason) {
      push(errors, `tasks.${task.id}.skippedReason`, 'is required when a task is skipped')
    }
    if (runTask.status === 'done') {
      for (const dep of task.dependsOn || []) {
        const depTask = runTasks.get(dep)
        if (!depTask || !SUCCESS_TASK_STATES.has(depTask.status)) {
          push(errors, `tasks.${task.id}.dependsOn`, `dependency ${dep} must be done or explicitly skipped`)
        }
      }
    }
  }

  for (const [taskId, runTask] of runTasks.entries()) {
    if (!manifestTasks.has(taskId)) {
      push(errors, `tasks.${taskId}`, 'task is not declared in the manifest')
    }
    const output = runTask.output || {}
    if (JSON.stringify(output).length > 6000) {
      push(errors, `tasks.${taskId}.output`, 'inline output is too large; upload artifacts instead')
    }
    inspectLargeInlinePayloads(output, `tasks.${taskId}.output`, errors)
  }
}

function validateWaiting(run, manifest, errors) {
  const runTasks = byId(run.tasks || [])
  const manifestTasks = byId(manifest.tasks || [])
  const waitingItems = run.waiting || []
  const resumedTasks = new Set()

  for (const [index, item] of waitingItems.entries()) {
    const path = `waiting[${index}]`
    const runTask = runTasks.get(item.taskId)
    if (!item.taskId) push(errors, `${path}.taskId`, 'is required')
    if (!['clarification', 'approval'].includes(item.waitType)) {
      push(errors, `${path}.waitType`, 'must be clarification or approval')
    }
    if (item.state === 'awaiting_human') {
      if (runTask && runTask.status !== 'in_progress') {
        push(errors, `tasks.${item.taskId}.status`, 'must remain in_progress while awaiting human input')
      }
      for (const key of ['reason', 'resumeCriteria']) {
        if (!item[key]) push(errors, `${path}.${key}`, 'is required while awaiting human input')
      }
      if (!Array.isArray(item.blockedNextStages) || item.blockedNextStages.length === 0) {
        push(errors, `${path}.blockedNextStages`, 'must list blocked downstream stages')
      }
      const output = runTask?.output || {}
      for (const key of ['state', 'waitType', 'reason', 'resumeCriteria']) {
        if (!output[key]) push(errors, `tasks.${item.taskId}.output.${key}`, 'is required while awaiting human input')
      }
      if (output.state && output.state !== 'awaiting_human') {
        push(errors, `tasks.${item.taskId}.output.state`, 'must be awaiting_human while waiting')
      }
      if (output.waitType && output.waitType !== item.waitType) {
        push(errors, `tasks.${item.taskId}.output.waitType`, 'must match the waiting entry waitType')
      }
      if (!Array.isArray(output.blockedNextStages) || output.blockedNextStages.length === 0) {
        push(errors, `tasks.${item.taskId}.output.blockedNextStages`, 'must list blocked downstream stages')
      }
      for (const task of manifest.tasks || []) {
        if (ancestorsFor(task.id, manifestTasks).has(item.taskId) && runTasks.get(task.id)?.status === 'done') {
          push(errors, `${path}.blockedNextStages`, `downstream task ${task.id} is done before human resume`)
        }
      }
    } else if (item.state === 'resumed') {
      resumedTasks.add(item.taskId)
      for (const key of ['humanAnswer', 'decision', 'resumedAt']) {
        if (!item[key]) push(errors, `${path}.${key}`, 'is required for resumed waits')
      }
      if (item.resumeCriteriaSatisfied !== true) {
        push(errors, `${path}.resumeCriteriaSatisfied`, 'must be true before downstream work continues')
      }
    } else {
      push(errors, `${path}.state`, 'must be awaiting_human or resumed')
    }
  }

  for (const task of run.tasks || []) {
    if (task.status === 'resumed' && !resumedTasks.has(task.id)) {
      push(errors, `tasks.${task.id}.status`, 'resumed task requires a matching waiting entry')
    }
  }
}

function countFor(test, key) {
  return Number.isFinite(test[key]) ? test[key] : undefined
}

function validateUnitTest(test, path, errors) {
  if (test.exitCode !== 0) push(errors, `${path}.exitCode`, 'must be 0')
  const passed = countFor(test, 'testsPassed')
  const total = countFor(test, 'totalTests')
  if (!Number.isFinite(passed) || !Number.isFinite(total)) {
    push(errors, `${path}.testsPassed`, 'testsPassed and totalTests are required')
  } else {
    if (total <= 0) push(errors, `${path}.totalTests`, 'must be greater than 0')
    if (passed !== total) push(errors, `${path}.testsPassed`, 'must equal totalTests')
  }
}

function validateDeployEphemeralTest(test, path, run, errors) {
  if (test.exitCode !== 0) push(errors, `${path}.exitCode`, 'must be 0')
  const env = run.environment || {}
  for (const key of ['namespace', 'serviceName', 'baseUrl', 'imageTag']) {
    if (!test[key] && !env[key]) push(errors, `${path}.${key}`, 'is required for isolated deployment evidence')
  }
  if (!test.rolloutStatus) push(errors, `${path}.rolloutStatus`, 'is required')
  if (!test.healthReadback) {
    push(errors, `${path}.healthReadback`, 'is required')
  } else if (test.healthReadback.statusCode && test.healthReadback.statusCode !== 200) {
    push(errors, `${path}.healthReadback.statusCode`, 'must be 200')
  }
  if (run.environment?.isolated !== true && run.environment?.humanApprovalForSharedEnv !== true) {
    push(errors, `${path}.environment`, 'requires isolated environment or human shared-env approval')
  }
}

function validateApiTest(test, path, run, errors) {
  if (test.exitCode !== 0) push(errors, `${path}.exitCode`, 'must be 0')
  if (!test.baseUrl) push(errors, `${path}.baseUrl`, 'is required')
  if (test.baseUrl && run.environment?.baseUrl && test.baseUrl !== run.environment.baseUrl) {
    push(errors, `${path}.baseUrl`, 'must match the isolated environment baseUrl')
  }
  const passed = countFor(test, 'testsPassed')
  const total = countFor(test, 'totalTests')
  if (!Number.isFinite(passed) || !Number.isFinite(total)) {
    push(errors, `${path}.testsPassed`, 'testsPassed and totalTests are required')
  } else {
    if (total <= 0) push(errors, `${path}.totalTests`, 'must be greater than 0')
    if (passed !== total) push(errors, `${path}.testsPassed`, 'must equal totalTests')
  }
  const apiEvidence = test.apiEvidence || test.requestResponseEvidence || []
  if (!Array.isArray(apiEvidence) || apiEvidence.length === 0) {
    push(errors, `${path}.apiEvidence`, 'request/response evidence is required')
  }
}

function validateE2eTest(test, path, run, manifest, expected, errors) {
  if (test.exitCode !== 0) push(errors, `${path}.exitCode`, 'must be 0')
  if (!test.baseUrl) push(errors, `${path}.baseUrl`, 'is required')
  if (test.baseUrl && run.environment?.baseUrl && test.baseUrl !== run.environment.baseUrl) {
    push(errors, `${path}.baseUrl`, 'must match the isolated environment baseUrl')
  }
  if (!test.experienceUrl) {
    push(errors, `${path}.experienceUrl`, 'feature experienceUrl is required')
  }
  if (!Array.isArray(test.featureAssertions) || test.featureAssertions.length === 0) {
    push(errors, `${path}.featureAssertions`, 'featureAssertions are required')
  }
  const screenshots = test.screenshots || []
  const artifacts = test.artifacts || []
  if (screenshots.length === 0 && artifacts.length === 0) {
    push(errors, `${path}.screenshots`, 'feature-specific screenshot, video, trace, or log evidence is required')
  }
  const evidenceItems = [...screenshots, ...artifacts]
  for (const [index, item] of evidenceItems.entries()) {
    if (!item.target && !item.targetUrl && !item.targetPath) {
      push(errors, `${path}.evidence[${index}].target`, 'must name the feature target')
    }
  }
  validateRequiredE2eEvidence({
    value: test,
    items: evidenceItems,
    requirements: expected,
    path,
    push,
    errors,
  })
  const tokens = featureTokens(run.featureId || manifest.featureId)
  const evidenceText = [
    test.experienceUrl,
    ...(test.featureAssertions || []),
    ...evidenceItems.map((item) => [item.target, item.targetUrl, item.targetPath].filter(Boolean).join(' ')),
  ].join(' ')
  if (!textMatchesFeature(evidenceText, tokens) && !evidenceItems.some((item) => item.featureSpecific === true)) {
    push(errors, `${path}.evidence`, `must mention the feature ${run.featureId || manifest.featureId} or mark a specific artifact as featureSpecific=true`)
  }
  if ((test.consoleErrors || []).length > 0 && test.humanWaiverForConsoleErrors !== true) {
    push(errors, `${path}.consoleErrors`, 'must be empty unless waived by human acknowledgement')
  }
  if ((test.failedNetwork || []).length > 0 && test.humanWaiverForNetworkErrors !== true) {
    push(errors, `${path}.failedNetwork`, 'must be empty unless waived by human acknowledgement')
  }
  const overflow = test.layoutOverflow || {}
  for (const viewport of ['desktop', 'mobile']) {
    if (!Number.isFinite(overflow[viewport])) {
      push(errors, `${path}.layoutOverflow.${viewport}`, 'is required')
    } else if (overflow[viewport] > 2) {
      push(errors, `${path}.layoutOverflow.${viewport}`, 'must be <= 2')
    }
  }
}

function validateIntegrationTest(test, path, run, errors) {
  if (run.environment?.isolated !== true && run.environment?.humanApprovalForSharedEnv !== true) {
    push(errors, `${path}.environment`, 'requires isolated environment or human shared-env approval')
  }
  if (test.exitCode !== 0) {
    const classification = test.failureClassification || test.classification
    if (!classification) {
      push(errors, `${path}.failureClassification`, 'is required when integration_live exits non-zero')
      return
    }
    if (classification.relatedToFeature === true || (classification.relatedFailures || 0) > 0) {
      push(errors, `${path}.failureClassification`, 'feature-related integration failures must loop back to develop')
    }
    if (classification.recommendedAction === 'continue_downstream') {
      if (classification.externalOnlyAutoContinue !== true && test.externalOnlyAutoContinue !== true) {
        push(errors, `${path}.failureClassification.externalOnlyAutoContinue`, 'must be true for automatic downstream continuation')
      }
      if ((classification.unrelatedFailures || 0) > 0) {
        push(errors, `${path}.failureClassification.unrelatedFailures`, 'must be 0 for automatic downstream continuation')
      }
      if ((classification.externalFailures || 0) <= 0) {
        push(errors, `${path}.failureClassification.externalFailures`, 'must be greater than 0 for external-only continuation')
      }
      if (!test.reportUrl && (!Array.isArray(test.artifacts) || test.artifacts.length === 0)) {
        push(errors, `${path}.reportUrl`, 'failed integration runs need a reportUrl or artifact link')
      }
    } else if (classification.recommendedAction === 'await_human') {
      const waitingForTask = (run.waiting || []).some((item) => item.taskId === test.taskId && item.state === 'awaiting_human')
      if (!waitingForTask) {
        push(errors, `${path}.waiting`, 'await_human classification requires a matching waiting entry')
      }
    } else {
      push(errors, `${path}.failureClassification.recommendedAction`, 'must be continue_downstream or await_human for non-zero integration runs')
    }
    return
  }
  const passed = countFor(test, 'testsPassed')
  const total = countFor(test, 'totalTests')
  if (Number.isFinite(passed) || Number.isFinite(total)) {
    if (!Number.isFinite(passed) || !Number.isFinite(total) || passed !== total) {
      push(errors, `${path}.testsPassed`, 'must equal totalTests when counts are present')
    }
  }
  if ((test.skippedTests || 0) > 0 && !test.skippedReason) {
    push(errors, `${path}.skippedReason`, 'is required when live integration tests are skipped')
  }
  if (!test.liveEvidence || test.liveEvidence.length === 0) {
    push(errors, `${path}.liveEvidence`, 'live readback evidence is required')
  }
}

function validateTests(run, manifest, errors) {
  const runTests = byId(run.tests || [])
  for (const expected of manifest.testMatrix || []) {
    const test = runTests.get(expected.id)
    if (!test) {
      push(errors, `tests.${expected.id}`, 'missing required test evidence')
      continue
    }
    if (!test.command) push(errors, `tests.${expected.id}.command`, 'is required')
    if (test.stage !== expected.stage) {
      push(errors, `tests.${expected.id}.stage`, `must match manifest stage ${expected.stage}`)
    }
    if (expected.stage === 'test_unit') validateUnitTest(test, `tests.${expected.id}`, errors)
    if (expected.stage === 'deploy_ephemeral') validateDeployEphemeralTest(test, `tests.${expected.id}`, run, errors)
    if (expected.stage === 'test_api') validateApiTest(test, `tests.${expected.id}`, run, errors)
    if (expected.stage === 'test_e2e') validateE2eTest(test, `tests.${expected.id}`, run, manifest, expected, errors)
    if (expected.stage === 'integration_live') validateIntegrationTest(test, `tests.${expected.id}`, run, errors)
  }
}

function validateReview(run, errors) {
  const review = run.review
  if (!review || typeof review !== 'object') {
    push(errors, 'review', 'automated review gate is required')
    return
  }
  if (review.status !== 'passed' && review.acceptedByHuman !== true) {
    push(errors, 'review.status', 'must be passed unless acceptedByHuman is true')
  }
  if ((review.blockingFindings || 0) > 0 && review.acceptedByHuman !== true) {
    push(errors, 'review.blockingFindings', 'must be 0 unless acceptedByHuman is true')
  }
  if (!review.scopeGuard || review.scopeGuard.status !== 'passed') {
    push(errors, 'review.scopeGuard.status', 'must be passed')
  }
  if (review.scopeGuard?.outOfScopeFiles?.length > 0) {
    push(errors, 'review.scopeGuard.outOfScopeFiles', 'must be empty')
  }
  if (!review.artifact) push(errors, 'review.artifact', 'review artifact is required')
}

function validatePlatformAcceptance(run, manifest, errors) {
  const deployRequired = (manifest.stages || []).includes('deploy')
    || (manifest.platformInputs?.required || []).includes('acceptanceCommand')
  if (!deployRequired) return

  const acceptance = run.platformAcceptance
  if (!acceptance || typeof acceptance !== 'object') {
    push(errors, 'platformAcceptance', 'is required for manifests with deploy or acceptanceCommand')
    return
  }

  if (acceptance.status === 'passed') {
    if (acceptance.claimedPlatformComplete !== true) {
      push(errors, 'platformAcceptance.claimedPlatformComplete', 'must be true when platform acceptance passed')
    }
    for (const key of ['workItemId', 'milestoneId', 'acceptanceCommand']) {
      if (!acceptance[key]) push(errors, `platformAcceptance.${key}`, 'is required when platform acceptance passed')
    }
    if (!acceptance.evidence || acceptance.evidence.length === 0) {
      push(errors, 'platformAcceptance.evidence', 'is required when platform acceptance passed')
    }
    return
  }

  if (acceptance.status === 'evidence_boundary') {
    if (acceptance.claimedPlatformComplete !== false) {
      push(errors, 'platformAcceptance.claimedPlatformComplete', 'must be false at the evidence boundary')
    }
    if (!acceptance.reason) push(errors, 'platformAcceptance.reason', 'is required at the evidence boundary')
    if (!acceptance.missingInputs || acceptance.missingInputs.length === 0) {
      push(errors, 'platformAcceptance.missingInputs', 'must list missing external platform inputs')
    }
    return
  }

  push(errors, 'platformAcceptance.status', 'must be passed or evidence_boundary')
}

function validateOutputs(run, errors) {
  for (const [index, output] of (run.outputs || []).entries()) {
    const path = `outputs[${index}]`
    if (!output.taskId) push(errors, `${path}.taskId`, 'is required')
    if (!output.state) push(errors, `${path}.state`, 'is required')
    if (JSON.stringify(output).length > 6000) {
      push(errors, path, 'inline output is too large; upload artifacts instead')
    }
    inspectLargeInlinePayloads(output, path, errors)
  }
}

async function validateArtifacts(run, errors, options = {}) {
  const artifacts = collectArtifacts(run)
  if (options.allowMissingArtifactPaths) return
  for (const [index, artifact] of artifacts.entries()) {
    const locator = artifact.url || artifact.path
    if (!locator) continue
    try {
      if (!(await localPathExists(locator))) {
        push(errors, `artifacts[${index}]`, `artifact is not a URL and does not exist: ${locator}`)
      }
    } catch (error) {
      push(errors, `artifacts[${index}]`, error.message)
    }
  }
}

function summarize(run) {
  const tests = run.tests || []
  const byStage = tests.reduce((acc, test) => {
    acc[test.stage] = (acc[test.stage] || 0) + 1
    return acc
  }, {})
  return {
    tasks: (run.tasks || []).length,
    tests: tests.length,
    byStage,
    artifacts: collectArtifacts(run).length,
  }
}

function printHelp() {
  console.log(`Usage: node harness/scripts/validate-delivery-run.mjs \\
  --manifest harness/manifests/<feature>.json \\
  --run <delivery-run.json>

Validates a Harness-compatible delivery run report. The command is read-only
and does not call the Harness platform.

Options:
  --allow-missing-artifact-paths  Portable kit self-check mode. Do not use for
                                  target repository validation.`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  if (!args.manifest) throw new Error('--manifest is required')
  if (!args.run) throw new Error('--run is required')

  const manifest = await readJson(args.manifest)
  const run = await readJson(args.run)
  const errors = []

  validateEnvironment(run, manifest, errors)
  validateTasks(run, manifest, errors)
  validateWaiting(run, manifest, errors)
  validateTests(run, manifest, errors)
  validateReview(run, errors)
  validatePlatformAcceptance(run, manifest, errors)
  validateOutputs(run, errors)
  await validateArtifacts(run, errors, args)

  if (errors.length > 0) {
    console.error(`Harness delivery run validation failed (${errors.length} issue${errors.length === 1 ? '' : 's'}):`)
    for (const error of errors) console.error(`- ${error.path}: ${error.message}`)
    process.exitCode = 1
    return
  }

  const summary = summarize(run)
  console.log('Harness delivery run validation passed')
  console.log(`Feature: ${manifest.featureId}`)
  console.log(`Tasks: ${summary.tasks}`)
  console.log(`Tests: ${summary.tests}`)
  console.log(`Artifacts: ${summary.artifacts}`)
  console.log(`Stages: ${Object.entries(summary.byStage).map(([stage, count]) => `${stage}=${count}`).join(', ')}`)
  if (run.platformAcceptance?.status) {
    console.log(`Platform acceptance: ${run.platformAcceptance.status}`)
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
