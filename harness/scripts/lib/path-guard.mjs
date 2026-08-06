import { tmpdir } from 'node:os'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const allowedExternalRoots = [
  resolve('/tmp'),
  resolve('/private/tmp'),
  resolve(tmpdir()),
]

function uniqueRoots(roots) {
  return [...new Set(roots.map((root) => resolve(root)))]
}

export function isInside(root, target) {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel))
}

function resolveAgainstRepo(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('path must be a non-empty string')
  }
  return resolve(repoRoot, path)
}

export function resolveRepoPath(path, label = 'Path') {
  const absolute = resolveAgainstRepo(path)
  if (!isInside(repoRoot, absolute)) {
    throw new Error(`${label} must stay inside the repository: ${path}`)
  }
  return absolute
}

export function resolveInputPath(path, label = 'Input path') {
  const absolute = resolveAgainstRepo(path)
  const allowedRoots = uniqueRoots([repoRoot, ...allowedExternalRoots])
  if (!allowedRoots.some((root) => isInside(root, absolute))) {
    throw new Error(`${label} must stay inside the repository or /tmp: ${path}`)
  }
  return absolute
}

export function resolveOutputPath(path, label = 'Output path') {
  return resolveInputPath(path, label)
}

export function isRemoteArtifactLocator(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    const parsed = new URL(value)
    return ['http:', 'https:', 'harness:'].includes(parsed.protocol)
  } catch {
    return false
  }
}
