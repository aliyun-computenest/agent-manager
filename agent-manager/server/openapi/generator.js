// agent-manager/server/openapi/generator.js
import { OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi'
import { registry } from './registry.js'
import { info, servers, tags } from './definition.js'

export function generateOpenAPIDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions)
  return generator.generateDocument({
    openapi: '3.0.0',
    info,
    servers,
    tags,
  })
}
