import { createRequire } from 'node:module'
import { dirname, resolve as resolvePath } from 'node:path'
import { apiReference } from '@scalar/express-api-reference'
import { generateOpenAPIDocument } from './generator.js'

// Scalar UI 默认从 jsdelivr CDN 加载 3.5MB 的 standalone bundle。
// 客户私有化部署的环境可能无外网,把 bundle 从本地 node_modules
// 静态托管出来,完全切断对外部 CDN 的依赖。
const require = createRequire(import.meta.url)
const SCALAR_BUNDLE = resolvePath(
  dirname(require.resolve('@scalar/api-reference')),
  'browser/standalone.js',
)

export function setupOpenAPI(app) {
  const spec = generateOpenAPIDocument()

  // /api/docs.json: 原始 OpenAPI 3.0 JSON,给客户自动化工具消费
  // 必须挂在 /api/docs 路由之前,避免被 Scalar 的 use() 吞掉
  app.get('/api/docs.json', (req, res) => res.json(spec))

  // 自托管 Scalar standalone bundle,无外部 CDN 依赖
  app.get('/api/docs/standalone.js', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.sendFile(SCALAR_BUNDLE)
  })

  // /api/docs: Scalar 渲染的现代化文档 UI
  app.use('/api/docs', apiReference({
    content: spec,
    cdn: '/api/docs/standalone.js',
  }))

  const count = Object.keys(spec.paths || {}).length
  const port = process.env.SERVER_PORT || 3001
  console.log(`📋 OpenAPI: http://localhost:${port}/api/docs (${count} endpoints)`)
}
