import { Sandbox } from '@e2b/code-interpreter'
import {
  SKILLHUB_ASSUME_ROLE_ARN,
  SKILLHUB_REGION_ID,
  SKILLHUB_STS_DURATION_SECONDS,
  SKILL_INSTALL_TIMEOUT_SECONDS,
} from '../config/index.js'
import { appLogger } from '../utils/logger.js'
import { getComputeNestEndpointRegion } from './computenest.js'
import { assumeSkillDownloadRole } from './skill-install-auth.js'
import { buildInstallCommand } from './skill-install-commands.js'

const ERROR_MESSAGES = {
  SKILL_ASSUME_ROLE_DENIED: '无法获取 Skill 下载临时凭证',
  SKILL_ROLE_PERMISSION_DENIED: 'Skill 下载角色权限不足',
  SKILL_CLI_UNAVAILABLE: '当前 Agent 镜像未预装可用的 Skill 安装工具，请升级到支持 Skill 的镜像，或基于官方 Dockerfile 重新构建镜像',
  SKILL_DOWNLOAD_FAILED: 'Skill 下载失败',
  SKILL_INSTALL_TIMEOUT: 'Skill 安装超时',
  SKILL_INSTALL_INTERRUPTED: 'Skill 安装被中断',
  SKILL_INSTALL_IN_PROGRESS: '该实例正在安装 Skill',
  SKILL_TARGET_UNAVAILABLE: 'Agent Skill 目录不可写',
}

export class SkillInstallError extends Error {
  constructor(code, message = ERROR_MESSAGES[code] || 'Skill 安装失败', status = 500) {
    super(message)
    this.name = 'SkillInstallError'
    this.code = code
    this.status = status
  }
}

export function resolveSkillInstallRuntime(agentType) {
  const targetRoot = String(agentType?.skill_path || '').trim()
  const sandboxUser = String(agentType?.terminal_user || '').trim()
  const segments = targetRoot.split('/')
  if (
    !targetRoot.startsWith('/') ||
    targetRoot === '/' ||
    targetRoot.length > 512 ||
    /[\x00-\x1f\x7f]/.test(targetRoot) ||
    segments.some(segment => segment === '.' || segment === '..')
  ) {
    throw new SkillInstallError('SKILL_TARGET_UNAVAILABLE', '当前 Agent 类型未配置有效的 Skill 安装路径', 400)
  }
  if (!/^[a-z_][a-z0-9_-]*$/i.test(sandboxUser) || sandboxUser === 'root') {
    throw new SkillInstallError('SKILL_TARGET_UNAVAILABLE', '当前 Agent 类型未配置有效的非 root 终端用户', 400)
  }
  return { sandboxUser, targetRoot }
}

function commandError(result, error) {
  if (error?.name === 'TimeoutError' || /timed?\s*out|timeout/i.test(error?.message || '')) {
    return new SkillInstallError('SKILL_INSTALL_TIMEOUT')
  }
  const commandResult = result || error?.result
  if (error && !commandResult) return new SkillInstallError('SKILL_INSTALL_INTERRUPTED')

  const output = `${commandResult?.stdout || ''}\n${commandResult?.stderr || ''}`
  if (commandResult?.exitCode === 126 || commandResult?.exitCode === 127) {
    return new SkillInstallError('SKILL_CLI_UNAVAILABLE', ERROR_MESSAGES.SKILL_CLI_UNAVAILABLE, 409)
  }
  if (/access.?denied|forbidden|no.?permission|unauthorized/i.test(output)) {
    return new SkillInstallError('SKILL_ROLE_PERMISSION_DENIED')
  }
  return new SkillInstallError('SKILL_DOWNLOAD_FAILED')
}

function remainingMs(deadline, now) {
  const value = deadline - now()
  if (value <= 0) throw new SkillInstallError('SKILL_INSTALL_TIMEOUT')
  return value
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw new SkillInstallError('SKILL_INSTALL_INTERRUPTED')
}

async function withTimeout(promise, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new SkillInstallError('SKILL_INSTALL_TIMEOUT')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function runCommand(sandbox, command, options) {
  try {
    const result = await sandbox.commands.run(command, options)
    if (result?.exitCode !== 0) throw commandError(result)
    return result
  } catch (error) {
    if (error instanceof SkillInstallError) throw error
    throw commandError(null, error)
  }
}

function installResult(skill, error = null) {
  return {
    skillId: skill.skillId,
    status: error ? 'failed' : 'succeeded',
    errorCode: error?.code || null,
    errorMessage: error?.message || null,
  }
}

const activeInstalls = new Set()

async function createInstallEnvs(skill, deadline, {
  assumeRole,
  roleArn,
  stsDurationSeconds,
  now,
}) {
  if (!skill.skillSpaceId) return {}

  let credentials
  try {
    credentials = await withTimeout(assumeRole({
      roleArn,
      durationSeconds: stsDurationSeconds,
      roleSessionName: `skill-install-${now().toString(36)}`.slice(0, 64),
    }), remainingMs(deadline, now))
  } catch (error) {
    if (error instanceof SkillInstallError) throw error
    throw new SkillInstallError('SKILL_ASSUME_ROLE_DENIED')
  }
  return {
    SKILLHUB_STS_ACCESS_KEY_ID: credentials.accessKeyId,
    SKILLHUB_STS_ACCESS_KEY_SECRET: credentials.accessKeySecret,
    SKILLHUB_STS_TOKEN: credentials.securityToken,
  }
}

export async function installSkills(
  { sandboxId, sandboxUser, targetRoot, skills, signal },
  {
    connectSandbox = id => Sandbox.connect(id),
    assumeRole = assumeSkillDownloadRole,
    regionId = SKILLHUB_REGION_ID,
    resolveRegionId = getComputeNestEndpointRegion,
    roleArn = SKILLHUB_ASSUME_ROLE_ARN,
    timeoutSeconds = SKILL_INSTALL_TIMEOUT_SECONDS,
    stsDurationSeconds = SKILLHUB_STS_DURATION_SECONDS,
    now = () => Date.now(),
  } = {},
) {
    if (activeInstalls.has(sandboxId)) {
      throw new SkillInstallError('SKILL_INSTALL_IN_PROGRESS', ERROR_MESSAGES.SKILL_INSTALL_IN_PROGRESS, 409)
    }
    activeInstalls.add(sandboxId)
    const deadline = now() + timeoutSeconds * 1000

    try {
      let sandbox
      try {
        sandbox = await connectSandbox(sandboxId)
      } catch {
        const error = new SkillInstallError('SKILL_INSTALL_INTERRUPTED')
        return skills.map(skill => installResult(skill, error))
      }

      assertNotAborted(signal)
      const resolvedRegionId = regionId || await withTimeout(resolveRegionId(), remainingMs(deadline, now))

      const results = []
      for (const skill of skills) {
        try {
          assertNotAborted(signal)
          const envs = await createInstallEnvs(skill, deadline, {
            assumeRole,
            roleArn,
            stsDurationSeconds,
            now,
          })

          assertNotAborted(signal)
          await runCommand(sandbox, buildInstallCommand({
            regionId: resolvedRegionId,
            skillName: skill.skillName,
            skillSpaceName: skill.skillSpaceName,
            targetRoot,
          }), {
            user: sandboxUser,
            envs,
            timeoutMs: Math.max(1000, remainingMs(deadline, now)),
          })

          appLogger.info(`[skill-installer] installed skillId=${skill.skillId} sandboxId=${sandboxId}`)
          results.push(installResult(skill))
        } catch (cause) {
          const error = cause instanceof SkillInstallError
            ? cause
            : new SkillInstallError('SKILL_DOWNLOAD_FAILED')
          if (error.code === 'SKILL_CLI_UNAVAILABLE') throw error
          appLogger.warn(`[skill-installer] failed skillId=${skill.skillId} sandboxId=${sandboxId} code=${error.code}`)
          results.push(installResult(skill, error))
        }
      }
      return results
    } finally {
      activeInstalls.delete(sandboxId)
    }
  }
