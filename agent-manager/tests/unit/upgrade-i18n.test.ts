import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const componentPaths = [
  'src/components/AgentTypeDetail.tsx',
  'src/components/InstanceUpgrade.tsx',
]

const localePaths = {
  zhCN: 'src/locales/zh-CN/admin.json',
  en: 'src/locales/en/admin.json',
}

const hardcodedUpgradePhrases = [
  '备份&升级配置',
  '升级配置已保存',
  '升级目标',
  '请选择 Agent 类型',
  'Sandbox 升级配置',
  '发起 Sandbox 升级',
  '历史升级详情',
  '当前沙箱配置做不到备份和恢复',
  '升级前命令失败',
  '只执行恢复命令',
  '暂无升级记录',
  'SandboxUpdateOps 资源',
  '升级过程和结果明细',
]

describe('upgrade UI i18n coverage', () => {
  it('keeps upgrade UI text out of component literals', () => {
    const source = componentPaths
      .map(path => readFileSync(resolve(process.cwd(), path), 'utf8'))
      .join('\n')

    for (const phrase of hardcodedUpgradePhrases) {
      expect(source, `found hardcoded upgrade phrase "${phrase}"`).not.toContain(phrase)
    }
  })

  it('keeps Chinese and English upgrade locale keys aligned', () => {
    const zhCN = JSON.parse(readFileSync(resolve(process.cwd(), localePaths.zhCN), 'utf8'))
    const en = JSON.parse(readFileSync(resolve(process.cwd(), localePaths.en), 'utf8'))
    const sections = [
      'instanceUpgrade',
      'agentTypeDetail.backupUpgrade',
      'agentTypeDetail.sandboxUpgrade',
    ]

    for (const section of sections) {
      expect(flattenKeys(getPath(zhCN, section))).toEqual(flattenKeys(getPath(en, section)))
    }
  })
})

function getPath(source: Record<string, unknown>, path: string) {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined
    return (current as Record<string, unknown>)[key]
  }, source)
}

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return prefix ? [prefix] : []
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key))
    .sort()
}
