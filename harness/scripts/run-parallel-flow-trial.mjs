#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const commandTimeoutMs = 30000
const outputLimit = 8192

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--manifest') {
      const value = argv[i + 1]
      if (!value) throw new Error('--manifest requires a path')
      args.manifest = value
      i += 1
    } else if (arg === '--trial') {
      const value = argv[i + 1]
      if (!value) throw new Error('--trial requires a path')
      args.trial = value
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
  return JSON.parse(await readFile(resolve(repoRoot, assertRepoPath(path)), 'utf8'))
}

function intersection(left = [], right = []) {
  const rightSet = new Set(right)
  return left.filter((item) => rightSet.has(item))
}

function scopeRoot(scope) {
  const normalized = scope.replaceAll('\\', '/')
  const wildcardIndex = normalized.search(/[*]/)
  const root = wildcardIndex >= 0 ? normalized.slice(0, wildcardIndex) : normalized
  return root.replace(/\/+$/, '')
}

function scopesOverlap(left, right) {
  if (!left || !right) return false
  if (left === right) return true
  const leftRoot = scopeRoot(left)
  const rightRoot = scopeRoot(right)
  if (!leftRoot || !rightRoot) return false
  return leftRoot === rightRoot
    || leftRoot.startsWith(`${rightRoot}/`)
    || rightRoot.startsWith(`${leftRoot}/`)
}

function overlappingScopes(left = [], right = []) {
  const overlaps = []
  for (const leftScope of left) {
    for (const rightScope of right) {
      if (scopesOverlap(leftScope, rightScope)) overlaps.push(`${leftScope} <> ${rightScope}`)
    }
  }
  return overlaps
}

function findWaveConflict(task, waveTasks) {
  for (const blocker of waveTasks) {
    const resourceLocks = intersection(task.resources || [], blocker.resources || [])
    const writeScopes = overlappingScopes(task.writeScope || [], blocker.writeScope || [])
    if (resourceLocks.length > 0 || writeScopes.length > 0) {
      return {
        taskId: task.id,
        blockedBy: blocker.id,
        resourceLocks,
        writeScopes,
      }
    }
  }
  return null
}

function uniqueSorted(values) {
  return [...new Set(values)].sort()
}

function planWaves(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const unscheduled = new Set(tasks.map((task) => task.id))
  const completed = new Set()
  const waves = []
  const serializedByLocks = []

  while (unscheduled.size > 0) {
    const ready = tasks.filter((task) => (
      unscheduled.has(task.id)
      && (task.dependsOn || []).every((dep) => completed.has(dep))
    ))
    if (ready.length === 0) {
      const remaining = [...unscheduled].join(', ')
      throw new Error(`No schedulable tasks remain; check for cycles or missing dependencies: ${remaining}`)
    }

    const waveTasks = []
    for (const task of ready) {
      const conflict = findWaveConflict(task, waveTasks)
      if (conflict) {
        serializedByLocks.push(conflict)
        continue
      }
      waveTasks.push(task)
    }

    waves.push({
      index: waves.length,
      tasks: waveTasks.map((task) => task.id),
      resourceLocks: uniqueSorted(waveTasks.flatMap((task) => task.resources || [])),
      writeScope: uniqueSorted(waveTasks.flatMap((task) => task.writeScope || [])),
    })

    for (const task of waveTasks) {
      completed.add(task.id)
      unscheduled.delete(task.id)
    }
  }

  return { waves, serializedByLocks }
}

function buildWave(tasks, index, taskIds) {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const waveTasks = taskIds.map((taskId) => {
    const task = byId.get(taskId)
    if (!task) throw new Error(`wave ${index} references unknown task: ${taskId}`)
    return task
  })

  return {
    index,
    tasks: taskIds,
    resourceLocks: uniqueSorted(waveTasks.flatMap((task) => task.resources || [])),
    writeScope: uniqueSorted(waveTasks.flatMap((task) => task.writeScope || [])),
  }
}

function planOverrideWaves(tasks, overrides) {
  const seen = new Set()
  const completed = new Set()
  const trialTaskIds = new Set(tasks.map((task) => task.id))
  const waves = overrides.map((override, index) => {
    const taskIds = override.tasks || []
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      throw new Error(`wave override ${index} must include tasks`)
    }
    for (const taskId of taskIds) {
      if (seen.has(taskId)) throw new Error(`wave override repeats task: ${taskId}`)
      seen.add(taskId)
    }
    return buildWave(tasks, override.index ?? index, taskIds)
  })

  for (const taskId of trialTaskIds) {
    if (!seen.has(taskId)) throw new Error(`wave overrides missing task: ${taskId}`)
  }

  const byId = new Map(tasks.map((task) => [task.id, task]))
  for (const wave of waves) {
    for (const taskId of wave.tasks) {
      const task = byId.get(taskId)
      const missingDep = (task.dependsOn || []).find((dep) => trialTaskIds.has(dep) && !completed.has(dep))
      if (missingDep) throw new Error(`wave override puts ${taskId} before dependency ${missingDep}`)
    }
    const waveTasks = wave.tasks.map((taskId) => byId.get(taskId))
    assertNoWaveConflicts(waveTasks)
    for (const taskId of wave.tasks) completed.add(taskId)
  }

  return { waves, serializedByLocks: [] }
}

function assertNoWaveConflicts(waveTasks) {
  for (let i = 0; i < waveTasks.length; i += 1) {
    const conflict = findWaveConflict(waveTasks[i], waveTasks.slice(0, i))
    if (conflict) {
      throw new Error(`Unsafe same-wave lock conflict for ${conflict.taskId} and ${conflict.blockedBy}`)
    }
  }
}

function tokenizeCommand(command) {
  if (Array.isArray(command)) {
    if (!command.every((part) => typeof part === 'string')) {
      throw new Error('command array must contain strings')
    }
    return command
  }
  if (typeof command !== 'string' || command.trim().length === 0) {
    throw new Error('command must be a non-empty string or string array')
  }

  const tokens = []
  let current = ''
  let quote = null
  let escaped = false
  for (const char of command.trim()) {
    if (escaped) {
      current += char
      escaped = false
    } else if (char === '\\') {
      escaped = true
    } else if (quote) {
      if (char === quote) quote = null
      else current += char
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
    } else {
      current += char
    }
  }
  if (escaped) current += '\\'
  if (quote) throw new Error('command has an unterminated quote')
  if (current.length > 0) tokens.push(current)
  return tokens
}

function assertRepoPath(path) {
  const absolute = resolve(repoRoot, path)
  const rel = relative(repoRoot, absolute)
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`) || rel.startsWith(sep)) {
    throw new Error(`node script path must stay inside the repo: ${path}`)
  }
  return rel
}

function assertSafeInlineScript(taskId, script) {
  const shortDelayPattern = /^setTimeout\(\(\) => \{(?:\s*console\.log\((?:"[^"]{0,120}"|'[^']{0,120}')\))?\s*\},\s*([1-9]\d{0,3})\)$/
  const match = script.match(shortDelayPattern)
  if (!match) {
    throw new Error(`Task ${taskId} node -e command must be a safe short-delay trial script`)
  }
  const durationMs = Number(match[1])
  if (durationMs > 5000) throw new Error(`Task ${taskId} inline delay must be <= 5000ms`)
}

function toNodeArgs(taskId, command) {
  const tokens = tokenizeCommand(command)
  if (tokens[0] !== 'node') throw new Error(`Task ${taskId} command must start with node`)

  if (tokens[1] === '-e') {
    if (tokens.length !== 3) throw new Error(`Task ${taskId} node -e command must contain exactly one inline script`)
    assertSafeInlineScript(taskId, tokens[2])
    return ['-e', tokens[2]]
  }

  if (tokens.length < 2) throw new Error(`Task ${taskId} node command requires a repo-local script path`)
  if (tokens[1].startsWith('-')) throw new Error(`Task ${taskId} only allows node -e or node <repo-path>`)
  const scriptPath = assertRepoPath(tokens[1])
  return [scriptPath, ...tokens.slice(2)]
}

function normalizeTrialTasks(manifest, trial) {
  const manifestById = new Map((manifest.tasks || []).map((task) => [task.id, task]))
  const trialTasks = Array.isArray(trial.tasks)
    ? trial.tasks
    : Object.entries(trial.tasks || {}).map(([taskId, value]) => ({ taskId, ...value }))
  if (trialTasks.length === 0) throw new Error('trial must include at least one task')
  const trialIds = new Set(trialTasks.map((trialTask) => trialTask.taskId || trialTask.id))

  return trialTasks.map((trialTask) => {
    const id = trialTask.taskId || trialTask.id
    if (!id) throw new Error('trial task is missing taskId')
    const manifestTask = manifestById.get(id)
    if (!manifestTask) throw new Error(`trial task is not present in manifest: ${id}`)
    return {
      ...manifestTask,
      id,
      dependsOn: (manifestTask.dependsOn || []).filter((dep) => trialIds.has(dep)),
      command: trialTask.command,
      nodeArgs: toNodeArgs(id, trialTask.command),
    }
  })
}

function emptyTaskRecord(task, wave) {
  return {
    taskId: task.id,
    wave,
    status: 'pending',
    exitCode: null,
    startedAt: null,
    endedAt: null,
    durationMs: null,
    stdout: '',
    stderr: '',
  }
}

function appendLimited(current, chunk) {
  const next = `${current}${chunk}`
  if (next.length <= outputLimit) return next
  return next.slice(0, outputLimit)
}

function calculateObservedMax(records) {
  const events = []
  for (const record of records) {
    if (!record.startedAt || !record.endedAt) continue
    events.push({ at: Date.parse(record.startedAt), delta: 1 })
    events.push({ at: Date.parse(record.endedAt), delta: -1 })
  }
  events.sort((left, right) => left.at - right.at || left.delta - right.delta)

  let active = 0
  let max = 0
  for (const event of events) {
    active += event.delta
    max = Math.max(max, active)
  }
  return max
}

function runTask(task, wave) {
  const started = Date.now()
  const record = {
    taskId: task.id,
    wave,
    status: 'running',
    exitCode: null,
    startedAt: new Date(started).toISOString(),
    endedAt: null,
    durationMs: null,
    stdout: '',
    stderr: '',
  }

  return new Promise((resolveTask) => {
    const child = spawn(process.execPath, task.nodeArgs, {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH || '',
        NODE_ENV: 'test',
        HARNESS_PARALLEL_FLOW_TRIAL: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      record.stdout = appendLimited(record.stdout || '', chunk)
    })
    child.stderr?.on('data', (chunk) => {
      record.stderr = appendLimited(record.stderr || '', chunk)
    })
    let settled = false
    let killTimer = null
    const timer = setTimeout(() => {
      settled = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000)
      finish('timeout', 124)
    }, commandTimeoutMs)

    function finish(status, exitCode) {
      if (record.endedAt) return
      clearTimeout(timer)
      if (!settled && killTimer) clearTimeout(killTimer)
      const ended = Date.now()
      record.status = status
      record.exitCode = exitCode
      record.endedAt = new Date(ended).toISOString()
      record.durationMs = ended - started
      resolveTask(record)
    }

    child.on('error', () => finish('failed', 127))
    child.on('exit', (code, signal) => {
      if (killTimer) clearTimeout(killTimer)
      if (settled && signal === 'SIGTERM') return
      finish(code === 0 ? 'passed' : 'failed', code ?? 1)
    })
  })
}

async function runTrial(manifest, trial) {
  const tasks = normalizeTrialTasks(manifest, trial)
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const { waves, serializedByLocks } = Array.isArray(trial.waveOverrides)
    ? planOverrideWaves(tasks, trial.waveOverrides)
    : planWaves(tasks)
  const records = new Map(tasks.map((task) => [task.id, emptyTaskRecord(task, null)]))
  let observedMax = 0
  let failed = false

  for (const wave of waves) {
    const waveTasks = wave.tasks.map((taskId) => byId.get(taskId))
    assertNoWaveConflicts(waveTasks)
    for (const task of waveTasks) {
      records.set(task.id, { ...records.get(task.id), wave: wave.index })
    }

    if (failed) {
      for (const task of waveTasks) {
        records.set(task.id, { ...records.get(task.id), status: 'skipped' })
      }
      continue
    }

    const results = await Promise.all(waveTasks.map((task) => runTask(task, wave.index)))
    observedMax = Math.max(observedMax, calculateObservedMax(results))
    for (const result of results) {
      records.set(result.taskId, result)
      if (result.status !== 'passed') failed = true
    }
  }

  return {
    schemaVersion: '1.0',
    featureId: trial.featureId || manifest.featureId,
    status: failed ? 'failed' : 'passed',
    waves,
    tasks: [...records.values()],
    parallelism: {
      maxAllowed: Math.max(0, ...waves.map((wave) => wave.tasks.length)),
      observedMax,
      waveCount: waves.length,
      serializedByLocks,
    },
  }
}

function printHelp() {
  console.log(`Usage: node harness/scripts/run-parallel-flow-trial.mjs --manifest <path> --trial <path>

Runs a read-only Harness parallel-flow trial. Trial commands must be either
node -e <inline> or node <repo-local-path>; commands run without a shell.`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  if (!args.manifest) throw new Error('--manifest is required')
  if (!args.trial) throw new Error('--trial is required')

  const manifest = await readJson(args.manifest)
  const trial = await readJson(args.trial)
  console.log(JSON.stringify(await runTrial(manifest, trial), null, 2))
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
