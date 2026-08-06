#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateStageOutput } from './check-stage-output.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const defaultDomainPath = 'harness/domains/agent-manager.json'
const defaultRepo = 'acs-automation/agent-manager'

const actionSpecs = {
  'env-create': {
    domainKey: 'envCreate',
    stage: 'env_prepare',
    envVarName: 'HARNESS_ENV_CREATE_PIPELINE_ID',
    yamlPath: '.aoneci/harness_env_create.yaml',
    required: ['workItemId', 'taskId', 'branch'],
  },
  'deploy-image': {
    domainKey: 'deployImage',
    stage: 'deploy_ephemeral',
    envVarName: 'HARNESS_BUILD_DEPLOY_PIPELINE_ID',
    alternateEnvVarNames: ['HARNESS_DEPLOY_IMAGE_PIPELINE_ID'],
    yamlPath: '.aoneci/harness_build_deploy.yaml',
    required: ['workItemId', 'taskId', 'branch', 'namespace'],
  },
  'build-image': {
    domainKey: 'imageBuild',
    stage: 'deploy_ephemeral',
    envVarName: 'HARNESS_IMAGE_BUILD_PIPELINE_ID',
    yamlPath: '.aoneci/build_and_push_image.yaml',
    required: ['workItemId', 'taskId', 'branch'],
  },
  'smoke-api': {
    domainKey: 'smokeTest',
    stage: 'test_api',
    envVarName: 'HARNESS_SMOKE_TEST_PIPELINE_ID',
    yamlPath: '.aoneci/harness_smoke_test.yaml',
    required: ['workItemId', 'taskId', 'branch', 'baseUrl'],
  },
  integration: {
    domainKey: 'integrationTest',
    stage: 'integration_live',
    envVarName: 'HARNESS_INTEGRATION_TEST_PIPELINE_ID',
    alternateEnvVarNames: ['HARNESS_INTEGRATION_PIPELINE_ID'],
    yamlPath: '.aoneci/auto-integration-test.yaml',
    required: ['workItemId', 'taskId', 'branch', 'baseUrl', 'namespace'],
  },
  cleanup: {
    domainKey: 'envCleanup',
    stage: 'deploy',
    envVarName: 'HARNESS_ENV_CLEANUP_PIPELINE_ID',
    yamlPath: '.aoneci/harness_env_cleanup.yaml',
    required: ['workItemId', 'taskId', 'branch', 'namespace'],
  },
}

const successStatuses = new Set(['SUCCESS', 'SUCCEEDED', 'PASSED', 'DONE'])
const pendingStatuses = new Set(['RUNNING', 'PENDING', 'QUEUED', 'CREATED', 'IN_PROGRESS'])
const failedStatuses = new Set(['FAILED', 'ERROR', 'CANCELED', 'CANCELLED', 'TIMEOUT', 'TIMED_OUT'])
const maxDiagnosticLength = 1200
const maxHarnessReportLength = 1800
const maxHarnessOutputLength = 12000

function normalizeStatus(value) {
  return String(value || 'UNKNOWN').trim().toUpperCase()
}

function isSuccess(value) {
  return successStatuses.has(normalizeStatus(value))
}

function isPending(value) {
  return pendingStatuses.has(normalizeStatus(value))
}

function isFailed(value) {
  return failedStatuses.has(normalizeStatus(value))
}

function sleep(ms) {
  if (!ms) return Promise.resolve()
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function defaultRunner(command, args, options = {}) {
  return new Promise((resolveRunner, rejectRunner) => {
    execFile(command, args, {
      cwd: repoRoot,
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      ...options,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        rejectRunner(error)
        return
      }
      resolveRunner({ exitCode: 0, stdout, stderr })
    })
  })
}

function usage() {
  return `Usage:
  node harness/scripts/aone-lifecycle.mjs env-create --work-item <id> --task-id <id> --branch <branch>
  node harness/scripts/aone-lifecycle.mjs build-image --work-item <id> --task-id <id> --branch <branch> --image-tag <tag>
  node harness/scripts/aone-lifecycle.mjs deploy-image --work-item <id> --task-id <id> --branch <branch> --namespace <ns> [--image-tag <tag>]
  node harness/scripts/aone-lifecycle.mjs smoke-api --work-item <id> --task-id <id> --branch <branch> --base-url <url>
  node harness/scripts/aone-lifecycle.mjs integration --work-item <id> --task-id <id> --branch <branch> --base-url <url> --namespace <ns>
  node harness/scripts/aone-lifecycle.mjs cleanup --work-item <id> --task-id <id> --branch <branch> --namespace <ns>
  node harness/scripts/aone-lifecycle.mjs status --work-item <id> --stage <stage>

Common options:
  --pipeline-id <id>       Override lifecycle pipeline id.
  --run-id <id>            Reuse an existing AOneCI run instead of triggering.
  --param <key=value>      Pass an additional AOneCI parameter.
  --dry-run                Print planned JSON without calling a1 or harness.
  --no-write-harness       Do not write task output or milestones.
`
}

export function parseArgs(argv) {
  const args = { extraParams: {} }
  const [action, ...rest] = argv
  args.action = action
  if (!action || action === '--help' || action === '-h') {
    args.help = true
    return args
  }
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    const next = () => {
      const value = rest[i + 1]
      if (!value) throw new Error(`${arg} requires a value`)
      i += 1
      return value
    }
    if (arg === '--work-item') {
      args.workItemId = next()
    } else if (arg === '--task-id' || arg === '--task') {
      args.taskId = next()
    } else if (arg === '--branch') {
      args.branch = next()
    } else if (arg === '--namespace') {
      args.namespace = next()
    } else if (arg === '--service-name') {
      args.serviceName = next()
    } else if (arg === '--base-url') {
      args.baseUrl = next()
    } else if (arg === '--app-config-map-name') {
      args.appConfigMapName = next()
    } else if (arg === '--app-secret-name') {
      args.appSecretName = next()
    } else if (arg === '--pipeline-id') {
      args.pipelineId = next()
    } else if (arg === '--run-id' || arg === '--pipeline-run-id') {
      args.runId = next()
    } else if (arg === '--stage') {
      args.stage = next()
    } else if (arg === '--agent-manager-image') {
      args.agentManagerImage = next()
    } else if (arg === '--image-tag') {
      args.imageTag = next()
    } else if (arg === '--skip-singapore') {
      const value = rest[i + 1]
      if (value && !value.startsWith('--')) {
        args.skipSingapore = next()
      } else {
        args.skipSingapore = true
      }
    } else if (arg === '--ros-stack-id') {
      args.rosStackId = next()
    } else if (arg === '--ros-stack-name') {
      args.rosStackName = next()
    } else if (arg === '--ros-region') {
      args.rosRegion = next()
    } else if (arg === '--ros-timeout-minutes') {
      args.rosTimeoutMinutes = next()
    } else if (arg === '--computenest-region') {
      args.computenestRegion = next()
    } else if (arg === '--deploy-region-id') {
      args.deployRegionId = next()
    } else if (arg === '--acs-service-id') {
      args.acsServiceId = next()
    } else if (arg === '--acs-cluster-id') {
      args.acsClusterId = next()
    } else if (arg === '--ros-template-path') {
      args.rosTemplatePath = next()
    } else if (arg === '--feature-suite') {
      args.featureSuite = next()
    } else if (arg === '--run-browser') {
      const value = rest[i + 1]
      if (value && !value.startsWith('--')) {
        args.runBrowser = next()
      } else {
        args.runBrowser = true
      }
    } else if (arg === '--skip-e2b') {
      const value = rest[i + 1]
      if (value && !value.startsWith('--')) {
        args.skipE2b = next()
      } else {
        args.skipE2b = true
      }
    } else if (arg === '--smoke-only') {
      const value = rest[i + 1]
      if (value && !value.startsWith('--')) {
        args.smokeOnly = next()
      } else {
        args.smokeOnly = true
      }
    } else if (arg === '--wait') {
      const value = rest[i + 1]
      if (value && !value.startsWith('--')) {
        args.wait = next()
      } else {
        args.wait = true
      }
    } else if (arg === '--param' || arg === '--extra-param') {
      const raw = next()
      const separator = raw.indexOf('=')
      if (separator <= 0) throw new Error(`${arg} requires key=value`)
      args.extraParams[raw.slice(0, separator)] = raw.slice(separator + 1)
    } else if (arg === '--repo') {
      args.repo = next()
    } else if (arg === '--domain') {
      args.domainPath = next()
    } else if (arg === '--poll-interval-ms') {
      args.pollIntervalMs = Number(next())
    } else if (arg === '--max-polls') {
      args.maxPolls = Number(next())
    } else if (arg === '--dry-run') {
      args.dryRun = true
    } else if (arg === '--no-write-harness') {
      args.noWriteHarness = true
    } else if (arg === '--no-auto-push-branch') {
      args.autoPushBranch = false
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return args
}

async function readJsonFile(path) {
  return JSON.parse(await readFile(resolve(repoRoot, path), 'utf8'))
}

export async function loadDomainConfig(path = defaultDomainPath) {
  return readJsonFile(path)
}

function parseJsonLoose(text, fallback = {}) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return fallback
  try {
    return JSON.parse(trimmed)
  } catch {
    const objectStart = trimmed.indexOf('{')
    const arrayStart = trimmed.indexOf('[')
    const starts = [objectStart, arrayStart].filter((index) => index >= 0)
    if (starts.length === 0) return fallback
    return JSON.parse(trimmed.slice(Math.min(...starts)))
  }
}

async function runJson(runner, command, args) {
  const result = await runner(command, args)
  return parseJsonLoose(result.stdout, {})
}

function normalizeListPayload(payload, keys) {
  if (Array.isArray(payload)) return payload
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key]
  }
  if (Array.isArray(payload?.data?.list)) return payload.data.list
  if (Array.isArray(payload?.data?.items)) return payload.data.items
  if (Array.isArray(payload?.data)) return payload.data
  return []
}

function pipelineYamlPath(pipeline) {
  return pipeline?.yamlPath
    || pipeline?.ymlPath
    || pipeline?.path
    || pipeline?.filePath
    || pipeline?.codeFilePath
    || pipeline?.config?.yamlPath
    || pipeline?.source?.yamlPath
    || pipeline?.codeFileUrl
    || ''
}

function pipelineIdOf(pipeline) {
  return pipeline?.pipelineId ?? pipeline?.id ?? pipeline?.pipeline_id
}

export async function resolvePipelineId(input, deps = {}) {
  const {
    explicitPipelineId,
    envVarName,
    alternateEnvVarNames = [],
    env = process.env,
    repo = defaultRepo,
    yamlPath,
  } = input
  if (explicitPipelineId) return { pipelineId: explicitPipelineId, source: 'cli' }

  for (const name of [envVarName, ...alternateEnvVarNames].filter(Boolean)) {
    if (env[name]) return { pipelineId: env[name], source: `env:${name}` }
  }

  const runner = deps.runner || defaultRunner
  const payload = await runJson(runner, 'a1', ['ci', 'pipeline', 'list', '--repo', repo, '--format', 'json'])
  const pipelines = normalizeListPayload(payload, ['pipelines', 'items', 'list'])
  const pipeline = pipelines.find((item) => pipelineYamlPath(item).endsWith(yamlPath))
  const pipelineId = pipelineIdOf(pipeline)
  if (!pipelineId) {
    throw new Error(`Cannot resolve AOneCI pipeline id for ${yamlPath}`)
  }
  return { pipelineId, source: 'a1-list' }
}

function slug(value) {
  const text = String(value || 'run')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return text || 'run'
}

function defaultNamespace(workItemId) {
  return `am-harness-${slug(workItemId)}`
}

function normalizeNamespace(value, workItemId) {
  const raw = slug(value || '')
  if (!raw) return defaultNamespace(workItemId)
  if (raw.startsWith('am-harness-')) return raw

  const suffix = raw
    .replace(/^hm-/, '')
    .replace(/^harness-/, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return `am-harness-${suffix || slug(workItemId)}`
}

function defaultRosStackName(workItemId) {
  return `harness-${slug(workItemId)}`
}

function addParam(params, key, value) {
  if (value !== undefined && value !== null && String(value).length > 0) params[key] = value
}

function lifecycleParams(action, options) {
  const params = {}
  const namespace = normalizeNamespace(options.namespace, options.workItemId)
  if (['env-create', 'deploy-image', 'smoke-api', 'cleanup'].includes(action)) {
    addParam(params, 'work_item_id', options.workItemId)
  }
  if (action === 'env-create') {
    addParam(params, 'namespace', namespace)
    addParam(params, 'service_name', options.serviceName || 'openclaw-platform')
    addParam(params, 'ros_stack_name', options.rosStackName || defaultRosStackName(options.workItemId))
    addParam(params, 'computenest_region', options.computenestRegion || 'ap-southeast-1')
    addParam(params, 'deploy_region_id', options.deployRegionId || 'cn-hongkong')
    addParam(params, 'acs_service_id', options.acsServiceId || 'service-731298a621304868a3a4')
    addParam(params, 'acs_cluster_id', options.acsClusterId || 'c2aa8f25b3d9443d28012b53cf7482920')
    addParam(params, 'vpc_id', options.vpcId || 'vpc-j6c11tziiynqsicwit1gv')
    addParam(params, 'vswitch_id', options.vswitchId || 'vsw-j6ceq555bjkzfgmm5kewl')
    addParam(params, 'zone_id', options.zoneId || 'cn-hongkong-d')
    addParam(params, 'skillhub_oss_bucket', options.skillhubOssBucket || 'skillhub-pre-test-intl')
    addParam(params, 'skillhub_oss_region', options.skillhubOssRegion || 'cn-hongkong')
    addParam(params, 'supabase_deployment_mode', options.supabaseDeploymentMode || 'CreateNew')
    addParam(params, 'supabase_project_spec', options.supabaseProjectSpec || '2C2G')
    addParam(params, 'supabase_storage_size', options.supabaseStorageSize || '10')
    if (options.bootstrapImage) addParam(params, 'bootstrap_image', options.bootstrapImage)
    addParam(params, 'agent_manager_artifact_id', options.agentManagerArtifactId || 'artifact-d17025551f9b40a6a3ec')
    addParam(params, 'agent_manager_artifact_region', options.agentManagerArtifactRegion || 'ap-southeast-1')
    if (options.agentManagerArtifactVersion) {
      addParam(params, 'agent_manager_artifact_version', options.agentManagerArtifactVersion)
    }
    addParam(params, 'ros_region', options.rosRegion || 'cn-hongkong')
    addParam(params, 'ros_template_path', options.rosTemplatePath || 'template/platform_template.yaml')
  } else if (action === 'build-image') {
    addParam(params, 'image_tag', options.imageTag || slug(`${options.workItemId}-${options.branch}`))
    addParam(params, 'skip_singapore', options.skipSingapore ?? false)
  } else if (action === 'deploy-image') {
    addParam(params, 'agent_manager_image', options.agentManagerImage)
    addParam(params, 'image_tag', options.imageTag || slug(`${options.workItemId}-${options.branch}`))
    addParam(params, 'namespace', namespace)
    addParam(params, 'service_name', options.serviceName || 'openclaw-platform')
    addParam(params, 'ros_stack_id', options.rosStackId)
    addParam(params, 'ros_stack_name', options.rosStackName)
    addParam(params, 'ros_region', options.rosRegion || 'cn-hongkong')
    addParam(params, 'ros_template_path', options.rosTemplatePath || 'template/platform_template.yaml')
    addParam(params, 'ros_timeout_minutes', options.rosTimeoutMinutes)
  } else if (action === 'smoke-api') {
    addParam(params, 'platform_url', options.baseUrl)
    addParam(params, 'task_id', options.taskId)
    addParam(params, 'feature_suite', options.featureSuite || 'checkpoint-backup')
    addParam(params, 'run_browser', options.runBrowser ?? false)
  } else if (action === 'integration') {
    addParam(params, 'base_url', options.baseUrl)
    addParam(params, 'namespace', namespace)
    addParam(params, 'app_config_map_name', options.appConfigMapName || 'openclaw-platform-config')
    addParam(params, 'app_secret_name', options.appSecretName || 'openclaw-platform-secret')
    addParam(params, 'skip_e2b', options.skipE2b ?? false)
    addParam(params, 'smoke_only', options.smokeOnly ?? false)
  } else if (action === 'cleanup') {
    addParam(params, 'namespace', namespace)
    addParam(params, 'ros_region', options.rosRegion)
    addParam(params, 'ros_stack_id', options.rosStackId)
    addParam(params, 'ros_stack_name', options.rosStackName)
    addParam(params, 'wait', options.wait)
  }
  return {
    ...params,
    ...(options.extraParams || {}),
  }
}

function normalizeParams(params) {
  if (!params) return {}
  if (Array.isArray(params)) {
    return Object.fromEntries(params.map((item) => [item.name || item.key, item.value]).filter(([key]) => key))
  }
  return { ...params }
}

function hasOutputValue(value) {
  return value !== undefined && value !== null && String(value).length > 0
}

function parseJsonishValue(value) {
  if (typeof value === 'string') {
    const text = value.trim()
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        return parseJsonishValue(JSON.parse(text))
      } catch {
        return value
      }
    }
    return value
  }
  if (Array.isArray(value)) return value.map((item) => parseJsonishValue(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, parseJsonishValue(item)]))
  }
  return value
}

function firstValue(object, keys) {
  for (const key of keys) {
    if (hasOutputValue(object?.[key])) return object[key]
  }
  return undefined
}

function normalizeOutputs(outputs) {
  const normalized = {}
  const visit = (value) => {
    const current = parseJsonishValue(value)
    if (Array.isArray(current)) {
      for (const item of current) visit(item)
      return
    }
    if (!current || typeof current !== 'object') return

    const namedKey = firstValue(current, ['OutputKey', 'ParameterKey', 'Name', 'Key'])
    const namedValue = firstValue(current, ['OutputValue', 'ParameterValue', 'Value'])
    if (typeof namedKey === 'string' && hasOutputValue(namedValue)) {
      normalized[namedKey] = namedValue
    }

    for (const [key, value] of Object.entries(current)) {
      if (!Array.isArray(value) && (!value || typeof value !== 'object') && hasOutputValue(value)) {
        normalized[key] = value
      }
    }
    for (const value of Object.values(current)) visit(value)
  }
  visit(outputs)
  return normalized
}

function outputValue(outputs, keys) {
  const normalized = normalizeOutputs(outputs)
  for (const key of keys) {
    if (hasOutputValue(normalized[key])) return normalized[key]
  }
  const lowerMap = Object.fromEntries(Object.entries(normalized).map(([key, value]) => [key.toLowerCase(), value]))
  for (const key of keys) {
    const value = lowerMap[key.toLowerCase()]
    if (hasOutputValue(value)) return value
  }
  return undefined
}

function normalizeRun(run) {
  const params = normalizeParams(run.params || run.parameters || run.inputParams || run.variables)
  const rawOutput = run.rawOutput || run.stdout || ''
  const outputs = {
    ...normalizeOutputs(run.outputs || run.output || run.result || run.resultData || {}),
    ...outputsFromText(rawOutput),
  }
  return {
    raw: run,
    runId: run.runId ?? run.id ?? run.pipelineRunId ?? run.run_id ?? extractRunIdFromText(rawOutput),
    status: normalizeStatus(run.status ?? run.state ?? run.resultStatus ?? statusFromText(rawOutput)),
    url: run.url ?? run.webUrl ?? run.pipelineUrl ?? run.runUrl ?? urlFromText(rawOutput),
    params,
    outputs,
  }
}

function isLocalBaseUrl(value) {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(String(value || ''))
}

function firstTextMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern)
    if (match?.[1]) return match[1].trim()
  }
  return undefined
}

function externalBaseUrlFromServiceLog(text, serviceName) {
  const wantedService = String(serviceName || '').trim()
  const lines = String(text || '').split(/\r?\n/)
  for (const line of lines) {
    const columns = line.trim().split(/\s+/)
    if (columns.length < 5) continue
    const [name, type,, externalIp, ports] = columns
    if (type !== 'LoadBalancer') continue
    if (wantedService && name !== wantedService) continue
    if (!externalIp || externalIp === '<pending>' || externalIp === '<none>') continue
    const port = String(ports || '').match(/^(\d+)/)?.[1] || '80'
    const scheme = port === '443' ? 'https' : 'http'
    const suffix = port === '80' || port === '443' ? '' : `:${port}`
    return `${scheme}://${externalIp}${suffix}`
  }
  return undefined
}

function outputsFromText(text) {
  const value = String(text || '')
  if (!value.trim()) return {}

  const namespace = firstTextMatch(value, [
    /^\s*namespace:\s*([^\s]+)\s*$/im,
    /\bNAMESPACE[=:]\s*([^\s]+)/i,
  ])
  const serviceName = firstTextMatch(value, [
    /^\s*service:\s*([^\s]+)\s*$/im,
    /\bSERVICE_NAME[=:]\s*([^\s]+)/i,
  ])
  const loggedBaseUrl = firstTextMatch(value, [
    /^\s*baseUrl:\s*(https?:\/\/[^\s]+)\s*$/im,
    /\bBASE_URL[=:]\s*(https?:\/\/[^\s]+)/i,
    /\bPlatformUrl[=:]\s*(https?:\/\/[^\s]+)/i,
  ])
  const apiHealthUrl = firstTextMatch(value, [
    /\bApiHealthUrl[=:]\s*(https?:\/\/[^\s]+)/i,
    /\bAPI_HEALTH_URL[=:]\s*(https?:\/\/[^\s]+)/i,
  ])
  const rosStackName = firstTextMatch(value, [
    /^\s*ros:\s*([^\s/]+)\s*\/\s*[^\s]+\s*$/im,
    /\bROS_STACK_NAME[=:]\s*([^\s]+)/i,
  ])
  const rosStackId = firstTextMatch(value, [
    /^\s*ros:\s*[^\s/]+\s*\/\s*([^\s]+)\s*$/im,
    /\bROS_STACK_ID[=:]\s*([^\s]+)/i,
  ])
  const externalBaseUrl = externalBaseUrlFromServiceLog(value, serviceName)
  const platformUrl = externalBaseUrl || loggedBaseUrl

  return Object.fromEntries(Object.entries({
    Namespace: namespace,
    ServiceName: serviceName,
    PlatformUrl: platformUrl,
    baseUrl: loggedBaseUrl,
    ApiHealthUrl: apiHealthUrl,
    RosStackName: rosStackName,
    RosStackId: rosStackId,
  }).filter(([, item]) => hasOutputValue(item)))
}

function mergeRunEvidence(run, text) {
  if (!run || !text) return run
  const textOutputs = outputsFromText(text)
  if (!Object.keys(textOutputs).length) return run
  return {
    ...run,
    rawOutput: [run.rawOutput, text].filter(Boolean).join('\n'),
    outputs: {
      ...(run.outputs || {}),
      ...textOutputs,
    },
  }
}

function runNeedsLogEvidence(action, options, params, run) {
  if (!run?.runId || !isSuccess(run.status)) return false
  if (action !== 'env-create' && action !== 'deploy-image') return false

  const environment = environmentFor(options, params, run)
  if (action === 'env-create') {
    return !environment.namespace
      || !environment.serviceName
      || !environment.baseUrl
      || isLocalBaseUrl(environment.baseUrl)
      || !environment.apiHealthUrl
      || !environment.rosStackName
  }
  return !environment.namespace
    || !environment.serviceName
    || !environment.baseUrl
    || isLocalBaseUrl(environment.baseUrl)
    || !environment.apiHealthUrl
}

async function hydrateRunEvidence({ runner, repo, action, options, params, run, diagnostics }) {
  if (!runNeedsLogEvidence(action, options, params, run)) return run
  try {
    const log = await runner('a1', [
      'ci',
      'run',
      'log',
      String(run.runId),
      '--repo',
      repo,
      '--all',
      '--format',
      'plain',
    ])
    const enriched = mergeRunEvidence(run, log.stdout)
    if (enriched !== run && !runNeedsLogEvidence(action, options, params, enriched)) {
      diagnostics.push(`recovered environment evidence from AOneCI run log ${run.runId}`)
    }
    return enriched
  } catch (error) {
    diagnostics.push(`run log evidence recovery failed for ${run.runId}: ${diagnosticFromError(error)}`)
    return run
  }
}

function runMatches(run, filters) {
  const params = normalizeParams(run.params || run.parameters || run.inputParams || run.variables)
  return Object.entries(filters).every(([key, expected]) => {
    if (expected === undefined || expected === null || String(expected).length === 0) return true
    return String(params[key] ?? '') === String(expected)
  })
}

function branchOfRun(run) {
  const raw = run?.raw || run || {}
  return raw.branch
    || raw.refName
    || raw.sourceBranch
    || raw.source_branch
    || String(raw.ref || '').replace(/^refs\/heads\//, '')
    || ''
}

function runMatchesBranch(run, branch) {
  if (!branch) return true
  const value = branchOfRun(run)
  return !value || String(value) === String(branch) || String(value).endsWith(`/${branch}`)
}

function findMatchingRun(runs, filters, branch) {
  return runs.find((run) => runMatches(run.raw || run, filters) && runMatchesBranch(run, branch)) || null
}

async function listRuns({ runner, repo, pipelineId, branch }) {
  const args = [
    'ci',
    'run',
    'list',
    '--repo',
    repo,
    '--pipeline',
    String(pipelineId),
  ]
  if (branch) args.push('--branch', branch)
  args.push('--format', 'json')
  const payload = await runJson(runner, 'a1', args)
  return normalizeListPayload(payload, ['runs', 'items', 'list']).map(normalizeRun)
}

function historyFilters(params, options = {}) {
  const filters = {}
  if (params.work_item_id) filters.work_item_id = params.work_item_id
  if (options.namespace && params.namespace) filters.namespace = params.namespace
  if (options.rosStackName && params.ros_stack_name) filters.ros_stack_name = params.ros_stack_name
  if (options.imageTag && params.image_tag) filters.image_tag = params.image_tag
  if (options.baseUrl && (params.base_url || params.platform_url)) {
    filters[params.base_url ? 'base_url' : 'platform_url'] = params.base_url || params.platform_url
  }
  return filters
}

function findReusableRun(runs, filters) {
  const matching = runs.filter((run) => runMatches(run, filters))
  return matching.find((run) => isSuccess(run.status))
    || matching.find((run) => isPending(run.status))
    || null
}

async function getRunById({ runner, repo, runId }) {
  if (!runId) return null
  const payload = await runJson(runner, 'a1', ['ci', 'run', 'get', String(runId), '--repo', repo, '--format', 'json'])
  const run = normalizeRun(payload)
  return run.runId ? run : null
}

function extractRunIdFromText(text) {
  const value = String(text || '')
  const patterns = [
    /\bpipelineRunId[=/:"'\s]+(\d{4,})\b/i,
    /\brunId[=/:"'\s]+(\d{4,})\b/i,
    /\/runs\/(\d{4,})\b/i,
  ]
  for (const pattern of patterns) {
    const match = value.match(pattern)
    if (match) return match[1]
  }
  return ''
}

function recoverableRunIdFromText(text, pipelineId) {
  const runId = extractRunIdFromText(text)
  if (!runId) return ''
  if (pipelineId && String(runId) === String(pipelineId)) return ''
  return runId
}

function pipelineLastRunId(payload) {
  return payload?.lastRunId
    ?? payload?.last_run_id
    ?? payload?.latestRunId
    ?? payload?.latest_run_id
    ?? payload?.currentRunId
    ?? payload?.current_run_id
    ?? payload?.data?.lastRunId
    ?? payload?.data?.last_run_id
    ?? payload?.data?.latestRunId
    ?? payload?.data?.latest_run_id
}

function statusFromText(text) {
  const value = String(text || '')
  if (/\bFAILED\b/i.test(value)) return 'FAILED'
  if (/\bCANCELLED\b|\bCANCELED\b/i.test(value)) return 'CANCELED'
  if (/\bSUCCESS\b|\bSUCCEEDED\b|\bPASSED\b/i.test(value)) return 'SUCCESS'
  if (/\bRUNNING\b/i.test(value)) return 'RUNNING'
  if (/\bPENDING\b|\bQUEUED\b/i.test(value)) return 'PENDING'
  return undefined
}

function urlFromText(text) {
  const match = String(text || '').match(/https?:\/\/\S+/)
  return match ? match[0].replace(/[),.;]+$/g, '') : undefined
}

async function waitForRun({ runner, repo, pipelineId, branch, initialRun, filters, pollIntervalMs, maxPolls }) {
  let current = initialRun
  for (let attempt = 0; attempt < maxPolls && isPending(current.status); attempt += 1) {
    await sleep(pollIntervalMs)
    const runs = await listRuns({ runner, repo, pipelineId, branch })
    current = runs.find((run) => String(run.runId) === String(initialRun.runId))
      || findReusableRun(runs, filters)
      || current
  }
  return current
}

async function triggerPipeline({ runner, repo, pipelineId, branch, params }) {
  const args = [
    'ci',
    'pipeline',
    'run',
    String(pipelineId),
    '--repo',
    repo,
    '--branch',
    branch,
  ]
  for (const [key, value] of Object.entries(params)) {
    args.push('--param', `${key}=${value}`)
  }
  args.push('--watch', '--format', 'json')
  const result = await runner('a1', args)
  const payload = parseJsonLoose(result.stdout, {})
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    payload.rawOutput = result.stdout
  }
  return normalizeRun(payload)
}

async function gitText(runner, args) {
  const result = await runner('git', args)
  return String(result.stdout || '').trim()
}

async function gitSucceeds(runner, args) {
  try {
    await runner('git', args)
    return true
  } catch {
    return false
  }
}

async function currentGitBranch(runner) {
  return gitText(runner, ['branch', '--show-current'])
}

async function gitPathExists(runner, ref, path) {
  return gitSucceeds(runner, ['cat-file', '-e', `${ref}:${path}`])
}

async function pushCurrentBranchForCi({ runner, branch, yamlPath, diagnostics }) {
  const currentBranch = await currentGitBranch(runner)
  if (currentBranch !== branch) {
    diagnostics.push(`remote branch ${branch} is not visible to AOneCI and current local branch is ${currentBranch || 'unknown'}; push the target branch before triggering the lifecycle pipeline`)
    return false
  }

  if (!await gitPathExists(runner, 'HEAD', yamlPath)) {
    diagnostics.push(`local branch ${branch} does not contain ${yamlPath}; reinstall or commit the harness kit before triggering the lifecycle pipeline`)
    return false
  }

  await runner('git', ['push', '-u', 'origin', `HEAD:refs/heads/${branch}`])
  diagnostics.push(`pushed local HEAD to origin/${branch} so AOneCI can read ${yamlPath}`)
  return true
}

async function ensureRemotePipelineFile({ runner, branch, yamlPath, diagnostics, autoPushBranch = true }) {
  if (!branch || !yamlPath) return

  let remoteBranchExists = await gitSucceeds(runner, ['ls-remote', '--exit-code', '--heads', 'origin', branch])
  if (!remoteBranchExists) {
    if (!autoPushBranch || !await pushCurrentBranchForCi({ runner, branch, yamlPath, diagnostics })) {
      throw new Error(`Remote branch ${branch} is missing; AOneCI cannot read ${yamlPath}. Push the work branch before triggering the lifecycle pipeline.`)
    }
    remoteBranchExists = true
  }

  if (remoteBranchExists) {
    await runner('git', ['fetch', '--quiet', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`])
  }

  if (await gitPathExists(runner, `refs/remotes/origin/${branch}`, yamlPath)) return

  if (autoPushBranch && await pushCurrentBranchForCi({ runner, branch, yamlPath, diagnostics })) {
    await runner('git', ['fetch', '--quiet', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`])
    if (await gitPathExists(runner, `refs/remotes/origin/${branch}`, yamlPath)) return
  }

  throw new Error(`Remote branch ${branch} does not contain ${yamlPath}; AOneCI would fail with Pipeline file Not Found. Push a commit containing the pipeline file before triggering the lifecycle pipeline.`)
}

function duplicateTriggerMessage(error) {
  const text = [error?.message, error?.stderr, error?.stdout].filter(Boolean).join('\n')
  if (/StackExists|ActionInProgress/i.test(text)) return text.trim()
  return ''
}

function truncateText(value, maxLength = maxDiagnosticLength) {
  const text = String(value || '')
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}\n...<truncated ${text.length - maxLength} chars>`
}

function diagnosticFromError(error) {
  return truncateText([error?.message, error?.stderr, error?.stdout].filter(Boolean).join('\n'))
}

function normalizeDiagnostics(diagnostics = []) {
  return diagnostics.map((item) => truncateText(item)).filter(Boolean)
}

function compactDiagnostics(diagnostics = [], { maxItems = 4, maxLength = 500 } = {}) {
  const normalized = normalizeDiagnostics(diagnostics)
  const compacted = normalized.slice(0, maxItems).map((item) => truncateText(item, maxLength))
  if (normalized.length > compacted.length) {
    compacted.push(`...${normalized.length - compacted.length} more diagnostics omitted; see AOneCI run logs/report artifacts`)
  }
  return compacted
}

function isSensitiveKey(key) {
  const lower = String(key).toLowerCase()
  return lower.includes('secret')
    || lower.includes('token')
    || lower.includes('password')
    || lower.includes('authorization')
    || lower.includes('credential')
    || lower.includes('apikey')
    || lower.includes('api_key')
    || lower.endsWith('accesskey')
    || lower.endsWith('access_key')
    || lower.endsWith('key')
}

export function sanitize(value) {
  if (Array.isArray(value)) return value.map((item) => sanitize(item))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    isSensitiveKey(key) ? '<redacted>' : sanitize(item),
  ]))
}

function baseUrlFromOutputs(outputs = {}, fallback) {
  if (fallback) return fallback
  const baseUrl = outputValue(outputs, ['PlatformUrl', 'platformUrl', 'baseUrl', 'PublicUrl', 'Endpoint', 'Url'])
  if (baseUrl) return baseUrl
  const healthUrl = outputValue(outputs, ['ApiHealthUrl', 'apiHealthUrl', 'HealthUrl'])
  if (healthUrl) return String(healthUrl).replace(/\/api\/health\/?$/, '')
  return undefined
}

function apiHealthUrlFromOutputs(outputs = {}, fallbackBaseUrl) {
  const healthUrl = outputValue(outputs, ['ApiHealthUrl', 'apiHealthUrl', 'HealthUrl'])
  if (healthUrl) return healthUrl
  const baseUrl = baseUrlFromOutputs(outputs, fallbackBaseUrl)
  return baseUrl ? `${String(baseUrl).replace(/\/+$/g, '')}/api/health` : undefined
}

function environmentFor(options, params, run) {
  const outputs = normalizeOutputs(run?.outputs || {})
  return sanitize({
    namespace: params.namespace || options.namespace || outputValue(outputs, ['namespace', 'Namespace']),
    serviceName: options.serviceName || params.service_name || outputValue(outputs, ['serviceName', 'ServiceName']),
    baseUrl: baseUrlFromOutputs(outputs, options.baseUrl),
    apiHealthUrl: apiHealthUrlFromOutputs(outputs, options.baseUrl),
    rosStackName: options.rosStackName || params.ros_stack_name || outputValue(outputs, ['rosStackName', 'RosStackName', 'StackName']),
    rosStackId: options.rosStackId || params.ros_stack_id || outputValue(outputs, ['rosStackId', 'RosStackId', 'StackId']),
    rosTemplatePath: params.ros_template_path || outputValue(outputs, ['rosTemplatePath', 'RosTemplatePath']),
    image: options.agentManagerImage || params.agent_manager_image || outputValue(outputs, ['agentManagerImage', 'AgentManagerImage', 'image', 'Image']),
  })
}

function reportFor(result) {
  const lines = [
    `# AOneCI 生命周期报告：${result.stage}`,
    '',
    `- 状态：${result.state}`,
    `- 工作项：${result.workItemId}`,
    `- Task：${result.taskId}`,
    `- Pipeline：${result.ci.pipelineId || '未解析'}`,
    `- Run：${result.ci.runId || '无'}`,
    `- Run 状态：${result.ci.status || 'UNKNOWN'}`,
  ]
  if (result.ci.url) lines.push(`- Run 链接：${result.ci.url}`)
  if (result.environment.namespace) lines.push(`- Namespace：${result.environment.namespace}`)
  if (result.environment.baseUrl) lines.push(`- Base URL：${result.environment.baseUrl}`)
  if (result.environment.image) lines.push(`- Image：${result.environment.image}`)
  if (result.diagnostics.length) {
    lines.push('', '## 诊断', ...result.diagnostics.map((item) => `- ${item}`))
  }
  return lines.join('\n')
}

function summaryFor(result) {
  const runText = result.ci?.runId ? `AOneCI run ${result.ci.runId}` : 'AOneCI run unknown'
  if (['completed', 'reused'].includes(result.state) && isSuccess(result.ci?.status)) {
    return `${result.stage} 已完成：${runText} ${result.ci.status}`
  }
  return `${result.stage} 未完成：${runText} ${result.ci?.status || 'UNKNOWN'}`
}

function evidenceFor(result) {
  if (!result.ci?.runId && !result.ci?.url) return []
  return [sanitize({
    type: 'aoneci-run',
    stage: result.stage,
    action: result.action,
    runId: result.ci.runId,
    status: result.ci.status,
    url: result.ci.url,
    pipelineId: result.ci.pipelineId,
    pipelinePath: result.ci.pipelinePath || result.pipelinePath,
  })]
}

function normalizeCleanupEvidence(result) {
  if (result.action !== 'cleanup') return result

  const cleanup = {
    ...(result.cleanup || {}),
    namespace: result.cleanup?.namespace || result.environment?.namespace,
    rosStackId: result.cleanup?.rosStackId || result.environment?.rosStackId,
    rosStackName: result.cleanup?.rosStackName || result.environment?.rosStackName,
    pipelinePath: result.cleanup?.pipelinePath || result.ci?.pipelinePath || result.pipelinePath,
  }
  const ci = { ...(result.ci || {}) }

  if (!ci.runId && cleanup.runId) ci.runId = cleanup.runId
  if (!ci.url && cleanup.url) ci.url = cleanup.url
  if (!ci.pipelinePath && cleanup.pipelinePath) ci.pipelinePath = cleanup.pipelinePath
  if ((!ci.status || isPending(ci.status)) && cleanup.status && isSuccess(cleanup.status)) {
    ci.status = cleanup.status
  }

  result.ci = ci
  result.cleanup = sanitize({
    ...cleanup,
    runId: cleanup.runId || ci.runId,
    status: cleanup.status || ci.status,
    url: cleanup.url || ci.url,
    pipelinePath: cleanup.pipelinePath || ci.pipelinePath || result.pipelinePath,
  })
  return result
}

function applyStageOutputGuard(result) {
  if (!['completed', 'reused'].includes(result.state)) return result
  if (result.action === 'build-image') return result

  const check = validateStageOutput(result.stage, result)
  if (check.errors.length === 0) return result

  result.state = 'failed'
  result.diagnostics = normalizeDiagnostics([
    ...(result.diagnostics || []),
    ...check.errors.map((error) => `stage output guard ${error.path}: ${error.message}`),
  ])
  result.reportMarkdown = reportFor(result)
  return result
}

function resultFor({ action, spec, state, workItemId, taskId, pipelineId, pipelineSource, pipelinePath, run, params, options, diagnostics }) {
  const result = {
    schemaVersion: '1.0',
    action,
    stage: spec.stage,
    state,
    workItemId,
    taskId,
    pipelinePath,
    ci: {
      pipelineId,
      pipelineSource,
      pipelinePath,
      runId: run?.runId,
      status: run?.status,
      url: run?.url,
    },
    environment: environmentFor(options, params, run),
    diagnostics: normalizeDiagnostics(diagnostics),
    reportMarkdown: '',
  }
  normalizeCleanupEvidence(result)
  result.summary = summaryFor(result)
  result.evidence = evidenceFor(result)
  result.reportMarkdown = reportFor(result)
  return sanitize(result)
}

function validateOptions(action, spec, options) {
  for (const key of spec.required) {
    if (!options[key] && !(action === 'env-create' && key === 'namespace')) {
      throw new Error(`${key} is required for ${action}`)
    }
  }
}

async function writeHarnessResult(result, options, deps) {
  if (options.noWriteHarness || options.dryRun || !options.taskId) return
  const runner = deps.runner || defaultRunner
  const buildProgressOnly = result.action === 'build-image'
    && ['completed', 'reused'].includes(result.state)
    && isSuccess(result.ci.status)
  const done = !buildProgressOnly && ['completed', 'reused'].includes(result.state) && isSuccess(result.ci.status)
  const taskOutput = harnessTaskOutput(result)
  if (done) {
    await completeStageThroughScript(result.stage, options.taskId, taskOutput, runner)
    await runner('harness', [
      'log',
      options.taskId,
      `${result.stage} 已完成：AOneCI run ${result.ci.runId || 'n/a'}`,
    ])
    return
  }

  await runner('harness', [
    'task',
    'update',
    options.taskId,
    'in_progress',
    '--output',
    JSON.stringify(taskOutput),
  ])

  if (buildProgressOnly) {
    await runner('harness', [
      'log',
      options.taskId,
      `镜像构建已完成：AOneCI run ${result.ci.runId || 'n/a'}，继续执行 deploy-image 发布到隔离环境`,
    ])
    return
  }

  try {
    await runner('harness', [
      'milestone',
      'blocker',
      options.taskId,
      `AOneCI ${result.stage} 未完成：${result.diagnostics[0] || result.ci.status || 'UNKNOWN'}`,
      '--require-ack',
    ])
  } catch (error) {
    console.warn(`warning: failed to write Harness blocker after task output update: ${error.message}`)
  }
}

async function completeStageThroughScript(stage, taskId, output, runner) {
  const dir = await mkdtemp(join(tmpdir(), 'aone-lifecycle-complete-stage-'))
  const filePath = join(dir, 'stage-output.json')
  try {
    await writeFile(filePath, JSON.stringify(output, null, 2))
    await runner(process.execPath, [
      'harness/scripts/complete-stage.mjs',
      '--stage',
      stage,
      '--task-id',
      taskId,
      '--output',
      filePath,
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function harnessTaskOutput(result) {
  const output = sanitize({
    schemaVersion: result.schemaVersion,
    action: result.action,
    stage: result.stage,
    state: result.state,
    workItemId: result.workItemId,
    taskId: result.taskId,
    ci: result.ci,
    pipelinePath: result.pipelinePath,
    environment: result.environment,
    summary: result.summary,
    evidence: result.evidence,
    generatedAt: result.generatedAt,
    cleanup: result.action === 'cleanup' ? result.cleanup : undefined,
    diagnostics: compactDiagnostics(result.diagnostics),
    reportMarkdown: truncateText(result.reportMarkdown || '', maxHarnessReportLength),
  })

  let text = JSON.stringify(output)
  if (text.length <= maxHarnessOutputLength) return output

  output.reportMarkdown = truncateText(output.reportMarkdown, 800)
  output.diagnostics = compactDiagnostics(result.diagnostics, { maxItems: 2, maxLength: 300 })
  text = JSON.stringify(output)
  if (text.length <= maxHarnessOutputLength) return output

  return sanitize({
    schemaVersion: result.schemaVersion,
    action: result.action,
    stage: result.stage,
    state: result.state,
    workItemId: result.workItemId,
    taskId: result.taskId,
    ci: result.ci,
    pipelinePath: result.pipelinePath,
    environment: result.environment,
    summary: result.summary,
    evidence: result.evidence,
    generatedAt: result.generatedAt,
    cleanup: result.action === 'cleanup' ? result.cleanup : undefined,
    diagnostics: ['task output compacted; see AOneCI run logs and reportMarkdown artifacts'],
    reportMarkdown: `# AOneCI 生命周期报告：${result.stage}\n\n- 状态：${result.state}\n- Run：${result.ci.runId || '无'}\n- Run 状态：${result.ci.status || 'UNKNOWN'}`,
  })
}

function dryRunResult(action, spec, options, params, repo, pipelineId) {
  const run = {
    runId: undefined,
    status: 'DRY_RUN',
    url: undefined,
    params,
    outputs: {},
  }
  const result = resultFor({
    action,
    spec,
    state: 'dry_run',
    workItemId: options.workItemId,
    taskId: options.taskId,
    pipelineId: pipelineId || '<resolved-by-aone-lifecycle>',
    pipelineSource: pipelineId ? 'cli-or-env' : 'dry-run',
    pipelinePath: spec.yamlPath,
    run,
    params,
    options,
    diagnostics: ['dry-run: no a1 or harness command was executed'],
  })
  result.plannedCommand = [
    'a1',
    'ci',
    'pipeline',
    'run',
    String(result.ci.pipelineId),
    '--repo',
    repo,
    '--branch',
    options.branch,
    ...Object.entries(params).flatMap(([key, value]) => ['--param', `${key}=${value}`]),
    '--watch',
    '--format',
    'json',
  ]
  return sanitize(result)
}

export async function executeLifecycle(action, options = {}, deps = {}) {
  if (action === 'status') return lifecycleStatus(options, deps)
  const spec = actionSpecs[action]
  if (!spec) throw new Error(`Unknown lifecycle action: ${action}`)
  validateOptions(action, spec, options)

  const env = deps.env || process.env
  const runner = deps.runner || defaultRunner
  const now = deps.now || (() => new Date().toISOString())
  const domain = deps.domain || await loadDomainConfig(options.domainPath || defaultDomainPath)
  const lifecycle = domain?.ciPipelines?.lifecycle?.[spec.domainKey] || {}
  const repo = options.repo || domain?.ciPipelines?.repo || defaultRepo
  const yamlPath = lifecycle.yamlPath || spec.yamlPath
  const params = lifecycleParams(action, options)
  const diagnostics = []

  const envPipelineId = [spec.envVarName, ...(spec.alternateEnvVarNames || [])]
    .map((name) => env[name])
    .find(Boolean)
  if (options.dryRun) {
    const result = dryRunResult(action, spec, options, params, repo, options.pipelineId || envPipelineId)
    result.generatedAt = now()
    return result
  }

  const { pipelineId, source: pipelineSource } = await resolvePipelineId({
    explicitPipelineId: options.pipelineId,
    envVarName: spec.envVarName,
    alternateEnvVarNames: spec.alternateEnvVarNames,
    env,
    repo,
    yamlPath,
  }, { runner })

  if (options.runId) {
    let run = await getRunById({ runner, repo, runId: options.runId })
    if (!run) throw new Error(`Cannot load AOneCI run ${options.runId}`)
    if (!runMatchesBranch(run, options.branch)) {
      throw new Error(`AOneCI run ${options.runId} is not on branch ${options.branch}`)
    }
    if (isPending(run.status)) {
      diagnostics.push(`explicit run ${run.runId} is ${run.status}; polling until terminal status`)
      run = await waitForRun({
        runner,
        repo,
        pipelineId,
        branch: options.branch,
        initialRun: run,
        filters: {},
        pollIntervalMs: options.pollIntervalMs ?? deps.pollIntervalMs ?? 10000,
        maxPolls: options.maxPolls ?? deps.maxPolls ?? 360,
      })
    } else {
      diagnostics.push(`reused explicit AOneCI run ${run.runId}`)
    }
    run = await hydrateRunEvidence({
      runner,
      repo,
      action,
      options,
      params,
      run,
      diagnostics,
    })
    const result = resultFor({
      action,
      spec,
      state: isFailed(run.status) ? 'failed' : 'completed',
      workItemId: options.workItemId,
      taskId: options.taskId,
      pipelineId,
      pipelineSource,
      pipelinePath: yamlPath,
      run,
      params,
      options,
      diagnostics,
    })
    applyStageOutputGuard(result)
    result.generatedAt = now()
    await writeHarnessResult(result, options, { runner })
    return result
  }

  const filters = historyFilters(params, options)
  const initialRuns = await listRuns({ runner, repo, pipelineId, branch: options.branch })
  let reusableRun = findReusableRun(initialRuns, filters)
  if (reusableRun) {
    if (isPending(reusableRun.status)) {
      diagnostics.push(`reused existing ${reusableRun.status} run ${reusableRun.runId}; waited instead of duplicate trigger`)
      reusableRun = await waitForRun({
        runner,
        repo,
        pipelineId,
        branch: options.branch,
        initialRun: reusableRun,
        filters,
        pollIntervalMs: options.pollIntervalMs ?? deps.pollIntervalMs ?? 10000,
        maxPolls: options.maxPolls ?? deps.maxPolls ?? 360,
      })
    } else {
      diagnostics.push(`reused existing SUCCESS run ${reusableRun.runId}`)
    }
    const state = isFailed(reusableRun.status) ? 'failed' : 'reused'
    reusableRun = await hydrateRunEvidence({
      runner,
      repo,
      action,
      options,
      params,
      run: reusableRun,
      diagnostics,
    })
    const result = resultFor({
      action,
      spec,
      state,
      workItemId: options.workItemId,
      taskId: options.taskId,
      pipelineId,
      pipelineSource,
      pipelinePath: yamlPath,
      run: reusableRun,
      params,
      options,
      diagnostics,
    })
    applyStageOutputGuard(result)
    result.generatedAt = now()
    await writeHarnessResult(result, options, { runner })
    return result
  }

  let run
  let state = 'completed'
  const waitIfPending = (candidate) => {
    if (!candidate || !isPending(candidate.status)) return candidate
    return waitForRun({
      runner,
      repo,
      pipelineId,
      branch: options.branch,
      initialRun: candidate,
      filters,
      pollIntervalMs: options.pollIntervalMs ?? deps.pollIntervalMs ?? 10000,
      maxPolls: options.maxPolls ?? deps.maxPolls ?? 360,
    })
  }
  const recoverRunFromList = async (reason) => {
    const rerunList = await listRuns({ runner, repo, pipelineId, branch: options.branch })
    const recovered = findReusableRun(rerunList, filters)
    if (!recovered) return null
    diagnostics.push(`${reason}; recovered ${recovered.status} run ${recovered.runId || 'unknown'} from run list`)
    return waitIfPending(recovered)
  }
  const recoverTriggeredRun = async (reason, text = '') => {
    const extractedRunId = extractRunIdFromText(text)
    const runId = recoverableRunIdFromText(text, pipelineId)
    if (extractedRunId && !runId) {
      diagnostics.push(`ignored extracted run id ${extractedRunId} because it matches pipeline id ${pipelineId}`)
    }
    if (runId) {
      try {
        const byId = await getRunById({ runner, repo, runId })
        if (byId && runMatches(byId.raw || byId, filters) && runMatchesBranch(byId, options.branch)) {
          diagnostics.push(`${reason}; recovered ${byId.status} run ${byId.runId} from run id`)
          return waitIfPending(byId)
        }
      } catch (error) {
        diagnostics.push(`run id recovery failed for ${runId}: ${diagnosticFromError(error)}`)
      }
    }

    const rerunList = await listRuns({ runner, repo, pipelineId, branch: options.branch })
    const matching = findMatchingRun(rerunList, filters, options.branch)
    if (matching) {
      diagnostics.push(`${reason}; recovered ${matching.status} run ${matching.runId || 'unknown'} from run list`)
      return waitIfPending(matching)
    }

    try {
      const pipeline = await runJson(runner, 'a1', ['ci', 'pipeline', 'get', String(pipelineId), '--repo', repo, '--format', 'json'])
      const lastRunId = pipelineLastRunId(pipeline)
      if (lastRunId) {
        const latest = await getRunById({ runner, repo, runId: lastRunId })
        if (latest && runMatches(latest.raw || latest, filters) && runMatchesBranch(latest, options.branch)) {
          diagnostics.push(`${reason}; recovered ${latest.status} run ${latest.runId} from pipeline lastRunId`)
          return waitIfPending(latest)
        }
      }
    } catch (error) {
      diagnostics.push(`pipeline lastRunId recovery failed: ${diagnosticFromError(error)}`)
    }

    return null
  }
  try {
    await ensureRemotePipelineFile({
      runner,
      branch: options.branch,
      yamlPath,
      diagnostics,
      autoPushBranch: options.autoPushBranch !== false,
    })
    run = await triggerPipeline({ runner, repo, pipelineId, branch: options.branch, params })
    if (isFailed(run.status)) {
      const recovered = await recoverRunFromList(`AOneCI run ${run.runId || 'unknown'} ended with ${run.status}; checked for a newer reusable run`)
      if (recovered) {
        run = recovered
        state = isFailed(run.status) ? 'failed' : 'completed'
      } else {
        state = 'failed'
        diagnostics.push(`AOneCI run ${run.runId || 'unknown'} ended with ${run.status}`)
      }
    } else if (isPending(run.status)) {
      diagnostics.push(`AOneCI run ${run.runId || 'unknown'} is ${run.status}; polling until terminal status`)
      run = await waitForRun({
        runner,
        repo,
        pipelineId,
        branch: options.branch,
        initialRun: run,
        filters,
        pollIntervalMs: options.pollIntervalMs ?? deps.pollIntervalMs ?? 10000,
        maxPolls: options.maxPolls ?? deps.maxPolls ?? 360,
      })
      if (isFailed(run.status)) {
        const recovered = await recoverRunFromList(`AOneCI run ${run.runId || 'unknown'} ended with ${run.status}; checked for a newer reusable run`)
        if (recovered) {
          run = recovered
          state = isFailed(run.status) ? 'failed' : 'completed'
        } else {
          state = 'failed'
        }
      } else {
        state = 'completed'
      }
    } else if (!isSuccess(run.status)) {
      const recovered = await recoverTriggeredRun(
        `AOneCI trigger returned non-terminal or non-machine-readable status ${run.status}`,
        JSON.stringify(run.raw || run),
      )
      if (recovered) {
        run = recovered
        state = isFailed(run.status) ? 'failed' : 'completed'
      } else {
        state = 'failed'
        diagnostics.push(`AOneCI returned unknown status ${run.status}`)
      }
    }
  } catch (error) {
    const duplicate = duplicateTriggerMessage(error)
    if (duplicate) {
      reusableRun = await recoverRunFromList(`duplicate trigger diagnosed from AOneCI error: ${duplicate}`)
      if (reusableRun) {
        reusableRun = await hydrateRunEvidence({
          runner,
          repo,
          action,
          options,
          params,
          run: reusableRun,
          diagnostics,
        })
        const result = resultFor({
          action,
          spec,
          state: isFailed(reusableRun.status) ? 'failed' : 'reused',
          workItemId: options.workItemId,
          taskId: options.taskId,
          pipelineId,
          pipelineSource,
          pipelinePath: yamlPath,
          run: reusableRun,
          params,
          options,
          diagnostics,
        })
        applyStageOutputGuard(result)
        result.generatedAt = now()
        await writeHarnessResult(result, options, { runner })
        return result
      }
    }
    const errorText = [error?.message, error?.stderr, error?.stdout].filter(Boolean).join('\n')
    const recovered = await recoverTriggeredRun(`AOneCI trigger command failed or returned unparseable output: ${diagnosticFromError(error)}`, errorText)
    if (recovered) {
      run = recovered
      state = isFailed(run.status) ? 'failed' : 'completed'
    } else {
      state = 'failed'
      diagnostics.push(diagnosticFromError(error))
      run = {
        runId: undefined,
        status: 'FAILED',
        url: undefined,
        params,
        outputs: {},
      }
    }
  }

  run = await hydrateRunEvidence({
    runner,
    repo,
    action,
    options,
    params,
    run,
    diagnostics,
  })
  const result = resultFor({
    action,
    spec,
    state,
    workItemId: options.workItemId,
    taskId: options.taskId,
    pipelineId,
    pipelineSource,
    pipelinePath: yamlPath,
    run,
    params,
    options,
    diagnostics,
  })
  applyStageOutputGuard(result)
  result.generatedAt = now()
  await writeHarnessResult(result, options, { runner })
  return result
}

async function lifecycleStatus(options = {}, deps = {}) {
  if (!options.workItemId) throw new Error('workItemId is required for status')
  if (!options.stage) throw new Error('stage is required for status')
  const env = deps.env || process.env
  const runner = deps.runner || defaultRunner
  const domain = deps.domain || await loadDomainConfig(options.domainPath || defaultDomainPath)
  const repo = options.repo || domain?.ciPipelines?.repo || defaultRepo
  const entries = Object.entries(domain?.ciPipelines?.lifecycle || {})
    .filter(([, lifecycle]) => lifecycle.stage === options.stage)

  const pipelines = []
  for (const [key, lifecycle] of entries) {
    const spec = Object.values(actionSpecs).find((item) => item.domainKey === key)
    const resolved = await resolvePipelineId({
      explicitPipelineId: options.pipelineId,
      envVarName: spec?.envVarName,
      alternateEnvVarNames: spec?.alternateEnvVarNames,
      env,
      repo,
      yamlPath: lifecycle.yamlPath,
    }, { runner })
    const runs = await listRuns({ runner, repo, pipelineId: resolved.pipelineId, branch: options.branch })
    pipelines.push({
      key,
      stage: lifecycle.stage,
      yamlPath: lifecycle.yamlPath,
      pipelineId: resolved.pipelineId,
      pipelineSource: resolved.source,
      runs: runs
        .filter((run) => runMatches(run, { work_item_id: options.workItemId }))
        .map((run) => sanitize(run)),
    })
  }
  return {
    schemaVersion: '1.0',
    action: 'status',
    stage: options.stage,
    state: 'completed',
    workItemId: options.workItemId,
    pipelines,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }
  const result = await executeLifecycle(args.action, args)
  console.log(`${JSON.stringify(result, null, 2)}\n`)
  if (result.state === 'failed') process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
