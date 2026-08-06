// agent-manager/server/openapi/registry.js
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi'
import { securitySchemes } from './definition.js'

export const registry = new OpenAPIRegistry()

// OpenApiGeneratorV3 只从 registry 读 components,直接给 generateDocument 传
// components 参数不会生效——必须在 registry 上 registerComponent
for (const [name, scheme] of Object.entries(securitySchemes)) {
  registry.registerComponent('securitySchemes', name, scheme)
}
