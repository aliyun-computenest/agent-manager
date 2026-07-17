import { appendFileSync, mkdirSync } from 'fs'
import { AsyncLocalStorage } from 'async_hooks'
import { hostname } from 'os'
import { join } from 'path'
import { inspect } from 'util'

const DEFAULT_LOG_DIR = '/var/log/agent-manager'
const DEFAULT_BODY_MAX_BYTES = 64 * 1024
const MAX_REDACTION_DEPTH = 10

const LEVELS = {
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60
}

const LEVEL_FILES = {
  info: 'info.log',
  warn: 'warn.log',
  error: 'error.log',
  fatal: 'error.log'
}

const SENSITIVE_FIELD_PATTERN = /^(password|token|accessToken|refreshToken|apiKey|api_key|secret|authorization|cookie|set-cookie|access_key|accessKeyId|accessKeySecret|service_role_key|consumer_apikey_encrypted|masterKey)$/i
const logContextStorage = new AsyncLocalStorage()

const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
}

function maskValue(value) {
  const text = String(value)
  if (text.length <= 8) return '***'
  return `${text.slice(0, 4)}***${text.slice(-4)}`
}

function serializeError(error) {
  if (!(error instanceof Error)) return error
  return {
    type: error.name,
    message: error.message,
    stack: error.stack
  }
}

function redactSensitiveData(value, depth = 0) {
  if (depth > MAX_REDACTION_DEPTH) return '[MaxDepth]'
  if (value instanceof Error) return serializeError(value)
  if (Array.isArray(value)) {
    return value.map(item => redactSensitiveData(item, depth + 1))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (SENSITIVE_FIELD_PATTERN.test(key)) {
        return [key, maskValue(item)]
      }
      return [key, redactSensitiveData(item, depth + 1)]
    }))
  }
  return value
}

function truncateUtf8(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  return Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')
}

function resolveMinimumLevel(level) {
  const value = level ?? process.env.LOG_LEVEL ?? 'info'
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return LEVELS[String(value).toLowerCase()] ?? LEVELS.info
}

function sanitizeBodyForLog(body, options = {}) {
  const maxBytes = Number(options.maxBytes) || DEFAULT_BODY_MAX_BYTES
  if (body === undefined || body === null) {
    return { body: null, truncated: false, size: 0 }
  }

  const redacted = redactSensitiveData(body)
  const serialized = typeof redacted === 'string' ? redacted : JSON.stringify(redacted)
  const size = Buffer.byteLength(serialized, 'utf8')
  if (size <= maxBytes) {
    return { body: redacted, truncated: false, size }
  }

  return {
    body: truncateUtf8(serialized, maxBytes),
    truncated: true,
    size
  }
}

function normalizeMeta(meta = {}) {
  const redacted = redactSensitiveData(meta)
  if (redacted.err instanceof Error) {
    redacted.err = serializeError(redacted.err)
  }
  return redacted
}

function getLogContext() {
  return logContextStorage.getStore() || {}
}

function withLogContext(meta = {}) {
  const context = getLogContext()
  if (!context.requestId || meta.requestId !== undefined) return meta
  return { requestId: context.requestId, ...meta }
}

function runWithLogContext(context, callback) {
  return logContextStorage.run(context, callback)
}

function formatConsoleArgs(args) {
  return args.map(arg => {
    if (typeof arg === 'string') return arg
    if (arg instanceof Error) return arg.stack || arg.message
    return inspect(arg, { depth: 6, colors: false })
  }).join(' ')
}

function createRecord(levelName, moduleName, msg, meta = {}) {
  const normalized = normalizeMeta(withLogContext(meta))
  const { err, ...rest } = normalized
  const record = {
    ...rest,
    level: LEVELS[levelName],
    time: Date.now(),
    pid: process.pid,
    hostname: hostname(),
    module: moduleName,
    requestId: rest.requestId ?? null,
    msg
  }

  if (err !== undefined) {
    record.err = serializeError(err)
  }

  return record
}

function createStructuredLogger(options = {}) {
  const logDir = options.logDir || process.env.LOG_DIR || DEFAULT_LOG_DIR
  const moduleName = options.module || 'app'
  const minimumLevel = resolveMinimumLevel(options.level)
  const pretty = options.pretty ?? (process.env.NODE_ENV !== 'production')
  const stdout = options.stdout ?? pretty

  if (options.createDir !== false) {
    try {
      mkdirSync(logDir, { recursive: true })
    } catch {
      // File logging is best-effort; stdout remains available.
    }
  }

  const writeRecord = (levelName, msg, meta) => {
    if (LEVELS[levelName] < minimumLevel) return

    const record = createRecord(levelName, moduleName, msg, meta)
    const line = `${JSON.stringify(record)}\n`

    try {
      appendFileSync(join(logDir, LEVEL_FILES[levelName]), line)
    } catch {
      // Missing or unwritable log dirs must not block app startup.
    }

    if (stdout) {
      const output = pretty
        ? `[${new Date(record.time).toISOString()}] ${levelName.toUpperCase()} [${moduleName}] ${msg}`
        : line.trim()
      const target = levelName === 'warn'
        ? originalConsole.warn
        : levelName === 'error' || levelName === 'fatal'
          ? originalConsole.error
          : originalConsole.log
      target(output)
    }
  }

  return {
    info: (msg, meta) => writeRecord('info', msg, meta),
    warn: (msg, meta) => writeRecord('warn', msg, meta),
    error: (msg, meta) => writeRecord('error', msg, meta),
    fatal: (msg, meta) => writeRecord('fatal', msg, meta),
    flush: async () => {}
  }
}

function createAccessLogger(options = {}) {
  const logDir = options.logDir || process.env.LOG_DIR || DEFAULT_LOG_DIR
  const pretty = options.pretty ?? false
  const stdout = options.stdout ?? false

  if (options.createDir !== false) {
    try {
      mkdirSync(logDir, { recursive: true })
    } catch {
      // File logging is best-effort; stdout remains available.
    }
  }

  return {
    access: record => {
      const line = `${JSON.stringify(record)}\n`
      try {
        appendFileSync(join(logDir, 'access.log'), line)
      } catch {
        // Missing or unwritable log dirs must not block app responses.
      }

      if (stdout) {
        const timestamp = record.timestamp || record.time
        const output = pretty
          ? `[${timestamp}] ACCESS ${record.method} ${record.path} ${record.statusCode} (${record.duration}ms)`
          : line.trim()
        originalConsole.log(output)
      }
    },
    flush: async () => {}
  }
}

const appLogger = createStructuredLogger({
  module: 'app',
  stdout: process.env.NODE_ENV !== 'test'
})

const accessLogger = createAccessLogger({
  stdout: false
})

function installConsoleLogger(logger = appLogger) {
  console.log = (...args) => logger.info(formatConsoleArgs(args), getLogContext())
  console.info = (...args) => logger.info(formatConsoleArgs(args), getLogContext())
  console.warn = (...args) => logger.warn(formatConsoleArgs(args), getLogContext())
  console.error = (...args) => logger.error(formatConsoleArgs(args), getLogContext())
  return restoreConsoleLogger
}

function restoreConsoleLogger() {
  console.log = originalConsole.log
  console.info = originalConsole.info
  console.warn = originalConsole.warn
  console.error = originalConsole.error
}

export {
  DEFAULT_BODY_MAX_BYTES,
  DEFAULT_LOG_DIR,
  LEVELS,
  appLogger,
  accessLogger,
  createAccessLogger,
  createStructuredLogger,
  installConsoleLogger,
  restoreConsoleLogger,
  getLogContext,
  originalConsole,
  redactSensitiveData,
  runWithLogContext,
  sanitizeBodyForLog,
  serializeError
}
