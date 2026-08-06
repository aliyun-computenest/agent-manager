#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolveInputPath } from './lib/path-guard.mjs'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--manifest') {
      const value = argv[i + 1]
      if (!value) throw new Error('--manifest requires a path')
      args.manifest = value
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
  return JSON.parse(await readFile(resolveInputPath(path, 'JSON path'), 'utf8'))
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

function planWaves(manifest) {
  const tasks = manifest.tasks || []
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

    if (waveTasks.length === 0) {
      const fallback = byId.get(ready[0].id)
      waveTasks.push(fallback)
    }

    const wave = {
      index: waves.length,
      tasks: waveTasks.map((task) => task.id),
      resourceLocks: uniqueSorted(waveTasks.flatMap((task) => task.resources || [])),
      writeScope: uniqueSorted(waveTasks.flatMap((task) => task.writeScope || [])),
    }
    waves.push(wave)

    for (const task of waveTasks) {
      completed.add(task.id)
      unscheduled.delete(task.id)
    }
  }

  return {
    schemaVersion: '1.0',
    featureId: manifest.featureId,
    title: manifest.title,
    dispatchModel: 'harness-daemon-safe-waves',
    waves,
    serializedByLocks,
  }
}

function printHelp() {
  console.log(`Usage: node harness/scripts/plan-parallel-waves.mjs --manifest <path>

Computes Harness-safe execution waves from a feature manifest. The command is
read-only and does not dispatch work.`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  if (!args.manifest) throw new Error('--manifest is required')

  const manifest = await readJson(args.manifest)
  console.log(JSON.stringify(planWaves(manifest), null, 2))
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
