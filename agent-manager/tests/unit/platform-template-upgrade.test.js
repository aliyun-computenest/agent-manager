/**
 * 约束计算巢模板不再创建旧网关，也不通过清理 Job 删除已有 K8s 资源。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import yaml from 'js-yaml'

const templatePath = new URL('../../../template/platform_template.yaml', import.meta.url)

function loadTemplate() {
  return yaml.load(readFileSync(templatePath, 'utf8'))
}

describe('platform template upgrade compatibility', () => {
  it('removes the legacy gateway configuration and leaves K8s cleanup to the user', () => {
    const template = loadTemplate()
    const configYaml = template.Resources.PlatformConfigMap.Properties.YamlContent['Fn::Sub'][0]
    const source = readFileSync(templatePath, 'utf8')

    expect(template.Parameters.EnableAgentGatewayAccess).toBeUndefined()
    expect(template.Conditions.AgentGatewayAccessEnabled).toBeUndefined()
    expect(template.Resources.AgentGatewaySlb).toBeUndefined()
    expect(template.Resources.AgentGatewayResources).toBeUndefined()
    expect(template.Resources.LegacyResourceCleanup).toBeUndefined()
    expect(template.Outputs.AgentGatewayUrl).toBeUndefined()
    expect(configYaml).not.toContain('AGENT_GATEWAY_')
    expect(configYaml).toContain('NATIVE_AGENT_UI_ENABLED: "true"')
    expect(source).not.toContain('kubectl -n "${Namespace}" delete deployment openclaw-agent-gateway')
    expect(source).not.toContain('openclaw-platform-upgrade-cleanup')
  })

  it('groups hosted Supabase networking and describes each OSS bucket by purpose', () => {
    const template = loadTemplate()
    const groups = template.Metadata['ALIYUN::ROS::Interface'].ParameterGroups
    const supabaseGroup = groups.find(group => group.Label.en === 'Supabase Configuration (Hosted Recommended)')
    const skillHubGroup = groups.find(group => group.Parameters.includes('SkillHubConfig'))

    expect(supabaseGroup.Parameters).toEqual(expect.arrayContaining(['ZoneId', 'VpcId', 'VSwitchId']))
    expect(groups.some(group => group.Label.en === 'Network Configuration')).toBe(false)
    expect(template.Parameters.OssOption.Description['zh-cn']).toContain('存储 Agent 备份数据')
    expect(template.Parameters.OssOption.Description['zh-cn']).not.toContain('用于')
    expect(template.Parameters.SkillHubConfig.Label['zh-cn']).toBe('SkillHub OSS 配置')
    expect(skillHubGroup.Label['zh-cn']).toBe('SkillHub OSS 配置')
    expect(template.Parameters.SkillHubConfig.Description['zh-cn']).toContain('该 OSS 用于存储用户 Skill')
  })
})
