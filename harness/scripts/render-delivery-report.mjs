#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolveInputPath } from './lib/path-guard.mjs'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--run') {
      args.run = argv[i + 1]
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

function artifacts(value, out = []) {
  if (!value || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    for (const item of value) artifacts(item, out)
    return out
  }
  if (value.url || value.path) out.push(value)
  for (const item of Object.values(value)) artifacts(item, out)
  return out
}

function link(label, locator) {
  if (!locator) return ''
  if (/^https?:\/\//.test(locator)) return `[${label}](${locator})`
  return `\`${locator}\``
}

function statusIcon(status) {
  if (status === 'done' || status === 'passed' || status === 'completed') return 'OK'
  if (status === 'in_progress' || status === 'awaiting_human') return 'WAIT'
  if (status === 'failed' || status === 'blocked') return 'BLOCKED'
  return status || ''
}

function table(rows, headers) {
  const head = `| ${headers.join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((row) => `| ${headers.map((key) => String(row[key] ?? '').replace(/\n/g, '<br>')).join(' | ')} |`)
  return [head, sep, ...body].join('\n')
}

function testsByStage(run, stage) {
  return (run.tests || []).filter((test) => test.stage === stage)
}

function renderEnvironment(run) {
  const env = run.environment || {}
  return [
    `- 隔离环境: ${env.isolated === true ? '是' : '否/未知'}`,
    `- Namespace: ${env.namespace || 'unknown'}`,
    `- Service: ${env.serviceName || 'unknown'}`,
    `- Base URL: ${link(env.baseUrl || 'unknown', env.baseUrl) || 'unknown'}`,
    `- Image: ${env.imageRef || env.imageTag || 'unknown'}`,
    `- AOneCI: env=${env.ci?.envCreateRunId || 'N/A'}, deploy=${env.ci?.buildDeployRunId || 'N/A'}, cleanup=${env.ci?.envCleanupRunId || 'N/A'}`,
  ].join('\n')
}

function renderE2e(run) {
  const tests = testsByStage(run, 'test_e2e')
  if (tests.length === 0) return 'No browser evidence recorded.'
  const lines = []
  for (const test of tests) {
    lines.push(`### ${test.id}`)
    lines.push(`- 状态: ${statusIcon(test.exitCode === 0 ? 'passed' : 'failed')} exitCode=${test.exitCode}`)
    lines.push(`- 体验入口: ${link(test.experienceUrl || test.baseUrl || 'N/A', test.experienceUrl || test.baseUrl) || 'N/A'}`)
    if (test.featureAssertions?.length) {
      lines.push('- 功能断言:')
      for (const assertion of test.featureAssertions) lines.push(`  - ${assertion}`)
    }
    const evidence = [...(test.screenshots || []), ...(test.artifacts || [])]
    if (evidence.length) {
      lines.push('- 平台可见证据:')
      for (const item of evidence) {
        const label = [item.kind || 'artifact', item.target || item.targetPath || item.targetUrl || 'evidence'].filter(Boolean).join(': ')
        lines.push(`  - ${label}: ${link(item.url || item.path || 'N/A', item.url || item.path) || 'N/A'}`)
      }
    }
    lines.push(`- Console errors: ${(test.consoleErrors || []).length}`)
    lines.push(`- Failed network: ${(test.failedNetwork || []).length}`)
  }
  return lines.join('\n')
}

function renderIntegration(run) {
  const tests = testsByStage(run, 'integration_live')
  if (tests.length === 0) return 'No live integration evidence recorded.'
  const lines = []
  for (const test of tests) {
    const classification = test.failureClassification || test.classification
    lines.push(`### ${test.id}`)
    lines.push(`- 状态: ${statusIcon(test.exitCode === 0 ? 'passed' : 'failed')} exitCode=${test.exitCode}`)
    if (test.reportUrl) lines.push(`- AOneCI/报告: ${link(test.reportUrl, test.reportUrl)}`)
    if (classification) {
      lines.push(`- 分类: ${classification.status || 'unknown'}`)
      lines.push(`- 推荐动作: ${classification.recommendedAction || 'unknown'}`)
      lines.push(`- 失败计数: related=${classification.relatedFailures || 0}, external=${classification.externalFailures || 0}, unrelated=${classification.unrelatedFailures || 0}`)
      if (classification.resumeCriteria) lines.push(`- 恢复条件: ${classification.resumeCriteria}`)
    }
    if (test.liveEvidence?.length) {
      lines.push('- Live readback:')
      for (const item of test.liveEvidence) {
        lines.push(`  - ${item.kind || 'evidence'}: ${item.target || ''} ${link(item.url || item.path || '', item.url || item.path)}`)
      }
    }
  }
  return lines.join('\n')
}

function render(run) {
  const lines = []
  lines.push(`# Harness Delivery Report: ${run.featureId || 'unknown feature'}`)
  lines.push('')
  lines.push(`- Work item: ${run.workItemId || 'unknown'}`)
  lines.push(`- Commit: ${run.commit || 'unknown'}`)
  lines.push(`- Run id: ${run.environment?.runId || 'unknown'}`)
  lines.push(`- Namespace: ${run.environment?.namespace || 'unknown'}`)
  lines.push(`- Artifact dir: ${run.environment?.artifactDir || 'unknown'}`)
  lines.push('')

  lines.push('## 隔离环境')
  lines.push(renderEnvironment(run))
  lines.push('')

  lines.push('## Tasks')
  lines.push(table(
    (run.tasks || []).map((task) => ({
      id: task.id,
      stage: task.stage,
      status: statusIcon(task.output?.state || task.status),
      summary: task.output?.summary || task.skippedReason || '',
    })),
    ['id', 'stage', 'status', 'summary'],
  ))
  lines.push('')

  lines.push('## Tests')
  lines.push(table(
    (run.tests || []).map((test) => ({
      id: test.id,
      stage: test.stage,
      exitCode: test.exitCode,
      result: test.totalTests ? `${test.testsPassed}/${test.totalTests}` : '',
      report: test.reportUrl || test.aoneCiUrl || test.artifacts?.[0]?.url || test.artifacts?.[0]?.path || '',
    })),
    ['id', 'stage', 'exitCode', 'result', 'report'],
  ))
  lines.push('')

  lines.push('## 浏览器证据')
  lines.push(renderE2e(run))
  lines.push('')

  lines.push('## 集成测试')
  lines.push(renderIntegration(run))
  lines.push('')

  lines.push('## Waiting')
  const waiting = run.waiting || []
  lines.push(waiting.length === 0 ? 'No human waits recorded.' : table(
    waiting.map((item) => ({
      taskId: item.taskId,
      waitType: item.waitType,
      state: item.state,
      decision: item.decision || '',
    })),
    ['taskId', 'waitType', 'state', 'decision'],
  ))
  lines.push('')

  lines.push('## Review')
  lines.push(`- Status: ${run.review?.status || 'unknown'}`)
  lines.push(`- Blocking findings: ${run.review?.blockingFindings ?? 'unknown'}`)
  lines.push(`- Scope guard: ${run.review?.scopeGuard?.status || 'unknown'}`)
  lines.push('')

  lines.push('## Platform Acceptance')
  lines.push(`- Status: ${run.platformAcceptance?.status || 'unknown'}`)
  lines.push(`- Claimed complete: ${run.platformAcceptance?.claimedPlatformComplete ?? false}`)
  if (run.platformAcceptance?.reason) lines.push(`- Reason: ${run.platformAcceptance.reason}`)
  if (run.platformAcceptance?.missingInputs?.length) {
    lines.push(`- Missing inputs: ${run.platformAcceptance.missingInputs.join(', ')}`)
  }
  lines.push('')

  lines.push('## Artifacts')
  const items = artifacts(run)
  if (items.length === 0) {
    lines.push('No artifacts linked.')
  } else {
    for (const item of items) lines.push(`- ${item.kind || 'artifact'}: ${item.url || item.path}`)
  }

  return `${lines.join('\n')}\n`
}

function printHelp() {
  console.log(`Usage: node harness/scripts/render-delivery-report.mjs --run <delivery-run.json>

Renders a compact Markdown delivery report from a Harness delivery run JSON.`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  if (!args.run) throw new Error('--run is required')
  console.log(render(await readJson(args.run)))
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
