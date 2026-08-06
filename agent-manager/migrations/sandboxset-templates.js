/**
 * SandboxSet 模板加载与构造工具，供 init-db.js → ensureSandboxSets() 使用。
 *
 * 设计原则：
 *   1. 完整 YAML 模板存放在 ../agents/<agentTypeCode>/SandboxSet.yaml，所有字段
 *      （image、resources、env、command、startupProbe、securityContext 等）全部
 *      写死，便于版本控制与审阅。容器镜像版本随 platform 镜像一起发版。
 *   2. 仅 metadata.annotations 中以 `network.alibabacloud.com/`、
 *      `image.alibabacloud.com/`、`k8s.aliyun.com/` 开头的 key（vsw、安全组、
 *      镜像缓存等集群强相关字段）会从集群已有 SandboxSet 动态读取并继承。
 *   3. 已存在同名 SandboxSet 时跳过创建，避免覆盖用户手动修改。
 */

import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml')

const __dirname = dirname(fileURLToPath(import.meta.url))
// 模板目录与 migrations/ 平级（agent-manager/agents/<code>/SandboxSet.yaml）
const TEMPLATES_DIR = join(__dirname, '..', 'agents')

// 需要从集群已有 SandboxSet 动态继承的 annotation 前缀
const DYNAMIC_ANNOTATION_PREFIXES = [
  'network.alibabacloud.com/',
  'image.alibabacloud.com/',
  'k8s.aliyun.com/',
]

function loadTemplate(agentTypeCode) {
  const fullPath = join(TEMPLATES_DIR, agentTypeCode, 'SandboxSet.yaml')
  const text = readFileSync(fullPath, 'utf-8')
  return yaml.load(text)
}

/**
 * 模板列表 —— 与 agent_types.sandbox_template_id 一一对应。
 */
export const SANDBOXSET_TEMPLATES = [
  {
    agentTypeCode: 'openclaw',
    name: 'agent-manager-openclaw',
    namespace: 'default',
    yaml: loadTemplate('openclaw'),
  },
  {
    agentTypeCode: 'hermes',
    name: 'agent-manager-hermes',
    namespace: 'default',
    yaml: loadTemplate('hermes'),
  },
  {
    agentTypeCode: 'qwenpaw',
    name: 'agent-manager-qwenpaw',
    namespace: 'default',
    yaml: loadTemplate('qwenpaw'),
  },
]

function pickDynamicAnnotations(refAnnotations) {
  const picked = {}
  for (const [key, value] of Object.entries(refAnnotations)) {
    if (DYNAMIC_ANNOTATION_PREFIXES.some(prefix => key.startsWith(prefix))) {
      picked[key] = value
    }
  }
  return picked
}

/**
 * 构造完整的 SandboxSet 对象。
 *
 * 容器 image 完全使用本地 SandboxSet.yaml 模板里写死的版本，不再被集群中
 * 已有的 SandboxSet 覆盖，避免被历史残留的旧 image 污染。
 *
 * @param {object} template - 来自 SANDBOXSET_TEMPLATES 的单条记录
 * @param {object} reference - 集群中已有的 SandboxSet（仅用于继承集群相关 annotations）
 */
export function buildSandboxSet(template, reference) {
  const obj = JSON.parse(JSON.stringify(template.yaml))

  // 强制覆盖 name / namespace，保证与本地配置一致
  obj.metadata = obj.metadata || {}
  obj.metadata.name = template.name
  obj.metadata.namespace = template.namespace

  // 动态注入 annotations（仅集群相关的前缀，模板里写死的 annotation 优先级更高，不会被覆盖）
  // 顶层 metadata.annotations 与 pod template metadata.annotations 都需要注入。
  const refTopAnnotations = pickDynamicAnnotations(reference?.metadata?.annotations || {})
  obj.metadata.annotations = { ...refTopAnnotations, ...(obj.metadata.annotations || {}) }

  const refPodAnnotations = pickDynamicAnnotations(reference?.spec?.template?.metadata?.annotations || {})
  const podMeta = obj.spec?.template?.metadata
  if (podMeta) {
    podMeta.annotations = { ...refPodAnnotations, ...(podMeta.annotations || {}) }
  }

  return obj
}
