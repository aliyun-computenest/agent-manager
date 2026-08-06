// agent-manager/server/scripts/validate-openapi.js
// Validates registry-derived OpenAPI spec quality. 7 checks:
//   1. spec generates without throwing
//   2. all operationIds present + unique
//   3. all used tags declared in definition.tags
//   4. requireAuth routes declare 401; requireAdmin routes declare 401 + 403
//   5. orphan route files (not reachable from routes/index.js)
//   6. no raw router.get/post/put/delete/patch calls (must use defineRoute)
//   7. no z.record(z.unknown()) / z.unknown() / z.any() in routes/ or schemas/
//
// Exit 0 = pass, 1 = fail.

import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve, basename } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Trigger registration
await import('../routes/index.js')

const { generateOpenAPIDocument } = await import('../openapi/generator.js')
const { tags: declaredTags } = await import('../openapi/definition.js')

let errors = 0
const fail = (msg) => { console.error('❌', msg); errors++ }
const ok   = (msg) => console.log('✅', msg)

// --- Check 1: spec generates ---
let spec
try { spec = generateOpenAPIDocument() }
catch (e) { fail(`spec generation threw: ${e.message}`); process.exit(1) }

const endpoints = []
for (const [path, methods] of Object.entries(spec.paths || {})) {
  for (const [method, detail] of Object.entries(methods)) {
    if (['get','post','put','patch','delete'].includes(method)) {
      endpoints.push({ path, method, detail })
    }
  }
}
console.log(`📋 ${endpoints.length} endpoints, ${Object.keys(spec.components?.schemas||{}).length} schemas`)

// --- Check 2: operationId presence + uniqueness ---
const opIds = new Map()
for (const e of endpoints) {
  const id = e.detail.operationId
  if (!id) { fail(`missing operationId: ${e.method.toUpperCase()} ${e.path}`); continue }
  if (opIds.has(id)) fail(`duplicate operationId: ${id}`)
  else opIds.set(id, true)
}
if (endpoints.every(e => e.detail.operationId)) ok(`all ${endpoints.length} endpoints have unique operationId`)

// --- Check 3: tag declarations ---
const tagNames = new Set(declaredTags.map(t => t.name))
const undeclared = new Set()
for (const e of endpoints) {
  for (const t of (e.detail.tags || [])) {
    if (!tagNames.has(t)) undeclared.add(t)
  }
}
if (undeclared.size === 0) ok('all tags declared')
else fail(`undeclared tags: ${[...undeclared].join(', ')}`)

// --- Check 4: auth middleware ↔ 401/403 declarations ---
const routesDir = resolve(__dirname, '../routes')
const routeFiles = readdirSync(routesDir).filter(f => f.endsWith('.js') && f !== 'index.js')
const routeGuards = new Map()
for (const file of routeFiles) {
  const content = readFileSync(resolve(routesDir, file), 'utf-8')
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    // Match defineRoute(router, { method: 'X', path: '/y', ... }, requireAuth?, requireAdmin?, ...)
    // Look ahead 20 lines from defineRoute for { method, path }
    if (!/\bdefineRoute\s*\(/.test(lines[i])) continue
    const block = lines.slice(i, i + 30).join('\n')
    const mMethod = block.match(/method:\s*['"](\w+)['"]/)
    const mPath = block.match(/path:\s*['"]([^'"]+)['"]/)
    if (!mMethod || !mPath) continue
    routeGuards.set(`${mMethod[1].toUpperCase()} ${mPath[1]}`, {
      file: basename(file),
      hasAuth: /\brequireAuth\b/.test(block),
      hasAdmin: /\brequireAdmin\b/.test(block),
    })
  }
}
let authMissing = 0
for (const e of endpoints) {
  const key = `${e.method.toUpperCase()} ${e.path}`
  const g = routeGuards.get(key)
  if (!g || (!g.hasAuth && !g.hasAdmin)) continue
  const codes = Object.keys(e.detail.responses || {})
  if (!codes.includes('401')) { fail(`${key} (${g.file}) guarded but missing 401`); authMissing++ }
  if (g.hasAdmin && !codes.includes('403')) { fail(`${key} (${g.file}) requireAdmin but missing 403`); authMissing++ }
}
if (authMissing === 0) ok('all guarded routes declare matching 401/403')

// --- Check 5: orphan route files ---
const indexSrc = readFileSync(resolve(routesDir, 'index.js'), 'utf-8')
const routeFileSet = new Set(routeFiles)
const reachableRouteFiles = new Set()
const importSpecPattern = /(?:import\s+['"]\.\/([^'"]+)['"]|from\s+['"]\.\/([^'"]+)['"])/g

function routeFileFromSpec(spec) {
  if (!spec || spec.includes('/')) return null
  const file = spec.endsWith('.js') ? spec : `${spec}.js`
  return routeFileSet.has(file) ? file : null
}

function collectReachableRouteFiles(file, src = null) {
  if (reachableRouteFiles.has(file)) return
  reachableRouteFiles.add(file)

  const content = src ?? readFileSync(resolve(routesDir, file), 'utf-8')
  for (const match of content.matchAll(importSpecPattern)) {
    const importedFile = routeFileFromSpec(match[1] || match[2])
    if (importedFile) collectReachableRouteFiles(importedFile)
  }
}

collectReachableRouteFiles('index.js', indexSrc)
const orphans = routeFiles.filter(f => !reachableRouteFiles.has(f))
if (orphans.length === 0) ok('all route files reachable from routes/index.js')
else fail(`orphan route files: ${orphans.join(', ')}`)

// --- Check 6: no raw router calls (must use defineRoute) ---
const allRouteDirs = [routesDir, resolve(routesDir, 'internal')]
const rawRouterPattern = /\brouter\.(get|post|put|delete|patch)\s*\(/
let rawRouterHits = 0
for (const dir of allRouteDirs) {
  let files
  try { files = readdirSync(dir).filter(f => f.endsWith('.js') && f !== 'index.js') } catch { continue }
  for (const file of files) {
    const content = readFileSync(resolve(dir, file), 'utf-8')
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (rawRouterPattern.test(lines[i])) {
        fail(`raw router call at ${file}:${i + 1} — must use defineRoute()`)
        rawRouterHits++
      }
    }
  }
}
if (rawRouterHits === 0) ok('no raw router calls (all routes use defineRoute)')

// --- Check 7: no z.record(z.unknown()) / z.unknown() / z.any() ---
const schemasDirs = [routesDir, resolve(routesDir, 'internal'), resolve(__dirname, '../schemas')]
const looseSchemaPatterns = [
  { re: /z\.record\(\s*z\.unknown\(\)/, label: 'z.record(z.unknown())' },
  { re: /z\.unknown\(\)/, label: 'z.unknown()' },
  { re: /z\.any\(\)/, label: 'z.any()' },
]
let looseSchemaHits = 0
for (const dir of schemasDirs) {
  let files
  try { files = readdirSync(dir).filter(f => f.endsWith('.js')) } catch { continue }
  for (const file of files) {
    const content = readFileSync(resolve(dir, file), 'utf-8')
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      for (const { re, label } of looseSchemaPatterns) {
        if (re.test(lines[i])) {
          fail(`${label} at ${file}:${i + 1} — must use explicit schema`)
          looseSchemaHits++
        }
      }
    }
  }
}
if (looseSchemaHits === 0) ok('no z.unknown()/z.any()/z.record(z.unknown()) in routes/ or schemas/')

// --- Summary ---
console.log(`\n${errors === 0 ? '✅ PASSED' : `❌ FAILED (${errors} errors)`}`)
process.exit(errors === 0 ? 0 : 1)
