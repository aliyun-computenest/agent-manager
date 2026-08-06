import { randomUUID } from 'crypto'

import {
  DEFAULT_BODY_MAX_BYTES,
  accessLogger,
  runWithLogContext,
  sanitizeBodyForLog
} from '../utils/logger.js'

const getTimestamp = () => new Date().toISOString()

const colorize = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  white: '\x1b[37m'
}

function isHealthCheck(req) {
  const path = req.path || req.originalUrl || req.url || ''
  return path === '/api/health' || path.startsWith('/api/health?')
}

function parseMaybeJson(value) {
  if (value === undefined || value === null || value === '') return null
  if (Buffer.isBuffer(value)) value = value.toString('utf8')
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function getClientIp(req) {
  const forwardedFor = req.headers?.['x-forwarded-for']
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim()
  }
  return req.ip || req.socket?.remoteAddress || null
}

function getContentLengthHeader(res) {
  if (typeof res.getHeader !== 'function') return null
  const value = Number(res.getHeader('content-length'))
  return Number.isFinite(value) && value >= 0 ? value : null
}

function createAccessLoggerMiddleware(options = {}) {
  const logger = options.accessLogger || accessLogger
  const maxBodyBytes = Number(options.maxBodyBytes || process.env.LOG_ACCESS_BODY_MAX_BYTES) || DEFAULT_BODY_MAX_BYTES
  const now = options.now || getTimestamp
  const requestIdFactory = options.requestIdFactory || randomUUID

  return function accessLoggerMiddleware(req, res, next) {
    const requestId = req.headers?.['x-request-id'] || requestIdFactory()
    return runWithLogContext({ requestId }, () => {
      const startTime = Date.now()
      req.requestId = requestId
      req.startTime = startTime
      if (typeof res.setHeader === 'function') {
        res.setHeader('X-Request-Id', requestId)
      }

      if (isHealthCheck(req)) return next()

      const chunks = []
      let capturedBytes = 0
      let responseContentLength = 0
      let responseTruncated = false
      let endChunkBeingWritten = null

      const captureChunk = chunk => {
        if (chunk === undefined) return

        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
        responseContentLength += buffer.length

        if (capturedBytes >= maxBodyBytes) {
          responseTruncated = true
          return
        }

        const remainingBytes = maxBodyBytes - capturedBytes
        if (buffer.length > remainingBytes) {
          chunks.push(buffer.subarray(0, remainingBytes))
          capturedBytes += remainingBytes
          responseTruncated = true
          return
        }

        chunks.push(buffer)
        capturedBytes += buffer.length
      }

      const originalWrite = res.write
      const originalEnd = res.end

      if (typeof originalWrite === 'function') {
        res.write = function writeWithCapture(chunk, ...args) {
          if (chunk !== undefined && chunk !== endChunkBeingWritten) {
            captureChunk(chunk)
          }
          return originalWrite.call(this, chunk, ...args)
        }
      }

      if (typeof originalEnd === 'function') {
        res.end = function endWithCapture(chunk, ...args) {
          captureChunk(chunk)
          endChunkBeingWritten = chunk
          try {
            return originalEnd.call(this, chunk, ...args)
          } finally {
            endChunkBeingWritten = null
          }
        }
      }

      res.on('finish', () => {
        const responseText = Buffer.concat(chunks).toString('utf8')
        const requestBody = sanitizeBodyForLog(req.body ?? null, { maxBytes: maxBodyBytes })
        const responseBody = sanitizeBodyForLog(parseMaybeJson(responseText), { maxBytes: maxBodyBytes })
        const contentLength = responseContentLength || getContentLengthHeader(res) || 0

        logger.access({
          timestamp: now(),
          requestId,
          method: req.method,
          path: req.originalUrl || req.url || req.path,
          statusCode: res.statusCode,
          duration: Date.now() - startTime,
          contentLength,
          clientIp: getClientIp(req),
          userAgent: req.headers?.['user-agent'] || null,
          userId: req.user?.id || null,
          requestBody: requestBody.body,
          responseBody: responseBody.body,
          truncated: requestBody.truncated || responseBody.truncated || responseTruncated
        })
      })

      next()
    })
  }
}

const loggerMiddleware = createAccessLoggerMiddleware()

export {
  createAccessLoggerMiddleware,
  loggerMiddleware,
  colorize,
  getTimestamp
}
