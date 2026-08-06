/**
 * Configuration Module
 * Handles environment variable loading and exports global config
 */

import { readFileSync, existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'
import WebSocket from 'ws'
import dns from 'dns'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Load environment variables from parent .env file
 */
function loadEnv() {
  try {
    const envPath = join(__dirname, '..', '..', '.env')
    const envContent = readFileSync(envPath, 'utf-8')
    const env = {}
    
    envContent.split('\n').forEach(line => {
      if (!line || line.startsWith('#')) return
      const match = line.match(/^([^=]+)=(.*)$/)
      if (match) {
        const key = match[1].trim()
        let value = match[2].trim()
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1)
        }
        env[key] = value
        // Also set to process.env (don't override existing values, matching dotenv default behavior)
        if (process.env[key] === undefined) {
          process.env[key] = value
        }
      }
    })
    return env
  } catch (error) {
    console.error('Error loading .env file:', error.message)
    process.exit(1)
  }
}

// Load environment variables
const env = loadEnv()

// Server configuration
const PORT = env.SERVER_PORT || 3001

// Supabase configuration
// Prefer internal URL (VPC endpoint) for server-side communication
const supabaseUrl = env.SUPABASE_INTERNAL_URL || env.VITE_SUPABASE_URL
const serviceRoleKey = env.SERVICE_ROLE_KEY
const anonKey = env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error('❌ Missing VITE_SUPABASE_URL or SERVICE_ROLE_KEY in .env')
  process.exit(1)
}

// Supabase Admin Client (with service role key, using internal URL when available)
const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  },
  realtime: {
    transport: WebSocket
  }
})

// E2B Configuration
const {E2B_DOMAIN} = env
const {E2B_API_KEY} = env
// E2B_IP is no longer a static config — it's resolved dynamically at startup via DNS

const NATIVE_AGENT_UI_ENABLED = (process.env.NATIVE_AGENT_UI_ENABLED || env.NATIVE_AGENT_UI_ENABLED || 'false').trim().toLowerCase() === 'true'
const PLATFORM_PUBLIC_URL = (process.env.PLATFORM_PUBLIC_URL || env.PLATFORM_PUBLIC_URL || '').trim()

// Shared OSS CSI mount configuration
const OSS_PV_NAME = process.env.OSS_PV_NAME || env.OSS_PV_NAME || 'oss-pv-openclaw-shared'
const BACKUP_MOUNT_PATH = process.env.BACKUP_MOUNT_PATH || env.BACKUP_MOUNT_PATH || '/backup'

// Deployment Environment Configuration
// Values: 'local-dev' (local development), 'cloud-dev' (cloud development), 'production'
const DEPLOY_ENVIRONMENT = process.env.DEPLOY_ENVIRONMENT || env.DEPLOY_ENVIRONMENT || 'local-dev'

// Persistent Volume Configuration (for skill mounts)
const VITE_OSS_PV_NAME = env.VITE_OSS_PV_NAME || ''
const VITE_SKILLHUB_OSS_PV_NAME = env.VITE_SKILLHUB_OSS_PV_NAME || ''

// SkillHub online installation. Agent images must preinstall a usable computenest-cli.
const SKILLHUB_ASSUME_ROLE_ARN = process.env.SKILLHUB_ASSUME_ROLE_ARN || env.SKILLHUB_ASSUME_ROLE_ARN || ''
// Optional test/diagnostic override. Production auto-detects the SkillHub
// control-plane region from the real AccountId returned by STS.
const SKILLHUB_REGION_ID = (process.env.SKILLHUB_REGION_ID || env.SKILLHUB_REGION_ID || '').trim()
const SKILL_INSTALL_TIMEOUT_SECONDS = positiveInt(
  process.env.SKILL_INSTALL_TIMEOUT_SECONDS || env.SKILL_INSTALL_TIMEOUT_SECONDS,
  600
)
const SKILLHUB_STS_DURATION_SECONDS = Math.max(900, positiveInt(
  process.env.SKILLHUB_STS_DURATION_SECONDS || env.SKILLHUB_STS_DURATION_SECONDS,
  900
))

function positiveInt(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

// Browser terminal proxy configuration
const TERMINAL_MAX_SESSIONS_PER_USER = positiveInt(process.env.TERMINAL_MAX_SESSIONS_PER_USER || env.TERMINAL_MAX_SESSIONS_PER_USER, 3)
const TERMINAL_MAX_SESSIONS_PER_INSTANCE = positiveInt(process.env.TERMINAL_MAX_SESSIONS_PER_INSTANCE || env.TERMINAL_MAX_SESSIONS_PER_INSTANCE, 1)
const TERMINAL_SESSION_TTL_SECONDS = positiveInt(process.env.TERMINAL_SESSION_TTL_SECONDS || env.TERMINAL_SESSION_TTL_SECONDS, 60)
const TERMINAL_IDLE_TIMEOUT_SECONDS = positiveInt(process.env.TERMINAL_IDLE_TIMEOUT_SECONDS || env.TERMINAL_IDLE_TIMEOUT_SECONDS, 1800)
const TERMINAL_SESSION_MAX_LIFETIME_SECONDS = positiveInt(process.env.TERMINAL_SESSION_MAX_LIFETIME_SECONDS || env.TERMINAL_SESSION_MAX_LIFETIME_SECONDS, 24 * 60 * 60)
const TERMINAL_OUTPUT_BUFFER_BYTES = positiveInt(process.env.TERMINAL_OUTPUT_BUFFER_BYTES || env.TERMINAL_OUTPUT_BUFFER_BYTES, 1024 * 1024)
const configuredTerminalSessionSecret = process.env.TERMINAL_SESSION_SECRET || env.TERMINAL_SESSION_SECRET
const TERMINAL_SESSION_SECRET = configuredTerminalSessionSecret || process.env.API_ENCRYPTION_KEY || env.API_ENCRYPTION_KEY

if (!TERMINAL_SESSION_SECRET) {
  console.error('❌ Missing TERMINAL_SESSION_SECRET or API_ENCRYPTION_KEY in .env')
  process.exit(1)
}

if (!configuredTerminalSessionSecret) {
  console.warn('⚠️  TERMINAL_SESSION_SECRET not configured, using API_ENCRYPTION_KEY as a fallback')
}

if (!E2B_API_KEY) {
  console.warn('⚠️  E2B_API_KEY not configured, sandbox features will be disabled')
}

console.log(`🔧 Deploy Environment: ${DEPLOY_ENVIRONMENT}`)

/**
 * Check whether an IP address is a private/internal address.
 * Private ranges: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10 (CGNAT)
 */
function isPrivateIp(ip) {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(isNaN)) return false
  const [a, b] = parts
  return (
    a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || a === 127
  )
}

/**
 * Resolve the E2B API endpoint to an IP via DNS and determine whether the
 * sandbox is reachable over a public network.
 *
 * E2B_DOMAIN (e.g. "agent-vpc.infra") is the base domain; the actual API
 * endpoint is "api.<domain>" which resolves via CNAME to the ALB address.
 * We use that resolved IP to decide whether hosts entries need to be shown
 * to users — private IP means the pod can reach E2B directly inside the
 * cluster without any /etc/hosts configuration.
 *
 * Resolves to an object: { ip: string|null, isPublic: boolean }
 */
async function resolveE2bNetworkInfo(domain) {
  if (!domain) return { ip: null, isPublic: false }
  // "api.<domain>" is the CNAME that points to the ALB, not the bare domain
  const apiHost = `api.${domain}`
  try {
    const addresses = await dns.promises.resolve4(apiHost)
    const ip = addresses[0] ?? null
    const isPublic = ip ? !isPrivateIp(ip) : false
    console.log(`🔍 E2B API host ${apiHost} resolved to ${ip} (${isPublic ? 'public' : 'private'} network)`)
    return { ip, isPublic }
  } catch (err) {
    console.warn(`⚠️  Failed to resolve E2B API host ${apiHost}: ${err.message}`)

    // Fallback 1: Try to read from E2B_IP env variable
    if (env.E2B_IP) {
      console.log(`📌 Using E2B_IP from environment: ${env.E2B_IP}`)
      const isPublic = !isPrivateIp(env.E2B_IP)
      return { ip: env.E2B_IP, isPublic }
    }

    // Fallback 2: Try to read from /etc/hosts
    try {
      const hostsContent = readFileSync('/etc/hosts', 'utf-8')
      const match = hostsContent.match(new RegExp(`(\\S+)\\s+${apiHost.replace('.', '\\.')}`))
      if (match && match[1] && match[1] !== 'null') {
        console.log(`📌 Using IP from /etc/hosts: ${match[1]}`)
        const isPublic = !isPrivateIp(match[1])
        return { ip: match[1], isPublic }
      }
    } catch (hostsErr) {
      console.warn(`⚠️  Failed to read /etc/hosts: ${hostsErr.message}`)
    }

    return { ip: null, isPublic: false }
  }
}

// Resolved at startup; exported so routes can use it without re-resolving
const e2bNetworkInfo = await resolveE2bNetworkInfo(E2B_DOMAIN)
// IP resolved from DNS at startup — used to generate /etc/hosts entries for users
const E2B_HOSTS_IP = e2bNetworkInfo.ip
// Whether to show hosts entries in the UI (only needed when E2B is on public network)
const E2B_NEEDS_HOSTS = e2bNetworkInfo.isPublic

console.log(`🔧 E2B Hosts IP: ${E2B_HOSTS_IP ?? 'unresolved'} | Needs hosts hint: ${E2B_NEEDS_HOSTS}`)

// Configure E2B with custom domain if provided
if (E2B_DOMAIN) {
  process.env.E2B_DOMAIN = E2B_DOMAIN
}
if (E2B_API_KEY) {
  process.env.E2B_API_KEY = E2B_API_KEY
}

// Inject Alibaba Cloud credentials into process.env for computenest.js
if (env.ALIBABA_CLOUD_ACCESS_KEY_ID) {
  process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = env.ALIBABA_CLOUD_ACCESS_KEY_ID
}
if (env.ALIBABA_CLOUD_ACCESS_KEY_SECRET) {
  process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = env.ALIBABA_CLOUD_ACCESS_KEY_SECRET
}

// AI Gateway Configuration
const ENABLE_AI_GATEWAY = env.ENABLE_AI_GATEWAY === 'true'

// Log initial AI Gateway status (actual config will be loaded from DB later)
if (ENABLE_AI_GATEWAY) {
  console.log('🌐 AI Gateway env hint: ENABLED (will load from DB)')
} else {
  console.log('🌐 AI Gateway env hint: DISABLED (will load from DB)')
}

// Template file path configuration
let TEMPLATE_FILE_PATH = env.OPENCLAW_TEMPLATE_PATH || join(__dirname, '..', '..', 'data', 'openclaw-template.json')
if (TEMPLATE_FILE_PATH.startsWith('./') || TEMPLATE_FILE_PATH.startsWith('../')) {
  TEMPLATE_FILE_PATH = join(__dirname, '..', '..', TEMPLATE_FILE_PATH)
}

// Ensure template directory exists
const templateDir = dirname(TEMPLATE_FILE_PATH)
if (!existsSync(templateDir)) {
  mkdirSync(templateDir, { recursive: true })
}

/**
 * Create a user-scoped Supabase client
 * @param {string} token - JWT token from the user
 * @returns {SupabaseClient}
 */
function createUserClient(token) {
  return createClient(supabaseUrl, anonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`
      }
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false
    },
    realtime: {
      transport: WebSocket
    }
  })
}

export {
  env,
  PORT,
  supabaseUrl,
  serviceRoleKey,
  supabaseAdmin,
  createUserClient,
  E2B_DOMAIN,
  E2B_API_KEY,
  NATIVE_AGENT_UI_ENABLED,
  PLATFORM_PUBLIC_URL,
  DEPLOY_ENVIRONMENT,
  E2B_HOSTS_IP,
  E2B_NEEDS_HOSTS,
  OSS_PV_NAME,
  BACKUP_MOUNT_PATH,
  ENABLE_AI_GATEWAY,
  TEMPLATE_FILE_PATH,
  VITE_OSS_PV_NAME,
  VITE_SKILLHUB_OSS_PV_NAME,
  SKILLHUB_ASSUME_ROLE_ARN,
  SKILLHUB_REGION_ID,
  SKILL_INSTALL_TIMEOUT_SECONDS,
  SKILLHUB_STS_DURATION_SECONDS,
  TERMINAL_MAX_SESSIONS_PER_USER,
  TERMINAL_MAX_SESSIONS_PER_INSTANCE,
  TERMINAL_SESSION_TTL_SECONDS,
  TERMINAL_IDLE_TIMEOUT_SECONDS,
  TERMINAL_SESSION_MAX_LIFETIME_SECONDS,
  TERMINAL_OUTPUT_BUFFER_BYTES,
  TERMINAL_SESSION_SECRET
}
