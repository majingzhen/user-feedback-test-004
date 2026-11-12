import * as api from './api.js'
import { drawOverlay, activeCuesAt, computeMetrics } from './overlay.js'
import { icon, formatClock, formatSecondsInput, formatBytes, toast, confirmDialog } from './ui.js'

const $ = (id) => document.getElementById(id)

const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm', 'flv', 'wmv', 'ts', 'mpeg', 'mpg', '3gp', 'm2ts', 'ogv'])
const SUB_EXT = new Set(['srt', 'ass', 'ssa', 'vtt', 'txt'])
const MAX_TIME_MS = 24 * 60 * 60 * 1000
const LS_EXACT = 'sub-burner:exact'
const LS_TAB = 'sub-burner:tab'

const S = {
  workspace: null,
  defaults: null,
  tools: null,
  style: null,
  cues: [],
  offsetMs: 0,
  duration: 0,
  currentTime: 0,
  playing: false,
  seeking: false,
  activeTab: 'style',
  selectedCueId: null,
  exact: true,
  videoReady: false,
  videoSourceKey: null,
  restoreTime: null,
  videoAspect: 16 / 9,
  videoLoadFailed: false,
  uploading: false,
  uploadAbort: null,
  dirtyRev: 0,
  savedRev: 0,
  saving: false,
  savingPromise: null,
  saveTimer: null,
  frameToken: 0,
  frameTimer: null,
  frameAbort: null,
  frameUrl: null,
  frameFailShown: false,
  activeSignature: '',
  rafId: 0,
  previewPollTimer: null,
  exportJob: null,
  exportTimer: null,
  dragDepth: 0,
  initialized: false,
}

const els = {
  video: $('video'),
  overlay: $('overlay'),
  exactFrame: $('exact-frame'),
  previewFrame: $('preview-frame'),
  previewStage: $('preview-stage'),
  timeline: $('timeline'),
  timelineTrack: $('timeline-track'),
  timelineRuler: $('timeline-ruler'),
  timelineCues: $('timeline-cues'),
  playhead: $('timeline-playhead'),
  cueList: $('cue-list'),
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const roundPx = (value) => Math.round(value * 10) / 10
const extOf = (name) => {
  const parts = String(name || '').split('.')
  return parts.length > 1 ? parts.pop().toLowerCase() : ''
}

function readPref(key) {
  try { return localStorage.getItem(key) } catch { return null }
}
function writePref(key, value) {
  try { localStorage.setItem(key, value) } catch { /* 隐私模式忽略 */ }
}

function videoSize() {
  const video = S.workspace?.video
  return {
    width: (video && video.width) || els.video.videoWidth || 1920,
    height: (video && video.height) || els.video.videoHeight || 1080,
  }
}

function findCue(id) {
  return S.cues.find((cue) => cue.id === id) || null
}

function canExport() {
  if (!S.workspace?.video || !S.cues.length) return false
  return Boolean(S.tools?.ffmpeg?.ok && S.tools?.ffmpeg?.libass)
}

function isExportRunning() {
  return Boolean(S.exportJob && S.exportJob.status === 'running')
}

function setSaveStatus(status) {
  const root = $('save-state')
  const text = $('save-text')
  if (!root || !text) return
  root.classList.remove('is-saving', 'is-pending', 'is-error')
  if (status === 'saving') { root.classList.add('is-saving'); text.textContent = '保存中…' }
  else if (status === 'pending') { root.classList.add('is-pending'); text.textContent = '待保存' }
  else if (status === 'error') { root.classList.add('is-error'); text.textContent = '保存失败' }
  else text.textContent = '已保存'
}

function buildSavePayload() {
  return {
    style: S.style,
    offsetMs: Math.round(S.offsetMs || 0),
    cues: S.cues,
    ui: { lastTime: Number.isFinite(S.currentTime) ? S.currentTime : 0 },
  }
}

function markDirty() {
  if (!S.workspace) return
  S.dirtyRev++
  setSaveStatus('pending')
  if (S.saveTimer) clearTimeout(S.saveTimer)
  S.saveTimer = setTimeout(() => {
    S.saveTimer = null
    flushSave()
  }, 500)
}

async function flushSave() {
  if (S.saveTimer) { clearTimeout(S.saveTimer); S.saveTimer = null }
  if (!S.workspace) return true

  while (S.dirtyRev !== S.savedRev) {
    if (S.saving && S.savingPromise) {
      await S.savingPromise
      continue
    }
    const rev = S.dirtyRev
    S.saving = true
    setSaveStatus('saving')
    S.savingPromise = api.saveState(buildSavePayload())
      .then(() => {
        S.savedRev = rev
        setSaveStatus(S.dirtyRev === S.savedRev ? 'saved' : 'pending')
        return true
      })
      .catch((err) => {
        setSaveStatus('error')
        toast(`保存失败：${err.message}`, 'error', 5000)
        return false
      })
      .finally(() => {
        S.saving = false
        S.savingPromise = null
      })
    const ok = await S.savingPromise
    if (!ok) return false
  }

  setSaveStatus('saved')
  return true
}

function updateToolBanner() {
  const banner = $('tool-banner')
  const text = $('tool-banner-text')
  if (!banner || !text) return
  const problems = []
  if (!S.tools?.ffmpeg?.ok) problems.push('未找到 ffmpeg，导出和精确预览不可用')
  else if (!S.tools.ffmpeg.libass) problems.push('当前 ffmpeg 没有 libass，无法烧录字幕')
  if (!S.tools?.ffprobe?.ok) problems.push('未找到 ffprobe，视频信息读取受限')
  if (problems.length) {
    text.textContent = problems.join('；')
    banner.hidden = false
  } else {
    banner.hidden = true
  }
}

function setChip(button, nameEl, fileName) {
  if (!button || !nameEl) return
  const hasFile = Boolean(fileName)
  button.hidden = !hasFile
  if (hasFile) {
    nameEl.textContent = fileName
    button.title = `点击替换：${fileName}`
  }
}

function updateChrome() {
  const ws = S.workspace
  const hasVideo = Boolean(ws?.video)
  const empty = $('empty-state')
  const editor = $('editor')
  if (empty) empty.hidden = hasVideo
  if (editor) editor.hidden = !hasVideo

  setChip($('chip-video'), $('chip-video-name'), ws?.video?.originalName)
  setChip($('chip-subtitle'), $('chip-subtitle-name'), ws?.subtitle?.originalName)
  const chips = $('file-chips')
  if (chips) chips.hidden = !ws?.video && !ws?.subtitle

  const note = $('empty-note')
  if (note) {
    const showNote = !hasVideo && Boolean(ws?.subtitle)
    note.hidden = !showNote
    if (showNote) $('empty-note-name').textContent = ws.subtitle.originalName || '字幕已就绪'
  }

  if (hasVideo) {
    const video = ws.video
    $('meta-resolution').textContent = video.width && video.height ? `${video.width} × ${video.height}` : '分辨率未知'
    $('meta-duration').textContent = S.duration > 0 ? formatClock(S.duration) : '—'
    $('meta-subtitle').textContent = S.cues.length ? `字幕 ${S.cues.length} 条` : '无字幕'
    requestAnimationFrame(fitPreviewFrame)
  }

  updateExportAvailability()
  updatePreviewEmpty()
}

function updateExportAvailability() {
  const ready = Boolean(S.workspace?.video) && S.cues.length > 0
  const toolsOk = Boolean(S.tools?.ffmpeg?.ok && S.tools?.ffmpeg?.libass)
  const busy = S.uploading || isExportRunning()
  const exportBtn = $('btn-export')
  const importBtn = $('btn-import')
  if (exportBtn) {
    exportBtn.disabled = !ready || !toolsOk || busy
    exportBtn.title = !ready ? '先导入视频和字幕' : !toolsOk ? 'ffmpeg / libass 不可用' : ''
  }
  if (importBtn) importBtn.disabled = S.uploading || isExportRunning()
}

function applyWorkspace(ws, options = {}) {
  const previousVideoFile = S.workspace?.video?.file
  const videoChanged = options.videoChanged === true
    || Boolean(previousVideoFile && ws.video?.file !== previousVideoFile)
  const wasInitial = Boolean(options.initial)

  S.workspace = ws
  if (wasInitial) {
    S.style = { ...(S.defaults || {}), ...(ws.style || {}) }
    S.currentTime = Number.isFinite(ws.ui?.lastTime) ? ws.ui.lastTime : 0
    S.selectedCueId = null
  } else if (!S.style) {
    S.style = { ...(S.defaults || {}), ...(ws.style || {}) }
  }

  S.cues = Array.isArray(ws.cues) ? ws.cues : []
  S.offsetMs = Number.isFinite(ws.offsetMs) ? ws.offsetMs : 0
  S.duration = ws.video?.durationMs ? ws.video.durationMs / 1000 : 0
  S.activeSignature = ''

  if (videoChanged) {
    S.currentTime = 0
    S.videoLoadFailed = false
  }

  if (S.selectedCueId && !S.cues.some((cue) => cue.id === S.selectedCueId)) {
    S.selectedCueId = null
  }

  updateChrome()
  syncStyleControls()
  syncTimingPanel()
  renderTimeline()
  renderCueList()
  updatePreviewSource({ videoChanged, time: S.currentTime })
  startPreviewPolling()
  updateTransport()
  refreshOverlay()
  updateExactToggle()
  setSaveStatus(S.dirtyRev === S.savedRev ? 'saved' : 'pending')
  if (wasInitial) S.initialized = true
}

async function boot() {
  S.exact = readPref(LS_EXACT) !== 'off'
  S.activeTab = readPref(LS_TAB) === 'timing' ? 'timing' : 'style'
  bindEvents()
  setTab(S.activeTab, { silent: true })
  updateExactToggle()
  setSaveStatus('saved')

  try {
    const state = await api.getState()
    S.defaults = { ...(state.defaults || {}) }
    S.tools = state.tools || null
    applyWorkspace(state.workspace, { initial: true })
    updateToolBanner()
  } catch (err) {
    toast(`无法读取工作状态：${err.message}`, 'error', 6000)
  }
}

function updatePreviewEmpty() {
  const hint = $('preview-empty')
  if (!hint) return
  hint.hidden = !(S.videoReady && S.workspace?.video && S.cues.length === 0)
}

function fitPreviewFrame() {
  if (!S.workspace?.video || $('editor')?.hidden) return
  const stage = els.previewStage
  const frame = els.previewFrame
  if (!stage || !frame) return
  const stageW = stage.clientWidth
  const stageH = stage.clientHeight
  if (stageW <= 0 || stageH <= 0) return

  const size = videoSize()
  let aspect = S.videoAspect
  if (!Number.isFinite(aspect) || aspect <= 0) aspect = size.width / size.height
  if (!Number.isFinite(aspect) || aspect <= 0) aspect = 16 / 9

  let width = stageW
  let height = width / aspect
  if (height > stageH) {
    height = stageH
    width = height * aspect
  }
  if (width < 1 || height < 1) return

  frame.style.width = `${width.toFixed(2)}px`
  frame.style.height = `${height.toFixed(2)}px`
  refreshOverlay()
}

function clearOverlay() {
  const canvas = els.overlay
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
}

function refreshOverlay() {
  if (!S.workspace?.video || !S.videoReady) {
    clearOverlay()
    return
  }
  const displayWidth = els.previewFrame.clientWidth
  const displayHeight = els.previewFrame.clientHeight
  if (!displayWidth || !displayHeight) {
    clearOverlay()
    return
  }
  const size = videoSize()
  drawOverlay(els.overlay, {
    cues: S.cues,
    style: S.style,
    timeMs: (S.currentTime || 0) * 1000,
    videoWidth: size.width,
    videoHeight: size.height,
    displayWidth,
    displayHeight,
  })
}

function detachVideo() {
  const video = els.video
  if (!video) return
  try { video.pause() } catch { /* 忽略 */ }
  video.removeAttribute('src')
  try { video.load() } catch { /* 忽略 */ }
  S.videoReady = false
  S.videoSourceKey = null
  S.playing = false
  stopFrameLoop()
  invalidateExactFrame()
  clearOverlay()
  updateTransport()
  updatePreviewEmpty()
}

function updatePendingUI() {
  const panel = $('preview-pending')
  if (!panel) return
  const video = S.workspace?.video
  const preview = video?.preview
  if (!video) {
    panel.hidden = true
    return
  }

  const blocked = !S.videoReady
    && (!video.playable || S.videoLoadFailed)
    && (!preview || preview.status !== 'ready')
  if (!blocked) {
    panel.hidden = true
    return
  }

  panel.hidden = false
  const spinner = panel.querySelector('.spinner')
  const title = $('pending-title')
  const detail = $('pending-detail')
  const retry = $('btn-preview-retry')
  const bar = $('pending-bar')
  const progress = Number(preview?.progress) || 0

  if (preview?.status === 'error') {
    if (spinner) spinner.hidden = true
    title.textContent = '预览代理生成失败'
    detail.textContent = preview.message || '浏览器无法直接播放这个视频，可以重试生成预览'
    retry.hidden = false
    bar.style.width = '0%'
  } else {
    if (spinner) spinner.hidden = false
    title.textContent = '正在生成预览代理'
    detail.textContent = progress > 0
      ? `浏览器无法直接播放这个编码 · ${Math.round(progress)}%`
      : '浏览器无法直接播放这个编码，正在转为可播放的预览文件'
    retry.hidden = true
    bar.style.width = `${clamp(progress, 0, 100)}%`
  }
}

function updatePreviewSource(options = {}) {
  const videoEl = els.video
  const video = S.workspace?.video
  if (!videoEl) return

  if (!video) {
    stopPreviewPolling()
    detachVideo()
    updatePendingUI()
    return
  }

  const preview = video.preview || { status: 'none', progress: 0, message: '' }
  let url = null
  if (preview.status === 'ready' && preview.file) {
    url = '/media/preview'
  } else if (video.playable && !S.videoLoadFailed) {
    url = '/media/video'
  }

  if (!url) {
    if (!S.videoReady || S.videoSourceKey) detachVideo()
    updatePendingUI()
    return
  }

  const sourceKey = preview.status === 'ready' && preview.file
    ? `preview:${preview.file}`
    : `video:${video.file}`

  if (S.videoSourceKey === sourceKey) {
    if (!S.videoReady && Number.isFinite(options.time)) S.restoreTime = options.time
    updatePendingUI()
    return
  }

  const restoreTime = options.videoChanged
    ? 0
    : (Number.isFinite(options.time) ? options.time : S.currentTime)

  S.videoSourceKey = sourceKey
  S.videoReady = false
  S.restoreTime = restoreTime
  S.frameFailShown = false
  S.playing = false
  stopFrameLoop()
  invalidateExactFrame()
  clearOverlay()
  try { videoEl.pause() } catch { /* 忽略 */ }

  if (video.width && video.height) S.videoAspect = video.width / video.height
  fitPreviewFrame()

  videoEl.src = url
  videoEl.load()
  updatePendingUI()
  updateTransport()
  updatePreviewEmpty()
}

function startPreviewPolling() {
  const video = S.workspace?.video
  if (!video || video.preview?.status !== 'pending') {
    stopPreviewPolling()
    return
  }
  if (S.previewPollTimer) return

  S.previewPollTimer = setInterval(async () => {
    try {
      const state = await api.getState()
      const current = state.workspace?.video
      if (!current || !S.workspace?.video || current.file !== S.workspace.video.file) {
        stopPreviewPolling()
        return
      }
      S.workspace.video.preview = current.preview
      S.workspace.video.playable = current.playable
      updatePendingUI()
      if (current.preview.status === 'ready') {
        stopPreviewPolling()
        S.videoLoadFailed = false
        updatePreviewSource({ time: S.currentTime })
      } else if (current.preview.status === 'error') {
        stopPreviewPolling()
        updatePendingUI()
      } else if (current.preview.status !== 'pending') {
        stopPreviewPolling()
        updatePreviewSource({ time: S.currentTime })
      }
    } catch { /* 网络抖动时等下一轮 */ }
  }, 1200)
}

function stopPreviewPolling() {
  if (S.previewPollTimer) {
    clearInterval(S.previewPollTimer)
    S.previewPollTimer = null
  }
}

async function forceProxy() {
  const video = S.workspace?.video
  if (!video) return
  S.videoLoadFailed = true
  video.preview = { status: 'pending', progress: 0, message: '' }
  detachVideo()
  stopPreviewPolling()
  updatePendingUI()
  try {
    const result = await api.startPreviewBuild()
    if (result?.preview) video.preview = result.preview
    if (video.preview.status === 'pending') startPreviewPolling()
    else updatePendingUI()
  } catch (err) {
    video.preview = { status: 'error', progress: 0, message: err.message }
    updatePendingUI()
    toast(`无法生成预览代理：${err.message}`, 'error', 5000)
  }
}

function updateTransport() {
  updateClockUI()
  updatePlayState()
  updatePreviewEmpty()
}

function updateClockUI() {
  const current = Number.isFinite(S.currentTime) ? Math.max(0, S.currentTime) : 0
  const total = Number.isFinite(S.duration) ? Math.max(0, S.duration) : 0
  const currentEl = $('time-current')
  const totalEl = $('time-total')
  if (currentEl) currentEl.textContent = formatClock(current, true)
  if (totalEl) totalEl.textContent = formatClock(total, true)
  if (els.playhead) {
    const percent = total > 0 ? clamp((current / total) * 100, 0, 100) : 0
    els.playhead.style.left = `${percent}%`
  }
}

function updatePlayState() {
  const playing = S.playing && !els.video.paused
  const playIcon = $('icon-play')
  const pauseIcon = $('icon-pause')
  if (playIcon) playIcon.hidden = playing
  if (pauseIcon) pauseIcon.hidden = !playing
  const playBtn = $('btn-play')
  if (playBtn) {
    playBtn.disabled = !S.videoReady
    playBtn.setAttribute('aria-label', playing ? '暂停' : '播放')
  }
  const back = $('btn-skip-back')
  const forward = $('btn-skip-fwd')
  if (back) back.disabled = !S.videoReady
  if (forward) forward.disabled = !S.videoReady
}

function startFrameLoop() {
  if (S.rafId) return
  S.rafId = requestAnimationFrame(frameLoop)
}

function stopFrameLoop() {
  if (S.rafId) {
    cancelAnimationFrame(S.rafId)
    S.rafId = 0
  }
}

function frameLoop() {
  S.rafId = 0
  if (!S.playing) return
  S.currentTime = els.video.currentTime
  updateClockUI()
  if (updateActiveCueState()) refreshOverlay()
  S.rafId = requestAnimationFrame(frameLoop)
}

function updateActiveCueState(force = false) {
  const active = activeCuesAt(S.cues, (S.currentTime || 0) * 1000)
  const signature = active.map((cue) => cue.id).join('|')
  if (!force && signature === S.activeSignature) return false
  S.activeSignature = signature
  const ids = new Set(active.map((cue) => cue.id))
  for (const el of els.timelineCues?.children || []) {
    el.classList.toggle('is-active', ids.has(el.dataset.id))
  }
  for (const el of els.cueList?.querySelectorAll('.cue-row') || []) {
    el.classList.toggle('is-current', ids.has(el.dataset.id))
  }
  return true
}

function onVideoMetadata() {
  const video = els.video
  S.videoReady = true
  S.videoLoadFailed = false
  const workspaceVideo = S.workspace?.video
  let duration = workspaceVideo?.durationMs ? workspaceVideo.durationMs / 1000 : video.duration
  if (!Number.isFinite(duration) || duration <= 0) duration = Number(video.duration) || 0
  S.duration = duration

  if (video.videoWidth > 0 && video.videoHeight > 0) {
    S.videoAspect = video.videoWidth / video.videoHeight
  } else if (workspaceVideo?.width && workspaceVideo?.height) {
    S.videoAspect = workspaceVideo.width / workspaceVideo.height
  }

  const restore = Number.isFinite(S.restoreTime) ? S.restoreTime : S.currentTime
  S.currentTime = clamp(restore || 0, 0, Math.max(0, duration - 0.05))
  S.restoreTime = null
  try {
    if (Math.abs(video.currentTime - S.currentTime) > 0.01) video.currentTime = S.currentTime
  } catch { /* 忽略 */ }

  fitPreviewFrame()
  updatePendingUI()
  updateTransport()
  updateChrome()
  renderTimeline()
  updateActiveCueState(true)
  refreshOverlay()
  scheduleExactFrame(250)
}

function onVideoError() {
  const video = els.video
  if (!S.workspace?.video) return
  if (!video.getAttribute('src')) return
  if (S.videoReady) {
    toast('视频播放出现异常，可以尝试重新导入文件', 'error', 5000)
    return
  }
  if (S.videoSourceKey?.startsWith('preview:')) {
    S.workspace.video.preview = { status: 'error', progress: 0, message: '预览文件无法播放，可以重试生成' }
    updatePendingUI()
    return
  }
  if (!S.videoLoadFailed) {
    S.videoLoadFailed = true
    if (S.tools?.ffmpeg?.ok) {
      toast('浏览器无法直接播放这个视频，正在生成预览代理…', 'info')
      forceProxy()
      return
    }
    S.workspace.video.preview = { status: 'error', progress: 0, message: '浏览器无法播放这个视频，且 ffmpeg 不可用' }
    updatePendingUI()
  }
}

function onSeeking() {
  S.seeking = true
  invalidateExactFrame()
}

function onSeeked() {
  S.seeking = false
  S.currentTime = els.video.currentTime
  updateClockUI()
  updateActiveCueState(true)
  refreshOverlay()
  if (!S.playing) {
    scheduleExactFrame(250)
    markDirty()
  }
}

function togglePlay() {
  if (!S.videoReady) return
  if (els.video.paused) {
    els.video.play().catch((err) => toast(`无法播放视频：${err.message}`, 'error', 5000))
  } else {
    els.video.pause()
  }
}

function pauseVideo() {
  if (!els.video.paused) {
    els.video.pause()
  } else {
    S.playing = false
    stopFrameLoop()
    updatePlayState()
    scheduleExactFrame(250)
  }
}

function seekTo(seconds) {
  if (!S.videoReady) return
  const duration = Number.isFinite(S.duration) && S.duration > 0 ? S.duration : Number(els.video.duration) || 0
  const target = clamp(Number(seconds) || 0, 0, Math.max(0, duration - 0.05))
  S.currentTime = target
  try { els.video.currentTime = target } catch { /* 忽略 */ }
  updateClockUI()
  updateActiveCueState(true)
  refreshOverlay()
  invalidateExactFrame()
  if (!S.playing) scheduleExactFrame(250)
}

function seekBy(delta) {
  seekTo(S.currentTime + delta)
}

function setExactCaption(mode) {
  const caption = $('preview-caption')
  if (!caption) return
  if (mode === 'off' || !S.exact) {
    caption.hidden = true
    return
  }
  caption.hidden = false
  const spinner = caption.querySelector('.spinner')
  const text = $('preview-caption-text')
  if (spinner) spinner.hidden = mode === 'shown'
  if (text) text.textContent = mode === 'shown' ? '精确渲染' : '精确渲染中…'
}

function invalidateExactFrame() {
  S.frameToken++
  if (S.frameTimer) { clearTimeout(S.frameTimer); S.frameTimer = null }
  if (S.frameAbort) { S.frameAbort.abort(); S.frameAbort = null }
  if (S.frameUrl) { URL.revokeObjectURL(S.frameUrl); S.frameUrl = null }
  if (els.exactFrame) {
    els.exactFrame.hidden = true
    els.exactFrame.removeAttribute('src')
  }
  setExactCaption('off')
}

function scheduleExactFrame(delay = 280) {
  invalidateExactFrame()
  if (!S.exact || !S.videoReady || S.playing || !S.workspace?.video) return
  if (!S.tools?.ffmpeg?.ok || !S.tools?.ffmpeg?.libass) return
  if (!activeCuesAt(S.cues, (S.currentTime || 0) * 1000).length) return

  const token = S.frameToken
  setExactCaption('loading')
  S.frameTimer = setTimeout(() => {
    S.frameTimer = null
    requestExactFrame(token)
  }, delay)
}

async function requestExactFrame(token) {
  if (token !== S.frameToken) return
  const saved = await flushSave()
  if (!saved || token !== S.frameToken) {
    setExactCaption('off')
    return
  }
  if (!S.exact || S.playing || !S.videoReady) {
    setExactCaption('off')
    return
  }

  const controller = new AbortController()
  S.frameAbort = controller
  const time = S.currentTime
  let objectUrl = null

  try {
    const blob = await api.fetchFrame(time, controller.signal)
    if (token !== S.frameToken) return
    if (S.frameAbort === controller) S.frameAbort = null

    objectUrl = URL.createObjectURL(blob)
    const img = els.exactFrame
    await new Promise((resolve, reject) => {
      img.onload = resolve
      img.onerror = reject
      img.src = objectUrl
    })
    if (token !== S.frameToken) {
      URL.revokeObjectURL(objectUrl)
      return
    }
    if (S.frameUrl) URL.revokeObjectURL(S.frameUrl)
    S.frameUrl = objectUrl
    objectUrl = null
    img.hidden = false
    setExactCaption('shown')
  } catch (err) {
    if (S.frameAbort === controller) S.frameAbort = null
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    if (err.name === 'AbortError') return
    if (token !== S.frameToken) return
    setExactCaption('off')
    if (!S.frameFailShown) {
      S.frameFailShown = true
      toast(`精确预览渲染失败：${err.message}`, 'error', 5000)
    }
  } finally {
    if (S.frameAbort === controller) S.frameAbort = null
  }
}

function updateExactToggle() {
  const button = $('btn-exact')
  if (!button) return
  button.setAttribute('aria-pressed', S.exact ? 'true' : 'false')
  if (!S.exact) {
    invalidateExactFrame()
  } else if (S.videoReady && !S.playing) {
    scheduleExactFrame(250)
  }
}

function chooseTick(duration, width) {
  const factors = [0.5, 1, 2, 2.5, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200]
  const target = duration / (width < 720 ? 5 : 8)
  return factors.find((factor) => factor >= target) || factors[factors.length - 1]
}

function renderTimeline() {
  const ruler = els.timelineRuler
  const cueLayer = els.timelineCues
  if (!ruler || !cueLayer) return
  ruler.replaceChildren()
  cueLayer.replaceChildren()

  const duration = S.duration
  if (!(duration > 0)) {
    updateClockUI()
    updateActiveCueState(true)
    return
  }

  const width = els.timelineTrack?.clientWidth || 600
  const tick = chooseTick(duration, width)
  const withTenths = tick < 1 || !Number.isInteger(tick)
  const tickFragment = document.createDocumentFragment()
  for (let time = 0; time <= duration + 0.0001; time += tick) {
    const label = document.createElement('span')
    label.className = 'timeline-tick'
    label.style.left = `${(Math.min(time, duration) / duration) * 100}%`
    if (time <= 0.0001) label.style.transform = 'translateX(0)'
    else if (duration - time <= 0.0001) label.style.transform = 'translateX(-100%)'
    label.textContent = formatClock(Math.min(time, duration), withTenths)
    tickFragment.appendChild(label)
  }
  ruler.appendChild(tickFragment)

  const fragment = document.createDocumentFragment()
  for (const cue of S.cues) {
    const start = clamp((cue.start || 0) / 1000, 0, duration)
    const end = clamp((cue.end || 0) / 1000, 0, duration)
    if (end <= 0 || start >= duration) continue
    const block = document.createElement('div')
    block.className = 'timeline-cue'
    if (cue.id === S.selectedCueId) block.classList.add('is-selected')
    block.dataset.id = cue.id
    block.style.left = `${(start / duration) * 100}%`
    block.style.width = `${Math.max(0.15, ((end - start) / duration) * 100)}%`
    block.title = `${formatClock(start)} – ${formatClock(end)}\n${cue.text.replace(/\n/g, ' ').slice(0, 80)}`
    fragment.appendChild(block)
  }
  cueLayer.appendChild(fragment)

  updateClockUI()
  updateActiveCueState(true)
}

function updateSelectedClasses() {
  for (const el of els.timelineCues?.children || []) {
    el.classList.toggle('is-selected', el.dataset.id === S.selectedCueId)
  }
  for (const el of els.cueList?.querySelectorAll('.cue-row') || []) {
    el.classList.toggle('is-selected', el.dataset.id === S.selectedCueId)
  }
}

let timelineDragging = false

function timelineTimeFromEvent(event) {
  const track = els.timelineTrack
  const rect = track.getBoundingClientRect()
  const ratio = rect.width > 0 ? clamp((event.clientX - rect.left) / rect.width, 0, 1) : 0
  return ratio * S.duration
}

function onTimelinePointerDown(event) {
  if (event.button !== 0 || !S.videoReady) return
  const cueEl = event.target.closest?.('.timeline-cue')
  if (cueEl) {
    event.preventDefault()
    selectCue(cueEl.dataset.id, { seek: true })
    return
  }
  event.preventDefault()
  timelineDragging = true
  try { els.timelineTrack.setPointerCapture(event.pointerId) } catch { /* 忽略 */ }
  pauseVideo()
  seekTo(timelineTimeFromEvent(event))
}

function onTimelinePointerMove(event) {
  if (!timelineDragging) return
  seekTo(timelineTimeFromEvent(event))
}

function onTimelinePointerUp(event) {
  if (!timelineDragging) return
  timelineDragging = false
  try { els.timelineTrack.releasePointerCapture(event.pointerId) } catch { /* 忽略 */ }
  markDirty()
  if (!S.playing) scheduleExactFrame(250)
}

function onTimelinePointerCancel() {
  timelineDragging = false
}

function normalizeHex(value, fallback = '#ffffff') {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : fallback
}

function pxText(value) {
  const rounded = roundPx(value)
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} px`
}

function togglePressed(el, pressed) {
  if (!el) return
  el.classList.toggle('is-active', pressed)
  el.setAttribute('aria-pressed', pressed ? 'true' : 'false')
}

function setColorControl(inputId, labelId, value) {
  const input = $(inputId)
  const label = $(labelId)
  const hex = normalizeHex(value)
  if (input) input.value = hex
  if (label) label.textContent = hex.toUpperCase()
}

function setModeUI(mode) {
  const boxMode = mode === 'box'
  togglePressed($('mode-outline'), !boxMode)
  togglePressed($('mode-box'), boxMode)
  const boxRow = $('row-box-alpha')
  if (boxRow) boxRow.hidden = !boxMode
  const outlineLabel = $('outline-label')
  const outlineColorLabel = $('outline-color-label')
  if (outlineLabel) outlineLabel.textContent = boxMode ? '底板内边距' : '描边宽度'
  if (outlineColorLabel) outlineColorLabel.textContent = boxMode ? '底板颜色' : '描边颜色'
}

function updateStyleLabels() {
  if (!S.style) return
  const size = videoSize()
  const metrics = computeMetrics(S.style, size.width, size.height)
  const map = {
    'font-size-value': pxText(metrics.fontPx),
    'outline-value': pxText(metrics.outlinePx),
    'shadow-value': pxText(metrics.shadowPx),
    'box-alpha-value': `${Math.round(S.style.boxAlpha)}%`,
    'shadow-alpha-value': `${Math.round(S.style.shadowAlpha)}%`,
    'margin-h-value': pxText(metrics.marginH),
    'margin-v-value': pxText(metrics.marginV),
  }
  for (const [id, value] of Object.entries(map)) {
    const el = $(id)
    if (el) el.textContent = value
  }
}

function syncStyleControls() {
  if (!S.style) return
  const style = S.style
  const size = videoSize()
  const metrics = computeMetrics(style, size.width, size.height)

  const fontInput = $('font-name')
  if (fontInput) fontInput.value = style.fontName || ''
  const fontRange = $('font-size')
  if (fontRange) {
    const maxPx = Math.max(40, Math.round(size.height * 0.25))
    fontRange.max = String(maxPx)
    fontRange.value = String(clamp(Math.round(metrics.fontPx), 10, maxPx))
  }

  togglePressed($('toggle-bold'), Boolean(style.bold))
  togglePressed($('toggle-italic'), Boolean(style.italic))
  setColorControl('color-text', 'color-text-value', style.color)
  setColorControl('color-outline', 'color-outline-value', style.outlineColor)
  setColorControl('color-shadow', 'color-shadow-value', style.shadowColor)

  const outlineRange = $('outline-width')
  if (outlineRange) outlineRange.value = String(style.outlinePct)
  const boxAlpha = $('box-alpha')
  if (boxAlpha) boxAlpha.value = String(style.boxAlpha)
  const shadowRange = $('shadow-size')
  if (shadowRange) shadowRange.value = String(style.shadowPct)
  const shadowAlpha = $('shadow-alpha')
  if (shadowAlpha) shadowAlpha.value = String(style.shadowAlpha)
  const marginH = $('margin-h')
  if (marginH) marginH.value = String(style.marginHPct)
  const marginV = $('margin-v')
  if (marginV) marginV.value = String(style.marginVPct)

  for (const button of document.querySelectorAll('#align-grid .align-btn')) {
    button.classList.toggle('is-active', Number(button.dataset.align) === style.alignment)
  }

  setModeUI(style.borderMode)
  updateStyleLabels()
}

function onStyleEdited() {
  refreshOverlay()
  markDirty()
  scheduleExactFrame(300)
}

function setTab(tab, options = {}) {
  S.activeTab = tab === 'timing' ? 'timing' : 'style'
  const styleTab = $('tab-style')
  const timingTab = $('tab-timing')
  const stylePanel = $('panel-style')
  const timingPanel = $('panel-timing')
  const isTiming = S.activeTab === 'timing'
  if (styleTab) { styleTab.classList.toggle('is-active', !isTiming); styleTab.setAttribute('aria-selected', String(!isTiming)) }
  if (timingTab) { timingTab.classList.toggle('is-active', isTiming); timingTab.setAttribute('aria-selected', String(isTiming)) }
  if (stylePanel) stylePanel.hidden = isTiming
  if (timingPanel) timingPanel.hidden = !isTiming
  writePref(LS_TAB, S.activeTab)
  if (!options.silent) {
    if (isTiming) syncTimingPanel()
    else syncStyleControls()
  }
}

function bindStyleEvents() {
  $('font-name')?.addEventListener('input', (event) => {
    const value = event.target.value.trim()
    if (!value) return
    S.style.fontName = value.slice(0, 80)
    onStyleEdited()
  })
  $('font-name')?.addEventListener('blur', (event) => {
    if (!event.target.value.trim()) event.target.value = S.style.fontName || ''
  })

  $('font-size')?.addEventListener('input', (event) => {
    const size = videoSize()
    const px = Number(event.target.value)
    if (!Number.isFinite(px)) return
    S.style.sizePct = clamp((px / size.height) * 100, 1, 25)
    updateStyleLabels()
    onStyleEdited()
  })

  $('toggle-bold')?.addEventListener('click', () => {
    S.style.bold = !S.style.bold
    togglePressed($('toggle-bold'), S.style.bold)
    onStyleEdited()
  })
  $('toggle-italic')?.addEventListener('click', () => {
    S.style.italic = !S.style.italic
    togglePressed($('toggle-italic'), S.style.italic)
    onStyleEdited()
  })

  const colorBindings = [
    ['color-text', 'color-text-value', 'color'],
    ['color-outline', 'color-outline-value', 'outlineColor'],
    ['color-shadow', 'color-shadow-value', 'shadowColor'],
  ]
  for (const [inputId, labelId, key] of colorBindings) {
    $(inputId)?.addEventListener('input', (event) => {
      const hex = normalizeHex(event.target.value)
      S.style[key] = hex
      const label = $(labelId)
      if (label) label.textContent = hex.toUpperCase()
      onStyleEdited()
    })
  }

  $('outline-width')?.addEventListener('input', (event) => {
    S.style.outlinePct = clamp(Number(event.target.value) || 0, 0, 20)
    updateStyleLabels()
    onStyleEdited()
  })
  $('box-alpha')?.addEventListener('input', (event) => {
    S.style.boxAlpha = clamp(Number(event.target.value) || 0, 0, 100)
    updateStyleLabels()
    onStyleEdited()
  })
  $('shadow-size')?.addEventListener('input', (event) => {
    S.style.shadowPct = clamp(Number(event.target.value) || 0, 0, 20)
    updateStyleLabels()
    onStyleEdited()
  })
  $('shadow-alpha')?.addEventListener('input', (event) => {
    S.style.shadowAlpha = clamp(Number(event.target.value) || 0, 0, 100)
    updateStyleLabels()
    onStyleEdited()
  })
  $('margin-h')?.addEventListener('input', (event) => {
    S.style.marginHPct = clamp(Number(event.target.value) || 0, 0, 45)
    updateStyleLabels()
    onStyleEdited()
  })
  $('margin-v')?.addEventListener('input', (event) => {
    S.style.marginVPct = clamp(Number(event.target.value) || 0, 0, 45)
    updateStyleLabels()
    onStyleEdited()
  })

  $('mode-outline')?.addEventListener('click', () => {
    S.style.borderMode = 'outline'
    setModeUI('outline')
    syncStyleControls()
    onStyleEdited()
  })
  $('mode-box')?.addEventListener('click', () => {
    S.style.borderMode = 'box'
    setModeUI('box')
    syncStyleControls()
    onStyleEdited()
  })

  for (const button of document.querySelectorAll('#align-grid .align-btn')) {
    button.addEventListener('click', () => {
      S.style.alignment = Number(button.dataset.align)
      syncStyleControls()
      onStyleEdited()
    })
  }

  $('btn-reset-style')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '恢复默认样式',
      message: '会覆盖当前的字体、颜色、描边和位置设置，字幕文本与时间不会受影响。',
      confirmText: '恢复默认',
      danger: true,
    })
    if (!ok) return
    S.style = { ...(S.defaults || {}) }
    syncStyleControls()
    onStyleEdited()
    toast('已恢复默认样式', 'success')
  })

  $('tab-style')?.addEventListener('click', () => setTab('style'))
  $('tab-timing')?.addEventListener('click', () => setTab('timing'))
}

function syncOffsetUI(force = false) {
  const input = $('offset-input')
  if (input && (force || document.activeElement !== input)) {
    input.value = (S.offsetMs / 1000).toFixed(2)
  }
  const label = $('timeline-offset')
  if (label) {
    const sign = S.offsetMs > 0 ? '+' : ''
    label.textContent = `偏移 ${sign}${(S.offsetMs / 1000).toFixed(2)}s`
  }
}

function syncCueEditor() {
  const editor = $('cue-editor')
  const emptyHint = $('cue-empty')
  if (!editor || !emptyHint) return
  if (!S.cues.length) {
    editor.hidden = true
    emptyHint.hidden = true
    return
  }
  const cue = findCue(S.selectedCueId)
  if (!cue) {
    editor.hidden = true
    emptyHint.hidden = false
    return
  }
  editor.hidden = false
  emptyHint.hidden = true
  $('cue-number').textContent = String(S.cues.indexOf(cue) + 1)
  $('cue-start').value = formatSecondsInput(cue.start / 1000)
  $('cue-end').value = formatSecondsInput(cue.end / 1000)
  $('cue-text').value = cue.text
}

function syncTimingPanel() {
  if (!S.workspace) return
  const count = $('cue-count')
  if (count) count.textContent = String(S.cues.length)
  syncOffsetUI()
  syncCueEditor()
}

function updateCueRowTime(cue) {
  if (!els.cueList) return
  const row = Array.from(els.cueList.querySelectorAll('.cue-row')).find((item) => item.dataset.id === cue.id)
  const time = row?.querySelector('.cue-row-time')
  if (time) time.textContent = `${formatClock(cue.start / 1000, true)} → ${formatClock(cue.end / 1000, true)}`
}

function updateCueRowText(cue) {
  if (!els.cueList) return
  const row = Array.from(els.cueList.querySelectorAll('.cue-row')).find((item) => item.dataset.id === cue.id)
  const text = row?.querySelector('.cue-row-text')
  if (text) text.textContent = cue.text.replace(/\n/g, ' ') || '（空）'
}

function renderCueList() {
  if (!els.cueList) return
  els.cueList.replaceChildren()
  const count = $('cue-count')
  if (count) count.textContent = String(S.cues.length)

  if (!S.cues.length) {
    const empty = document.createElement('div')
    empty.className = 'cue-list-empty'
    empty.innerHTML = `${icon('captions')}<span>还没有字幕，拖入 SRT / ASS / VTT 文件</span>`
    els.cueList.appendChild(empty)
    S.selectedCueId = null
    syncCueEditor()
    updateActiveCueState(true)
    return
  }

  const fragment = document.createDocumentFragment()
  S.cues.forEach((cue, index) => {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'cue-row'
    row.dataset.id = cue.id
    if (cue.id === S.selectedCueId) row.classList.add('is-selected')

    const top = document.createElement('div')
    top.className = 'cue-row-top'
    const indexEl = document.createElement('span')
    indexEl.className = 'cue-index'
    indexEl.textContent = String(index + 1)
    const time = document.createElement('span')
    time.className = 'cue-row-time'
    time.textContent = `${formatClock(cue.start / 1000, true)} → ${formatClock(cue.end / 1000, true)}`
    top.append(indexEl, time)

    const text = document.createElement('span')
    text.className = 'cue-row-text'
    text.textContent = cue.text.replace(/\n/g, ' ') || '（空）'
    row.append(top, text)
    fragment.appendChild(row)
  })
  els.cueList.appendChild(fragment)
  updateActiveCueState(true)
  syncCueEditor()
}

function selectCue(id, options = {}) {
  const cue = findCue(id)
  if (!cue) return
  S.selectedCueId = id
  if (S.playing) pauseVideo()
  if (options.seek !== false) seekTo(cue.start / 1000 + 0.005)
  updateSelectedClasses()
  syncCueEditor()
  if (options.scroll) {
    const row = Array.from(els.cueList.querySelectorAll('.cue-row')).find((item) => item.dataset.id === id)
    row?.scrollIntoView({ block: 'nearest' })
  }
}

function afterCueGeometryChange() {
  const cue = findCue(S.selectedCueId)
  if (cue) updateCueRowTime(cue)
  renderTimeline()
  syncCueEditor()
  refreshOverlay()
  markDirty()
  scheduleExactFrame(300)
}

function onCueStartChange() {
  const cue = findCue(S.selectedCueId)
  if (!cue) return
  const raw = $('cue-start').value.trim()
  if (!raw) {
    syncCueEditor()
    return
  }
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds < 0) {
    syncCueEditor()
    return
  }
  cue.start = clamp(Math.round(seconds * 1000), 0, MAX_TIME_MS)
  if (cue.end <= cue.start) cue.end = Math.min(MAX_TIME_MS, cue.start + 10)
  afterCueGeometryChange()
}

function onCueEndChange() {
  const cue = findCue(S.selectedCueId)
  if (!cue) return
  const raw = $('cue-end').value.trim()
  if (!raw) {
    syncCueEditor()
    return
  }
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds < 0) {
    syncCueEditor()
    return
  }
  cue.end = clamp(Math.round(seconds * 1000), 0, MAX_TIME_MS)
  if (cue.end <= cue.start) cue.end = Math.min(MAX_TIME_MS, cue.start + 10)
  afterCueGeometryChange()
}

function setCueBoundaryFromPlayhead(which) {
  const cue = findCue(S.selectedCueId)
  if (!cue) return
  const time = Math.round((S.currentTime || 0) * 1000)
  if (which === 'start') {
    cue.start = clamp(time, 0, Math.max(0, cue.end - 10))
    if (cue.end <= cue.start) cue.end = Math.min(MAX_TIME_MS, cue.start + 10)
  } else {
    cue.end = clamp(Math.max(time, cue.start + 10), cue.start + 10, MAX_TIME_MS)
  }
  afterCueGeometryChange()
}

async function deleteSelectedCue() {
  const cue = findCue(S.selectedCueId)
  if (!cue) return
  const ok = await confirmDialog({
    title: '删除这条字幕',
    message: `确定删除「${cue.text.replace(/\n/g, ' ').slice(0, 40) || '空白字幕'}」吗？删除后无法恢复。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  const scrollTop = els.cueList?.scrollTop || 0
  S.cues = S.cues.filter((item) => item.id !== cue.id)
  S.selectedCueId = null
  renderCueList()
  if (els.cueList) els.cueList.scrollTop = scrollTop
  renderTimeline()
  refreshOverlay()
  updateChrome()
  markDirty()
  scheduleExactFrame(300)
  toast('已删除这条字幕', 'success')
}

function locateCurrentCue() {
  const active = activeCuesAt(S.cues, (S.currentTime || 0) * 1000)
  if (!active.length) {
    toast('当前时间没有正在显示的字幕', 'info')
    return
  }
  selectCue(active[0].id, { seek: false, scroll: true })
}

function applyOffsetDelta(deltaMs) {
  let delta = Math.round(Number(deltaMs) || 0)
  if (!delta) {
    syncOffsetUI(true)
    return
  }

  if (delta < 0 && S.cues.length) {
    const earliest = Math.min(...S.cues.map((cue) => cue.start))
    if (earliest < -delta) delta = -earliest
  }
  if (!delta) {
    syncOffsetUI(true)
    return
  }

  S.offsetMs = clamp(S.offsetMs + delta, -MAX_TIME_MS, MAX_TIME_MS)
  const cueById = new Map()
  for (const cue of S.cues) {
    cue.start = Math.max(0, cue.start + delta)
    cue.end = Math.min(MAX_TIME_MS, Math.max(cue.start + 10, cue.end + delta))
    cueById.set(cue.id, cue)
  }
  if (els.cueList) {
    for (const row of els.cueList.querySelectorAll('.cue-row')) {
      const cue = cueById.get(row.dataset.id)
      const time = row.querySelector('.cue-row-time')
      if (cue && time) time.textContent = `${formatClock(cue.start / 1000, true)} → ${formatClock(cue.end / 1000, true)}`
    }
  }
  syncOffsetUI(true)
  renderTimeline()
  syncCueEditor()
  refreshOverlay()
  markDirty()
  scheduleExactFrame(300)
}

function bindTimingEvents() {
  els.cueList?.addEventListener('click', (event) => {
    const row = event.target.closest?.('.cue-row')
    if (!row) return
    selectCue(row.dataset.id, { seek: true })
  })

  $('cue-start')?.addEventListener('change', onCueStartChange)
  $('cue-end')?.addEventListener('change', onCueEndChange)
  $('cue-text')?.addEventListener('input', (event) => {
    const cue = findCue(S.selectedCueId)
    if (!cue) return
    cue.text = event.target.value
    updateCueRowText(cue)
    refreshOverlay()
    markDirty()
    scheduleExactFrame(400)
  })
  $('cue-start-now')?.addEventListener('click', () => setCueBoundaryFromPlayhead('start'))
  $('cue-end-now')?.addEventListener('click', () => setCueBoundaryFromPlayhead('end'))
  $('btn-delete-cue')?.addEventListener('click', deleteSelectedCue)
  $('btn-locate-current')?.addEventListener('click', locateCurrentCue)

  $('offset-input')?.addEventListener('change', (event) => {
    const raw = event.target.value.trim()
    if (!raw) {
      syncOffsetUI(true)
      return
    }
    const seconds = Number(raw)
    if (!Number.isFinite(seconds)) {
      syncOffsetUI(true)
      return
    }
    const target = clamp(Math.round(seconds * 1000), -MAX_TIME_MS, MAX_TIME_MS)
    applyOffsetDelta(target - S.offsetMs)
  })
  $('offset-minus-1')?.addEventListener('click', () => applyOffsetDelta(-1000))
  $('offset-minus-01')?.addEventListener('click', () => applyOffsetDelta(-100))
  $('offset-plus-01')?.addEventListener('click', () => applyOffsetDelta(100))
  $('offset-plus-1')?.addEventListener('click', () => applyOffsetDelta(1000))
  $('offset-reset')?.addEventListener('click', () => {
    if (S.offsetMs === 0) {
      syncOffsetUI(true)
      return
    }
    applyOffsetDelta(-S.offsetMs)
  })
}

const VIDEO_ACCEPT = 'video/*,.mp4,.mov,.m4v,.mkv,.avi,.webm,.flv,.wmv,.ts,.m2ts,.ogv'
const SUB_ACCEPT = '.srt,.ass,.ssa,.vtt,.txt'
const ALL_ACCEPT = `${VIDEO_ACCEPT},${SUB_ACCEPT}`

function openPicker(mode = 'any') {
  const input = $('file-input')
  if (!input) return
  input.accept = mode === 'video' ? VIDEO_ACCEPT : mode === 'subtitle' ? SUB_ACCEPT : ALL_ACCEPT
  input.value = ''
  input.click()
}

function showUploadBanner(kind, file) {
  const banner = $('upload-banner')
  if (!banner) return
  $('upload-title').textContent = `${kind === 'video' ? '正在上传视频' : '正在上传字幕'} · ${file.name}`
  $('upload-detail').textContent = '0%'
  $('upload-bar').style.width = '0%'
  const cancel = $('btn-cancel-upload')
  if (cancel) cancel.disabled = false
  banner.hidden = false
}

function updateUploadProgress(percent) {
  const value = clamp(Number(percent) || 0, 0, 100)
  const detail = $('upload-detail')
  const bar = $('upload-bar')
  if (detail) detail.textContent = `${Math.round(value)}%`
  if (bar) bar.style.width = `${value}%`
}

function hideUploadBanner() {
  const banner = $('upload-banner')
  if (banner) banner.hidden = true
}

async function uploadOne(kind, file) {
  const controller = new AbortController()
  S.uploadAbort = controller
  showUploadBanner(kind, file)
  try {
    const result = await api.upload(kind, file, {
      signal: controller.signal,
      onProgress: updateUploadProgress,
    })
    if (!result?.workspace) throw new Error('服务没有返回新的工作区状态')
    const workspace = result.workspace
    if (kind === 'video') S.currentTime = 0
    if (kind === 'subtitle' && workspace.subtitle?.hash !== S.workspace?.subtitle?.hash) {
      S.selectedCueId = null
    }
    applyWorkspace(workspace, { videoChanged: kind === 'video', time: S.currentTime })
    toast(kind === 'video' ? '视频已就绪' : '字幕已导入', 'success')
    return true
  } catch (err) {
    if (err.name === 'AbortError') toast('已取消上传', 'info')
    else toast(`${kind === 'video' ? '视频' : '字幕'}上传失败：${err.message}`, 'error', 5000)
    return false
  } finally {
    S.uploadAbort = null
  }
}

async function handleFiles(files) {
  if (S.uploading) {
    toast('正在上传文件，稍等一下', 'info')
    return
  }
  if (isExportRunning()) {
    toast('导出正在进行，完成后再替换文件', 'warning')
    return
  }

  const videos = []
  const subtitles = []
  for (const file of files) {
    const ext = extOf(file.name)
    if (VIDEO_EXT.has(ext)) videos.push(file)
    else if (SUB_EXT.has(ext)) subtitles.push(file)
  }
  if (!videos.length && !subtitles.length) {
    toast('只支持视频文件和 SRT / ASS / VTT 字幕文件', 'error')
    return
  }
  if (videos.length > 1) toast('一次只处理一个视频，多余的会被忽略', 'info')
  if (subtitles.length > 1) toast('一次只处理一个字幕文件，多余的会被忽略', 'info')

  S.uploading = true
  updateExportAvailability()
  pauseVideo()

  try {
    const saved = await flushSave()
    if (!saved) toast('当前调整没有保存成功，仍会继续导入', 'warning')
    const video = videos[0]
    const subtitle = subtitles[0]
    if (video) {
      const ok = await uploadOne('video', video)
      if (!ok) return
    }
    if (subtitle) await uploadOne('subtitle', subtitle)
  } finally {
    S.uploading = false
    hideUploadBanner()
    updateExportAvailability()
  }
}

function hasFilesDrag(event) {
  const types = event.dataTransfer?.types
  return Boolean(types && Array.from(types).includes('Files'))
}

function setDragVisual(active) {
  const veil = $('drop-veil')
  if (veil) veil.hidden = !active || Boolean($('editor')?.hidden)
  $('empty-state')?.classList.toggle('is-dragging', active)
}

function bindUploadEvents() {
  $('file-input')?.addEventListener('change', (event) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    if (files.length) handleFiles(files)
  })

  $('btn-import')?.addEventListener('click', () => openPicker('any'))
  $('drop-video')?.addEventListener('click', () => openPicker('video'))
  $('drop-subtitle')?.addEventListener('click', () => openPicker('subtitle'))
  $('chip-video')?.addEventListener('click', () => openPicker('video'))
  $('chip-subtitle')?.addEventListener('click', () => openPicker('subtitle'))
  $('btn-preview-retry')?.addEventListener('click', () => forceProxy())
  $('btn-cancel-upload')?.addEventListener('click', () => S.uploadAbort?.abort())

  window.addEventListener('dragenter', (event) => {
    if (!hasFilesDrag(event)) return
    event.preventDefault()
    S.dragDepth++
    setDragVisual(true)
  })
  window.addEventListener('dragover', (event) => {
    if (!hasFilesDrag(event)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  })
  window.addEventListener('dragleave', (event) => {
    if (!hasFilesDrag(event)) return
    S.dragDepth = Math.max(0, S.dragDepth - 1)
    if (!S.dragDepth) setDragVisual(false)
  })
  window.addEventListener('drop', (event) => {
    if (!hasFilesDrag(event)) return
    event.preventDefault()
    S.dragDepth = 0
    setDragVisual(false)
    const files = Array.from(event.dataTransfer?.files || [])
    if (files.length) handleFiles(files)
  })
}

const EXPORT_BODIES = ['export-stage-form', 'export-stage-progress', 'export-stage-done', 'export-stage-error']
const EXPORT_FEET = ['export-foot-form', 'export-foot-progress', 'export-foot-done', 'export-foot-error']

function showExportStage(stage) {
  for (const id of EXPORT_BODIES) {
    const el = $(id)
    if (el) el.hidden = id !== `export-stage-${stage}`
  }
  for (const id of EXPORT_FEET) {
    const el = $(id)
    if (el) el.hidden = id !== `export-foot-${stage}`
  }
  const close = $('btn-close-export')
  if (close) close.disabled = stage === 'progress'
  if (stage === 'progress') {
    const stop = $('btn-export-stop')
    if (stop) {
      stop.disabled = false
      stop.textContent = '停止导出'
    }
  }
}

function fillExportSummary() {
  const videoName = S.workspace?.video?.originalName || '视频'
  $('export-video-name').textContent = videoName
  $('export-subtitle-count').textContent = `${S.cues.length} 条`
  $('export-output-name').textContent = ''
  $('export-percent').textContent = '0%'
  $('export-speed').textContent = '准备中…'
  $('export-time').textContent = `00:00 / ${formatClock(S.duration)}`
  $('export-bar').style.width = '0%'
  $('btn-download-export').href = '#'
  $('btn-download-export').removeAttribute('download')
}

function openExportModal() {
  if (!S.workspace?.video) {
    toast('先导入视频文件', 'warning')
    return
  }
  if (!S.cues.length) {
    toast('先导入字幕文件', 'warning')
    return
  }
  if (!S.tools?.ffmpeg?.ok || !S.tools?.ffmpeg?.libass) {
    toast('ffmpeg 或 libass 不可用，暂时无法导出', 'error', 5000)
    return
  }
  pauseVideo()
  invalidateExactFrame()
  stopExportPolling()
  S.exportJob = null
  fillExportSummary()
  showExportStage('form')
  const standard = document.querySelector('input[name="quality"][value="standard"]')
  if (standard) standard.checked = true
  const start = $('btn-export-start')
  if (start) start.disabled = false
  $('export-modal').hidden = false
  setTimeout(() => start?.focus(), 0)
}

function closeExportModal() {
  if (isExportRunning()) return
  stopExportPolling()
  S.exportJob = null
  $('export-modal').hidden = true
  updateExportAvailability()
}

function renderExportProgress() {
  const job = S.exportJob
  if (!job) return
  const percent = clamp(Number(job.percent) || 0, 0, 100)
  $('export-percent').textContent = `${Math.round(percent)}%`
  $('export-bar').style.width = `${percent}%`
  $('export-speed').textContent = job.speed ? `速度 ${job.speed}` : '正在编码…'
  const totalMs = S.workspace?.video?.durationMs || 0
  $('export-time').textContent = `${formatClock((job.timeMs || 0) / 1000)} / ${formatClock(totalMs / 1000)}`
  $('export-output-name').textContent = job.outputName || ''
}

function stopExportPolling() {
  if (S.exportTimer) {
    clearTimeout(S.exportTimer)
    S.exportTimer = null
  }
}

function scheduleExportPoll() {
  stopExportPolling()
  S.exportTimer = setTimeout(pollExport, 600)
}

async function beginExport() {
  if (isExportRunning()) return
  const startBtn = $('btn-export-start')
  if (startBtn) startBtn.disabled = true
  const quality = document.querySelector('input[name="quality"]:checked')?.value || 'standard'

  const saved = await flushSave()
  if (!saved) {
    if (startBtn) startBtn.disabled = false
    toast('当前调整保存失败，暂时不能导出', 'error', 5000)
    return
  }

  try {
    const result = await api.startExport(quality)
    S.exportJob = result.job
    showExportStage('progress')
    renderExportProgress()
    scheduleExportPoll()
    updateExportAvailability()
  } catch (err) {
    if (err.status === 409 && err.data?.job) {
      S.exportJob = err.data.job
      showExportStage('progress')
      renderExportProgress()
      scheduleExportPoll()
      updateExportAvailability()
      toast('已经有一个导出任务在进行', 'warning')
      return
    }
    if (startBtn) startBtn.disabled = false
    $('export-error-text').textContent = err.message
    showExportStage('error')
    updateExportAvailability()
  }
}

async function stopExport() {
  const job = S.exportJob
  if (!job || job.status !== 'running') return
  const button = $('btn-export-stop')
  if (button) {
    button.disabled = true
    button.textContent = '正在停止…'
  }
  try {
    const result = await api.cancelExport(job.id)
    S.exportJob = result.job
    if (S.exportJob.status !== 'running') scheduleExportPoll()
  } catch (err) {
    if (button) {
      button.disabled = false
      button.textContent = '停止导出'
    }
    toast(`停止导出失败：${err.message}`, 'error', 5000)
  }
}

function finishExportSuccess(job) {
  showExportStage('done')
  $('export-done-name').textContent = job.outputName || '导出完成'
  $('export-done-size').textContent = `${formatBytes(job.size)} · 已保存到 data/exports 目录`
  const download = $('btn-download-export')
  if (download) {
    download.href = job.outputUrl || '#'
    if (job.outputName) download.setAttribute('download', job.outputName)
  }
  updateExportAvailability()
  toast('字幕已经烧进视频了', 'success', 5000)
}

async function pollExport() {
  if (!S.exportJob) return
  let job
  try {
    const result = await api.getExport(S.exportJob.id)
    job = result.job
    S.exportJob = job
  } catch (err) {
    S.exportJob = { ...S.exportJob, status: 'failed', error: err.message }
    $('export-error-text').textContent = err.message
    showExportStage('error')
    updateExportAvailability()
    return
  }

  if (job.status === 'running') {
    renderExportProgress()
    scheduleExportPoll()
    return
  }

  if (job.status === 'success') {
    finishExportSuccess(job)
    return
  }

  if (job.status === 'cancelled') {
    toast('已停止导出', 'info')
    S.exportJob = { ...job, status: 'failed' }
    closeExportModal()
    return
  }

  $('export-error-text').textContent = job.error || '导出没有完成，请查看服务日志'
  showExportStage('error')
  updateExportAvailability()
}

function retryExport() {
  stopExportPolling()
  S.exportJob = null
  const start = $('btn-export-start')
  if (start) start.disabled = false
  showExportStage('form')
  updateExportAvailability()
}

async function revealExportFolder() {
  try {
    await api.revealExports()
  } catch (err) {
    toast(`无法打开文件夹：${err.message}`, 'error', 5000)
  }
}

function bindExportEvents() {
  $('btn-export')?.addEventListener('click', openExportModal)
  $('btn-close-export')?.addEventListener('click', closeExportModal)
  $('btn-export-cancel')?.addEventListener('click', closeExportModal)
  $('btn-export-done-close')?.addEventListener('click', closeExportModal)
  $('btn-export-error-close')?.addEventListener('click', closeExportModal)
  $('btn-export-start')?.addEventListener('click', beginExport)
  $('btn-export-stop')?.addEventListener('click', stopExport)
  $('btn-export-retry')?.addEventListener('click', retryExport)
  $('btn-reveal-folder')?.addEventListener('click', revealExportFolder)
  $('export-modal')?.addEventListener('click', (event) => {
    if (event.target.id !== 'export-modal') return
    if (!isExportRunning()) closeExportModal()
  })
}

function bindVideoEvents() {
  els.video.addEventListener('loadedmetadata', onVideoMetadata)
  els.video.addEventListener('error', onVideoError)
  els.video.addEventListener('play', () => {
    S.playing = true
    invalidateExactFrame()
    updatePlayState()
    startFrameLoop()
  })
  els.video.addEventListener('pause', () => {
    S.playing = false
    stopFrameLoop()
    updatePlayState()
    if (S.videoReady) {
      scheduleExactFrame(300)
      markDirty()
    }
  })
  els.video.addEventListener('ended', () => {
    S.playing = false
    stopFrameLoop()
    updatePlayState()
    scheduleExactFrame(300)
    markDirty()
  })
  els.video.addEventListener('timeupdate', () => {
    S.currentTime = els.video.currentTime
    updateClockUI()
    if (updateActiveCueState()) refreshOverlay()
  })
  els.video.addEventListener('seeking', onSeeking)
  els.video.addEventListener('seeked', onSeeked)
}

function bindGlobalEvents() {
  els.timelineTrack?.addEventListener('pointerdown', onTimelinePointerDown)
  els.timelineTrack?.addEventListener('pointermove', onTimelinePointerMove)
  els.timelineTrack?.addEventListener('pointerup', onTimelinePointerUp)
  els.timelineTrack?.addEventListener('pointercancel', onTimelinePointerCancel)

  $('btn-play')?.addEventListener('click', togglePlay)
  $('btn-skip-back')?.addEventListener('click', () => seekBy(-5))
  $('btn-skip-fwd')?.addEventListener('click', () => seekBy(5))
  $('btn-exact')?.addEventListener('click', () => {
    S.exact = !S.exact
    writePref(LS_EXACT, S.exact ? 'on' : 'off')
    updateExactToggle()
    if (S.exact && S.videoReady && !S.playing) scheduleExactFrame(100)
  })

  els.previewFrame?.addEventListener('click', (event) => {
    if (event.target.closest?.('button, .preview-pending, .preview-caption, .drop-veil')) return
    if (!S.videoReady) return
    togglePlay()
  })

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return
    const confirmOpen = $('confirm-modal') && !$('confirm-modal').hidden
    if (confirmOpen) return
    const exportOpen = $('export-modal') && !$('export-modal').hidden
    if (exportOpen) {
      if (event.key === 'Escape' && !isExportRunning()) closeExportModal()
      return
    }
    const target = event.target
    if (target && target.closest && target.closest('input, textarea, select, button, [contenteditable="true"]')) return
    if (event.key === ' ') {
      event.preventDefault()
      togglePlay()
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      seekBy(-5)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      seekBy(5)
    }
  })

  if (typeof ResizeObserver !== 'undefined' && els.previewStage) {
    new ResizeObserver(() => fitPreviewFrame()).observe(els.previewStage)
  }
  window.addEventListener('resize', () => fitPreviewFrame())

  if (document.fonts?.ready) {
    document.fonts.ready.then(() => refreshOverlay()).catch(() => {})
  }

  window.addEventListener('pagehide', () => {
    if (!S.workspace || S.dirtyRev === S.savedRev) return
    try {
      const body = JSON.stringify(buildSavePayload())
      if (body.length < 60000) {
        fetch('/api/state', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: true,
        })
      }
    } catch { /* 关闭页面时忽略 */ }
  })

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && S.workspace && S.dirtyRev !== S.savedRev) {
      flushSave()
    }
  })
}

let eventsBound = false

function bindEvents() {
  if (eventsBound) return
  eventsBound = true
  bindStyleEvents()
  bindTimingEvents()
  bindUploadEvents()
  bindExportEvents()
  bindVideoEvents()
  bindGlobalEvents()
}

boot()





