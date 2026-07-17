/**
 * Skill Injector — Template Method pattern for injecting skill mount
 * configuration into agent config templates.
 *
 * Each agent type (openclaw, hermes, …) has a different config format,
 * so the concrete injection logic lives in subclasses while the common
 * steps (extract mount paths → chmod → inject) are orchestrated here.
 *
 * To add a new agent type:
 *   1. Create a subclass of SkillInjector
 *   2. Implement `injectSkillPaths(templateContent, mountPaths)`
 *   3. Register it in `createSkillInjector`
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Batch chmod mount paths in a single shell command to avoid
 * executing one process per mount path inside the sandbox.
 * @param {import('@e2b/code-interpreter').Sandbox} sandbox
 * @param {string[]} mountPaths
 */
async function batchChmodMountPaths(sandbox, mountPaths) {
  const validPaths = mountPaths.filter(Boolean)
  if (validPaths.length === 0) return

  const joinedPaths = validPaths.join(' ')
  try {
    const chmodResult = await sandbox.commands.run(`chmod -R 755 ${joinedPaths}`, {
      user: 'root',
      timeoutMs: 15000
    })
    if (chmodResult.exitCode === 0) {
      console.log(`🔧 Fixed permissions on ${validPaths.length} mount path(s): ${joinedPaths}`)
    } else {
      console.warn(`⚠️ chmod exited with code ${chmodResult.exitCode}: ${chmodResult.stderr}`)
    }
  } catch (chmodErr) {
    console.warn(`⚠️ Failed to chmod mount paths: ${chmodErr.message}`)
  }
}

/**
 * Poll each mount path until it becomes readable, up to 60s timeout.
 * Workaround for ossfs cold start on ECI/virtual-kubelet where readdir (ls)
 * returns EPERM for the first few minutes after CSI mount.
 * @param {import('@e2b/code-interpreter').Sandbox} sandbox
 * @param {string[]} mountPaths
 */
async function waitForMountPathsReadable(sandbox, mountPaths) {
  const validPaths = mountPaths.filter(Boolean)
  if (validPaths.length === 0) return

  console.log(`⏳ Waiting for ${validPaths.length} mount path(s) to become readable (ossfs cold start workaround)...`)
  // Check all paths in parallel (each path polls independently)
  await Promise.all(validPaths.map(async (p) => {
    for (let i = 0; i < 30; i++) {
      try {
        const result = await sandbox.commands.run(`ls "${p}"`, {
          user: 'root',
          timeoutMs: 5000
        })
        if (result.exitCode === 0) {
          console.log(`  ✅ ${p} is readable (attempt ${i + 1})`)
          return
        }
      } catch (_) {
        // ls may throw if EPERM — ignore and retry
      }
      if (i === 29) {
        console.warn(`  ⚠️ ${p} still not readable after 60s, proceeding anyway`)
      }
      await new Promise(r => setTimeout(r, 2000))
    }
  }))
}

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

class SkillInjector {
  /**
   * Template method: orchestrates the full skill injection flow.
   *
   * @param {import('@e2b/code-interpreter').Sandbox} sandbox
   * @param {Object}   agentType        — agent_types row
   * @param {string}   templateContent  — current template string (JSON or YAML)
   * @returns {Promise<string>} updated templateContent
   */
  async inject(sandbox, agentType, templateContent, skillConfigSnapshot = null) {
    // Use snapshot if provided (filtered by selectedSkillSpaceIds), otherwise fallback to agentType.skill_config (legacy)
    // Note: empty array [] is a valid snapshot meaning user selected no optional skills — do NOT fallback.
    const skillConfig = Array.isArray(skillConfigSnapshot)
      ? skillConfigSnapshot
      : agentType.skill_config
    if (!Array.isArray(skillConfig) || skillConfig.length === 0) {
      return templateContent
    }

    // Extract base mount paths (single CSI mount per base path)
    const basePathSet = new Set()
    for (const entry of skillConfig) {
      const lastSlash = entry.mountPath.lastIndexOf('/')
      basePathSet.add(entry.mountPath.substring(0, lastSlash))
    }
    const basePaths = [...basePathSet]

    // Step 1 — wait for the single base mount to be readable (ossfs cold start workaround)
    await waitForMountPathsReadable(sandbox, basePaths)

    // Note: permissions are handled by ossfs mount option umask=022 (set in ROS template)
    // No need for batchChmodMountPaths — recursive chmod on FUSE is slow and times out

    // Step 2 — create symlinks for each skill space
    // CSI mounts the bucket at basePath with subPath "spaces/", so skillSpaceId directories
    // are directly under basePath. Create symlinks: basePath/spaceName → basePath/spaceId
    const symlinkResults = await Promise.all(skillConfig.map(async (entry) => {
      const lastSlash = entry.mountPath.lastIndexOf('/')
      const basePath = entry.mountPath.substring(0, lastSlash)
      const spaceName = entry.mountPath.substring(lastSlash + 1)
      const spaceId = entry.subPath.split('/')[1] // spaces/ss-xxx/ → ss-xxx
      if (!spaceName || !spaceId) return null
      try {
        await sandbox.commands.run(
          `ln -sfn "${basePath}/${spaceId}" "${entry.mountPath}"`,
          { user: 'root', timeoutMs: 5000 }
        )
        return entry.mountPath
      } catch (e) {
        console.warn(`  ⚠️ Failed to create symlink for ${spaceName}: ${e.message}`)
        return null
      }
    }))
    const mountPaths = symlinkResults.filter(Boolean)
    console.log(`📦 Created ${mountPaths.length}/${skillConfig.length} skill symlinks`)

    // Step 3 — delegate format-specific injection to subclass
    return this.injectSkillPaths(templateContent, mountPaths)
  }

  /**
   * Subclass hook: inject mountPaths into the template string.
   * Must return the updated templateContent.
   *
   * @abstract
   * @param {string}   templateContent
   * @param {string[]} mountPaths
   * @returns {string} updated templateContent
   */
  // eslint-disable-next-line no-unused-vars
  injectSkillPaths(templateContent, mountPaths) {
    throw new Error('SkillInjector subclass must implement injectSkillPaths()')
  }
}

// ---------------------------------------------------------------------------
// OpenClaw (JSON) — injects skills.load.extraDirs + watch config
// ---------------------------------------------------------------------------

class OpenclawSkillInjector extends SkillInjector {
  injectSkillPaths(templateContent, mountPaths) {
    let templateJson
    try {
      templateJson = JSON.parse(templateContent)
    } catch (parseError) {
      console.warn(`⚠️ Failed to parse template for skills injection: ${parseError.message}`)
      return templateContent
    }

    if (!templateJson.skills) templateJson.skills = {}
    if (!templateJson.skills.load) templateJson.skills.load = {}

    const existingDirs = templateJson.skills.load.extraDirs || []
    const allDirs = [...existingDirs, ...mountPaths]
    templateJson.skills.load.extraDirs = allDirs

    // Enable file watching so newly mounted skill files are picked up at runtime
    // (volume mounts may complete after gateway startup, and OpenClaw only scans
    // extraDirs once on startup unless watch is enabled).
    if (templateJson.skills.load.watch === undefined) {
      templateJson.skills.load.watch = true
    }
    if (templateJson.skills.load.watchDebounceMs === undefined) {
      templateJson.skills.load.watchDebounceMs = 250
    }

    console.log(`📦 Injected skills config with ${allDirs.length} extraDirs (watch: ${templateJson.skills.load.watch})`)
    return JSON.stringify(templateJson, null, 2)
  }
}

// ---------------------------------------------------------------------------
// Hermes (YAML) — appends skills.external_dirs block
// ---------------------------------------------------------------------------

class HermesSkillInjector extends SkillInjector {
  injectSkillPaths(templateContent, mountPaths) {
    let skillsYaml = '\n\n# Skills configuration\nskills:\n  external_dirs:\n'
    for (const mountPath of mountPaths) {
      skillsYaml += `    - ${mountPath}\n`
    }

    console.log(`📦 Appended skills config with ${mountPaths.length} external_dirs`)
    return templateContent.trimEnd() + skillsYaml
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the appropriate SkillInjector for the given agent type code.
 *
 * @param {string} agentTypeCode — e.g. 'openclaw', 'hermes'
 * @returns {SkillInjector|null} null when the code is unknown (caller can
 *          decide whether to warn or silently skip)
 */
function createSkillInjector(agentTypeCode) {
  switch (agentTypeCode) {
    case 'openclaw':
      return new OpenclawSkillInjector()
    case 'hermes':
      return new HermesSkillInjector()
    default:
      return null
  }
}

export {
  SkillInjector,
  OpenclawSkillInjector,
  HermesSkillInjector,
  createSkillInjector,
  batchChmodMountPaths
}
