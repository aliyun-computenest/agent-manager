import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'

vi.mock('../../server/config/index.js', () => ({
  SKILLHUB_ASSUME_ROLE_ARN: 'acs:ram::1234567890123456:role/ComputeNestSkillHubAccessRole',
  SKILLHUB_REGION_ID: 'ap-southeast-1',
  SKILLHUB_STS_DURATION_SECONDS: 900,
  SKILL_INSTALL_TIMEOUT_SECONDS: 600,
}))

vi.mock('../../server/utils/logger.js', () => ({
  appLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../server/services/computenest.js', () => ({
  getComputeNestEndpointRegion: vi.fn(async () => 'cn-hangzhou'),
}))

import {
  installSkills as installSkillsService,
  resolveSkillInstallRuntime,
} from '../../server/services/skill-installer.js'
import { buildInstallCommand, shellQuote } from '../../server/services/skill-install-commands.js'
import { InstallSkillsRequestSchema } from '../../server/schemas/skill-hub.js'

const DEFAULT_RUNTIME = {
  sandboxUser: 'node',
  targetRoot: '/home/node/.agents/skills',
}

function buildTestInstallCommand(options) {
  return buildInstallCommand({
    regionId: 'ap-southeast-1',
    targetRoot: DEFAULT_RUNTIME.targetRoot,
    ...options,
  })
}

function installSkills(dependencies, options) {
  return installSkillsService({ ...DEFAULT_RUNTIME, ...options }, dependencies)
}

function officialSkill(id = '0-ui-ux-pro-max') {
  return { skillId: id, skillName: id, skillSpaceId: null, skillSpaceName: null }
}

function privateSkill(id) {
  return {
    skillId: id,
    skillName: `name-${id}`,
    skillSpaceId: 'ss-team',
    skillSpaceName: 'Team Skills',
  }
}

function deferred() {
  let resolve
  const promise = new Promise(next => { resolve = next })
  return { promise, resolve }
}

function platformTemplate() {
  return yaml.load(readFileSync(new URL('../../../template/platform_template.yaml', import.meta.url), 'utf8'))
}

describe('skill installer', () => {
  let run
  let connectSandbox
  let assumeRole

  beforeEach(() => {
    run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    connectSandbox = vi.fn(async () => ({ commands: { run } }))
    assumeRole = vi.fn(async () => ({
      accessKeyId: 'STS.TEST',
      accessKeySecret: 'temporary-secret',
      securityToken: 'temporary-token',
    }))
  })

  it('provisions a reusable least-privilege SkillHub download role', () => {
    const template = platformTemplate()
    const role = template.Resources.ComputeNestSkillHubAccessRole
    const statements = role.Properties.Policies[0].PolicyDocument.Statement
    const catalogStatement = statements.find(statement => statement.Action?.includes('computenest:ListSkillSpaces'))
    const bundleStatement = statements.find(statement => statement.Action?.includes('oss:GetObject'))
    expect(role.Properties.AssumeRolePolicyDocument.Statement[0].Action).toBe('sts:AssumeRole')
    expect(role.Properties.IgnoreExisting).toBe(true)
    expect(role.Properties.RoleName).toBe('ComputeNestSkillHubAccessRole')
    expect(template.Parameters.SkillHubAssumeRoleName).toBeUndefined()
    expect(catalogStatement.Action).toEqual([
      'computenest:ListSkillSpaces',
      'computenest:ListSkills',
    ])
    expect(catalogStatement.Resource).toEqual(['*'])
    expect(JSON.stringify(bundleStatement.Resource)).toContain('acs:oss:*:*:${SkillHubBucket}/archives/*')
  })

  it('injects the role ARN, auto-detects the site, and grants the generated platform AK only AssumeRole access', () => {
    const template = platformTemplate()
    const secretYaml = template.Resources.PlatformSecret.Properties.YamlContent['Fn::Sub'][0]
    const configYaml = template.Resources.PlatformConfigMap.Properties.YamlContent['Fn::Sub'][0]
    const statements = template.Resources.AgentManagerRamUser.Properties.Policies[0].PolicyDocument.Statement
    const assumeRole = statements.find(statement =>
      JSON.stringify(statement.Resource).includes('ComputeNestSkillHubAccessRole'),
    )
    expect(secretYaml).toContain('SKILLHUB_ASSUME_ROLE_ARN: ${SkillHubAssumeRoleArnB64}')
    expect(configYaml).not.toContain('SKILLHUB_REGION_ID')
    expect(template.Parameters.SkillHubRegionId).toBeUndefined()
    expect(assumeRole.Resource).toEqual([
      { 'Fn::GetAtt': ['AgentManagerOOSExecutionRole', 'Arn'] },
      { 'Fn::GetAtt': ['ComputeNestSkillHubAccessRole', 'Arn'] },
    ])
  })

  it('keeps online installation independent from supports_skills', () => {
    const baseline = readFileSync(new URL('../../migrations/init_database.sql', import.meta.url), 'utf8')
    const installRoute = readFileSync(new URL('../../server/routes/install-skills.js', import.meta.url), 'utf8')
    const qwenpawSeed = baseline.slice(baseline.indexOf('-- QwenPaw'), baseline.indexOf('-- 插入 OpenClaw'))

    expect(installRoute).not.toContain('agentType.supports_skills')
    expect(qwenpawSeed).toMatch(/\),\s+false,\s+false,\s+'root',\s+'node'/)
    expect(baseline).toContain("('1.0.6', 'init_database.sql')")
  })

  it('stores an explicit Skill install path for every Agent Type', () => {
    const baseline = readFileSync(new URL('../../migrations/init_database.sql', import.meta.url), 'utf8')
    const migration = readFileSync(new URL('../../migrations/versions/1.0.6/001__add_agent_type_skill_path.sql', import.meta.url), 'utf8')
    expect(baseline).toContain("'node',\n  '/home/node/.agents/skills',")
    expect(baseline).toContain("'hermes',\n  '/opt/data/skills',")
    expect(baseline).toContain("'node',\n  '/app/working/skill_pool',")
    expect(baseline).not.toContain('SET skill_path = CASE code')
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS skill_path VARCHAR(512)')
    expect(migration).toContain("WHEN 'openclaw' THEN '/home/node/.agents/skills'")
    expect(migration).toContain("WHEN 'hermes' THEN '/opt/data/skills'")
    expect(migration).toContain("WHEN 'qwenpaw' THEN '/app/working/skill_pool'")
    expect(migration).toContain("SET terminal_user = 'hermes'")
    expect(migration).toContain('ALTER COLUMN skill_path SET NOT NULL')
    expect(migration).not.toContain('agent_types_skill_path_absolute_check')
  })

  it('packages a pre-initialized SkillHub CLI in every Agent image that supports online installation', () => {
    for (const agentType of ['openclaw', 'hermes', 'qwenpaw']) {
      const dockerfile = readFileSync(new URL(`../../../agent-docker/${agentType}/Dockerfile`, import.meta.url), 'utf8')
      expect(dockerfile).toContain('COMPUTENEST_CLI_VERSION=1.9.16')
      expect(dockerfile).toContain('computenest-cli==${COMPUTENEST_CLI_VERSION}')
      expect(dockerfile).toContain('/opt/agent-manager/computenest-venv/bin/computenest-cli skillhub install --help')
      expect(dockerfile).not.toContain('aliyun-cli-linux')
      expect(dockerfile).not.toContain('agent-docker/skillhub/aliyun')
      expect(dockerfile).not.toContain('computenestcli/log.conf')
      expect(dockerfile).not.toContain('sys.version_info')
    }

    const hermesDockerfile = readFileSync(new URL('../../../agent-docker/hermes/Dockerfile', import.meta.url), 'utf8')
    expect(hermesDockerfile).toContain(
      'FROM nousresearch/hermes-agent:v2026.5.16@sha256:b6e41c155d6bfce5ad83c5d0fec670086db8a43250e4511c9474134be5482d33',
    )
    expect(hermesDockerfile).not.toContain('FROM nousresearch/hermes-agent:latest')
    expect(hermesDockerfile).toContain('UV_PYTHON_DOWNLOADS=never')
    expect(hermesDockerfile).toContain('--python python3')
    expect(hermesDockerfile).not.toContain('SKILLHUB_PYTHON_VERSION')
    expect(hermesDockerfile).not.toContain('UV_PYTHON_INSTALL_DIR')
    expect(hermesDockerfile).not.toContain('3.11.13')
    expect(hermesDockerfile).toContain('/opt/agent-manager/computenest-venv')
    expect(hermesDockerfile).toContain("su -s /bin/sh hermes -c 'HOME=/opt/data")
    expect(hermesDockerfile).not.toContain('useradd')

    const openclawDockerfile = readFileSync(new URL('../../../agent-docker/openclaw/Dockerfile', import.meta.url), 'utf8')
    expect(openclawDockerfile).toContain('python3 -m venv /opt/agent-manager/computenest-venv')

    const qwenpawDockerfile = readFileSync(new URL('../../../agent-docker/qwenpaw/Dockerfile', import.meta.url), 'utf8')
    const qwenpawRunCommand = readFileSync(new URL('../../../agent-docker/qwenpaw/run-cmd.sh', import.meta.url), 'utf8')
    expect(qwenpawDockerfile).toContain('UV_PYTHON_DOWNLOADS=never uv venv --python python3')
    expect(qwenpawDockerfile).toContain('/opt/agent-manager/computenest-venv')
    expect(qwenpawDockerfile).toContain("su -s /bin/sh node -c 'HOME=/home/node")
    expect(qwenpawRunCommand).toContain('[ -L "$skill_pool" ]')
    expect(qwenpawRunCommand).toContain('chown -hR node:node "$skill_pool"')

  })

  it('keeps the computenest-cli version consistent across Agent images', () => {
    const openclawDockerfile = readFileSync(new URL('../../../agent-docker/openclaw/Dockerfile', import.meta.url), 'utf8')
    const hermesDockerfile = readFileSync(new URL('../../../agent-docker/hermes/Dockerfile', import.meta.url), 'utf8')
    const qwenpawDockerfile = readFileSync(new URL('../../../agent-docker/qwenpaw/Dockerfile', import.meta.url), 'utf8')
    const versions = {
      openclaw: openclawDockerfile.match(/^ARG COMPUTENEST_CLI_VERSION=(\S+)$/m)?.[1],
      hermes: hermesDockerfile.match(/^ARG COMPUTENEST_CLI_VERSION=(\S+)$/m)?.[1],
      qwenpaw: qwenpawDockerfile.match(/^ARG COMPUTENEST_CLI_VERSION=(\S+)$/m)?.[1],
    }

    expect(new Set(Object.values(versions))).toEqual(new Set(['1.9.16']))
  })

  it('quotes shell arguments without allowing command injection', () => {
    expect(shellQuote("skill'; touch /tmp/pwned; echo '")).toBe("'skill'\"'\"'; touch /tmp/pwned; echo '\"'\"''")
  })

  it('uses the actual Agent runtime user and its scanned Skill directory', () => {
    expect(resolveSkillInstallRuntime({
      code: 'hermes',
      terminal_user: 'hermes',
      sandbox_user: 'root',
      skill_path: '/opt/data/skills',
    })).toEqual({
      sandboxUser: 'hermes',
      targetRoot: '/opt/data/skills',
    })
    expect(resolveSkillInstallRuntime({
      code: 'openclaw',
      terminal_user: 'node',
      sandbox_user: 'root',
      skill_path: '/home/node/.agents/skills',
    })).toEqual({
      sandboxUser: 'node',
      targetRoot: '/home/node/.agents/skills',
    })
    expect(resolveSkillInstallRuntime({
      code: 'custom-agent',
      terminal_user: 'agent',
      skill_path: '/srv/custom-agent/skills',
    })).toEqual({
      sandboxUser: 'agent',
      targetRoot: '/srv/custom-agent/skills',
    })
    expect(resolveSkillInstallRuntime({
      code: 'qwenpaw',
      terminal_user: 'node',
      sandbox_user: 'root',
      skill_path: '/app/working/skill_pool',
    })).toEqual({
      sandboxUser: 'node',
      targetRoot: '/app/working/skill_pool',
    })
    expect(() => resolveSkillInstallRuntime({ code: 'custom', skill_path: '../skills' }))
      .toThrow('当前 Agent 类型未配置有效的 Skill 安装路径')
    expect(() => resolveSkillInstallRuntime({ code: 'custom', terminal_user: 'root', skill_path: '/root/skills' }))
      .toThrow('当前 Agent 类型未配置有效的非 root 终端用户')
    expect(() => resolveSkillInstallRuntime({ code: 'custom', skill_path: '/home/node/.agents/skills' }))
      .toThrow('当前 Agent 类型未配置有效的非 root 终端用户')
    expect(() => resolveSkillInstallRuntime({ code: 'custom', terminal_user: 'node', skill_path: '/tmp/skills\tbad' }))
      .toThrow('当前 Agent 类型未配置有效的 Skill 安装路径')
  })

  it('builds the public command without credential flags', () => {
    const command = buildTestInstallCommand({ skillName: '0-ui-ux-pro-max' })
    expect(command).toContain("'/opt/agent-manager/computenest-venv/bin/computenest-cli' skillhub install --region_id 'ap-southeast-1' --output_dir '/home/node/.agents/skills' '0-ui-ux-pro-max'")
    expect(command).not.toContain('"$COMPUTENEST_CLI_BIN" computenest-cli skillhub')
    expect(command).toContain("test -s '/home/node/.agents/skills/0-ui-ux-pro-max/SKILL.md'")
    expect(command).not.toContain('stage_root')
    expect(command).not.toContain('.agent-manager-install.lock')
    expect(command).not.toContain('backup')
    expect(command).not.toContain('--access_key_id')
    expect(command).not.toContain('--security_token')
  })

  it('publishes Hermes skills into its scanned data directory', () => {
    const command = buildTestInstallCommand({
      skillName: 'stock-question-refiner',
      targetRoot: '/opt/data/skills',
    })
    expect(command).toContain("--output_dir '/opt/data/skills'")
    expect(command).not.toContain('chown')
  })

  it('does not resolve install tools from the Agent user directory or PATH', () => {
    const command = buildTestInstallCommand({ skillName: '0-ui-ux-pro-max' })
    expect(command).toContain("'/opt/agent-manager/computenest-venv/bin/computenest-cli' skillhub install")
    expect(command).not.toContain('$HOME/.aliyun')
    expect(command).not.toContain('command -v')
  })

  it('uses environment references instead of embedding private credentials', () => {
    const command = buildTestInstallCommand({
      skillName: 'private-skill',
      skillSpaceName: 'Team Skills',
    })
    expect(command).toContain("--skill_space_name 'Team Skills' 'private-skill'")
    expect(command).toContain("--region_id 'ap-southeast-1'")
    expect(command).toContain('--access_key_id="$SKILLHUB_STS_ACCESS_KEY_ID"')
    expect(command).toContain('--access_key_secret="$SKILLHUB_STS_ACCESS_KEY_SECRET"')
    expect(command).toContain('--security_token="$SKILLHUB_STS_TOKEN"')
    expect(command).not.toContain('temporary-secret')
    expect(command).not.toContain('temporary-token')
  })

  it('requires the installed Skill to contain SKILL.md', () => {
    const targetRoot = mkdtempSync(join(tmpdir(), 'skillhub-install-'))
    try {
      const command = buildTestInstallCommand({ skillName: 'missing-skill', targetRoot })
        .replace('/opt/agent-manager/computenest-venv/bin/computenest-cli', '/usr/bin/true')
      expect(() => execFileSync('/bin/sh', ['-c', command])).toThrow()
    } finally {
      rmSync(targetRoot, { recursive: true, force: true })
    }
  })

  it('installs public skills without requesting STS credentials', async () => {
    const dependencies = { connectSandbox, assumeRole }
    const results = await installSkills(dependencies, {
      sandboxId: 'default--agent-1',
      sandboxUser: 'node',
      targetRoot: '/home/node/.agents/skills',
      skills: [officialSkill()],
    })

    expect(results).toEqual([expect.objectContaining({ status: 'succeeded', errorCode: null })])
    expect(assumeRole).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledWith(expect.not.stringContaining('--security_token'), expect.objectContaining({
      user: 'node',
      envs: {},
    }))
  })

  it('initializes and publishes Hermes skills as the hermes runtime user', async () => {
    const dependencies = { connectSandbox, assumeRole }
    const results = await installSkills(dependencies, {
      sandboxId: 'default--agent-manager-hermes-test',
      sandboxUser: 'hermes',
      targetRoot: '/opt/data/skills',
      skills: [officialSkill('stock-question-refiner')],
    })

    expect(results).toEqual([expect.objectContaining({ status: 'succeeded' })])
    const installCall = run.mock.calls.find(([command]) => command.includes('--output_dir'))
    expect(installCall?.[1].user).toBe('hermes')
    expect(installCall?.[0]).toContain("--output_dir '/opt/data/skills'")
  })

  it.each([
    ['public', [officialSkill('qwenpaw-public')], 0],
    ['private', [privateSkill('qwenpaw-private')], 1],
  ])('installs %s QwenPaw skills using only Agent Type configuration', async (_, skills, assumeRoleCount) => {
    const dependencies = { connectSandbox, assumeRole }
    const runtime = resolveSkillInstallRuntime({
      terminal_user: 'node',
      sandbox_user: 'root',
      skill_path: '/app/working/skill_pool',
    })
    const results = await installSkills(dependencies, {
      sandboxId: 'default--agent-manager-qwenpaw-test',
      ...runtime,
      skills,
    })

    expect(results).toEqual([expect.objectContaining({ status: 'succeeded', errorCode: null })])
    expect(assumeRole).toHaveBeenCalledTimes(assumeRoleCount)
    const installCall = run.mock.calls.find(([command]) => command.includes('--output_dir'))
    expect(installCall?.[1].user).toBe('node')
    expect(installCall?.[0]).toContain("--output_dir '/app/working/skill_pool'")
    expect(run.mock.calls.some(([command]) => command.includes('install -d'))).toBe(false)
    expect(run.mock.calls.some(([command]) => command.includes('/api/skills/pool/refresh'))).toBe(false)
  })

  it('auto-detects the SkillHub endpoint once for the whole install request', async () => {
    const resolveRegionId = vi.fn(async () => 'ap-southeast-1')
    const dependencies = {
      connectSandbox,
      assumeRole,
      regionId: '',
      resolveRegionId,
    }
    const results = await installSkills(dependencies, {
      sandboxId: 'default--agent-1',
      skills: [officialSkill('one'), officialSkill('two')],
    })

    expect(results.every(result => result.status === 'succeeded')).toBe(true)
    expect(resolveRegionId).toHaveBeenCalledTimes(1)
    const installCalls = run.mock.calls.filter(([command]) => command.includes('--output_dir'))
    expect(installCalls).toHaveLength(2)
    expect(installCalls.every(([command]) => command.includes("--region_id 'ap-southeast-1'"))).toBe(true)
  })

  it('requests independent STS credentials for each private skill', async () => {
    let credentialIndex = 0
    assumeRole.mockImplementation(async () => {
      credentialIndex += 1
      return {
        accessKeyId: `STS.${credentialIndex}`,
        accessKeySecret: `secret-${credentialIndex}`,
        securityToken: `token-${credentialIndex}`,
      }
    })
    const dependencies = { connectSandbox, assumeRole }
    const results = await installSkills(dependencies, {
      sandboxId: 'default--agent-1',
      sandboxUser: 'node',
      skills: [privateSkill('one'), privateSkill('two')],
    })

    expect(results.every(result => result.status === 'succeeded')).toBe(true)
    expect(assumeRole).toHaveBeenCalledTimes(2)
    const installCalls = run.mock.calls.filter(([command]) => command.includes('--output_dir'))
    expect(installCalls).toHaveLength(2)
    const commandText = installCalls.map(([command]) => command).join('\n')
    expect(commandText).not.toContain('secret-1')
    expect(commandText).not.toContain('token-2')
    expect(installCalls[0][1].envs.SKILLHUB_STS_ACCESS_KEY_ID).toMatch(/^STS\./)
  })

  it('rejects another request while the same Sandbox lock is held', async () => {
    let release
    run.mockImplementation(command => command.includes('--output_dir')
      ? new Promise(resolve => { release = () => resolve({ exitCode: 0 }) })
      : Promise.resolve({ exitCode: 0 }))
    const dependencies = { connectSandbox, assumeRole }
    const first = installSkills(dependencies, { sandboxId: 'default--agent-1', skills: [officialSkill()] })

    await expect(installSkills(dependencies, {
      sandboxId: 'default--agent-1',
      skills: [officialSkill('another')],
    })).rejects.toMatchObject({ code: 'SKILL_INSTALL_IN_PROGRESS', status: 409 })

    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release()
    await first
  })

  it('keeps the in-process guard until an install command finishes after the HTTP request is aborted', async () => {
    const install = deferred()
    run.mockImplementation(command => command.includes('--output_dir')
      ? install.promise
      : Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }))
    const dependencies = { connectSandbox, assumeRole }
    const controller = new AbortController()
    const first = installSkills(dependencies, {
      sandboxId: 'default--agent-1',
      skills: [officialSkill()],
      signal: controller.signal,
    })

    await vi.waitFor(() => {
      expect(run.mock.calls.some(([command]) => command.includes('--output_dir'))).toBe(true)
    })
    controller.abort()

    await expect(installSkills(dependencies, {
      sandboxId: 'default--agent-1',
      skills: [officialSkill('another')],
    })).rejects.toMatchObject({ code: 'SKILL_INSTALL_IN_PROGRESS', status: 409 })

    install.resolve({ exitCode: 0, stdout: '', stderr: '' })
    await expect(first).resolves.toEqual([
      expect.objectContaining({ status: 'succeeded', errorCode: null }),
    ])
    const installCall = run.mock.calls.find(([command]) => command.includes('--output_dir'))
    expect(installCall?.[1]).not.toHaveProperty('signal')
  })

  it('maps a CLI failure without returning raw output', async () => {
    run.mockImplementation(async command => command.includes('--output_dir')
      ? { exitCode: 1, stdout: 'STS.TEST', stderr: 'temporary-secret' }
      : { exitCode: 0, stdout: '', stderr: '' })
    const dependencies = { connectSandbox, assumeRole }
    const [result] = await installSkills(dependencies, { sandboxId: 'default--agent-1', skills: [officialSkill()] })
    expect(result.errorCode).toBe('SKILL_DOWNLOAD_FAILED')
    expect(result.errorMessage).not.toContain('temporary-secret')
    expect(result.errorMessage).not.toContain('STS.TEST')
  })

  it.each([126, 127])('returns one stable upgrade error when the CLI exits with %s', async exitCode => {
    run.mockImplementation(async command => command.includes('--output_dir')
      ? { exitCode, stdout: '', stderr: 'command unavailable' }
      : { exitCode: 0, stdout: '', stderr: '' })
    const dependencies = { connectSandbox, assumeRole }

    await expect(installSkills(dependencies, {
      sandboxId: 'default--agent-1',
      skills: [officialSkill('one'), officialSkill('two')],
    })).rejects.toMatchObject({
      code: 'SKILL_CLI_UNAVAILABLE',
      status: 409,
      message: expect.stringContaining('升级到支持 Skill 的镜像'),
    })
    expect(assumeRole).not.toHaveBeenCalled()
    expect(run.mock.calls.filter(([command]) => command.includes('--output_dir'))).toHaveLength(1)
  })

  it('classifies E2B CommandExitError results instead of reporting interruption', async () => {
    run.mockImplementation(async command => {
      if (!command.includes('--output_dir')) return { exitCode: 0, stdout: '', stderr: '' }
      const error = new Error('exit status 127')
      error.name = 'CommandExitError'
      error.result = { exitCode: 127, stdout: '', stderr: 'command not found' }
      throw error
    })
    const dependencies = { connectSandbox, assumeRole }
    await expect(installSkills(dependencies, {
      sandboxId: 'default--agent-1',
      skills: [officialSkill()],
    })).rejects.toMatchObject({ code: 'SKILL_CLI_UNAVAILABLE', status: 409 })
  })

  it('maps command timeout failures to a stable safe result', async () => {
    const timeout = new Error('command timeout')
    timeout.name = 'TimeoutError'
    run.mockImplementation(command => command.includes('--output_dir')
      ? Promise.reject(timeout)
      : Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }))
    const dependencies = { connectSandbox, assumeRole }
    const [result] = await installSkills(dependencies, { sandboxId: 'default--agent-1', skills: [officialSkill()] })
    expect(result).toMatchObject({ status: 'failed', errorCode: 'SKILL_INSTALL_TIMEOUT' })
  })

  it('applies the overall deadline while requesting private Skill credentials', async () => {
    assumeRole.mockImplementation(() => new Promise(() => {}))
    const dependencies = { connectSandbox, assumeRole, timeoutSeconds: 0.005 }
    const [result] = await installSkills(dependencies, {
      sandboxId: 'default--agent-1',
      skills: [privateSkill('slow-sts')],
    })
    expect(result).toMatchObject({ status: 'failed', errorCode: 'SKILL_INSTALL_TIMEOUT' })
  })
})

describe('install skills request schema', () => {
  it('accepts one source and at most ten unique Skills', () => {
    const skills = Array.from({ length: 10 }, (_, index) => ({
      skillId: `private-${index}`,
      skillSpaceId: 'ss-team',
    }))
    expect(InstallSkillsRequestSchema.safeParse({ skills }).success).toBe(true)
  })

  it('rejects duplicate Skills, mixed sources, and oversized batches', () => {
    expect(InstallSkillsRequestSchema.safeParse({
      skills: [{ skillId: 'same' }, { skillId: 'same' }],
    }).success).toBe(false)
    expect(InstallSkillsRequestSchema.safeParse({
      skills: [{ skillId: 'official' }, { skillId: 'private', skillSpaceId: 'ss-team' }],
    }).success).toBe(false)
    expect(InstallSkillsRequestSchema.safeParse({
      skills: Array.from({ length: 11 }, (_, index) => ({ skillId: `skill-${index}` })),
    }).success).toBe(false)
  })
})
