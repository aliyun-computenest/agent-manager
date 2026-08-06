#!/usr/bin/env node
import { access, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { declaredSkillSlugs, validateStageSkillConfig } from './lib/cloud-skill-bindings.mjs'
import { resolveInputPath, resolveRepoPath } from './lib/path-guard.mjs'

function parseArgs(argv) {
  const args = { manifests: [], allowMissingSourcePaths: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--manifest') {
      const value = argv[i + 1]
      if (!value) throw new Error('--manifest requires a path')
      args.manifests.push(value)
      i += 1
    } else if (arg === '--allow-missing-source-paths') {
      args.allowMissingSourcePaths = true
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
  try {
    return JSON.parse(await readFile(fullPath, 'utf8'))
  } catch (error) {
    throw new Error(`Failed to read JSON ${path}: ${error.message}`)
  }
}

async function defaultManifestPaths() {
  const dir = resolveRepoPath('harness/manifests')
  const files = await readdir(dir)
  return files
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => join('harness/manifests', file))
}

function requireArray(value, path, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`)
    return []
  }
  return value
}

function requireString(value, path, errors) {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${path} must be a non-empty string`)
    return ''
  }
  return value
}

function findDuplicates(values) {
  const seen = new Set()
  const duplicates = new Set()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return [...duplicates]
}

async function pathExists(path) {
  try {
    await access(resolveRepoPath(path, 'Source path'))
    return true
  } catch {
    return false
  }
}

function assertNoCycles(tasks, manifestPath, errors) {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const visiting = new Set()
  const visited = new Set()

  function visit(id, stack) {
    if (visited.has(id)) return
    if (visiting.has(id)) {
      errors.push(`${manifestPath}: cyclic dependency detected: ${[...stack, id].join(' -> ')}`)
      return
    }
    const task = byId.get(id)
    if (!task) return
    visiting.add(id)
    for (const dep of task.dependsOn || []) {
      visit(dep, [...stack, id])
    }
    visiting.delete(id)
    visited.add(id)
  }

  for (const task of tasks) visit(task.id, [])
}

async function validateManifest(manifest, manifestPath, core, parallelism, options = {}) {
  const errors = []
  const knownStages = new Set(core.stages.map((stage) => stage.id))
  const knownResources = new Set(parallelism.resourceLocks.map((lock) => lock.id))

  requireString(manifest.schemaVersion, `${manifestPath}.schemaVersion`, errors)
  if (manifest.schemaVersion && manifest.schemaVersion !== '1.0') {
    errors.push(`${manifestPath}.schemaVersion must be 1.0`)
  }
  requireString(manifest.featureId, `${manifestPath}.featureId`, errors)
  requireString(manifest.title, `${manifestPath}.title`, errors)
  requireArray(manifest.stages, `${manifestPath}.stages`, errors)
  const tasks = requireArray(manifest.tasks, `${manifestPath}.tasks`, errors)
  const tests = requireArray(manifest.testMatrix, `${manifestPath}.testMatrix`, errors)
  requireArray(manifest.evidence, `${manifestPath}.evidence`, errors)
  requireArray(manifest.humanGates, `${manifestPath}.humanGates`, errors)

  if (!manifest.sources || typeof manifest.sources !== 'object') {
    errors.push(`${manifestPath}.sources must be an object`)
  } else {
    const designDocs = requireArray(manifest.sources.designDocs, `${manifestPath}.sources.designDocs`, errors)
    const uiArtifacts = requireArray(manifest.sources.uiArtifacts, `${manifestPath}.sources.uiArtifacts`, errors)
    for (const sourcePath of [...designDocs, ...uiArtifacts]) {
      if (
        !options.allowMissingSourcePaths &&
        typeof sourcePath === 'string' &&
        sourcePath.length > 0 &&
        !(await pathExists(sourcePath))
      ) {
        errors.push(`${manifestPath}: source path does not exist: ${sourcePath}`)
      }
    }
  }

  if (!manifest.platformInputs || typeof manifest.platformInputs !== 'object') {
    errors.push(`${manifestPath}.platformInputs must be an object`)
  } else {
    requireArray(manifest.platformInputs.required, `${manifestPath}.platformInputs.required`, errors)
    requireArray(manifest.platformInputs.optional, `${manifestPath}.platformInputs.optional`, errors)
  }

  const taskIds = tasks.map((task) => task.id)
  for (const duplicate of findDuplicates(taskIds)) {
    errors.push(`${manifestPath}: duplicate task id ${duplicate}`)
  }

  const taskIdSet = new Set(taskIds)
  for (const [index, task] of tasks.entries()) {
    const prefix = `${manifestPath}.tasks[${index}]`
    requireString(task.id, `${prefix}.id`, errors)
    requireString(task.stage, `${prefix}.stage`, errors)
    if (task.stage && !knownStages.has(task.stage)) errors.push(`${prefix}.stage references unknown stage ${task.stage}`)
    requireArray(task.dependsOn, `${prefix}.dependsOn`, errors)
    requireArray(task.resources, `${prefix}.resources`, errors)
    requireArray(task.writeScope, `${prefix}.writeScope`, errors)
    for (const dep of task.dependsOn || []) {
      if (!taskIdSet.has(dep)) errors.push(`${prefix}.dependsOn references unknown task ${dep}`)
    }
    for (const resource of task.resources || []) {
      if (!knownResources.has(resource)) errors.push(`${prefix}.resources references unknown resource ${resource}`)
    }
    if (task.stage === 'develop' && (!task.writeScope || task.writeScope.length === 0)) {
      errors.push(`${prefix}.writeScope is required for develop tasks`)
    }
  }

  const testIds = tests.map((item) => item.id)
  for (const duplicate of findDuplicates(testIds)) {
    errors.push(`${manifestPath}: duplicate test id ${duplicate}`)
  }
  for (const [index, item] of tests.entries()) {
    const prefix = `${manifestPath}.testMatrix[${index}]`
    requireString(item.id, `${prefix}.id`, errors)
    requireString(item.stage, `${prefix}.stage`, errors)
    if (item.stage && !knownStages.has(item.stage)) errors.push(`${prefix}.stage references unknown stage ${item.stage}`)
    requireString(item.command, `${prefix}.command`, errors)
    requireArray(item.resources, `${prefix}.resources`, errors)
    requireArray(item.evidence, `${prefix}.evidence`, errors)
    if (item.requiredAssertions !== undefined) {
      const requiredAssertions = requireArray(item.requiredAssertions, `${prefix}.requiredAssertions`, errors)
      if (requiredAssertions.length === 0) errors.push(`${prefix}.requiredAssertions must not be empty when present`)
      for (const [assertionIndex, assertionId] of requiredAssertions.entries()) {
        requireString(assertionId, `${prefix}.requiredAssertions[${assertionIndex}]`, errors)
      }
      for (const duplicate of findDuplicates(requiredAssertions)) {
        errors.push(`${prefix}.requiredAssertions contains duplicate ${duplicate}`)
      }
    }
    if (item.requiresPostActionReadback !== undefined && typeof item.requiresPostActionReadback !== 'boolean') {
      errors.push(`${prefix}.requiresPostActionReadback must be a boolean`)
    }
    if (item.requiresPostActionReadback === true) {
      if (item.stage !== 'test_e2e') errors.push(`${prefix}.requiresPostActionReadback is only valid for test_e2e`)
      if (!Array.isArray(item.requiredAssertions) || item.requiredAssertions.length === 0) {
        errors.push(`${prefix}.requiresPostActionReadback requires at least one requiredAssertions id`)
      }
      if (!item.postActionReadback || typeof item.postActionReadback !== 'object' || Array.isArray(item.postActionReadback)) {
        errors.push(`${prefix}.requiresPostActionReadback requires a postActionReadback contract`)
      }
    }
    if (item.postActionReadback !== undefined) {
      const contract = item.postActionReadback
      if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
        errors.push(`${prefix}.postActionReadback must be an object`)
      } else {
        const targetPathPattern = requireString(
          contract.targetPathPattern,
          `${prefix}.postActionReadback.targetPathPattern`,
          errors,
        )
        if (targetPathPattern) {
          try {
            new RegExp(targetPathPattern)
          } catch {
            errors.push(`${prefix}.postActionReadback.targetPathPattern must be a valid regular expression`)
          }
        }
        for (const field of [
          'resultMatchFields',
          'evidenceTextFields',
          'requiredEvidenceText',
          'actionResultMatchFields',
          'actionResultStatuses',
        ]) {
          if (contract[field] === undefined && field !== 'resultMatchFields') continue
          const values = requireArray(contract[field], `${prefix}.postActionReadback.${field}`, errors)
          if (field === 'resultMatchFields' && values.length === 0) {
            errors.push(`${prefix}.postActionReadback.resultMatchFields must not be empty`)
          }
          for (const [valueIndex, value] of values.entries()) {
            requireString(value, `${prefix}.postActionReadback.${field}[${valueIndex}]`, errors)
          }
          for (const duplicate of findDuplicates(values)) {
            errors.push(`${prefix}.postActionReadback.${field} contains duplicate ${duplicate}`)
          }
        }
        const resultFields = new Set(contract.resultMatchFields || [])
        for (const field of [
          ...(contract.evidenceTextFields || []),
          ...(contract.actionResultMatchFields || []),
        ]) {
          if (!resultFields.has(field)) {
            errors.push(`${prefix}.postActionReadback field ${field} must also appear in resultMatchFields`)
          }
        }
        const actionMatchFields = contract.actionResultMatchFields || []
        const actionStatuses = contract.actionResultStatuses || []
        if (actionMatchFields.length > 0 && actionStatuses.length === 0) {
          errors.push(`${prefix}.postActionReadback.actionResultStatuses must not be empty when actionResultMatchFields is configured`)
        }
        if (actionStatuses.length > 0 && actionMatchFields.length === 0) {
          errors.push(`${prefix}.postActionReadback.actionResultMatchFields must not be empty when actionResultStatuses is configured`)
        }
      }
    }
    for (const resource of item.resources || []) {
      if (!knownResources.has(resource)) errors.push(`${prefix}.resources references unknown resource ${resource}`)
    }
  }

  assertNoCycles(tasks, manifestPath, errors)

  return errors
}

function validateRules(core, parallelism, deliveryGuard, stateMachine, evidenceContract) {
  const errors = []
  const stageIds = core.stages?.map((stage) => stage.id) || []
  for (const duplicate of findDuplicates(stageIds)) {
    errors.push(`core stages duplicate id ${duplicate}`)
  }
  if (!core.waitingProtocol?.awaitingOutput) errors.push('core waitingProtocol.awaitingOutput is required')
  if (!core.waitingProtocol?.resumedOutput) errors.push('core waitingProtocol.resumedOutput is required')

  const lockIds = parallelism.resourceLocks?.map((lock) => lock.id) || []
  for (const duplicate of findDuplicates(lockIds)) {
    errors.push(`parallelism resourceLocks duplicate id ${duplicate}`)
  }

  const guardIds = deliveryGuard.gates?.map((gate) => gate.id) || []
  for (const duplicate of findDuplicates(guardIds)) {
    errors.push(`delivery guard duplicate id ${duplicate}`)
  }
  if (!stateMachine.taskStates?.includes('awaiting_human')) {
    errors.push('state-machine taskStates must include awaiting_human')
  }
  if (!stateMachine.taskStates?.includes('resumed')) {
    errors.push('state-machine taskStates must include resumed')
  }
  if (!stateMachine.resumeRule) errors.push('state-machine resumeRule is required')
  if (!evidenceContract.unit?.pass) errors.push('evidence-contract unit pass rule is required')
  if (!evidenceContract.deployEphemeral?.pass) {
    errors.push('evidence-contract deployEphemeral pass rule is required')
  }
  if (!evidenceContract.api?.pass) errors.push('evidence-contract api pass rule is required')
  if (!evidenceContract.e2e?.pass) errors.push('evidence-contract e2e pass rule is required')
  if (!evidenceContract.integrationLive?.pass) {
    errors.push('evidence-contract integrationLive pass rule is required')
  }
  if (!Number.isFinite(evidenceContract.output?.maxInlineBytes)) {
    errors.push('evidence-contract output.maxInlineBytes must be a number')
  }
  return errors
}

async function validateCloudSkills(core, stageSkillConfig) {
  const stageIds = core.stages?.map((stage) => stage.id) || []
  const errors = validateStageSkillConfig(stageSkillConfig, stageIds)
  for (const slug of declaredSkillSlugs(stageSkillConfig)) {
    for (const path of [
      `harness/skills/${slug}/SKILL.md`,
      `harness/skills/${slug}/agents/openai.yaml`,
    ]) {
      if (!(await pathExists(path))) errors.push(`cloud skill source path does not exist: ${path}`)
    }
  }
  return errors
}

function printHelp() {
  console.log(`Usage: node harness/scripts/validate-rules.mjs [--manifest <path> ...]

Validates Harness rules, domain metadata, and feature manifests. The command is
read-only and does not call the Harness platform.

Options:
  --allow-missing-source-paths  Portable kit self-check mode. Do not use for
                                target repository validation.`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const [core, parallelism, deliveryGuard, stateMachine, evidenceContract, stageSkillConfig] = await Promise.all([
    readJson('harness/rules/core.json'),
    readJson('harness/rules/parallelism.json'),
    readJson('harness/rules/delivery-guard.json'),
    readJson('harness/rules/state-machine.json'),
    readJson('harness/rules/evidence-contract.json'),
    readJson('harness/config/stage-skills.json'),
  ])

  const errors = validateRules(core, parallelism, deliveryGuard, stateMachine, evidenceContract)
  errors.push(...await validateCloudSkills(core, stageSkillConfig))
  const manifestPaths = args.manifests.length > 0 ? args.manifests : await defaultManifestPaths()
  const features = []
  for (const manifestPath of manifestPaths) {
    const manifest = await readJson(manifestPath)
    features.push(manifest.featureId || manifestPath)
    errors.push(...await validateManifest(manifest, manifestPath, core, parallelism, args))
  }

  if (errors.length > 0) {
    console.error(`Harness rules validation failed (${errors.length} issue${errors.length === 1 ? '' : 's'}):`)
    for (const error of errors) console.error(`- ${error}`)
    process.exitCode = 1
    return
  }

  console.log('Harness rules validation passed')
  console.log(`Features: ${features.join(', ')}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
