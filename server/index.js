import http from 'node:http'
import path from 'node:path'
import { HOST, PORT, PUBLIC_DIR } from './config.js'
import * as store from './store.js'
import * as media from './media.js'
import { ctx } from './context.js'
import { HttpError, sendJson, sendError, serveStatic, streamFile } from './http-utils.js'
import {
  handleVideoUpload,
  handleSubtitleUpload,
  handleStateUpdate,
  cleanupMedia,
  ensurePreviewBuild,
  stopPreviewJob,
} from './uploads.js'
import {
  handleFrame,
  handleExportStart,
  handleExportStatus,
  handleExportCancel,
  handleExportsList,
  handleExportDownload,
  handleReveal,
  handleHealth,
} from './render.js'

function videoContentType(file) {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.webm') return 'video/webm'
  if (ext === '.mov') return 'video/quicktime'
  if (ext === '.mkv') return 'video/x-matroska'
  if (ext === '.ogv') return 'video/ogg'
  return 'video/mp4'
}

function workspacePayload() {
  return { workspace: ctx.workspace, defaults: store.DEFAULT_STYLE, tools: media.toolStatus }
}

function serveMedia(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '只支持 GET')
  if (url.pathname === '/media/video') {
    if (!ctx.workspace.video) throw new HttpError(404, '还没有视频')
    const file = store.mediaPath(ctx.workspace.video.file)
    streamFile(req, res, file, { contentType: videoContentType(ctx.workspace.video.file) })
    return
  }
  if (url.pathname === '/media/preview') {
    const preview = ctx.workspace.video?.preview
    if (!preview || preview.status !== 'ready' || !preview.file) throw new HttpError(404, '预览尚未就绪')
    streamFile(req, res, store.mediaPath(preview.file), { contentType: 'video/mp4' })
    return
  }
  throw new HttpError(404, '媒体不存在')
}

async function apiRoute(req, res, url) {
  const method = req.method
  const pathname = url.pathname

  if (pathname === '/api/state') {
    if (method === 'GET') {
      ensurePreviewBuild(ctx)
      sendJson(res, 200, workspacePayload())
      return
    }
    if (method === 'PUT') {
      await handleStateUpdate(req, res, ctx)
      return
    }
    throw new HttpError(405, '请求方法不支持')
  }

  if (pathname === '/api/video' && method === 'POST') {
    await handleVideoUpload(req, res, url, ctx)
    return
  }

  if (pathname === '/api/subtitle' && method === 'POST') {
    await handleSubtitleUpload(req, res, url, ctx)
    return
  }

  if (pathname === '/api/frame' && method === 'GET') {
    await handleFrame(req, res, url, ctx)
    return
  }

  if (pathname === '/api/preview/build' && method === 'POST') {
    ensurePreviewBuild(ctx, true, true)
    sendJson(res, 200, { preview: ctx.workspace.video?.preview || null })
    return
  }

  if (pathname === '/api/exports') {
    if (method === 'GET') {
      handleExportsList(req, res)
      return
    }
    if (method === 'POST') {
      await handleExportStart(req, res, ctx)
      return
    }
    throw new HttpError(405, '请求方法不支持')
  }

  if (pathname.startsWith('/api/exports/') && method === 'GET') {
    handleExportDownload(req, res, url)
    return
  }

  const statusMatch = /^\/api\/export\/([A-Za-z0-9_-]+)$/.exec(pathname)
  if (statusMatch && method === 'GET') {
    handleExportStatus(req, res, url, ctx, statusMatch[1])
    return
  }

  const cancelMatch = /^\/api\/export\/([A-Za-z0-9_-]+)\/cancel$/.exec(pathname)
  if (cancelMatch && method === 'POST') {
    await handleExportCancel(req, res, ctx, cancelMatch[1])
    return
  }

  if (pathname === '/api/reveal' && method === 'POST') {
    handleReveal(req, res)
    return
  }

  if (pathname === '/api/health' && method === 'GET') {
    handleHealth(req, res)
    return
  }

  throw new HttpError(404, '接口不存在')
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost')

  if (url.pathname.startsWith('/api/')) {
    await apiRoute(req, res, url)
    return
  }

  if (url.pathname === '/media/video' || url.pathname === '/media/preview') {
    serveMedia(req, res, url)
    return
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, PUBLIC_DIR, url.pathname)
    return
  }

  throw new HttpError(405, '请求方法不支持')
}

const server = http.createServer((req, res) => {
  Promise.resolve(route(req, res)).catch((err) => {
    const status = Number(err?.status) || 500
    if (status >= 500 && status !== 503) console.error('[server]', err)
    if (!res.headersSent && !res.writableEnded) {
      sendError(res, status, err?.message || '服务器内部错误', err?.extra)
    } else if (!res.writableEnded) {
      res.destroy()
    }
  })
})

server.requestTimeout = 0
server.headersTimeout = 60000
server.timeout = 0

async function main() {
  store.ensureDirs()
  await media.detectTools()
  cleanupMedia(ctx, true)
  ensurePreviewBuild(ctx, true)

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`端口 ${PORT} 已被占用，可设置环境变量 PORT 换一个端口`)
    } else {
      console.error(err)
    }
    process.exit(1)
  })

  server.listen(PORT, HOST, () => {
    console.log(`字幕烧录已启动: http://${HOST}:${PORT}`)
    if (!media.toolStatus.ffmpeg.ok) console.warn(`[ffmpeg] ${media.toolStatus.ffmpeg.message}`)
    else if (!media.toolStatus.ffmpeg.libass) console.warn(`[ffmpeg] ${media.toolStatus.ffmpeg.message}`)
    if (!media.toolStatus.ffprobe.ok) console.warn(`[ffprobe] ${media.toolStatus.ffprobe.message}`)
  })
}

async function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在收尾…`)
  stopPreviewJob(ctx)
  if (ctx.activeExportId) {
    const job = ctx.exportJobs.get(ctx.activeExportId)
    if (job) media.killProcess(job._child)
  }
  await store.saveWorkspace(ctx.workspace).catch(() => {})
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
