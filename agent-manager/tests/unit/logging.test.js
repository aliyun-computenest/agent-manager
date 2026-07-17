import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { EventEmitter } from 'events'
import { afterEach, describe, it } from 'vitest'
import assert from 'node:assert/strict'

import { createAccessLoggerMiddleware } from '../../server/middleware/logger.js'
import {
  createStructuredLogger,
  installConsoleLogger,
  redactSensitiveData,
  restoreConsoleLogger,
  runWithLogContext,
  sanitizeBodyForLog
} from '../../server/utils/logger.js'

let tempDirs = []

async function makeTempLogDir() {
  const dir = await mkdtemp(join(tmpdir(), 'agent-manager-logs-'))
  tempDirs.push(dir)
  return dir
}

async function readJsonLines(filePath) {
  const content = await readFile(filePath, 'utf8')
  return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

async function readJsonLinesIfExists(filePath) {
  try {
    return await readJsonLines(filePath)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function queryMockLogChain(logDir, requestId) {
  const files = {
    access: 'access.log',
    info: 'info.log',
    warn: 'warn.log',
    error: 'error.log'
  }
  const entries = await Promise.all(Object.entries(files).map(async ([type, file]) => {
    const records = await readJsonLinesIfExists(join(logDir, file))
    return records
      .filter(record => record.requestId === requestId)
      .map(record => ({ type, ...record }))
  }))

  return entries.flat().sort((a, b) => {
    const aTime = a.timestamp ? Date.parse(a.timestamp) : (a.time ?? 0)
    const bTime = b.timestamp ? Date.parse(b.timestamp) : (b.time ?? 0)
    return aTime - bTime
  })
}

afterEach(async () => {
  restoreConsoleLogger()
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('SLS deployment configuration', () => {
  async function readWorkspaceFile(path) {
    return readFile(new URL(`../../${path}`, import.meta.url), 'utf8')
  }

  it('creates the default log directory in the production image', async () => {
    const dockerfile = await readWorkspaceFile('Dockerfile')

    assert.match(dockerfile, /mkdir -p \/var\/log\/agent-manager/)
  })

  it('wires access logging before body parsing and all registered API routes', async () => {
    const serverIndex = await readWorkspaceFile('server/index.js')
    const routesIndex = await readWorkspaceFile('server/routes/index.js')

    assert.ok(
      serverIndex.indexOf('app.use(loggerMiddleware)') < serverIndex.indexOf("app.use(express.json({ limit: '50mb' }))")
    )
    assert.ok(
      serverIndex.indexOf('app.use(loggerMiddleware)') < serverIndex.indexOf('registerRoutes(app)')
    )

    const mountPoints = [...routesIndex.matchAll(/app\.use\('([^']+)',\s*\w+\)/g)]
      .map(match => match[1])
    assert.ok(mountPoints.length > 0)
    assert.deepEqual([...new Set(mountPoints)], ['/api', '/internal/agent-gateway'])
  })

  for (const templatePath of [
    '../template/platform_template.yaml'
  ]) {
    it(`declares SLS log collection env vars in ${templatePath}`, async () => {
      const template = await readWorkspaceFile(templatePath)

      for (const name of [
        'aliyun_logs_agent-manager-info',
        'aliyun_logs_agent-manager-info_logstore',
        'aliyun_logs_agent-manager-warn',
        'aliyun_logs_agent-manager-warn_logstore',
        'aliyun_logs_agent-manager-error',
        'aliyun_logs_agent-manager-error_logstore',
        'aliyun_logs_agent-manager-access',
        'aliyun_logs_agent-manager-access_logstore'
      ]) {
        assert.match(template, new RegExp(`name: ${name}`))
      }

      assert.match(template, /name: agent-manager-logs/)
      assert.match(template, /mountPath: \/var\/log\/agent-manager/)
    })
  }
})

describe('structured file logger', () => {
  it('writes info, warn, and error records to exact level files', async () => {
    const logDir = await makeTempLogDir()
    const logger = createStructuredLogger({
      logDir,
      module: 'unit-test',
      pretty: false,
      stdout: false
    })

    logger.info('info message', { requestId: 'req-info' })
    logger.warn('warn message', { requestId: 'req-warn' })
    logger.error('error message', { err: new Error('boom'), requestId: 'req-error' })
    logger.fatal('fatal message', { requestId: 'req-fatal' })
    await logger.flush()

    const infoLines = await readJsonLines(join(logDir, 'info.log'))
    const warnLines = await readJsonLines(join(logDir, 'warn.log'))
    const errorLines = await readJsonLines(join(logDir, 'error.log'))

    assert.equal(infoLines.length, 1)
    assert.deepEqual({
      level: infoLines[0].level,
      timeType: typeof infoLines[0].time,
      module: infoLines[0].module,
      msg: infoLines[0].msg,
      requestId: infoLines[0].requestId
    }, {
      level: 30,
      timeType: 'number',
      module: 'unit-test',
      msg: 'info message',
      requestId: 'req-info'
    })

    assert.equal(warnLines.length, 1)
    assert.deepEqual({
      level: warnLines[0].level,
      module: warnLines[0].module,
      msg: warnLines[0].msg,
      requestId: warnLines[0].requestId
    }, {
      level: 40,
      module: 'unit-test',
      msg: 'warn message',
      requestId: 'req-warn'
    })

    assert.equal(errorLines.length, 2)
    assert.deepEqual(errorLines.map(line => line.level), [50, 60])
    assert.deepEqual({
      message: errorLines[0].err.message,
      type: errorLines[0].err.type
    }, {
      message: 'boom',
      type: 'Error'
    })
  })

  it('honors the configured minimum log level', async () => {
    const logDir = await makeTempLogDir()
    const logger = createStructuredLogger({
      logDir,
      module: 'unit-test',
      pretty: false,
      stdout: false,
      level: 'warn'
    })

    logger.info('filtered info message')
    logger.warn('kept warn message')
    logger.error('kept error message')
    await logger.flush()

    await assert.rejects(
      () => readFile(join(logDir, 'info.log'), 'utf8'),
      /ENOENT/
    )

    const warnLines = await readJsonLines(join(logDir, 'warn.log'))
    const errorLines = await readJsonLines(join(logDir, 'error.log'))

    assert.deepEqual(warnLines.map(line => line.msg), ['kept warn message'])
    assert.deepEqual(errorLines.map(line => line.msg), ['kept error message'])
  })

  it('keeps reserved fields stable when metadata uses the same keys', async () => {
    const logDir = await makeTempLogDir()
    const logger = createStructuredLogger({
      logDir,
      module: 'unit-test',
      pretty: false,
      stdout: false
    })

    logger.info('stable message', {
      level: 999,
      time: 'not-a-timestamp',
      pid: 0,
      hostname: 'bad-host',
      module: 'bad-module',
      msg: 'bad message',
      requestId: 'request-id'
    })
    await logger.flush()

    const infoLines = await readJsonLines(join(logDir, 'info.log'))

    assert.equal(infoLines[0].level, 30)
    assert.equal(typeof infoLines[0].time, 'number')
    assert.equal(infoLines[0].pid, process.pid)
    assert.notEqual(infoLines[0].hostname, 'bad-host')
    assert.equal(infoLines[0].module, 'unit-test')
    assert.equal(infoLines[0].msg, 'stable message')
    assert.equal(infoLines[0].requestId, 'request-id')
  })

  it('inherits requestId from the active API log context', async () => {
    const logDir = await makeTempLogDir()
    const logger = createStructuredLogger({
      logDir,
      module: 'unit-test',
      pretty: false,
      stdout: false
    })

    runWithLogContext({ requestId: 'context-request-id' }, () => {
      logger.info('context message')
      logger.info('explicit message', { requestId: 'explicit-request-id' })
    })
    await logger.flush()

    const infoLines = await readJsonLines(join(logDir, 'info.log'))
    assert.equal(infoLines[0].requestId, 'context-request-id')
    assert.equal(infoLines[1].requestId, 'explicit-request-id')
  })

  it('redacts sensitive fields recursively without mutating the source object', () => {
    const source = {
      password: 'short',
      nested: {
        apiKey: 'sk-live-1234567890',
        authorization: 'Bearer secret-token-value'
      },
      safe: 'visible'
    }

    const redacted = redactSensitiveData(source)

    assert.deepEqual(redacted, {
      password: '***',
      nested: {
        apiKey: 'sk-l***7890',
        authorization: 'Bear***alue'
      },
      safe: 'visible'
    })
    assert.equal(source.nested.apiKey, 'sk-live-1234567890')
  })

  it('limits logged bodies to the configured byte budget', () => {
    const body = {
      value: 'x'.repeat(200),
      token: 'token-value-123456'
    }

    const result = sanitizeBodyForLog(body, { maxBytes: 64 })

    assert.equal(result.truncated, true)
    assert.match(result.body, /"value"/)
    assert.ok(result.body.length <= 64)
    assert.equal(result.body.includes('token-value-123456'), false)
  })

  it('does not throw when the log directory is missing', async () => {
    const logger = createStructuredLogger({
      logDir: join(tmpdir(), 'agent-manager-missing-log-dir'),
      module: 'unit-test',
      pretty: false,
      stdout: false,
      createDir: false
    })

    assert.doesNotThrow(() => logger.info('still starts'))
    await logger.flush()
  })
})

describe('access logger middleware', () => {
  function makeReq(overrides = {}) {
    return {
      method: 'POST',
      originalUrl: '/api/instances?debug=true',
      path: '/api/instances',
      body: { name: 'agent', password: 'secret' },
      headers: {
        'user-agent': 'node-test',
        'x-forwarded-for': '10.0.0.1, 10.0.0.2'
      },
      socket: { remoteAddress: '127.0.0.1' },
      user: { id: 'user-123' },
      ...overrides
    }
  }

  function makeRes() {
    const res = new EventEmitter()
    res.statusCode = 200
    res.headers = {}
    res.setHeader = (key, value) => {
      res.headers[key.toLowerCase()] = value
    }
    res.getHeader = key => res.headers[key.toLowerCase()]
    res.write = chunk => {
      res.emit('write', chunk)
      return true
    }
    res.end = chunk => {
      if (chunk !== undefined) res.write(chunk)
      res.emit('finish')
      return res
    }
    return res
  }

  it('skips health access records while keeping request context', () => {
    const records = []
    const appRecords = []
    const consoleLogger = {
      info: (msg, meta) => appRecords.push({ level: 'info', msg, meta }),
      warn: (msg, meta) => appRecords.push({ level: 'warn', msg, meta }),
      error: (msg, meta) => appRecords.push({ level: 'error', msg, meta })
    }
    const middleware = createAccessLoggerMiddleware({
      accessLogger: { access: record => records.push(record) },
      requestIdFactory: () => 'health-request-id'
    })
    const req = makeReq({ method: 'GET', originalUrl: '/api/health', path: '/api/health' })
    const res = makeRes()

    installConsoleLogger(consoleLogger)

    middleware(req, res, () => {
      console.log('health route log')
    })
    res.end(JSON.stringify({ ok: true }))

    assert.deepEqual(records, [])
    assert.equal(req.requestId, 'health-request-id')
    assert.equal(res.getHeader('x-request-id'), 'health-request-id')
    assert.equal(appRecords[0].meta.requestId, 'health-request-id')
  })

  it('writes one access record with request and response context', () => {
    const records = []
    const middleware = createAccessLoggerMiddleware({
      accessLogger: { access: record => records.push(record) },
      now: () => '2026-05-14T12:30:45.123Z',
      requestIdFactory: () => 'request-id-1',
      maxBodyBytes: 256
    })
    const req = makeReq()
    const res = makeRes()
    const responsePayload = JSON.stringify({
      success: true,
      token: 'response-token-123456'
    })

    middleware(req, res, () => {})
    res.statusCode = 201
    res.end(responsePayload)

    assert.equal(res.getHeader('x-request-id'), 'request-id-1')
    assert.equal(records.length, 1)
    assert.equal(records[0].timestamp, '2026-05-14T12:30:45.123Z')
    assert.equal(records[0].requestId, 'request-id-1')
    assert.equal(records[0].method, 'POST')
    assert.equal(records[0].path, '/api/instances?debug=true')
    assert.equal(records[0].statusCode, 201)
    assert.equal(records[0].contentLength, Buffer.byteLength(responsePayload))
    assert.equal(records[0].clientIp, '10.0.0.1')
    assert.equal(records[0].userId, 'user-123')
    assert.equal(records[0].requestBody.password, '***')
    assert.equal(records[0].responseBody.token, 'resp***3456')
    assert.equal(records[0].truncated, false)
  })

  it('propagates the same requestId to async console logs', async () => {
    const accessRecords = []
    const appRecords = []
    const consoleLogger = {
      info: (msg, meta) => appRecords.push({ level: 'info', msg, meta }),
      warn: (msg, meta) => appRecords.push({ level: 'warn', msg, meta }),
      error: (msg, meta) => appRecords.push({ level: 'error', msg, meta })
    }
    const middleware = createAccessLoggerMiddleware({
      accessLogger: { access: record => accessRecords.push(record) },
      requestIdFactory: () => 'generated-request-id'
    })
    const req = makeReq({
      headers: {
        ...makeReq().headers,
        'x-request-id': 'client-request-id'
      }
    })
    const res = makeRes()

    installConsoleLogger(consoleLogger)

    await new Promise(resolve => {
      middleware(req, res, () => {
        setImmediate(() => {
          console.log('route handler log', { step: 'after db call' })
          res.end(JSON.stringify({ success: true }))
          resolve()
        })
      })
    })

    assert.equal(res.getHeader('x-request-id'), 'client-request-id')
    assert.equal(req.requestId, 'client-request-id')
    assert.equal(accessRecords.length, 1)
    assert.equal(accessRecords[0].requestId, 'client-request-id')
    assert.equal(appRecords.length, 1)
    assert.equal(appRecords[0].meta.requestId, 'client-request-id')
  })

  it('isolates requestId context across overlapping requests', async () => {
    const appRecords = []
    const consoleLogger = {
      info: (msg, meta) => appRecords.push({ level: 'info', msg, meta }),
      warn: (msg, meta) => appRecords.push({ level: 'warn', msg, meta }),
      error: (msg, meta) => appRecords.push({ level: 'error', msg, meta })
    }
    const middleware = createAccessLoggerMiddleware({
      accessLogger: { access: () => {} }
    })
    const firstReq = makeReq({
      headers: {
        ...makeReq().headers,
        'x-request-id': 'request-a'
      }
    })
    const secondReq = makeReq({
      headers: {
        ...makeReq().headers,
        'x-request-id': 'request-b'
      }
    })
    const firstRes = makeRes()
    const secondRes = makeRes()

    installConsoleLogger(consoleLogger)

    await Promise.all([
      new Promise(resolve => {
        middleware(firstReq, firstRes, () => {
          setTimeout(() => {
            console.log('first request log')
            firstRes.end(JSON.stringify({ success: true }))
            resolve()
          }, 10)
        })
      }),
      new Promise(resolve => {
        middleware(secondReq, secondRes, () => {
          setImmediate(() => {
            console.log('second request log')
            secondRes.end(JSON.stringify({ success: true }))
            resolve()
          })
        })
      })
    ])

    assert.deepEqual(
      appRecords.map(record => [record.msg, record.meta.requestId]).sort(),
      [
        ['first request log', 'request-a'],
        ['second request log', 'request-b']
      ]
    )
  })

  it('truncates large access bodies', () => {
    const records = []
    const middleware = createAccessLoggerMiddleware({
      accessLogger: { access: record => records.push(record) },
      requestIdFactory: () => 'request-id-2',
      maxBodyBytes: 64
    })
    const req = makeReq({ body: { value: 'x'.repeat(200) } })
    const res = makeRes()

    middleware(req, res, () => {})
    res.end(JSON.stringify({ value: 'y'.repeat(200) }))

    assert.equal(records.length, 1)
    assert.equal(records[0].truncated, true)
    assert.ok(records[0].contentLength > 64)
    assert.ok(typeof records[0].requestBody === 'string')
    assert.ok(typeof records[0].responseBody === 'string')
    assert.ok(records[0].requestBody.length <= 64)
    assert.ok(records[0].responseBody.length <= 64)
  })
})

describe('mock log chain query', () => {
  it('correlates access and app logs by requestId only', async () => {
    const logDir = await makeTempLogDir()

    await writeFile(join(logDir, 'access.log'), [
      JSON.stringify({
        timestamp: '2026-05-18T10:00:00.000Z',
        requestId: 'chain-request-id',
        method: 'POST',
        path: '/api/observability/embed-url',
        statusCode: 200
      })
    ].join('\n') + '\n')
    await writeFile(join(logDir, 'info.log'), [
      JSON.stringify({
        level: 30,
        time: Date.parse('2026-05-18T10:00:00.100Z'),
        module: 'app',
        requestId: 'chain-request-id',
        msg: 'Querying CMS workspaces'
      })
    ].join('\n') + '\n')
    await writeFile(join(logDir, 'warn.log'), [
      JSON.stringify({
        level: 40,
        time: Date.parse('2026-05-18T10:00:00.200Z'),
        module: 'app',
        requestId: null,
        msg: 'Failed to create Umodel. request id: cloud-api-request-id'
      }),
      JSON.stringify({
        level: 40,
        time: Date.parse('2026-05-18T10:00:00.300Z'),
        module: 'app',
        requestId: 'chain-request-id',
        msg: 'Gateway integration ensured'
      })
    ].join('\n') + '\n')

    const chain = await queryMockLogChain(logDir, 'chain-request-id')

    assert.deepEqual(chain.map(record => record.type), ['access', 'info', 'warn'])
    assert.deepEqual(chain.map(record => record.requestId), [
      'chain-request-id',
      'chain-request-id',
      'chain-request-id'
    ])
    assert.equal(chain.some(record => record.msg?.includes('cloud-api-request-id')), false)
  })
})
