#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolveInputPath } from './lib/path-guard.mjs'

const stageTitles = {
  env_prepare: '隔离环境准备',
  deploy_ephemeral: '发布隔离环境',
  test_api: '隔离环境 API 测试',
  test_e2e: '隔离环境浏览器功能测试',
  integration_live: '真实集成验证',
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--input') {
      args.input = argv[++i]
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return args
}

async function readJson(path) {
  if (!path) throw new Error('--input is required')
  return JSON.parse(await readFile(resolveInputPath(path, 'Report input path'), 'utf8'))
}

function valueOrUnknown(value) {
  return value === undefined || value === null || value === '' ? 'unknown' : String(value)
}

function statusText(value) {
  const raw = valueOrUnknown(value)
  if (/^(success|passed|done|completed)$/i.test(raw)) return `通过 (${raw})`
  if (/^(failed|failure|blocked|canceled|cancelled)$/i.test(raw)) return `未通过 (${raw})`
  if (/^(running|in_progress|pending)$/i.test(raw)) return `进行中 (${raw})`
  return raw
}

function markdownLink(item) {
  const label = item.label || item.name || item.kind || item.url || item.path || 'link'
  const url = item.url || item.path
  if (!url) return `- ${label}`
  return `- [${label}](${url})`
}

function table(rows, headers) {
  if (!Array.isArray(rows) || rows.length === 0) return ''
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${headers.map((key) => valueOrUnknown(row[key])).join(' | ')} |`),
  ].join('\n')
}

function renderChecks(checks) {
  const rows = (checks || []).map((check) => ({
    name: check.name || check.target || check.apiPath || check.command || 'check',
    result: statusText(check.status || check.result || check.exitCode),
    detail: check.detail || check.summary || check.body || '',
  }))
  return table(rows, ['name', 'result', 'detail'])
}

function renderMetrics(metrics) {
  const entries = Array.isArray(metrics)
    ? metrics
    : Object.entries(metrics || {}).map(([name, value]) => ({ name, value }))
  const rows = entries.map((item) => ({
    name: item.name || item.label || 'metric',
    value: item.value ?? item.count ?? item.result ?? '',
  }))
  return table(rows, ['name', 'value'])
}

function render(report) {
  const title = report.title || `阶段报告：${stageTitles[report.stage] || report.stage || 'unknown'}`
  const lines = [
    `# ${title}`,
    '',
    `- 阶段: ${valueOrUnknown(report.stage)}`,
    `- 状态: ${statusText(report.status || report.state)}`,
    `- Work item: ${valueOrUnknown(report.workItemId)}`,
    `- Task: ${valueOrUnknown(report.taskId)}`,
    `- 环境: ${valueOrUnknown(report.namespace || report.environment?.namespace)}`,
    `- Base URL: ${valueOrUnknown(report.baseUrl || report.platformUrl || report.environment?.baseUrl)}`,
  ]

  const runIds = report.runIds || report.ci || {}
  if (Object.keys(runIds).length > 0) {
    lines.push(`- CI: ${Object.entries(runIds).map(([key, value]) => `${key}=${value}`).join(', ')}`)
  }
  if (report.summary) lines.push(`- 摘要: ${report.summary}`)
  lines.push('')

  const links = report.links || []
  lines.push('## 直接链接')
  lines.push(links.length > 0 ? links.map(markdownLink).join('\n') : '暂无链接。')
  lines.push('')

  const checks = renderChecks(report.checks)
  lines.push('## 检查结果')
  lines.push(checks || '暂无检查项。')
  lines.push('')

  const metrics = renderMetrics(report.metrics)
  lines.push('## 指标')
  lines.push(metrics || '暂无指标。')
  lines.push('')

  const artifacts = [...(report.evidence || []), ...(report.artifacts || [])]
  lines.push('## 证据')
  lines.push(artifacts.length > 0 ? artifacts.map(markdownLink).join('\n') : '暂无证据附件。')
  lines.push('')

  if (report.nextAction) {
    lines.push('## 下一步')
    lines.push(report.nextAction)
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

function printHelp() {
  console.log(`Usage: node harness/scripts/render-stage-report.mjs --input <stage-report.json>

Renders a human-readable Markdown report for one Harness stage. The output is
intended to be uploaded or pasted into task output/comment so platform readers
can see more than raw run ids.`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  process.stdout.write(render(await readJson(args.input)))
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
