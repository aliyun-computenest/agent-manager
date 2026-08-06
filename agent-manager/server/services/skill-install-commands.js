/**
 * 本模块只负责生成 POSIX Shell 脚本，不直接执行命令。
 * `skill-installer.js` 会把生成的脚本发送到 Agent 沙箱执行。将 Shell 构造独立出来，
 * 可以把执行边界、参数转义和安装编排分开审查。
 *
 * 与 `skill-installer.js` 约定的退出码：126/127 表示镜像缺少安装工具。
 */
const COMPUTENEST_CLI_BIN = '/opt/agent-manager/computenest-venv/bin/computenest-cli'

// 所有写入 Shell 源码的值都必须转义。运行时密钥不拼接到脚本中，
// 而是通过命令环境变量单独传递。
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`
}

export function buildInstallCommand({
  regionId,
  skillName,
  skillSpaceName = null,
  targetRoot,
}) {
  // 公开 Skill 不需要凭证；私有 Skill 空间使用环境变量接收短期 STS 凭证，
  // 避免密钥进入 Shell 源码。
  const args = [
    shellQuote(COMPUTENEST_CLI_BIN),
    'skillhub',
    'install',
    '--region_id', shellQuote(regionId),
    '--output_dir', shellQuote(targetRoot),
  ]

  if (skillSpaceName) {
    args.push(
      '--skill_space_name', shellQuote(skillSpaceName),
      shellQuote(skillName),
      '--access_key_id="$SKILLHUB_STS_ACCESS_KEY_ID"',
      '--access_key_secret="$SKILLHUB_STS_ACCESS_KEY_SECRET"',
      '--security_token="$SKILLHUB_STS_TOKEN"'
    )
  } else {
    args.push(shellQuote(skillName))
  }

  const skillFile = shellQuote(`${targetRoot}/${skillName}/SKILL.md`)
  return `${args.join(' ')} && test -s ${skillFile}`
}
