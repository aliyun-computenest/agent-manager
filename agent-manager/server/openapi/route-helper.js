// agent-manager/server/openapi/route-helper.js
import { registry } from './registry.js'

/**
 * Convert OpenAPI-style path params ({name}) to Express-style (:name).
 * Express 4 (path-to-regexp 0.1.x) only supports `:name`; OpenAPI requires `{name}`.
 * meta.path uses the OpenAPI form, and we translate just for router registration.
 */
function toExpressPath(openapiPath) {
  return openapiPath.replace(/\{([^/}]+)\}/g, ':$1')
}

/**
 * Build status -> zodSchema map from the responses metadata.
 * Skips entries that aren't zod schemas so non-validated entries still register.
 */
function extractResponseSchemas(responses) {
  const out = {}
  for (const [status, def] of Object.entries(responses ?? {})) {
    const schema = def?.content?.['application/json']?.schema
    if (schema && typeof schema.safeParse === 'function') {
      out[Number(status)] = schema
    }
  }
  return out
}

/**
 * Middleware that intercepts res.json() to validate the outgoing payload
 * against the schema declared in `responses[statusCode]` — symmetric counterpart
 * to validate() on the request side. Same zod schemas drive OpenAPI docs AND
 * runtime checks, eliminating doc-vs-code drift.
 *
 * Mounted FIRST so it also covers responses emitted by requireAuth /
 * validate() — not just the final route handler.
 *
 * All environments: log-only; never alter response bytes.
 */
function installResponseValidator(method, path, responseSchemas) {
  return (req, res, next) => {
    const originalJson = res.json.bind(res)
    res.json = (body) => {
      if (!responseSchemas[res.statusCode] && !responseSchemas[Math.floor(res.statusCode / 100) * 100]) {
        console.error(
          `[Undeclared Status Code] ${method.toUpperCase()} ${path} returned ${res.statusCode}, ` +
          `which is not declared in responses: [${Object.keys(responseSchemas).join(', ')}]`
        )
      }
      const schema = responseSchemas[res.statusCode]
      if (schema) {
        const result = schema.safeParse(body)
        if (!result.success) {
          console.error(
            `[Response Schema Mismatch] ${method.toUpperCase()} ${path} ${res.statusCode}`,
            result.error.format()
          )
        }
      }
      return originalJson(body)
    }
    next()
  }
}

function assertRouteMeta(meta) {
  if (!meta.operationId) {
    throw new Error(`defineRoute: operationId is required for ${meta.method} ${meta.path}`)
  }
  if (!meta.responses || Object.keys(meta.responses).length === 0) {
    throw new Error(`defineRoute: responses is required for ${meta.operationId}`)
  }
  if (meta.security === undefined) {
    throw new Error(`defineRoute: security must be explicitly declared (use [] for public routes) for ${meta.operationId}`)
  }
}

/**
 * Declare a route AND register it into the OpenAPI registry in one step.
 * Also injects a response-schema validator so the same zod schemas that
 * generate the docs are enforced at runtime — keeping doc and code in sync
 * with no per-handler boilerplate.
 *
 * @param {import('express').Router} router
 * @param {object} meta - registry.registerPath() args:
 *                        { method, path, operationId, tags, summary, description,
 *                          request?, responses, security? }
 *                        path uses OpenAPI form: /foo/{id}
 * @param  {...Function} handlers - Express middleware chain (middleware + handler)
 */
export function defineRoute(router, meta, ...handlers) {
  assertRouteMeta(meta)

  registry.registerPath(meta)
  const responseSchemas = extractResponseSchemas(meta.responses)
  const validator = installResponseValidator(meta.method, meta.path, responseSchemas)

  const routeHandler = handlers.pop()
  const safeHandler = async (req, res, next) => {
    try {
      await routeHandler(req, res, next)
    } catch (error) {
      console.error(`[Route Error] ${meta.method.toUpperCase()} ${meta.path}:`, error)
      if (!res.headersSent) {
        res.status(error.httpStatus || 500).json({ success: false, error: error.message })
      }
    }
  }

  router[meta.method](toExpressPath(meta.path), validator, ...handlers, safeHandler)
}
