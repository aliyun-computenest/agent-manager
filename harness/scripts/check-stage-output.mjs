#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { isRemoteArtifactLocator, resolveInputPath } from './lib/path-guard.mjs'
import {
  validateFeatureRelevantBrowserEvidence,
  validateRequiredE2eEvidence,
} from './lib/e2e-evidence-guard.mjs'

const completedStates = new Set(['completed', 'reused'])
const successStatuses = new Set(['SUCCESS', 'SUCCEEDED', 'PASSED', 'DONE'])
const stageAliases = { plan: 'dev_orchestration' }

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--stage') {
      args.stage = argv[++i]
    } else if (arg === '--task-id' || arg === '--task') {
      args.taskId = argv[++i]
    } else if (arg === '--output') {
      args.output = argv[++i]
    } else if (arg === '--work-item') {
      args.workItem = argv[++i]
    } else if (arg === '--manifest') {
      args.manifest = argv[++i]
    } else if (arg === '--test-id') {
      args.testId = argv[++i]
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

function usage() {
  return `Usage:
  node harness/scripts/check-stage-output.mjs --stage <stage> --output <stage-output.json>
  node harness/scripts/check-stage-output.mjs --stage <stage> --work-item <work-item-context.json> [--task-id <task_id>]
  node harness/scripts/check-stage-output.mjs --stage test_e2e --output <stage-output.json> --manifest <feature-manifest.json> [--test-id <test_id>]

This is a read-only guard. Write the intended Harness task output to a JSON file,
run this script, and only mark the task done when it passes.`
}

async function readJson(path, label) {
  if (!path) throw new Error(`${label} path is required`)
  const fullPath = resolveInputPath(path, label)
  const text = await readFile(fullPath, 'utf8')
  try {
    return parseOutputValue(JSON.parse(text))
  } catch (error) {
    throw new Error(`Failed to parse ${label} JSON ${path}: ${error.message}`)
  }
}

function canonicalStage(stage) {
  const value = String(stage || '').trim()
  return stageAliases[value] || value
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

function outputFromTask(task) {
  if (!task || typeof task !== 'object') return undefined
  return parseOutputValue(task.output ?? task.result ?? task.data?.output)
}

function taskStage(task) {
  return canonicalStage(task?.stage || task?.type || task?.taskType || task?.platformTaskType)
}

export function testDefinitionFor(manifest, { stage, testId } = {}) {
  if (!manifest) return undefined
  const tests = Array.isArray(manifest.testMatrix) ? manifest.testMatrix : []
  if (testId) {
    const test = tests.find((item) => String(item.id) === String(testId))
    if (!test) throw new Error(`Manifest test ${testId} was not found`)
    if (canonicalStage(test.stage) !== canonicalStage(stage)) {
      throw new Error(`Manifest test ${testId} belongs to stage ${test.stage}, not ${stage}`)
    }
    return test
  }
  const candidates = tests.filter((item) => canonicalStage(item.stage) === canonicalStage(stage))
  if (candidates.length === 0) throw new Error(`Manifest has no test for stage ${stage}`)
  if (candidates.length > 1) throw new Error(`Manifest has multiple tests for stage ${stage}; pass --test-id`)
  return candidates[0]
}

function extractStageOutput(payload, { stage, taskId } = {}) {
  const canonical = canonicalStage(stage)
  if (payload?.workItem || payload?.tasks || payload?.work_item) {
    const tasks = payload.tasks || payload.workItem?.tasks || payload.work_item?.tasks || []
    const task = tasks.find((item) => {
      if (taskId && String(item.id || item.taskId) !== String(taskId)) return false
      return taskId || taskStage(item) === canonical
    })
    return outputFromTask(task)
  }
  if (payload?.task) return outputFromTask(payload.task)
  if (payload?.output) return parseOutputValue(payload.output)
  return payload
}

function push(errors, path, message) {
  errors.push({ path, message })
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function hasNonEmptyCollection(value) {
  if (Array.isArray(value)) return value.length > 0
  if (value && typeof value === 'object') return Object.keys(value).length > 0
  return false
}

function getPath(value, path) {
  return path.split('.').reduce((current, key) => current?.[key], value)
}

function requireText(errors, output, path) {
  if (!hasText(String(getPath(output, path) ?? ''))) push(errors, path, 'must be present')
}

function requireCollection(errors, output, path) {
  if (!hasNonEmptyCollection(getPath(output, path))) push(errors, path, 'must be a non-empty array or object')
}

function requireAnyCollection(errors, output, paths, label) {
  if (!paths.some((path) => hasNonEmptyCollection(getPath(output, path)))) {
    push(errors, label, `one of ${paths.join(', ')} must be a non-empty array or object`)
  }
}

function requireAnyText(errors, output, paths, label) {
  if (!paths.some((path) => hasText(String(getPath(output, path) ?? '')))) {
    push(errors, label, `one of ${paths.join(', ')} must be present`)
  }
}

function normalizeStatus(value) {
  return String(value || '').trim().toUpperCase()
}

function isLocalUrl(value) {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(String(value || ''))
}

function isPlatformVisibleLocator(value) {
  if (!isRemoteArtifactLocator(value)) return false
  return !isLocalUrl(value)
}

function experienceUrlFor(output) {
  return output?.experienceUrl || output?.experience?.url || output?.targetUrl
}

function browserEvidenceItems(output) {
  const items = [
    ...(Array.isArray(output?.screenshots) ? output.screenshots : []),
    ...(Array.isArray(output?.artifacts) ? output.artifacts : []),
  ]
  if (hasText(output?.traceUrl)) items.push({ kind: 'trace', url: output.traceUrl })
  if (hasText(output?.videoUrl)) items.push({ kind: 'video', url: output.videoUrl })
  return items
}

function validatePlatformVisibleBrowserEvidence(output, errors) {
  const items = browserEvidenceItems(output)
  if (items.length === 0) {
    push(errors, 'screenshots', 'must include feature-specific screenshot, artifact, trace, or video evidence')
    return
  }

  let visibleCount = 0
  for (const [index, item] of items.entries()) {
    const path = item?.kind === 'screenshot' ? `screenshots[${index}]` : `artifacts[${index}]`
    const url = typeof item === 'string' ? item : item?.url
    if (!isPlatformVisibleLocator(url)) {
      push(errors, `${path}.url`, 'must be a platform-visible uploaded URL or harness:// artifact, not only a local path')
      continue
    }
    visibleCount += 1
  }

  if (visibleCount === 0) {
    push(errors, 'screenshots', 'must include at least one platform-visible uploaded screenshot/artifact URL')
  }
}

function validateCommonCompleted(stage, output, errors) {
  if (!output || typeof output !== 'object') {
    push(errors, stage, 'stage output must be a JSON object')
    return
  }
  if (!completedStates.has(output.state)) {
    push(errors, 'state', 'must be completed or reused before marking the task done')
  }
}

function validateDevOrchestration(output, errors) {
  validateCommonCompleted('dev_orchestration', output, errors)
  if (!output || typeof output !== 'object') return
  requireText(errors, output, 'summary')
  requireCollection(errors, output, 'allowlist')
  if (!Array.isArray(output.denylist)) push(errors, 'denylist', 'must be an array, even when empty')
  requireCollection(errors, output, 'dag')
  requireAnyCollection(errors, output, ['parallelWaves', 'waves'], 'parallelWaves')
  requireCollection(errors, output, 'resourceLocks')
  requireCollection(errors, output, 'environmentPlan')
  requireCollection(errors, output, 'testMatrix')
  requireAnyCollection(errors, output, ['evidenceRequirements', 'requiredEvidence'], 'evidenceRequirements')
  requireText(errors, output, 'scopeGuardCommand')
}

function validateEnvPrepare(output, errors) {
  validateCommonCompleted('env_prepare', output, errors)
  if (!output || typeof output !== 'object') return
  if (output.schemaVersion !== '1.0') push(errors, 'schemaVersion', 'must be "1.0"')
  if (output.stage !== 'env_prepare') push(errors, 'stage', 'must be env_prepare')
  if (output.action && output.action !== 'env-create') push(errors, 'action', 'must be env-create when present')
  if (!successStatuses.has(normalizeStatus(output.ci?.status))) {
    push(errors, 'ci.status', 'must be SUCCESS/SUCCEEDED/PASSED/DONE')
  }
  requireText(errors, output, 'ci.pipelineId')
  requireText(errors, output, 'ci.runId')
  requireText(errors, output, 'ci.url')
  requireAnyText(errors, output, ['ci.pipelinePath', 'pipelinePath'], 'pipelinePath')
  requireText(errors, output, 'environment.namespace')
  requireText(errors, output, 'environment.serviceName')
  requireText(errors, output, 'environment.baseUrl')
  requireText(errors, output, 'environment.apiHealthUrl')
  requireText(errors, output, 'environment.rosStackName')
  if (isLocalUrl(output.environment?.baseUrl) || isLocalUrl(output.baseUrl)) {
    push(errors, 'environment.baseUrl', 'must not be localhost or 127.0.0.1 for isolated environment completion')
  }
  if (isLocalUrl(output.environment?.apiHealthUrl)) {
    push(errors, 'environment.apiHealthUrl', 'must not be localhost or 127.0.0.1 for isolated environment completion')
  }
  if (!hasText(output.reportMarkdown) && !hasNonEmptyCollection(output.report)) {
    push(errors, 'reportMarkdown', 'must include a readable reportMarkdown or report')
  }
}

function validateDeployEphemeral(output, errors) {
  validateCommonCompleted('deploy_ephemeral', output, errors)
  if (!output || typeof output !== 'object') return
  if (output.schemaVersion !== '1.0') push(errors, 'schemaVersion', 'must be "1.0"')
  if (output.stage !== 'deploy_ephemeral') push(errors, 'stage', 'must be deploy_ephemeral')
  if (output.action !== 'deploy-image') push(errors, 'action', 'must be deploy-image; build-image alone cannot complete deploy_ephemeral')
  if (!successStatuses.has(normalizeStatus(output.ci?.status))) {
    push(errors, 'ci.status', 'must be SUCCESS/SUCCEEDED/PASSED/DONE')
  }
  requireText(errors, output, 'ci.pipelineId')
  requireText(errors, output, 'ci.runId')
  requireText(errors, output, 'ci.url')
  requireAnyText(errors, output, ['ci.pipelinePath', 'pipelinePath'], 'pipelinePath')
  requireText(errors, output, 'environment.namespace')
  requireText(errors, output, 'environment.serviceName')
  requireText(errors, output, 'environment.baseUrl')
  requireText(errors, output, 'environment.apiHealthUrl')
  requireText(errors, output, 'environment.image')
  if (!hasText(output.environment?.rosStackId) && !hasText(output.environment?.rosStackName)) {
    push(errors, 'environment.rosStackId', 'rosStackId or rosStackName must be present')
  }
  if (isLocalUrl(output.environment?.baseUrl) || isLocalUrl(output.baseUrl)) {
    push(errors, 'environment.baseUrl', 'must not be localhost or 127.0.0.1 for isolated deploy completion')
  }
  if (isLocalUrl(output.environment?.apiHealthUrl)) {
    push(errors, 'environment.apiHealthUrl', 'must not be localhost or 127.0.0.1 for isolated deploy completion')
  }
  if (!hasText(output.reportMarkdown) && !hasNonEmptyCollection(output.report)) {
    push(errors, 'reportMarkdown', 'must include a readable deployment report')
  }
}

function validateDeploy(output, errors) {
  validateCommonCompleted('deploy', output, errors)
  if (!output || typeof output !== 'object') return
  if (output.schemaVersion !== '1.0') push(errors, 'schemaVersion', 'must be "1.0"')
  if (output.stage !== 'deploy') push(errors, 'stage', 'must be deploy')
  if (output.action !== 'cleanup') push(errors, 'action', 'must be cleanup for final deploy/environment cleanup completion')
  if (!successStatuses.has(normalizeStatus(output.ci?.status))) {
    push(errors, 'ci.status', 'must be SUCCESS/SUCCEEDED/PASSED/DONE')
  }
  requireText(errors, output, 'ci.pipelineId')
  requireText(errors, output, 'ci.runId')
  requireText(errors, output, 'ci.url')
  requireAnyText(errors, output, ['ci.pipelinePath', 'pipelinePath'], 'pipelinePath')
  requireText(errors, output, 'environment.namespace')
  if (!hasText(output.environment?.rosStackId) && !hasText(output.environment?.rosStackName)) {
    push(errors, 'environment.rosStackId', 'rosStackId or rosStackName must be present')
  }
  if (output.cleanup && typeof output.cleanup === 'object') {
    if (hasText(output.cleanup.runId) && hasText(output.ci?.runId) && String(output.cleanup.runId) !== String(output.ci.runId)) {
      push(errors, 'cleanup.runId', 'must match ci.runId')
    }
    if (hasText(output.cleanup.status) && hasText(output.ci?.status) && normalizeStatus(output.cleanup.status) !== normalizeStatus(output.ci.status)) {
      push(errors, 'cleanup.status', 'must match ci.status')
    }
    if (successStatuses.has(normalizeStatus(output.cleanup.status)) && !successStatuses.has(normalizeStatus(output.ci?.status))) {
      push(errors, 'ci.status', 'must mirror successful cleanup.status')
    }
    if (hasText(output.cleanup.pipelinePath) && hasText(output.ci?.pipelinePath) && output.cleanup.pipelinePath !== output.ci.pipelinePath) {
      push(errors, 'cleanup.pipelinePath', 'must match ci.pipelinePath')
    }
  }
  if (!hasText(output.reportMarkdown) && !hasNonEmptyCollection(output.report)) {
    push(errors, 'reportMarkdown', 'must include a readable deploy/cleanup report')
  }
}

function validateUnit(output, errors) {
  validateCommonCompleted('test_unit', output, errors)
  if (output?.exitCode !== 0) push(errors, 'exitCode', 'must be 0')
  if (typeof output?.testsPassed !== 'number') push(errors, 'testsPassed', 'must be a number')
  if (typeof output?.totalTests !== 'number') push(errors, 'totalTests', 'must be a number')
  if (output?.testsPassed !== output?.totalTests) push(errors, 'testsPassed', 'must equal totalTests')
}

function validateBrowser(output, errors, requirements = {}) {
  validateCommonCompleted('test_e2e', output, errors)
  requireText(errors, output, 'baseUrl')
  if (isLocalUrl(output?.baseUrl)) push(errors, 'baseUrl', 'must not be localhost or 127.0.0.1')
  const experienceUrl = experienceUrlFor(output)
  if (!hasText(experienceUrl)) {
    push(errors, 'experienceUrl', 'must provide a clickable experience URL for platform readers')
  } else if (isLocalUrl(experienceUrl)) {
    push(errors, 'experienceUrl', 'must not be localhost or 127.0.0.1')
  }
  validatePlatformVisibleBrowserEvidence(output, errors)
  validateFeatureRelevantBrowserEvidence({
    value: output,
    items: browserEvidenceItems(output),
    experienceUrl,
    path: 'test_e2e',
    push,
    errors,
  })
  validateRequiredE2eEvidence({
    value: output,
    items: browserEvidenceItems(output),
    requirements,
    path: 'test_e2e',
    push,
    errors,
  })
}

export function validateStageOutput(stage, payload, options = {}) {
  const canonical = canonicalStage(stage)
  const output = extractStageOutput(payload, { stage: canonical, taskId: options.taskId })
  const errors = []
  if (!output) {
    push(errors, canonical, 'stage output was not found')
    return { stage: canonical, output, errors }
  }
  if (canonical === 'dev_orchestration') {
    validateDevOrchestration(output, errors)
  } else if (canonical === 'env_prepare') {
    validateEnvPrepare(output, errors)
  } else if (canonical === 'deploy_ephemeral') {
    validateDeployEphemeral(output, errors)
  } else if (canonical === 'deploy') {
    validateDeploy(output, errors)
  } else if (canonical === 'test_unit') {
    validateUnit(output, errors)
  } else if (canonical === 'test_e2e') {
    if (!options.testDefinition) {
      push(errors, 'test_e2e.manifest', 'manifest-aware test definition is required; check-stage-output accepts --manifest/--test-id, while complete-stage resolves the platform-owned binding')
    }
    validateBrowser(output, errors, options.testDefinition)
  } else {
    validateCommonCompleted(canonical, output, errors)
    requireText(errors, output, 'summary')
    if (!hasNonEmptyCollection(output.evidence) && !hasText(output.reportMarkdown) && !hasNonEmptyCollection(output.report)) {
      push(errors, 'evidence', 'must include evidence, report, or reportMarkdown')
    }
  }
  return { stage: canonical, output, errors }
}

function printResult(result) {
  if (result.errors.length === 0) {
    console.log(`Stage output check passed: ${result.stage}`)
    return
  }
  console.error(`Stage output check failed: ${result.stage}`)
  for (const error of result.errors) {
    console.error(`- ${error.path}: ${error.message}`)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }
  if (!args.stage) throw new Error('--stage is required')
  if (!args.output && !args.workItem) throw new Error('--output or --work-item is required')

  const payload = args.output
    ? await readJson(args.output, 'Stage output')
    : await readJson(args.workItem, 'Work item')
  const manifest = args.manifest ? await readJson(args.manifest, 'Manifest') : undefined
  const testDefinition = canonicalStage(args.stage) === 'test_e2e'
    ? testDefinitionFor(manifest, { stage: args.stage, testId: args.testId })
    : undefined
  const result = validateStageOutput(args.stage, payload, { taskId: args.taskId, testDefinition })
  printResult(result)
  if (result.errors.length > 0) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
