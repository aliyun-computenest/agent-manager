/**
 * 带 runId 前缀的测试实体命名工厂
 */
import { entityPrefix } from '../setup/test-env.js'

let seq = 0
function nextSeq() {
  seq += 1
  return seq.toString(36)
}

function uniq(tag) {
  return `${tag || 'x'}-${nextSeq()}-${Math.random().toString(36).slice(2, 6)}`
}

export function prefixedName(tag) {
  return `${entityPrefix}${uniq(tag)}`
}

export function prefixedCode(tag) {
  // provider / agent-type code 只允许 [a-zA-Z0-9_-]
  return `${entityPrefix}${uniq(tag)}`.replace(/[^a-zA-Z0-9_-]/g, '-')
}

export function prefixedEmail(tag) {
  return `${prefixedName(tag)}@test.local`
}

export { entityPrefix }
