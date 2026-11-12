import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { DATA_DIR, MEDIA_DIR, EXPORTS_DIR, WORKSPACE_FILE } from './config.js'

export const DEFAULT_STYLE = Object.freeze({
  fontName: 'SimHei',
  sizePct: 4.6,
  bold: false,
  italic: false,
  color: '#ffffff',
  outlineColor: '#000000',
  outlinePct: 6,
  shadowPct: 0,
  shadowColor: '#000000',
  shadowAlpha: 55,
  borderMode: 'outline',
  boxColor: '#000000',
  boxAlpha: 55,
  alignment: 2,
  marginHPct: 5,
  marginVPct: 4,
})

export const MAX_CUES = 5000
const MAX_CUE_TEXT = 2000
const MAX_TIME = 24 * 60 * 60 * 1000

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const clamp = (v, min, max) => Math.min(max, Math.max(min, v))
const nowIso = () => new Date().toISOString()

export function ensureDirs() {
  for (const dir of [DATA_DIR, MEDIA_DIR, EXPORTS_DIR]) fs.mkdirSync(dir, { recursive: true })
}

export function mediaPath(name) {
  if (!name || path.basename(name) !== name) throw new Error('非法媒体文件名')
  return path.join(MEDIA_DIR, name)
}

export function exportPath(name) {
  if (!name || path.basename(name) !== name) throw new Error('非法导出文件名')
  return path.join(EXPORTS_DIR, name)
}

export function safeOriginalName(name, fallback = '未命名') {
  const base = typeof name === 'string' ? name.replace(/[/\\]/g, '_').trim() : ''
  return (base || fallback).slice(0, 255)
}

export function sanitizeStyle(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out

  if (typeof raw.fontName === 'string') {
    const name = raw.fontName.trim().replace(/[,\r\n{}]/g, ' ').slice(0, 80)
    if (name) out.fontName = name
  }
  if (isNum(raw.sizePct)) out.sizePct = clamp(raw.sizePct, 1, 25)
  if (typeof raw.bold === 'boolean') out.bold = raw.bold
  if (typeof raw.italic === 'boolean') out.italic = raw.italic

  for (const key of ['color', 'outlineColor', 'shadowColor', 'boxColor']) {
    if (typeof raw[key] === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw[key])) {
      out[key] = raw[key].toLowerCase()
    }
  }

  if (isNum(raw.outlinePct)) out.outlinePct = clamp(raw.outlinePct, 0, 20)
  if (isNum(raw.shadowPct)) out.shadowPct = clamp(raw.shadowPct, 0, 20)
  if (isNum(raw.shadowAlpha)) out.shadowAlpha = clamp(raw.shadowAlpha, 0, 100)
  if (raw.borderMode === 'outline' || raw.borderMode === 'box') out.borderMode = raw.borderMode
  if (isNum(raw.boxAlpha)) out.boxAlpha = clamp(raw.boxAlpha, 0, 100)
  if (isNum(raw.alignment)) out.alignment = Math.round(clamp(raw.alignment, 1, 9))
  if (isNum(raw.marginHPct)) out.marginHPct = clamp(raw.marginHPct, 0, 45)
  if (isNum(raw.marginVPct)) out.marginVPct = clamp(raw.marginVPct, 0, 45)
  return out
}

export function mergeStyle(base, patch) {
  return { ...DEFAULT_STYLE, ...sanitizeStyle(base), ...sanitizeStyle(patch) }
}

export function sanitizeCues(raw) {
  if (!Array.isArray(raw)) return null
  const out = []
  const seen = new Set()

  for (const item of raw.slice(0, MAX_CUES)) {
    if (!item || typeof item !== 'object') continue
    let start = isNum(item.start) ? Math.round(clamp(item.start, 0, MAX_TIME)) : 0
    let end = isNum(item.end) ? Math.round(clamp(item.end, 0, MAX_TIME)) : start
    if (end <= start) end = start + 10

    const text = typeof item.text === 'string'
      ? item.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').slice(0, MAX_CUE_TEXT)
      : ''

    let id = typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(item.id)
      ? item.id
      : `c${out.length + 1}`
    while (seen.has(id)) id = `c${out.length + 1}-${Math.random().toString(36).slice(2, 6)}`
    seen.add(id)
    out.push({ id, start, end, text })
  }
  return out
}

function normPreview(raw) {
  const status = ['pending', 'ready', 'none', 'error'].includes(raw?.status) ? raw.status : 'none'
  return {
    status,
    progress: isNum(raw?.progress) ? clamp(raw.progress, 0, 100) : 0,
    message: typeof raw?.message === 'string' ? raw.message.slice(0, 500) : '',
    forced: raw?.forced === true,
  }
}

function normVideo(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.file !== 'string') return null
  if (path.basename(raw.file) !== raw.file || !raw.file.startsWith('video')) return null
  const abs = path.join(MEDIA_DIR, raw.file)
  if (!fs.existsSync(abs)) return null

  const preview = normPreview(raw.preview)
  if (preview.status === 'ready') {
    const previewFile = typeof raw.preview?.file === 'string' ? raw.preview.file : 'preview.mp4'
    if (path.basename(previewFile) !== previewFile || !previewFile.startsWith('preview') || !fs.existsSync(path.join(MEDIA_DIR, previewFile))) {
      preview.status = 'pending'
      preview.progress = 0
    } else {
      preview.file = previewFile
    }
  }

  return {
    file: raw.file,
    originalName: typeof raw.originalName === 'string' ? raw.originalName.slice(0, 255) : 'video',
    ext: typeof raw.ext === 'string' ? raw.ext.replace(/[^a-z0-9]/gi, '').toLowerCase() : 'mp4',
    width: isNum(raw.width) && raw.width > 0 ? Math.round(raw.width) : 0,
    height: isNum(raw.height) && raw.height > 0 ? Math.round(raw.height) : 0,
    durationMs: isNum(raw.durationMs) && raw.durationMs >= 0 ? Math.round(raw.durationMs) : 0,
    codec: typeof raw.codec === 'string' ? raw.codec : '',
    format: typeof raw.format === 'string' ? raw.format : '',
    audioCodec: typeof raw.audioCodec === 'string' ? raw.audioCodec : '',
    playable: typeof raw.playable === 'boolean' ? raw.playable : false,
    preview,
  }
}

function normSubtitle(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.file !== 'string') return null
  if (path.basename(raw.file) !== raw.file || !raw.file.startsWith('subtitle')) return null
  if (!fs.existsSync(path.join(MEDIA_DIR, raw.file))) return null

  return {
    file: raw.file,
    originalName: typeof raw.originalName === 'string' ? raw.originalName.slice(0, 255) : 'subtitle',
    format: typeof raw.format === 'string' ? raw.format : 'srt',
    encoding: typeof raw.encoding === 'string' ? raw.encoding : 'utf-8',
    hash: typeof raw.hash === 'string' ? raw.hash : '',
    cueCount: isNum(raw.cueCount) ? Math.max(0, Math.round(raw.cueCount)) : 0,
  }
}

export function createEmptyWorkspace() {
  const at = nowIso()
  return {
    version: 1,
    createdAt: at,
    updatedAt: at,
    video: null,
    subtitle: null,
    style: { ...DEFAULT_STYLE },
    offsetMs: 0,
    cues: [],
    ui: { lastTime: 0 },
  }
}

function normalizeWorkspace(raw) {
  if (!raw || typeof raw !== 'object') return createEmptyWorkspace()

  const video = normVideo(raw.video)
  const subtitle = normSubtitle(raw.subtitle)
  const cues = sanitizeCues(raw.cues)

  const ws = {
    version: 1,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
    video,
    subtitle,
    style: mergeStyle(raw.style),
    offsetMs: isNum(raw.offsetMs) ? clamp(Math.round(raw.offsetMs), -MAX_TIME, MAX_TIME) : 0,
    cues: cues || [],
    ui: {
      lastTime: isNum(raw.ui?.lastTime) ? clamp(raw.ui.lastTime, 0, MAX_TIME / 1000) : 0,
    },
  }

  if (!video) {
    ws.offsetMs = 0
    ws.ui.lastTime = 0
  }
  return ws
}

export function loadWorkspace() {
  ensureDirs()
  try {
    const raw = JSON.parse(fs.readFileSync(WORKSPACE_FILE, 'utf8'))
    return normalizeWorkspace(raw)
  } catch {
    return createEmptyWorkspace()
  }
}

let writeChain = Promise.resolve()

export function saveWorkspace(ws) {
  ensureDirs()
  ws.updatedAt = nowIso()
  const json = JSON.stringify(ws, null, 2)
  writeChain = writeChain
    .then(async () => {
      const tmp = `${WORKSPACE_FILE}.tmp`
      await fsp.writeFile(tmp, json, 'utf8')
      await fsp.rename(tmp, WORKSPACE_FILE)
    })
    .catch((err) => {
      console.error('[workspace] 保存失败:', err.message)
    })
  return writeChain
}

export function removeMediaByPrefix(prefix) {
  try {
    for (const name of fs.readdirSync(MEDIA_DIR)) {
      if (name.startsWith(`${prefix}.`)) {
        try { fs.unlinkSync(path.join(MEDIA_DIR, name)) } catch { /* 文件可能正被播放器占用 */ }
      }
    }
  } catch { /* 目录不存在时忽略 */ }
}

export function listExports() {
  ensureDirs()
  const items = []
  for (const name of fs.readdirSync(EXPORTS_DIR)) {
    if (!name.toLowerCase().endsWith('.mp4')) continue
    try {
      const stat = fs.statSync(path.join(EXPORTS_DIR, name))
      if (!stat.isFile()) continue
      items.push({
        name,
        size: stat.size,
        createdAt: stat.mtime.toISOString(),
        url: `/api/exports/${encodeURIComponent(name)}`,
      })
    } catch { /* 忽略读不了的文件 */ }
  }
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
