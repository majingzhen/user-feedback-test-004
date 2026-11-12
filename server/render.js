import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { MEDIA_DIR, EXPORTS_DIR } from './config.js'
import * as store from './store.js'
import * as media from './media.js'
import { buildAss } from './subtitles.js'
import { HttpError, sendJson, readJson, streamFile } from './http-utils.js'

const clamp = (v, min, max) => Math.min(max, Math.max(min, v))
const uniqueTag = () => crypto.randomUUID().slice(0, 12)

function frameAssName() {
  return `frame-${uniqueTag()}.ass`
}
function frameImageName() {
  return `frame-${uniqueTag()}.jpg`
}

export async function handleFrame(req, res, url, ctx) {
  if (!media.toolStatus.ffmpeg.ok || !media.toolStatus.ffmpeg.libass) {
    throw new HttpError(503, 'ffmpeg 或 libass 不可用，无法渲染校验帧')
  }
  const video = ctx.workspace.video
  if (!video) throw new HttpError(400, '还没有视频')

  const rawTime = Number(url.searchParams.get('t'))
  if (!Number.isFinite(rawTime) || rawTime < 0) throw new HttpError(400, '时间参数不正确')
  const duration = video.durationMs
  const timeMs = duration > 0 ? clamp(rawTime * 1000, 0, Math.max(0, duration - 30)) : rawTime * 1000

  const assName = frameAssName()
  const imageName = frameImageName()
  const assPath = path.join(MEDIA_DIR, assName)
  const imagePath = path.join(MEDIA_DIR, imageName)

  await fsp.writeFile(assPath, buildAss({
    style: ctx.workspace.style,
    cues: ctx.workspace.cues,
    width: video.width || 1920,
    height: video.height || 1080,
    shiftMs: -timeMs,
  }), 'utf8')

  let finished = false
  let child = null
  const cleanup = () => {
    fsp.rm(assPath, { force: true }).catch(() => {})
    fsp.rm(imagePath, { force: true }).catch(() => {})
  }

  try {
    const started = media.startFrameRender(
      video.file,
      assName,
      imageName,
      timeMs,
      duration,
      (spawned) => {
        child = spawned
        req.on('close', () => {
          if (finished) return
          finished = true
          media.killProcess(spawned)
          cleanup()
        })
      },
      MEDIA_DIR,
    )
    child = started.child

    const result = await started.done
    if (finished || res.writableEnded || res.destroyed) return
    if (result.code !== 0 || !fs.existsSync(imagePath)) {
      throw new HttpError(500, `校验帧渲染失败：${(result.stderr || 'ffmpeg 返回错误').trim().slice(-500)}`)
    }

    const image = await fsp.readFile(imagePath)
    if (finished || res.writableEnded || res.destroyed) return
    finished = true
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': image.length,
      'Cache-Control': 'no-store',
    })
    res.end(image)
  } finally {
    if (!finished) {
      finished = true
      if (child) media.killProcess(child)
    }
    cleanup()
  }
}

function publicJob(job) {
  const copy = { ...job }
  delete copy._child
  delete copy.tempName
  return copy
}

function formatStamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function pickOutputName() {
  const base = `hardsub-${formatStamp()}`
  let name = `${base}.mp4`
  let index = 2
  while (fs.existsSync(store.exportPath(name))) {
    name = `${base}-${index}.mp4`
    index++
  }
  return name
}

function pruneJobs(ctx) {
  if (ctx.exportJobs.size <= 30) return
  for (const [key, job] of ctx.exportJobs) {
    if (ctx.exportJobs.size <= 20) break
    if (key !== ctx.activeExportId && job.status !== 'running') ctx.exportJobs.delete(key)
  }
}

export async function handleExportStart(req, res, ctx) {
  if (!media.toolStatus.ffmpeg.ok || !media.toolStatus.ffmpeg.libass) {
    throw new HttpError(503, 'ffmpeg 或 libass 不可用，无法导出')
  }
  const ws = ctx.workspace
  if (!ws.video) throw new HttpError(400, '还没有视频')
  if (!ws.cues.length) throw new HttpError(400, '还没有字幕')

  if (ctx.activeExportId) {
    const running = ctx.exportJobs.get(ctx.activeExportId)
    throw new HttpError(409, '已经有一个导出任务在进行', running ? { job: publicJob(running) } : null)
  }

  let body = {}
  try { body = await readJson(req, 64 * 1024) } catch (err) {
    if (err.status === 413) throw err
    body = {}
  }
  const quality = ['high', 'standard', 'compact'].includes(body.quality) ? body.quality : 'standard'

  const outputName = pickOutputName()
  const assName = 'render-export.ass'
  const assPath = path.join(MEDIA_DIR, assName)
  await fsp.writeFile(assPath, buildAss({
    style: ws.style,
    cues: ws.cues,
    width: ws.video.width || 1920,
    height: ws.video.height || 1080,
  }), 'utf8')

  const job = {
    id: uniqueTag(),
    status: 'running',
    quality,
    percent: 0,
    timeMs: 0,
    speed: '',
    fps: '',
    outputName,
    outputUrl: '',
    size: 0,
    error: '',
    cancelRequested: false,
    createdAt: new Date().toISOString(),
    endedAt: '',
    tempName: '',
    _child: null,
  }
  job.tempName = `export-${job.id}.mp4`

  ctx.exportJobs.set(job.id, job)
  ctx.activeExportId = job.id

  const tempPath = store.mediaPath(job.tempName)
  const { child, done } = media.startExport(
    ws.video.file,
    assName,
    tempPath,
    ws.video,
    quality,
    (progress) => {
      if (progress.percent !== null) job.percent = Math.round(progress.percent * 10) / 10
      if (progress.timeMs !== null) job.timeMs = Math.round(progress.timeMs)
      if (progress.speed) job.speed = progress.speed
      if (progress.fps) job.fps = progress.fps
    },
    MEDIA_DIR,
  )
  job._child = child

  done.then(async (result) => {
    job._child = null
    job.endedAt = new Date().toISOString()
    if (ctx.activeExportId === job.id) ctx.activeExportId = null

    const outputPath = store.exportPath(job.outputName)
    const finished = result.code === 0 && fs.existsSync(tempPath)

    if (job.cancelRequested) {
      job.status = 'cancelled'
      await fsp.rm(tempPath, { force: true }).catch(() => {})
    } else if (!finished) {
      job.status = 'failed'
      job.error = (result.stderr || 'ffmpeg 导出失败').trim().slice(-1200)
      await fsp.rm(tempPath, { force: true }).catch(() => {})
    } else {
      try {
        await fsp.rename(tempPath, outputPath)
        job.status = 'success'
        job.percent = 100
        job.outputUrl = `/api/exports/${encodeURIComponent(job.outputName)}`
        try { job.size = fs.statSync(outputPath).size } catch { job.size = 0 }
      } catch (err) {
        job.status = 'failed'
        job.error = `导出文件保存失败：${err.message}`
        await fsp.rm(tempPath, { force: true }).catch(() => {})
        await fsp.rm(outputPath, { force: true }).catch(() => {})
      }
    }

    await fsp.rm(assPath, { force: true }).catch(() => {})
    pruneJobs(ctx)
  })

  sendJson(res, 200, { job: publicJob(job) })
}

export function handleExportStatus(req, res, url, ctx, id) {
  const job = ctx.exportJobs.get(id)
  if (!job) throw new HttpError(404, '导出任务不存在或服务已重启')
  sendJson(res, 200, { job: publicJob(job) })
}

export async function handleExportCancel(req, res, ctx, id) {
  const job = ctx.exportJobs.get(id)
  if (!job) throw new HttpError(404, '导出任务不存在')
  if (job.status === 'running') {
    job.cancelRequested = true
    media.killProcess(job._child)
  }
  sendJson(res, 200, { job: publicJob(job) })
}

export function handleExportsList(req, res) {
  sendJson(res, 200, { exports: store.listExports() })
}

export function handleExportDownload(req, res, url) {
  const raw = url.pathname.slice('/api/exports/'.length)
  let name
  try { name = decodeURIComponent(raw) } catch { throw new HttpError(400, '文件名不合法') }
  if (!name || path.basename(name) !== name || !name.toLowerCase().endsWith('.mp4')) {
    throw new HttpError(404, '导出文件不存在')
  }
  const file = store.exportPath(name)
  if (!fs.existsSync(file)) throw new HttpError(404, '导出文件不存在')
  streamFile(req, res, file, { contentType: 'video/mp4', downloadName: name })
}

export function handleReveal(req, res) {
  if (!media.revealFolder(EXPORTS_DIR)) throw new HttpError(500, '无法打开导出目录')
  sendJson(res, 200, { ok: true })
}

export function handleHealth(req, res) {
  sendJson(res, 200, { ok: true, tools: media.toolStatus })
}
