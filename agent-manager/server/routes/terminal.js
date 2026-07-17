import { Router } from 'express'
import { WebSocketServer } from 'ws'
import { z } from 'zod'
import multer from 'multer'
import { Sandbox } from '@e2b/code-interpreter'
import { requireAuth } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import { defineRoute } from '../openapi/route-helper.js'
import { supabaseAdmin } from '../config/index.js'
import {
  canAccessInstanceRecord,
  getActiveGroupMemberships
} from '../services/principal-access.js'
import {
  TerminalError,
  attachTerminalWebSocket,
  createTerminalSession
} from '../services/terminal.js'

const router = Router()

const TerminalInstanceParamsSchema = z.object({
  instanceId: z.string().describe('Instance ID')
})

const TerminalSessionResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({ sessionId: z.string() }).passthrough()
})

const TerminalErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  message: z.string().optional()
})

function sendTerminalError(res, error) {
  if (error instanceof TerminalError) {
    return res.status(error.status).json({
      success: false,
      error: error.code,
      message: error.message
    })
  }
  console.error('Terminal route error:', error)
  return res.status(500).json({
    success: false,
    error: 'TERMINAL_START_FAILED',
    message: error.message
  })
}

defineRoute(router, {
  method: 'post',
  path: '/instances/{instanceId}/terminal/session',
  operationId: 'createTerminalSession',
  tags: ['Terminal'],
  summary: 'Create terminal session',
  description: 'Create a terminal session for the specified instance. Returns a sessionId for subsequent WebSocket connection.',
  security: [{ bearerAuth: [] }],
  request: {
    params: TerminalInstanceParamsSchema,
  },
  responses: {
    200: {
      description: 'Terminal session created successfully',
      content: { 'application/json': { schema: TerminalSessionResponseSchema } },
    },
    400: { description: 'Terminal error', content: { 'application/json': { schema: TerminalErrorResponseSchema } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: TerminalErrorResponseSchema } } },
    403: { description: 'Terminal error', content: { 'application/json': { schema: TerminalErrorResponseSchema } } },
    500: { description: 'Terminal error', content: { 'application/json': { schema: TerminalErrorResponseSchema } } },
  },
}, requireAuth, validate({ params: TerminalInstanceParamsSchema }), async (req, res) => {
  try {
    const session = await createTerminalSession({
      instanceId: req.params.instanceId,
      req
    })
    res.json({
      success: true,
      data: session
    })
  } catch (error) {
    sendTerminalError(res, error)
  }
})

function rejectUpgrade(socket, statusCode, message) {
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

function getHeaderValues(value) {
  if (!value) return []
  return String(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

function isAllowedUpgradeOrigin(request) {
  const origin = request.headers.origin
  if (!origin) return true

  let originHost
  try {
    originHost = new URL(origin).host
  } catch {
    return false
  }

  const allowedHosts = new Set([
    ...getHeaderValues(request.headers.host),
    ...getHeaderValues(request.headers['x-forwarded-host'])
  ])
  return allowedHosts.has(originHost)
}

// --- File Upload to Pod ---

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }
})

const UPLOAD_TARGET_DIR = '/root/uploads/'

const VALID_USERNAME_RE = /^[a-zA-Z0-9_-]{1,32}$/

function resolveUploadDir(targetUser) {
  if (!targetUser) return UPLOAD_TARGET_DIR
  const user = String(targetUser).trim()
  if (!VALID_USERNAME_RE.test(user)) return UPLOAD_TARGET_DIR
  if (user === 'root') return '/root/uploads/'
  return `/home/${user}/uploads/`
}

function sanitizeFilename(filename) {
  // Remove path separators and parent directory references
  let sanitized = String(filename || 'upload')
    .replace(/\.\./g, '')
    .replace(/[/\\]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '') // remove control characters
    .replace(/[<>:"|?*]/g, '') // remove special chars unsafe for filesystems
    .trim()
  if (!sanitized) sanitized = 'upload'
  // Limit length
  if (sanitized.length > 200) sanitized = sanitized.slice(0, 200)
  return sanitized
}

const FileUploadParamsSchema = z.object({
  instanceId: z.string().describe('Instance ID')
})

const FileUploadResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    path: z.string(),
    size: z.number()
  })
})

const FileUploadErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  message: z.string().optional()
})

defineRoute(router, {
  method: 'post',
  path: '/instances/{instanceId}/files/upload',
  operationId: 'uploadFileToInstance',
  tags: ['Terminal'],
  summary: 'Upload file to instance Pod',
  description: 'Upload a file to the specified instance Pod. Target directory is /root/uploads/ by default, or /home/{targetUser}/uploads/ for non-root users.',
  security: [{ bearerAuth: [] }],
  request: {
    params: FileUploadParamsSchema,
  },
  responses: {
    200: {
      description: 'File uploaded successfully',
      content: { 'application/json': { schema: FileUploadResponseSchema } },
    },
    400: { description: 'Upload error', content: { 'application/json': { schema: FileUploadErrorResponseSchema } } },
    401: { description: 'Unauthorized', content: { 'application/json': { schema: FileUploadErrorResponseSchema } } },
    404: { description: 'Instance not found', content: { 'application/json': { schema: FileUploadErrorResponseSchema } } },
    413: { description: 'File too large', content: { 'application/json': { schema: FileUploadErrorResponseSchema } } },
    500: { description: 'Server error', content: { 'application/json': { schema: FileUploadErrorResponseSchema } } },
  },
}, requireAuth, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          success: false,
          error: 'FILE_TOO_LARGE',
          message: 'File size exceeds 500MB limit'
        })
      }
      return res.status(400).json({
        success: false,
        error: 'UPLOAD_ERROR',
        message: err.message
      })
    }
    next()
  })
}, async (req, res) => {
  let sandbox = null
  try {
    const { instanceId } = req.params
    const file = req.file

    if (!file) {
      return res.status(400).json({
        success: false,
        error: 'NO_FILE',
        message: 'No file provided'
      })
    }

    // Permission check: query instance, ensure caller is admin, owner, or
    // an active member when the instance owner is a group.
    const { data: instance, error: dbError } = await supabaseAdmin
      .from('agent_instances')
      .select('id, principal_id, status, sandbox_id')
      .eq('id', instanceId)
      .single()

    if (dbError || !instance) {
      return res.status(404).json({
        success: false,
        error: 'INSTANCE_NOT_FOUND',
        message: 'Instance not found or access denied'
      })
    }

    const memberships = await getActiveGroupMemberships(req.user.id)
    const allowed = canAccessInstanceRecord(
      instance,
      req.user.id,
      memberships,
      req.userProfile
    )
    if (!allowed) {
      return res.status(404).json({
        success: false,
        error: 'INSTANCE_NOT_FOUND',
        message: 'Instance not found or access denied'
      })
    }

    if (instance.status !== 'running') {
      return res.status(409).json({
        success: false,
        error: 'INSTANCE_NOT_RUNNING',
        message: 'Instance is not running'
      })
    }

    if (!instance.sandbox_id) {
      return res.status(409).json({
        success: false,
        error: 'SANDBOX_NOT_READY',
        message: 'Instance sandbox is not ready'
      })
    }

    // Determine target directory based on targetUser field
    const targetUser = req.body?.targetUser || null
    const uploadDir = resolveUploadDir(targetUser)

    // Sanitize filename
    const sanitizedFilename = sanitizeFilename(file.originalname)
    const targetPath = uploadDir + sanitizedFilename

    // Connect to sandbox and write file
    const fileUser = (targetUser && VALID_USERNAME_RE.test(String(targetUser).trim())) ? String(targetUser).trim() : 'root'
    sandbox = await Sandbox.connect(instance.sandbox_id)
    await sandbox.files.write(targetPath, file.buffer, { user: fileUser })

    return res.json({
      success: true,
      data: {
        path: targetPath,
        size: file.size
      }
    })
  } catch (err) {
    console.error('File upload error:', err)
    return res.status(500).json({
      success: false,
      error: 'UPLOAD_FAILED',
      message: err.message || 'Failed to upload file to sandbox'
    })
  } finally {
    if (sandbox) {
      try {
        await sandbox.close()
      } catch {
        // Ignore close errors
      }
    }
  }
})

export function registerTerminalWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (request, socket, head) => {
    let url
    try {
      url = new URL(request.url || '/', 'http://localhost')
    } catch {
      return rejectUpgrade(socket, 400, 'Bad Request')
    }

    const match = url.pathname.match(/^\/api\/instances\/([^/]+)\/terminal\/ws$/)
    if (!match) return rejectUpgrade(socket, 404, 'Not Found')
    if (!isAllowedUpgradeOrigin(request)) return rejectUpgrade(socket, 403, 'Forbidden')

    const instanceId = decodeURIComponent(match[1])
    const sessionId = url.searchParams.get('sessionId')
    if (!sessionId) return rejectUpgrade(socket, 401, 'Unauthorized')

    wss.handleUpgrade(request, socket, head, ws => {
      wss.emit('connection', ws, request)
      attachTerminalWebSocket({ ws, instanceId, sessionId })
    })
  })
}

export default router
