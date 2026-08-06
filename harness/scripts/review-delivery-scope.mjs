#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { repoRoot, resolveInputPath } from './lib/path-guard.mjs'

const execFileAsync = promisify(execFile)

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--manifest') {
      args.manifest = argv[i + 1]
      i += 1
    } else if (arg === '--changed-files') {
      args.changedFiles = argv[i + 1]
      i += 1
    } else if (arg === '--git-status') {
      args.gitStatus = true
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

function escapeRegexChar(char) {
  return /[|\\{}()[\]^$+?.]/.test(char) ? `\\${char}` : char
}

function globToRegex(glob) {
  let pattern = ''
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]
    if (char === '*') {
      if (glob[i + 1] === '*') {
        pattern += '.*'
        i += 1
      } else {
        pattern += '[^/]*'
      }
    } else {
      pattern += escapeRegexChar(char)
    }
  }
  return new RegExp(`^${pattern}$`)
}

function normalizeFileLine(line) {
  if (typeof line !== 'string') return null
  const trimmed = line.trim()
  if (!trimmed) return null
  return trimmed.replace(/^["']|["']$/g, '')
}

async function readChangedFilesFromPath(path) {
  const content = await readFile(resolveInputPath(path, 'Changed-files path'), 'utf8')
  return content.split(/\r?\n/).map(normalizeFileLine).filter(Boolean)
}

async function readChangedFilesFromGitStatus() {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  return stdout
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim()) return null
      const status = line.slice(0, 2)
      const rawPath = line.slice(3).trim()
      const renamed = rawPath.includes(' -> ') ? rawPath.split(' -> ').at(-1) : rawPath
      if (status === '??') return renamed
      return renamed
    })
    .map(normalizeFileLine)
    .filter(Boolean)
}

function collectWriteScopes(manifest) {
  const scopes = new Set()
  for (const task of manifest.tasks || []) {
    for (const scope of task.writeScope || []) scopes.add(scope)
  }
  return [...scopes].sort()
}

function isAllowed(file, regexes) {
  return regexes.some((regex) => regex.test(file))
}

function printHelp() {
  console.log(`Usage: node harness/scripts/review-delivery-scope.mjs \\
  --manifest harness/manifests/<feature>.json \\
  (--changed-files <path> | --git-status)

Checks changed files against the manifest writeScope allowlist. The command is
read-only and does not mutate git state.`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  if (!args.manifest) throw new Error('--manifest is required')
  if (!args.changedFiles && !args.gitStatus) throw new Error('--changed-files or --git-status is required')

  const manifest = await readJson(args.manifest)
  const changedFiles = args.changedFiles
    ? await readChangedFilesFromPath(args.changedFiles)
    : await readChangedFilesFromGitStatus()
  const writeScopes = collectWriteScopes(manifest)
  const regexes = writeScopes.map(globToRegex)
  const outOfScope = changedFiles.filter((file) => !isAllowed(file, regexes))

  const result = {
    schemaVersion: '1.0',
    featureId: manifest.featureId,
    status: outOfScope.length === 0 ? 'passed' : 'failed',
    changedFiles,
    writeScopes,
    outOfScopeFiles: outOfScope,
  }

  console.log(JSON.stringify(result, null, 2))
  if (outOfScope.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
