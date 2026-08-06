/**
 * OpenClaw API Server - Main Entry Point
 *
 * This file only wires together config, middleware and routes.
 * Business logic lives under routes/, services/, middleware/ and utils/.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync } from 'fs'

import { NATIVE_AGENT_UI_ENABLED, PORT } from './config/index.js'
import { loggerMiddleware } from './middleware/index.js'
import { registerRoutes } from './routes/index.js'
import { loadGatewayConfig, autoConfigureFromEnv } from './services/gateway-config.js'
import { setupOpenAPI } from './openapi/setup.js'
import { registerTerminalWebSocket } from './routes/terminal.js'
import { installConsoleLogger } from './utils/logger.js'
import { registerNativeAgentUiProxy } from './native-agent-ui-proxy.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

installConsoleLogger()

const app = express()
const server = createServer(app)

app.use(cors())
app.use(loggerMiddleware)

// Register before body parsing so Agent requests can stream unchanged.
registerNativeAgentUiProxy(app, server)

app.use(express.json({ limit: '50mb' }))

// Mount OpenAPI docs UI + JSON spec (before routes; harmless either way)
setupOpenAPI(app)

// Register API routes first
registerRoutes(app)
registerTerminalWebSocket(server)

// Serve static frontend files in production
const distPath = join(__dirname, '..', 'dist')
if (existsSync(distPath)) {
  // Serve env-config.js dynamically
  app.get('/env-config.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript')
    const runtimeEnv = {
      VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL || '',
      VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY || '',
      VITE_APP_ID: process.env.VITE_APP_ID || 'public',
      VITE_API_URL: '',
      VITE_OSS_URL: process.env.VITE_OSS_URL || '',
      VITE_OSS_PV_NAME: process.env.VITE_OSS_PV_NAME || '',
      VITE_SKILLHUB_OSS_PV_NAME: process.env.VITE_SKILLHUB_OSS_PV_NAME || '',
      VITE_ACS_CLUSTER_ID: process.env.VITE_ACS_CLUSTER_ID || '',
      VITE_NATIVE_AGENT_UI_ENABLED: String(NATIVE_AGENT_UI_ENABLED)
    }
    res.send(`window.__ENV__ = ${JSON.stringify(runtimeEnv)};`)
  })

  // Serve static files from dist directory
  app.use(express.static(distPath))

  // SPA fallback: serve index.html for all non-API routes
  app.get('*', (req, res) => {
    // Don't interfere with API routes
    if (req.path.startsWith('/api')) {
      return res.status(404).json({ error: 'API endpoint not found' })
    }
    res.sendFile(join(distPath, 'index.html'))
  })

  console.log(`📦 Serving static frontend files from ${distPath}`)
}


// Load AI Gateway config from DB, auto-configure from env if needed, then start server
loadGatewayConfig().then(() => autoConfigureFromEnv()).then(() => {
  server.listen(PORT, () => {
    console.log(`🚀 OpenClaw Server running on http://localhost:${PORT}`)
    if (existsSync(distPath)) {
      console.log(`🌐 Frontend available at http://localhost:${PORT}/`)
      console.log(`🔌 API available at http://localhost:${PORT}/api/`)
    }

    // Fire-and-forget: initialize observability_env for builtin Agent Types
    import('./services/observability-init.js').then(({ initializeObservabilityEnv }) => {
      initializeObservabilityEnv().catch(err => {
        console.warn('[observability-init] Failed to initialize defaults:', err.message)
      })
    })
  })
}).catch(err => {
  console.error('Failed to load gateway config:', err)
  process.exit(1)
})
