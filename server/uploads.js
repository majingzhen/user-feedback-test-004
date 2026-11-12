import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { MEDIA_DIR } from './config.js'
import * as store from './store.js'
import * as media from './media.js'
import { decodeSubtitle, parseSubtitle } from './subtitles.js'
import { HttpError, sendJson, readJson, saveStreamToFile } from './http-utils.js'

const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm', 'flv', 'wmv', 'ts', 'mpeg', 'mpg', '3gp', 'm2ts', 'ogv'])
const SUB_EXT = new Set(['srt', 'ass', 'ssa', 'vtt', 'txt'])
const MAX_SUBTITLE_BYTES = 20 * 1024 * 1024
const MAX_OFFSET = 24 * 60 * 60 * 1000

const extOf = (name) => {
  const parts = String(name || '').split('.')
  return parts.length > 1 ? parts.pop().toLowerCase() : ''
}
const randomTag = () => crypto.randomUUID().slice(0, 10)
const round = (n) => (Number.isFinite(n) ? Math.round(n) : 0)

export function cleanupMedia(ctx, includeFrames = false) {
  const keep = new Set([
    ctx.workspace.video?.file,
    ctx.workspace.video?.preview?.file,
    ctx.workspace.subtitle?.file,
    ctx.previewJob?.outName,
  ].filter(Boolean))

  try {
    for (const name of fs.readdirSync(MEDIA_DIR)) {
      const matches = name.startsWith('video-')
        || name.startsWith('subtitle-')
        || name.startsWith('preview-')
        || (includeFrames && (name.startsWith('frame-') || name.startsWith('upload-') || name.startsWith('export-') || name.startsWith('render-')))
      if (!matches || keep.has(name)) continue
      try { fs.unlinkSync(path.join(MEDIA_DIR, name)) } catch { /* 可能正被播放器占用 */ }
    }
  } catch { /* 目录不存在时忽略 */ }
}

export function stopPreviewJob(ctx) {
  const job = ctx.previewJob
  if (!job) return
  job.cancelled = true
  ctx.previewJob = null
  media.killProcess(job.child)
}

export function ensurePreviewBuild(ctx, retry = false, force = false) {
  const video = ctx.workspace.video
  if (!video) return
  if (force) video.preview.forced = true
  const wantsProxy = !video.playable || video.preview.forced
  if (!wantsProxy) {
    if (video.preview.status !== 'none') {
      video.preview = { status: 'none', progress: 0, message: '', forced: false }
      store.saveWorkspace(ctx.workspace)
    }
    return
  }

  if (video.preview.status === 'ready' && video.preview.file) return
  if (ctx.previewJob) return
  if (video.preview.status === 'error' && !retry) return

  if (!media.toolStatus.ffmpeg.ok) {
    video.preview = { status: 'error', progress: 0, message: media.toolStatus.ffmpeg.message || 'ffmpeg 不可用', forced: true }
    store.saveWorkspace(ctx.workspace)
    return
  }

  const job = {
    videoFile: video.file,
    outName: `preview-${Date.now()}-${randomTag()}.mp4`,
    child: null,
    cancelled: false,
    lastSave: 0,
    forced: Boolean(video.preview.forced),
  }
  ctx.previewJob = job
  video.preview = { status: 'pending', progress: 0, message: '', forced: job.forced }
  store.saveWorkspace(ctx.workspace)

  const videoPath = store.mediaPath(job.videoFile)
  const outPath = store.mediaPath(job.outName)
  const { child, done } = media.startPreviewBuild(videoPath, outPath, video.durationMs, (progress) => {
    if (ctx.previewJob !== job) return
    const current = ctx.workspace.video
    if (!current || current.file !== job.videoFile) return
    current.preview.status = 'pending'
    current.preview.progress = round(progress.percent)
    const now = Date.now()
    if (now - job.lastSave > 2000) {
      job.lastSave = now
      store.saveWorkspace(ctx.workspace)
    }
  })
  job.child = child

  done.then(async (result) => {
    if (ctx.previewJob === job) ctx.previewJob = null
    const current = ctx.workspace.video
    const isCurrent = current && current.file === job.videoFile

    if (job.cancelled) {
      fsp.rm(outPath, { force: true }).catch(() => {})
      return
    }

    if (result.code === 0 && fs.existsSync(outPath)) {
      if (isCurrent) {
        current.preview = { status: 'ready', progress: 100, message: '', file: job.outName, forced: job.forced }
        await store.saveWorkspace(ctx.workspace)
        cleanupMedia(ctx)
      } else {
        fsp.rm(outPath, { force: true }).catch(() => {})
      }
      return
    }

    fsp.rm(outPath, { force: true }).catch(() => {})
    if (isCurrent) {
      const message = (result.stderr || '预览代理生成失败').trim().split('\n').slice(-4).join(' ')
      current.preview = { status: 'error', progress: 0, message: message.slice(0, 500), forced: job.forced }
      await store.saveWorkspace(ctx.workspace)
    }
  }).catch((err) => {
    if (ctx.previewJob === job) ctx.previewJob = null
    const current = ctx.workspace.video
    if (current && current.file === job.videoFile) {
      current.preview = { status: 'error', progress: 0, message: String(err.message || err).slice(0, 500), forced: job.forced }
      store.saveWorkspace(ctx.workspace)
    }
    fsp.rm(outPath, { force: true }).catch(() => {})
  })
}

export async function handleVideoUpload(req, res, url, ctx) {
  if (ctx.activeExportId) throw new HttpError(409, '导出正在进行，完成后再替换视频')
  const name = url.searchParams.get('name') || ''
  const ext = extOf(name)
  if (!VIDEO_EXT.has(ext)) throw new HttpError(400, '不支持的视频格式，请换 MP4 / MOV / MKV / WEBM 等常见格式')
  if (!media.toolStatus.ffprobe.ok) throw new HttpError(503, media.toolStatus.ffprobe.message || 'ffprobe 不可用')

  const tempName = `upload-${randomTag()}.${ext}`
  const tempPath = store.mediaPath(tempName)

  try {
    await saveStreamToFile(req, tempPath)
    const stat = await fsp.stat(tempPath)
    if (!stat.size) throw new HttpError(400, '视频文件是空的')

    const meta = await media.probeVideo(tempPath, ext)
    stopPreviewJob(ctx)

    const finalName = `video-${Date.now()}-${randomTag()}.${ext}`
    await fsp.rename(tempPath, store.mediaPath(finalName))

    const video = {
      file: finalName,
      originalName: store.safeOriginalName(name, 'video'),
      ext,
      width: meta.width,
      height: meta.height,
      durationMs: meta.durationMs,
      codec: meta.codec,
      format: meta.format,
      audioCodec: meta.audioCodec,
      playable: meta.playable,
      preview: {
        status: meta.playable ? 'none' : 'pending',
        progress: 0,
        message: meta.playable ? '' : '浏览器不支持这个编码，正在生成预览代理',
      },
    }

    ctx.workspace.video = video
    if (ctx.workspace.ui.lastTime > meta.durationMs / 1000) {
      ctx.workspace.ui.lastTime = meta.durationMs / 1000
    }
    await store.saveWorkspace(ctx.workspace)
    cleanupMedia(ctx)
    sendJson(res, 200, { workspace: ctx.workspace })

    if (!meta.playable) setImmediate(() => ensurePreviewBuild(ctx))
  } catch (err) {
    await fsp.rm(tempPath, { force: true }).catch(() => {})
    if (err instanceof HttpError) throw err
    throw new HttpError(400, `视频读取失败：${err.message}`)
  }
}

export async function handleSubtitleUpload(req, res, url, ctx) {
  if (ctx.activeExportId) throw new HttpError(409, '导出正在进行，完成后再替换字幕')
  const name = url.searchParams.get('name') || ''
  const ext = extOf(name)
  if (!SUB_EXT.has(ext)) throw new HttpError(400, '不支持的字幕格式，请使用 SRT / ASS / VTT')

  const tempName = `upload-${randomTag()}.${ext}`
  const tempPath = store.mediaPath(tempName)

  try {
    await saveStreamToFile(req, tempPath)
    const stat = await fsp.stat(tempPath)
    if (!stat.size) throw new HttpError(400, '字幕文件是空的')
    if (stat.size > MAX_SUBTITLE_BYTES) throw new HttpError(413, '字幕文件太大（超过 20MB）')

    const buffer = await fsp.readFile(tempPath)
    const { text, encoding } = decodeSubtitle(buffer)
    const parsed = parseSubtitle(text, name)
    if (!parsed.cues.length) throw new HttpError(400, '没有从这个文件里解析出字幕内容')

    const hash = crypto.createHash('sha1').update(buffer).digest('hex')
    const sameFile = ctx.workspace.subtitle?.hash === hash && ctx.workspace.cues.length > 0

    if (sameFile) {
      await fsp.rm(tempPath, { force: true })
      ctx.workspace.subtitle = {
        ...ctx.workspace.subtitle,
        originalName: store.safeOriginalName(name, 'subtitle'),
        format: parsed.format,
        encoding,
        cueCount: ctx.workspace.cues.length,
      }
      await store.saveWorkspace(ctx.workspace)
      sendJson(res, 200, { workspace: ctx.workspace })
      return
    }

    const finalName = `subtitle-${Date.now()}-${randomTag()}.${ext}`
    await fsp.rename(tempPath, store.mediaPath(finalName))

    ctx.workspace.subtitle = {
      file: finalName,
      originalName: store.safeOriginalName(name, 'subtitle'),
      format: parsed.format,
      encoding,
      hash,
      cueCount: parsed.cues.length,
    }
    ctx.workspace.cues = parsed.cues
    ctx.workspace.offsetMs = 0
    await store.saveWorkspace(ctx.workspace)
    cleanupMedia(ctx)
    sendJson(res, 200, { workspace: ctx.workspace })
  } catch (err) {
    await fsp.rm(tempPath, { force: true }).catch(() => {})
    if (err instanceof HttpError) throw err
    throw new HttpError(400, `字幕读取失败：${err.message}`)
  }
}

export async function handleStateUpdate(req, res, ctx) {
  const body = await readJson(req, 2 * 1024 * 1024)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '状态格式不正确')

  if (body.style && typeof body.style === 'object' && !Array.isArray(body.style)) {
    const patch = store.sanitizeStyle(body.style)
    ctx.workspace.style = { ...ctx.workspace.style, ...patch }
  }

  if (typeof body.offsetMs === 'number' && Number.isFinite(body.offsetMs)) {
    ctx.workspace.offsetMs = Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, Math.round(body.offsetMs)))
  }

  if (Array.isArray(body.cues)) {
    const cues = store.sanitizeCues(body.cues)
    if (cues) ctx.workspace.cues = cues
  }

  if (body.ui && typeof body.ui === 'object' && typeof body.ui.lastTime === 'number' && Number.isFinite(body.ui.lastTime)) {
    const max = ctx.workspace.video ? Math.max(0, ctx.workspace.video.durationMs / 1000) : 24 * 3600
    ctx.workspace.ui.lastTime = Math.max(0, Math.min(body.ui.lastTime, max))
  }

  await store.saveWorkspace(ctx.workspace)
  sendJson(res, 200, {
    ok: true,
    updatedAt: ctx.workspace.updatedAt,
    cueCount: ctx.workspace.cues.length,
    offsetMs: ctx.workspace.offsetMs,
  })
}
