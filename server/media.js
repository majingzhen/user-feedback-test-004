import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { FFMPEG_PATH, FFPROBE_PATH } from './config.js'

const execFileAsync = promisify(execFile)
const clamp = (v, min, max) => Math.min(max, Math.max(min, v))

const PLAYABLE_CONTAINERS = new Set(['mp4', 'm4v', 'mov', 'webm'])
const PLAYABLE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av01'])
const PLAYABLE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac'])
const MP4_AUDIO_COPY = new Set(['aac', 'mp3', 'alac'])

export const toolStatus = {
  ffmpeg: { ok: false, version: '', libass: false, message: '' },
  ffprobe: { ok: false, version: '', message: '' },
}

export async function detectTools() {
  try {
    const { stdout } = await execFileAsync(FFMPEG_PATH, ['-hide_banner', '-version'], { timeout: 15000, windowsHide: true })
    const filters = await execFileAsync(FFMPEG_PATH, ['-hide_banner', '-filters'], { timeout: 15000, windowsHide: true })
    toolStatus.ffmpeg.ok = true
    toolStatus.ffmpeg.version = stdout.split('\n')[0].trim()
    toolStatus.ffmpeg.libass = /\bass\s+V->V\b/.test(filters.stdout) || filters.stdout.includes('libass')
    toolStatus.ffmpeg.message = toolStatus.ffmpeg.libass ? '' : '当前 ffmpeg 未编译 libass，无法烧录字幕'
  } catch (err) {
    toolStatus.ffmpeg.ok = false
    toolStatus.ffmpeg.libass = false
    toolStatus.ffmpeg.message = `找不到可用的 ffmpeg：${err.message}`
  }

  try {
    const { stdout } = await execFileAsync(FFPROBE_PATH, ['-hide_banner', '-version'], { timeout: 15000, windowsHide: true })
    toolStatus.ffprobe.ok = true
    toolStatus.ffprobe.version = stdout.split('\n')[0].trim()
  } catch (err) {
    toolStatus.ffprobe.ok = false
    toolStatus.ffprobe.message = `找不到可用的 ffprobe：${err.message}`
  }

  return toolStatus
}

export function probe(file) {
  return new Promise((resolve, reject) => {
    execFile(
      FFPROBE_PATH,
      ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
      { timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message || 'ffprobe 失败').trim()))
        try { resolve(JSON.parse(stdout)) } catch (e) { reject(e) }
      },
    )
  })
}

function rotationOf(stream) {
  const side = Array.isArray(stream.side_data_list)
    ? stream.side_data_list.find((item) => item.rotation !== undefined)
    : null
  const raw = side ? side.rotation : (stream.tags && stream.tags.rotate)
  const value = Number(raw)
  return Number.isFinite(value) ? value : 0
}

export function isBrowserPlayable(meta, ext) {
  return PLAYABLE_CONTAINERS.has(String(ext || '').toLowerCase())
    && PLAYABLE_VIDEO.has(meta.codec)
    && (!meta.audioCodec || PLAYABLE_AUDIO.has(meta.audioCodec))
}

export async function probeVideo(file, ext) {
  const info = await probe(file)
  const video = (info.streams || []).find((stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1)
  if (!video) throw new Error('这个文件里没有检测到视频画面')

  const audio = (info.streams || []).find((stream) => stream.codec_type === 'audio')
  let width = Number(video.width) || 0
  let height = Number(video.height) || 0
  const rotation = rotationOf(video)
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width]

  let duration = Number(info.format?.duration)
  if (!Number.isFinite(duration) || duration <= 0) duration = Number(video.duration) || 0
  const meta = {
    width,
    height,
    durationMs: Math.max(0, Math.round(duration * 1000)),
    codec: String(video.codec_name || ''),
    audioCodec: String(audio?.codec_name || ''),
    format: String(info.format?.format_name || ''),
    rotation,
  }
  meta.playable = isBrowserPlayable(meta, ext)
  return meta
}

function parseProgressBlock(data, durationMs) {
  let timeMs = null
  if (data.out_time_us !== undefined && data.out_time_us !== 'N/A') timeMs = Number(data.out_time_us) / 1000
  else if (data.out_time_ms !== undefined && data.out_time_ms !== 'N/A') timeMs = Number(data.out_time_ms) / 1000
  if (!Number.isFinite(timeMs)) timeMs = null

  let percent = null
  if (timeMs !== null && durationMs > 0) percent = clamp((timeMs / durationMs) * 100, 0, 100)
  return {
    percent,
    timeMs,
    speed: data.speed && data.speed !== 'N/A' ? String(data.speed) : '',
    fps: data.fps && data.fps !== 'N/A' ? String(data.fps) : '',
    done: data.progress === 'end',
  }
}

function spawnProcess(args, options = {}) {
  const child = spawn(FFMPEG_PATH, args, { cwd: options.cwd, windowsHide: true })
  let stderr = ''
  let stdoutBuffer = ''
  let block = {}
  let settled = false

  if (options.onSpawn) {
    try { options.onSpawn(child) } catch { /* 忽略回调异常 */ }
  }

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk
    const lines = stdoutBuffer.split(/\r?\n/)
    stdoutBuffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      const key = trimmed.slice(0, eq)
      const value = trimmed.slice(eq + 1)
      block[key] = value
      if (key === 'progress') {
        const payload = parseProgressBlock(block, options.durationMs || 0)
        payload.progress = value
        if (options.onProgress) {
          try { options.onProgress(payload) } catch { /* 忽略回调异常 */ }
        }
        block = {}
      }
    }
  })

  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-12000)
  })

  const done = new Promise((resolve) => {
    child.on('error', (err) => {
      if (settled) return
      settled = true
      resolve({ code: -1, stderr: err.message })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      resolve({ code, stderr })
    })
  })

  return { child, done }
}

export function killProcess(child) {
  if (!child || child.killed) return
  try { child.kill('SIGKILL') } catch { /* 进程可能已结束 */ }
}

// 预览代理：统一转成浏览器能播的 H.264 / AAC，限制在 1280 以内
export function startPreviewBuild(videoFile, outFile, durationMs, onProgress) {
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', videoFile,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-vf', 'scale=1280:1280:force_original_aspect_ratio=decrease:force_divisible_by=2',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '30',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    '-nostats',
    outFile,
  ]
  return spawnProcess(args, { durationMs, onProgress })
}

// 导出：直接烧录 ASS，视频重编码，音频能复制就复制
export function startExport(videoFile, assFile, outFile, meta, quality, onProgress, cwd) {
  const crfMap = { high: '18', standard: '20', compact: '24' }
  const crf = crfMap[quality] || crfMap.standard
  const filters = [`ass=${assFile}`]
  if ((meta.width || 0) % 2 !== 0 || (meta.height || 0) % 2 !== 0) {
    filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2')
  }

  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', videoFile,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-vf', filters.join(','),
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', crf,
    '-pix_fmt', 'yuv420p',
  ]

  if (meta.audioCodec) {
    if (MP4_AUDIO_COPY.has(meta.audioCodec)) args.push('-c:a', 'copy')
    else args.push('-c:a', 'aac', '-b:a', '192k')
  } else {
    args.push('-an')
  }

  args.push('-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', outFile)
  return spawnProcess(args, { durationMs: meta.durationMs, onProgress, cwd })
}

// 精确预览帧：输入 seek + 已经平移过的 ASS，快速拿到和导出完全一致的画面
export function startFrameRender(videoFile, assFile, imageFile, timeMs, durationMs, onSpawn, cwd) {
  const safeTime = Math.max(0, Math.min(timeMs, durationMs > 0 ? durationMs - 30 : timeMs))
  const args = ['-y', '-hide_banner', '-loglevel', 'error']
  if (safeTime > 1) args.push('-ss', (safeTime / 1000).toFixed(3))
  args.push('-i', videoFile, '-vf', `ass=${assFile}`, '-frames:v', '1', '-an', '-q:v', '2', imageFile)
  return spawnProcess(args, { durationMs, onSpawn, cwd })
}

export function revealFolder(dir) {
  try {
    if (process.platform === 'win32') {
      spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [dir], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref()
    }
    return true
  } catch {
    return false
  }
}
