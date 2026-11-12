const ROUND1 = (n) => Math.round(n * 10) / 10

export function computeMetrics(style, width, height) {
  const W = Math.max(2, Number(width) || 1920)
  const H = Math.max(2, Number(height) || 1080)
  const fontPx = Math.max(1, ROUND1(((style.sizePct ?? 4.6) / 100) * H))
  return {
    width: W,
    height: H,
    fontPx,
    outlinePx: ROUND1(fontPx * ((style.outlinePct ?? 0) / 100)),
    shadowPx: ROUND1(fontPx * ((style.shadowPct ?? 0) / 100)),
    marginH: ROUND1(((style.marginHPct ?? 0) / 100) * W),
    marginV: ROUND1(((style.marginVPct ?? 0) / 100) * H),
  }
}

export function fontString(style, fontPx) {
  const name = String(style.fontName || 'SimHei').replace(/"/g, '')
  return `${style.italic ? 'italic ' : ''}${style.bold ? 700 : 400} ${fontPx}px "${name}"`
}

export function activeCuesAt(cues, timeMs) {
  const out = []
  if (!Array.isArray(cues)) return out
  for (const cue of cues) {
    if (cue.start <= timeMs && timeMs < cue.end) out.push(cue)
  }
  return out
}

function isCjk(ch) {
  const code = ch.codePointAt(0)
  return (code >= 0x2e80 && code <= 0x9fff)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0x3000 && code <= 0x303f)
    || (code >= 0xff00 && code <= 0xffef)
}

function tokenize(paragraph) {
  const tokens = []
  let i = 0
  while (i < paragraph.length) {
    const ch = paragraph[i]
    if (ch === ' ' || ch === '\t') {
      let j = i
      while (j < paragraph.length && (paragraph[j] === ' ' || paragraph[j] === '\t')) j++
      tokens.push(paragraph.slice(i, j).replace(/\t/g, ' '))
      i = j
      continue
    }
    if (isCjk(ch)) {
      tokens.push(ch)
      i++
      continue
    }
    let j = i
    while (j < paragraph.length && paragraph[j] !== ' ' && paragraph[j] !== '\t' && !isCjk(paragraph[j])) j++
    tokens.push(paragraph.slice(i, j))
    i = j
  }
  return tokens
}

const wrapCache = new Map()

function splitLongToken(ctx, token, maxWidth, lines) {
  let rest = token
  while (rest && ctx.measureText(rest).width > maxWidth) {
    let low = 1
    let high = rest.length
    let fit = 1
    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      if (ctx.measureText(rest.slice(0, mid)).width <= maxWidth) {
        fit = mid
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    lines.push(rest.slice(0, fit))
    rest = rest.slice(fit)
  }
  return rest
}

function wrapParagraph(ctx, paragraph, maxWidth, key) {
  const cacheKey = `${key}\u0000${maxWidth}\u0000${paragraph}`
  if (wrapCache.has(cacheKey)) return wrapCache.get(cacheKey)

  let lines = []
  if (!paragraph) {
    lines = ['']
  } else {
    let line = ''
    for (const token of tokenize(paragraph)) {
      if (token.trim() === '' && !line) continue
      const candidate = line + token
      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate
        continue
      }
      if (line.trim()) {
        lines.push(line.replace(/\s+$/, ''))
        line = ''
      }
      if (token.trim() === '') continue
      const rest = splitLongToken(ctx, token.replace(/^\s+/, ''), maxWidth, lines)
      line = rest
      if (line.trim() === '') line = ''
    }
    if (line || !lines.length) lines.push(line.replace(/\s+$/, ''))
  }

  if (wrapCache.size > 500) wrapCache.clear()
  wrapCache.set(cacheKey, lines)
  return lines
}

function wrapCue(ctx, text, maxWidth, key) {
  const paragraphs = String(text || '').replace(/\t/g, ' ').replace(/\r/g, '').split('\n')
  let lines = []
  for (const paragraph of paragraphs) lines.push(...wrapParagraph(ctx, paragraph, maxWidth, key))
  while (lines.length && !lines[0]) lines.shift()
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  return lines
}

function rgba(hex, opacityPct = 100) {
  const clean = /^#[0-9a-fA-F]{6}$/.test(hex || '') ? hex.slice(1) : 'ffffff'
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  const alpha = Math.max(0, Math.min(100, opacityPct)) / 100
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function drawOutlineText(ctx, line, x, y, color, strokeWidth) {
  ctx.fillStyle = color
  if (strokeWidth > 0) {
    ctx.strokeStyle = color
    ctx.lineWidth = strokeWidth * 2
    ctx.strokeText(line, x, y)
  }
  ctx.fillText(line, x, y)
}

export function drawOverlay(canvas, options) {
  const { cues, style, timeMs, videoWidth, videoHeight, displayWidth, displayHeight } = options
  if (!canvas) return
  const W = Math.max(2, Number(videoWidth) || 1920)
  const H = Math.max(2, Number(videoHeight) || 1080)
  const dpr = Math.min(2.5, window.devicePixelRatio || 1)
  const pixelWidth = Math.max(1, Math.round((displayWidth || 0) * dpr))
  const pixelHeight = Math.max(1, Math.round((displayHeight || 0) * dpr))

  if (canvas.width !== pixelWidth) canvas.width = pixelWidth
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight

  const ctx = canvas.getContext('2d')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (!displayWidth || !displayHeight) return

  ctx.setTransform((displayWidth * dpr) / W, 0, 0, (displayHeight * dpr) / H, 0, 0)

  const active = activeCuesAt(cues, timeMs)
  if (!active.length) return

  const metrics = computeMetrics(style, W, H)
  const font = fontString(style, metrics.fontPx)
  const maxWidth = Math.max(1, W - metrics.marginH * 2)
  const cacheKey = `${font}\u0000${style.borderMode}\u0000${style.alignment}`

  ctx.font = font
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.miterLimit = 2
  ctx.imageSmoothingEnabled = true

  for (const cue of active) {
    const lines = wrapCue(ctx, cue.text, maxWidth, cacheKey)
    if (!lines.length) continue

    const lineHeight = metrics.fontPx
    const blockHeight = lines.length * lineHeight
    const vertical = style.alignment <= 3 ? 'bottom' : style.alignment <= 6 ? 'middle' : 'top'
    let blockTop
    if (vertical === 'top') blockTop = metrics.marginV
    else if (vertical === 'middle') blockTop = (H - blockHeight) / 2
    else blockTop = H - metrics.marginV - blockHeight

    const horizontal = (style.alignment - 1) % 3

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineWidth = ctx.measureText(line).width
      const centerY = blockTop + i * lineHeight + lineHeight / 2
      let lineX = metrics.marginH
      if (horizontal === 1) lineX = (W - lineWidth) / 2
      else if (horizontal === 2) lineX = W - metrics.marginH - lineWidth

      if (style.borderMode === 'box') {
        const pad = metrics.outlinePx
        if (lineWidth > 0 && pad >= 0) {
          if (metrics.shadowPx > 0) {
            ctx.fillStyle = rgba(style.shadowColor, style.shadowAlpha)
            ctx.fillRect(
              lineX - pad + metrics.shadowPx,
              centerY - lineHeight / 2 - pad + metrics.shadowPx,
              lineWidth + pad * 2,
              lineHeight + pad * 2,
            )
          }
          ctx.fillStyle = rgba(style.boxColor, style.boxAlpha)
          ctx.fillRect(
            lineX - pad,
            centerY - lineHeight / 2 - pad,
            lineWidth + pad * 2,
            lineHeight + pad * 2,
          )
        }
        if (lineWidth > 0) {
          ctx.fillStyle = rgba(style.color, 100)
          ctx.fillText(line, lineX, centerY)
        }
      } else {
        if (lineWidth > 0) {
          if (metrics.shadowPx > 0) {
            drawOutlineText(
              ctx,
              line,
              lineX + metrics.shadowPx,
              centerY + metrics.shadowPx,
              rgba(style.shadowColor, style.shadowAlpha),
              metrics.outlinePx,
            )
          }
          drawOutlineText(ctx, line, lineX, centerY, rgba(style.outlineColor, 100), metrics.outlinePx)
          ctx.fillStyle = rgba(style.color, 100)
          ctx.fillText(line, lineX, centerY)
        }
      }
    }
  }
}
