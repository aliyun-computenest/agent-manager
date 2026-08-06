#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { resolveInputPath, resolveOutputPath } from './lib/path-guard.mjs'

const EXTERNAL_PATTERNS = [
  { reason: 'e2b_connectivity', pattern: /failed to connect to e2b api/i },
  { reason: 'e2b_connectivity', pattern: /api\.agent-vpc\.infra/i },
  { reason: 'timeout', pattern: /operation was aborted due to timeout/i },
  { reason: 'oos_template_missing', pattern: /oos .*template .*not configured/i },
  { reason: 'oos_template_missing', pattern: /backup template .*not configured/i },
  { reason: 'oos_template_missing', pattern: /missing .*oos/i },
  { reason: 'environment_prerequisite', pattern: /environment prerequisite/i },
  { reason: 'environment_prerequisite', pattern: /external prerequisite/i },
]

function parseArgs(argv) {
  const args = {
    featureId: '',
    allowExternalAutoContinue: true,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--input') {
      args.input = argv[++i]
    } else if (arg === '--feature-id') {
      args.featureId = argv[++i]
    } else if (arg === '--out') {
      args.out = argv[++i]
    } else if (arg === '--no-auto-continue') {
      args.allowExternalAutoContinue = false
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
    if (argv[i] === undefined && !['--help', '-h', '--no-auto-continue'].includes(arg)) {
      throw new Error(`${arg} requires a value`)
    }
  }
  return args
}

async function readJson(path) {
  return JSON.parse(await readFile(resolveInputPath(path, 'JSON path'), 'utf8'))
}

function normalizeFailure(item) {
  if (typeof item === 'string') return { name: item, message: item }
  if (!item || typeof item !== 'object') return { name: String(item), message: String(item) }
  return {
    name: item.name || item.testName || item.title || item.id || '',
    message: item.message || item.error || item.reason || item.summary || '',
    file: item.file || item.path || '',
    stage: item.stage || '',
  }
}

function featureTokens(featureId) {
  return String(featureId || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3)
}

function includesFeature(failure, tokens) {
  if (tokens.length === 0) return false
  const haystack = Object.values(failure).join(' ').toLowerCase()
  return tokens.some((token) => haystack.includes(token))
}

function externalReason(failure) {
  const text = Object.values(failure).join(' ')
  return EXTERNAL_PATTERNS.find(({ pattern }) => pattern.test(text))?.reason || ''
}

function sample(items) {
  return items.slice(0, 5).map((item) => {
    const label = [item.externalReason ? `[${item.externalReason}]` : '', item.name, item.message].filter(Boolean).join(': ')
    return label.length > 180 ? `${label.slice(0, 177)}...` : label
  })
}

function classify({ failures, featureId, allowExternalAutoContinue }) {
  const tokens = featureTokens(featureId)
  const related = []
  const external = []
  const unrelated = []

  for (const item of failures.map(normalizeFailure)) {
    const reason = externalReason(item)
    if (reason) {
      external.push({ ...item, externalReason: reason })
    } else if (includesFeature(item, tokens)) {
      related.push(item)
    } else {
      unrelated.push(item)
    }
  }

  let status = 'passed'
  let recommendedAction = 'complete'
  let resumeCriteria = ''
  let blockedNextStages = []

  if (related.length > 0) {
    status = 'related_failures_require_develop'
    recommendedAction = 'loop_to_develop'
    resumeCriteria = '修复与本功能相关的失败后重新执行单测、发布、API、浏览器和 integration_live。'
    blockedNextStages = ['code_review', 'deploy']
  } else if (unrelated.length > 0) {
    status = 'unrelated_failures_require_triage'
    recommendedAction = 'await_human'
    resumeCriteria = '请人工确认这些不相关失败是否作为外部问题放行、修复后复跑，或判定为本功能相关后回退 develop。'
    blockedNextStages = ['code_review', 'deploy']
  } else if (external.length > 0) {
    status = allowExternalAutoContinue ? 'external_only_auto_continue' : 'external_only_require_ack'
    recommendedAction = allowExternalAutoContinue ? 'continue_downstream' : 'await_human'
    resumeCriteria = allowExternalAutoContinue
      ? '仅存在明确外部/环境前置失败，且本功能相关失败为 0，可继续 code_review/deploy。'
      : '请人工确认是否将明确外部/环境前置失败视为非阻塞。'
    blockedNextStages = allowExternalAutoContinue ? [] : ['code_review', 'deploy']
  }

  return {
    schemaVersion: '1.0',
    featureId,
    status,
    recommendedAction,
    relatedFailures: related.length,
    externalFailures: external.length,
    unrelatedFailures: unrelated.length,
    relatedToFeature: related.length > 0,
    externalOnlyAutoContinue: status === 'external_only_auto_continue',
    blockedNextStages,
    resumeCriteria,
    samples: {
      related: sample(related),
      external: sample(external),
      unrelated: sample(unrelated),
    },
  }
}

function printHelp() {
  console.log(`Usage: node harness/scripts/classify-integration-failure.mjs \\
  --input <failures.json> \\
  --feature-id <feature-id> [--no-auto-continue]

Input may be an array of failure objects or an object with a failures array.
The command is read-only and emits a machine-readable gate decision.`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  if (!args.input) throw new Error('--input is required')
  if (!args.featureId) throw new Error('--feature-id is required')

  const payload = await readJson(args.input)
  const failures = Array.isArray(payload) ? payload : payload.failures || []
  if (!Array.isArray(failures)) throw new Error('input must be an array or contain a failures array')

  const result = classify({
    failures,
    featureId: args.featureId,
    allowExternalAutoContinue: args.allowExternalAutoContinue,
  })
  const text = `${JSON.stringify(result, null, 2)}\n`
  if (args.out) await writeFile(resolveOutputPath(args.out), text)
  else process.stdout.write(text)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
