export class ApiError extends Error {
  constructor(message, status = 0, data = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.data = data
  }
}

async function requestJson(url, options = {}) {
  let res
  try {
    res = await fetch(url, { cache: 'no-store', ...options })
  } catch (err) {
    throw new ApiError(`无法连接本地服务：${err.message}`)
  }

  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = null }

  if (!res.ok) {
    throw new ApiError((data && data.error) || `请求失败（HTTP ${res.status}）`, res.status, data)
  }
  return data
}

export function getState() {
  return requestJson('/api/state')
}

export function saveState(patch, options = {}) {
  return requestJson('/api/state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    keepalive: Boolean(options.keepalive),
  })
}

export function startPreviewBuild() {
  return requestJson('/api/preview/build', { method: 'POST' })
}

export async function fetchFrame(timeSeconds, signal) {
  let res
  try {
    res = await fetch(`/api/frame?t=${encodeURIComponent(timeSeconds.toFixed(3))}&_=${Date.now()}`, { cache: 'no-store', signal })
  } catch (err) {
    if (err.name === 'AbortError') throw err
    throw new ApiError(`无法获取校验帧：${err.message}`)
  }
  if (!res.ok) {
    let message = `校验帧渲染失败（HTTP ${res.status}）`
    try {
      const data = await res.json()
      if (data && data.error) message = data.error
    } catch { /* 使用默认错误信息 */ }
    throw new ApiError(message, res.status)
  }
  return res.blob()
}

function abortError() {
  const err = new Error('已取消')
  err.name = 'AbortError'
  return err
}

export function upload(kind, file, options = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const url = `/api/${kind}?name=${encodeURIComponent(file.name)}`
    let settled = false
    let aborted = false

    const cleanup = () => {
      if (options.signal) options.signal.removeEventListener('abort', onAbort)
    }
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      cleanup()
      fn(value)
    }
    const onAbort = () => {
      aborted = true
      try { xhr.abort() } catch { /* 忽略 */ }
      finish(reject, abortError())
    }

    xhr.open('POST', url)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || !options.onProgress) return
      const percent = Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100)))
      options.onProgress(percent)
    }
    xhr.onload = () => {
      if (aborted) return
      let data = null
      try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null } catch { data = null }
      if (xhr.status >= 200 && xhr.status < 300) {
        finish(resolve, data)
      } else {
        const message = (data && data.error) || `上传失败（HTTP ${xhr.status}）`
        finish(reject, new ApiError(message, xhr.status, data))
      }
    }
    xhr.onerror = () => {
      if (aborted) return
      finish(reject, new ApiError('上传失败，无法连接本地服务'))
    }
    xhr.onabort = () => {
      if (aborted) return
      finish(reject, abortError())
    }

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    xhr.send(file)
  })
}

export function startExport(quality) {
  return requestJson('/api/exports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quality }),
  })
}

export function getExport(id) {
  return requestJson(`/api/export/${encodeURIComponent(id)}`)
}

export function cancelExport(id) {
  return requestJson(`/api/export/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
}

export function listExports() {
  return requestJson('/api/exports')
}

export function revealExports() {
  return requestJson('/api/reveal', { method: 'POST' })
}
