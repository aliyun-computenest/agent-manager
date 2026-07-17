// agent-manager/server/middleware/validate.js
import { ZodError } from 'zod'

/**
 * Validate request parts against zod schemas — DOCUMENTATION-AS-CODE bridge.
 *
 * Goal: openapi.json 描述的 contract 跟运行时实际行为 100% 一致。
 * Schema 描述什么,运行时就拒绝什么(且仅拒绝那些)。
 *
 * 用法: router.post('/x', validate({ body: CreateXBody, query: ListXQuery }), handler)
 *
 * 实现细节:
 *   - 用 safeParse 而不是 parse,**不修改 req.body / req.query / req.params**
 *     (handler 看到原始客户端输入,跟 develop 行为一致 — 无 strip / 无 coerce)
 *   - 失败响应格式: { success: false, error: 'plain text' } — 跟 develop 手写 if 一致
 *   - formatZodMessage 把 zod issue 翻译回旧版"X is required" / "Invalid X" 风格
 */
export function validate(schemas) {
  return (req, res, next) => {
    for (const part of ['body', 'query', 'params']) {
      const schema = schemas[part]
      if (!schema) continue
      const result = schema.safeParse(req[part])
      if (!result.success) {
        return res.status(400).json({
          success: false,
          error: formatZodMessage(result.error),
        })
      }
      // 注意: 不替换 req[part]。handler 看到原始客户端输入。
    }
    next()
  }
}

/**
 * Convert ZodError to a single human-readable string matching develop's manual-if style.
 *
 * Examples:
 *   missing(name)               → "name is required"
 *   missing(name, provider)     → "name and provider are required"
 *   missing(a, b, c)            → "a, b and c are required"
 *   invalid_value(channelType)  → "Invalid channelType. Must be one of: feishu, dingtalk, qq, wecom"
 *   custom (.refine())          → 直接透传 .refine() 的 message 文本
 */
function formatZodMessage(err) {
  const issues = err.issues || err.errors || []
  const parts = issues.map(issue => {
    const field = issue.path.join('.') || 'value'
    const code = issue.code

    if (code === 'invalid_type' && issue.received === 'undefined') {
      if (issue.message && issue.message !== 'Required') return issue.message
      return `${field} is required`
    }
    if (code === 'invalid_enum_value' || code === 'invalid_value') {
      if (issue.message && !issue.message.startsWith('Invalid enum value') && !issue.message.startsWith('Invalid option')) {
        return issue.message
      }
      if (issue.options && issue.options.length > 0) {
        return `Invalid ${field}. Must be one of: ${issue.options.join(', ')}`
      }
      const msg = (issue.message || '').split(', received')[0]
      const values = []
      const re = /['"]([^'"]+)['"]/g
      let m
      while ((m = re.exec(msg)) !== null) values.push(m[1])
      if (values.length > 0) {
        return `Invalid ${field}. Must be one of: ${values.join(', ')}`
      }
      return `Invalid ${field}: ${issue.message}`
    }
    if (code === 'too_small') {
      return issue.message || `${field}: value too small`
    }
    if (code === 'invalid_format' && issue.format === 'uuid') {
      return `Invalid ${field}: must be a valid UUID`
    }
    if (code === 'invalid_format' && (issue.format === 'regex' || issue.format === 'pattern')) {
      return `Invalid ${field}: does not match required format`
    }
    if (code === 'custom') {
      return issue.message || 'Validation failed'
    }
    return `${field}: ${issue.message}`
  })

  // "X is required" + "Y is required" → "X and Y are required"
  const requiredParts = parts.filter(p => p.endsWith(' is required'))
  const otherParts = parts.filter(p => !p.endsWith(' is required'))

  if (requiredParts.length > 1 && otherParts.length === 0) {
    const fields = requiredParts.map(p => p.replace(' is required', ''))
    const last = fields.pop()
    return `${fields.join(', ')} and ${last} are required`
  }

  return parts.join(', ')
}
