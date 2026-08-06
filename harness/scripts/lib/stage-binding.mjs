import { createHash } from 'node:crypto'

const MARKER = 'HARNESS_STAGE_BINDING_V1:'

export function manifestDigest(manifest) {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
}

export function renderStageBinding(binding) {
  return `${MARKER}${Buffer.from(JSON.stringify(binding), 'utf8').toString('base64url')}`
}

export function parseStageBinding(agentHints) {
  const lines = String(agentHints || '').split(/\r?\n/)
  const markers = lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith(MARKER))

  if (markers.length === 0) throw new Error('platform task is missing its Harness stage binding')
  if (markers.length > 1) throw new Error('platform task has multiple Harness stage bindings')

  try {
    const encoded = markers[0].slice(MARKER.length)
    const binding = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    if (binding?.version !== 1) throw new Error('unsupported binding version')
    if (!binding.stage || !binding.featureId || !binding.testId || !binding.manifestDigest) {
      throw new Error('binding fields are incomplete')
    }
    return binding
  } catch (error) {
    throw new Error(`platform task has an invalid Harness stage binding: ${error.message}`)
  }
}
