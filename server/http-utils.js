import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'

export class HttpError extends Error {
  constructor(status, message, extra = null) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

export function sendJson(res, status, data) {
  if (res.headersSent || res.writableEnded) return
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

export function sendError(res, status, message, extra = null) {
  sendJson(res, status, { error: message, ...(extra || {}) })
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new HttpError(413, '请求内容过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export async function readJson(req, limit = 2 * 1024 * 1024) {
  const buffer = await readBody(req, limit)
  if (!buffer.length) return {}
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new HttpError(400, '请求内容不是合法的 JSON')
  }
}

export async function saveStreamToFile(req, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  await pipeline(req, createWriteStream(dest))
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

export function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
}

export function serveStatic(req, res, baseDir, pathname) {
  let decoded
  try { decoded = decodeURIComponent(pathname) } catch { throw new HttpError(400, '路径不合法') }
  const relative = decoded === '/' || decoded === '' ? 'index.html' : decoded.replace(/^\/+/, '')
  const file = path.resolve(baseDir, relative)
  if (!file.startsWith(path.resolve(baseDir)) || relative.includes('..')) throw new HttpError(404, '页面不存在')

  let stat
  try { stat = fs.statSync(file) } catch { throw new HttpError(404, '页面不存在') }
  if (!stat.isFile()) throw new HttpError(404, '页面不存在')

  res.writeHead(200, {
    'Content-Type': mimeFor(file),
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  })
  if (req.method === 'HEAD') return res.end()
  fs.createReadStream(file).pipe(res)
}

function parseRange(size, header) {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  let start = match[1] === '' ? null : Number(match[1])
  let end = match[2] === '' ? null : Number(match[2])
  if (start === null && end === null) return null
  if (start === null) {
    start = Math.max(0, size - end)
    end = size - 1
  } else {
    if (end === null || end >= size) end = size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return { invalid: true }
  return { start, end }
}

export function streamFile(req, res, file, options = {}) {
  let stat
  try { stat = fs.statSync(file) } catch { throw new HttpError(404, '文件不存在') }
  if (!stat.isFile()) throw new HttpError(404, '文件不存在')

  const range = parseRange(stat.size, req.headers.range)
  if (range?.invalid) {
    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
    return res.end()
  }

  const headers = {
    'Content-Type': options.contentType || mimeFor(file),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  }
  if (options.downloadName) {
    headers['Content-Disposition'] = `attachment; filename="${options.downloadName.replace(/"/g, '')}"`
  }

  if (range) {
    headers['Content-Length'] = range.end - range.start + 1
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`
    res.writeHead(206, headers)
    if (req.method === 'HEAD') return res.end()
    fs.createReadStream(file, { start: range.start, end: range.end }).pipe(res)
    return
  }

  headers['Content-Length'] = stat.size
  res.writeHead(200, headers)
  if (req.method === 'HEAD') return res.end()
  fs.createReadStream(file).pipe(res)
}
