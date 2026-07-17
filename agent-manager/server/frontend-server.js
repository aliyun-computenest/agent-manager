import fs from 'fs'
import http from 'http'
import net from 'net'
import path from 'path'

const DIST = process.env.FRONTEND_DIST || '/app/dist'
const PORT = Number(process.env.FRONTEND_PORT || 8080)
const BACKEND_HOST = process.env.BACKEND_HOST || '127.0.0.1'
const BACKEND_PORT = Number(process.env.BACKEND_PORT || 3001)
const DIST_ROOT = path.resolve(DIST)

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

function proxyHttp(req, res) {
  const proxy = http.request({
    hostname: BACKEND_HOST,
    port: BACKEND_PORT,
    path: req.url,
    method: req.method,
    headers: req.headers
  }, proxyRes => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers)
    proxyRes.pipe(res)
  })

  proxy.on('error', () => {
    res.writeHead(502)
    res.end('Backend unavailable')
  })
  req.pipe(proxy)
}

function serveStatic(req, res) {
  const requestPath = (req.url || '/').split('?')[0] || '/'
  let decodedPath
  try {
    decodedPath = decodeURIComponent(requestPath)
  } catch {
    res.writeHead(400)
    res.end('Bad Request')
    return
  }

  if (decodedPath.includes('\0')) {
    res.writeHead(400)
    res.end('Bad Request')
    return
  }

  const relativePath = decodedPath === '/'
    ? 'index.html'
    : `.${decodedPath.startsWith('/') ? decodedPath : `/${decodedPath}`}`
  let filePath = path.resolve(DIST_ROOT, relativePath)

  if (filePath !== DIST_ROOT && !filePath.startsWith(`${DIST_ROOT}${path.sep}`)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST_ROOT, 'index.html')
  }

  const ext = path.extname(filePath)
  const contentType = MIME_TYPES[ext] || 'application/octet-stream'

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404)
      res.end('Not Found')
      return
    }
    res.writeHead(200, { 'Content-Type': contentType })
    res.end(data)
  })
}

const server = http.createServer((req, res) => {
  if ((req.url || '').startsWith('/api')) {
    proxyHttp(req, res)
    return
  }

  serveStatic(req, res)
})

server.on('upgrade', (req, socket, head) => {
  if (!(req.url || '').startsWith('/api')) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }

  const backend = net.connect(BACKEND_PORT, BACKEND_HOST, () => {
    backend.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`)
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      backend.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`)
    }
    backend.write('\r\n')
    if (head?.length) backend.write(head)
    backend.pipe(socket)
    socket.pipe(backend)
  })

  backend.on('error', () => {
    if (!socket.destroyed) {
      socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
      socket.destroy()
    }
  })

  socket.on('error', () => backend.destroy())
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Frontend serving on http://0.0.0.0:${PORT}`)
})
