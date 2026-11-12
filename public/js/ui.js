export function icon(name, className = 'icon') {
  return `<svg class="${className}" aria-hidden="true"><use href="#i-${name}"></use></svg>`
}

export function pad2(value) {
  return String(Math.floor(value)).padStart(2, '0')
}

export function formatClock(seconds, withTenths = false) {
  let value = Number(seconds)
  if (!Number.isFinite(value) || value < 0) value = 0
  value = Math.floor(value * 10) / 10
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor((value % 3600) / 60)
  const secs = Math.floor(value % 60)
  const base = hours > 0
    ? `${hours}:${pad2(minutes)}:${pad2(secs)}`
    : `${pad2(minutes)}:${pad2(secs)}`
  if (!withTenths) return base
  return `${base}.${Math.floor((value * 10) % 10)}`
}

export function formatSecondsInput(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value < 0) return '0.00'
  return value.toFixed(2)
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function debounce(fn, wait) {
  let timer = null
  const wrapped = (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => { timer = null; fn(...args) }, wait)
  }
  wrapped.cancel = () => { clearTimeout(timer); timer = null }
  return wrapped
}

const TOAST_ICONS = {
  success: 'check',
  error: 'alert',
  warning: 'alert',
  info: 'spark',
}

export function toast(message, type = 'info', duration = 3500) {
  const stack = document.getElementById('toast-stack')
  if (!stack) return
  while (stack.children.length >= 4) stack.firstElementChild?.remove()

  const item = document.createElement('div')
  item.className = `toast is-${type}`
  const iconWrap = document.createElement('span')
  iconWrap.innerHTML = icon(TOAST_ICONS[type] || 'spark')
  const text = document.createElement('span')
  text.textContent = message
  item.append(iconWrap.firstElementChild, text)
  stack.appendChild(item)

  const remove = () => {
    if (!item.isConnected) return
    item.classList.add('is-leaving')
    setTimeout(() => item.remove(), 220)
  }
  setTimeout(remove, duration)
}

let confirmResolver = null
let confirmBound = false

function settleConfirm(value) {
  if (!confirmResolver) return
  const resolve = confirmResolver
  confirmResolver = null
  const modal = document.getElementById('confirm-modal')
  if (modal) modal.hidden = true
  resolve(value)
}

function bindConfirm() {
  if (confirmBound) return
  confirmBound = true
  document.getElementById('confirm-cancel')?.addEventListener('click', () => settleConfirm(false))
  document.getElementById('confirm-ok')?.addEventListener('click', () => settleConfirm(true))
  document.getElementById('confirm-modal')?.addEventListener('click', (event) => {
    if (event.target.id === 'confirm-modal') settleConfirm(false)
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && confirmResolver) settleConfirm(false)
  })
}

export function confirmDialog(options = {}) {
  bindConfirm()
  const modal = document.getElementById('confirm-modal')
  const title = document.getElementById('confirm-title')
  const message = document.getElementById('confirm-message')
  const ok = document.getElementById('confirm-ok')
  if (!modal || !title || !message || !ok) return Promise.resolve(false)

  if (confirmResolver) settleConfirm(false)

  title.textContent = options.title || '确认操作'
  message.textContent = options.message || '确定要继续吗？'
  ok.textContent = options.confirmText || '确认'
  ok.classList.toggle('btn-danger', Boolean(options.danger))
  ok.classList.toggle('btn-primary', !options.danger)

  modal.hidden = false
  setTimeout(() => ok.focus(), 0)

  return new Promise((resolve) => {
    confirmResolver = resolve
  })
}
