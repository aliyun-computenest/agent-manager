#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { access, mkdir, readFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { declaredSkillSlugs, validateStageSkillConfig } from './lib/cloud-skill-bindings.mjs'
import { repoRoot, resolveInputPath, resolveOutputPath } from './lib/path-guard.mjs'

function parseArgs(argv) {
  const args = {
    config: 'harness/config/stage-skills.json',
    out: '/tmp/agent-manager-harness-cloud-skills.zip',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--config') args.config = argv[++index]
    else if (arg === '--out') args.out = argv[++index]
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('Usage: node harness/scripts/package-cloud-skills.mjs [--config <path>] [--out <zip>]')
    return
  }

  const [config, core] = await Promise.all([
    readFile(resolveInputPath(args.config, 'Stage skill config'), 'utf8').then(JSON.parse),
    readFile(resolveInputPath('harness/rules/core.json', 'Harness core rules'), 'utf8').then(JSON.parse),
  ])
  const stageIds = (core.stages || []).map((stage) => stage.id)
  const errors = validateStageSkillConfig(config, stageIds)
  if (errors.length > 0) throw new Error(errors.join('\n'))

  const slugs = declaredSkillSlugs(config)
  const skillsRoot = join(repoRoot, 'harness/skills')
  for (const slug of slugs) {
    await access(join(skillsRoot, slug, 'SKILL.md'))
    await access(join(skillsRoot, slug, 'agents/openai.yaml'))
  }

  const output = resolveOutputPath(args.out, 'Cloud skill package output')
  await mkdir(dirname(output), { recursive: true })
  await unlink(output).catch((error) => {
    if (error.code !== 'ENOENT') throw error
  })
  execFileSync('zip', ['-q', '-r', output, ...slugs], { cwd: skillsRoot, stdio: 'inherit' })
  console.log(JSON.stringify({ ok: true, output, skills: slugs }, null, 2))
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
