import { DEFAULT_STYLE, MAX_CUES } from './store.js'

const ROUND1 = (n) => Math.round(n * 10) / 10
const clampNum = (n, min, max) => Math.min(max, Math.max(min, n))

export function decodeSubtitle(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  const head = buf.subarray(0, 4)

  try {
    if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
      return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf-8' }
    }
    if (head[0] === 0xff && head[1] === 0xfe) {
      return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' }
    }
    if (head[0] === 0xfe && head[1] === 0xff) {
      return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be' }
    }
  } catch { /* 继续尝试其他编码 */ }

  for (const encoding of ['utf-8', 'gb18030', 'big5']) {
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(buf)
      return { text, encoding }
    } catch { /* 换下一种编码 */ }
  }

  return { text: new TextDecoder('utf-8').decode(buf), encoding: 'utf-8' }
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
}

function cleanText(raw, isAss = false) {
  let text = raw
    .replace(/\uFEFF/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')

  text = text.replace(/\\N/g, '\n').replace(/\\n/g, '\n')

  if (isAss) {
    text = text
      .replace(/\\h/g, ' ')
      .replace(/\{\\[^}]*\}/g, '')
      .replace(/\\[a-zA-Z0-9]+/g, '')
  } else {
    text = text.replace(/\{\\[^}]*\}/g, '')
  }

  text = decodeEntities(text)
    .replace(/\u00A0/g, ' ')

  const lines = text.split('\n').map((line) => line.replace(/\s+/g, ' ').trim())
  while (lines.length && !lines[0]) lines.shift()
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  return lines.join('\n').trim()
}

function parseTimestamp(value) {
  const raw = String(value || '').trim()
  const parts = raw.split(':')
  if (parts.length !== 2 && parts.length !== 3) return null

  const secPart = parts.pop()
  const minutePart = parts.pop()
  const hourPart = parts.length ? parts.pop() : '0'
  const secMatch = /^(\d{1,2})(?:[.,](\d{1,4}))?$/.exec(secPart)
  if (!secMatch) return null

  const hours = Number(hourPart)
  const minutes = Number(minutePart)
  const seconds = Number(secMatch[1])
  const fraction = secMatch[2] ? Number(`0.${secMatch[2]}`) : 0
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) return null

  return Math.round((hours * 3600 + minutes * 60 + seconds + fraction) * 1000)
}

function normalizeCues(items) {
  const cues = []
  for (const item of items) {
    if (!item) continue
    const start = Math.max(0, Math.round(item.start))
    let end = Math.max(0, Math.round(item.end))
    if (end <= start) end = start + 10
    const text = String(item.text || '').trim()
    if (!text) continue
    cues.push({ start, end, text })
  }
  cues.sort((a, b) => a.start - b.start || a.end - b.end)
  return cues.slice(0, MAX_CUES).map((cue, index) => ({ id: `c${index + 1}`, ...cue }))
}

function stampOfLine(line) {
  if (!line.includes('-->')) return null
  const parts = line.split('-->')
  if (parts.length < 2) return null
  const start = parseTimestamp(parts[0])
  const end = parseTimestamp((parts[1] || '').trim().split(/\s+/)[0])
  if (start === null || end === null) return null
  return { start, end }
}

function parseSrt(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const stamps = []
  for (let i = 0; i < lines.length; i++) {
    const stamp = stampOfLine(lines[i])
    if (stamp) stamps.push({ ...stamp, line: i })
  }

  const items = []
  for (let index = 0; index < stamps.length; index++) {
    const current = stamps[index]
    const next = stamps[index + 1]
    const body = lines.slice(current.line + 1, next ? next.line : lines.length)
    while (body.length && !body[body.length - 1].trim()) body.pop()
    if (next && body.length && /^\s*\d{1,5}\s*$/.test(body[body.length - 1])) {
      body.pop()
      while (body.length && !body[body.length - 1].trim()) body.pop()
    }
    items.push({ start: current.start, end: current.end, text: cleanText(body.join('\n')) })
  }
  return normalizeCues(items)
}

function parseVtt(text) {
  const clean = text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')
  const blocks = clean.split(/\n{2,}/)
  const items = []

  for (const block of blocks) {
    const lines = block.split('\n')
    if (!lines.length) continue
    const head = lines[0].trim()
    if (head === 'WEBVTT' || head.startsWith('NOTE') || head.startsWith('STYLE') || head.startsWith('REGION')) continue

    let stampIndex = lines.findIndex((line) => line.includes('-->'))
    if (stampIndex < 0) continue
    const arrow = lines[stampIndex].split('-->')
    const start = parseTimestamp(arrow[0])
    const end = parseTimestamp((arrow[1] || '').trim().split(/\s+/)[0])
    if (start === null || end === null) continue

    const body = lines.slice(stampIndex + 1)
    items.push({ start, end, text: cleanText(body.join('\n')) })
  }
  return normalizeCues(items)
}

function splitAssLine(line, count) {
  const parts = []
  let current = ''
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ',' && parts.length < count - 1) {
      parts.push(current)
      current = ''
    } else {
      current += line[i]
    }
  }
  parts.push(current)
  return parts
}

function parseAss(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const items = []
  let inEvents = false
  let format = null

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('[')) {
      inEvents = line.toLowerCase() === '[events]'
      format = null
      continue
    }
    if (!inEvents) continue

    if (line.toLowerCase().startsWith('format:')) {
      format = splitAssLine(line.slice(7).trim(), 64).map((part) => part.trim().toLowerCase())
      continue
    }
    if (!line.toLowerCase().startsWith('dialogue:')) continue

    const body = line.slice(line.indexOf(':') + 1).trim()
    const fields = format ? splitAssLine(body, format.length) : splitAssLine(body, 10)
    const startIndex = format ? format.indexOf('start') : 1
    const endIndex = format ? format.indexOf('end') : 2
    const textIndex = format ? format.indexOf('text') : 9
    if (startIndex < 0 || endIndex < 0 || textIndex < 0) continue

    const start = parseTimestamp(fields[startIndex])
    const end = parseTimestamp(fields[endIndex])
    if (start === null || end === null) continue
    items.push({ start, end, text: cleanText(fields[textIndex] || '', true) })
  }
  return normalizeCues(items)
}

export function detectFormat(filename, text) {
  const ext = String(filename || '').split('.').pop().toLowerCase()
  if (ext === 'vtt') return 'vtt'
  if (ext === 'ass' || ext === 'ssa') return 'ass'
  if (ext === 'srt') return 'srt'
  if (/^WEBVTT/m.test(text)) return 'vtt'
  if (/^\[Script Info\]/im.test(text) || /\[Events\]/im.test(text) || /Dialogue:/im.test(text)) return 'ass'
  return 'srt'
}

export function parseSubtitle(text, filename) {
  const format = detectFormat(filename, text)
  const parsers = format === 'vtt'
    ? [parseVtt, parseSrt, parseAss]
    : format === 'ass'
      ? [parseAss, parseSrt, parseVtt]
      : [parseSrt, parseVtt, parseAss]

  for (const parser of parsers) {
    const cues = parser(text)
    if (cues.length) {
      return { format: parser === parseVtt ? 'vtt' : parser === parseAss ? 'ass' : 'srt', cues }
    }
  }

  return { format, cues: [] }
}

export function assMetrics(style, width, height) {
  const H = Math.max(2, height || 1080)
  const W = Math.max(2, width || 1920)
  const fontPx = Math.max(1, ROUND1((style.sizePct / 100) * H))
  return {
    width: W,
    height: H,
    fontPx,
    outlinePx: ROUND1(fontPx * (style.outlinePct / 100)),
    shadowPx: ROUND1(fontPx * (style.shadowPct / 100)),
    marginH: ROUND1((style.marginHPct / 100) * W),
    marginV: ROUND1((style.marginVPct / 100) * H),
  }
}

function assColor(hex, opacityPct = 100) {
  const clean = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.slice(1) : 'ffffff'
  const r = clean.slice(0, 2)
  const g = clean.slice(2, 4)
  const b = clean.slice(4, 6)
  const alpha = Math.round(((100 - clampNum(opacityPct, 0, 100)) / 100) * 255)
  return `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}${b}${g}${r}`.toUpperCase()
}

function assTime(ms) {
  const total = Math.max(0, Math.round(ms / 10))
  const hours = Math.floor(total / 360000)
  const minutes = Math.floor((total % 360000) / 6000)
  const seconds = Math.floor((total % 6000) / 100)
  const centis = total % 100
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centis).padStart(2, '0')}`
}

function assEscape(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/\uFEFF/g, '')
    .replace(/\\/g, '')
    .replace(/\{/g, '')
    .replace(/\}/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\\N')
}

export function buildAss(options) {
  const style = { ...DEFAULT_STYLE, ...(options.style || {}) }
  const cues = options.cues || []
  const shiftMs = options.shiftMs || 0
  const m = assMetrics(style, options.width, options.height)

  const fontName = (style.fontName || DEFAULT_STYLE.fontName).replace(/[,\r\n{}]/g, ' ')
  const bold = style.bold ? -1 : 0
  const italic = style.italic ? -1 : 0
  const borderStyle = style.borderMode === 'box' ? 3 : 1
  const outlineColor = style.borderMode === 'box'
    ? assColor(style.boxColor, style.boxAlpha)
    : assColor(style.outlineColor, 100)
  const backColor = assColor(style.shadowColor, style.shadowAlpha)
  const primaryColor = assColor(style.color, 100)

  const info = [
    '[Script Info]',
    '; generated by Subtitle Burner',
    'ScriptType: v4.00+',
    `PlayResX: ${m.width}`,
    `PlayResY: ${m.height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
  ]

  const styleLine = 'Style: Default,'
    + [
      fontName,
      m.fontPx.toFixed(1),
      primaryColor,
      '&H000000FF',
      outlineColor,
      backColor,
      bold,
      italic,
      0,
      0,
      100,
      100,
      0,
      0,
      borderStyle,
      m.outlinePx.toFixed(1),
      m.shadowPx.toFixed(1),
      style.alignment,
      m.marginH.toFixed(1),
      m.marginH.toFixed(1),
      m.marginV.toFixed(1),
      1,
    ].join(',')

  const header = [
    ...info,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    styleLine,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]

  const events = []
  for (const cue of cues) {
    const text = assEscape(cue.text)
    if (!text) continue
    let start = Math.max(0, cue.start + shiftMs)
    let end = Math.max(0, cue.end + shiftMs)
    if (end <= start) {
      if (start <= 0) continue
      end = start + 10
    }
    events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${text}`)
  }

  return `${header.concat(events).join('\n')}\n`
}
