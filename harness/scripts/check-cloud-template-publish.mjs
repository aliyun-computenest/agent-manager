#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolveInputPath } from './lib/path-guard.mjs'

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--result') args.result = argv[++index]
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('Usage: node harness/scripts/check-cloud-template-publish.mjs --result <publish-result.json>')
    return
  }
  if (!args.result) throw new Error('--result is required')
  const result = JSON.parse(await readFile(resolveInputPath(args.result, 'Template publish result'), 'utf8'))
  if (result.success === false) throw new Error(result.message || 'template publish failed')
  if (!result.template?.id) throw new Error('template publish result does not contain template.id')
  if (!Array.isArray(result.droppedSkillIds)) {
    throw new Error('template publish result does not contain droppedSkillIds')
  }
  if (result.droppedSkillIds.length > 0) {
    throw new Error(`template dropped unattached cloud skills: ${result.droppedSkillIds.join(', ')}`)
  }
  console.log(`Cloud template publish verified: ${result.template.name} (${result.template.id})`)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
