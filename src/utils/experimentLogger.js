const LOG_BUFFER = []
let SESSION_META = null
let flushInterval = null
const SESSION_STORAGE_KEY = 'experiment-session'

// Debounce: for slider/continuous changes, only log the final value
const DEBOUNCE_EVENTS = new Set(['widget_change', 'property_change'])
const DEBOUNCE_MS = 1000
let _debounceTimer = null
let _debounceEntry = null

export function startSession({ participantId, condition, taskId }) {
  SESSION_META = { participantId, condition, taskId, sessionStartTime: Date.now() }
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(SESSION_META))
  logEvent('session_start', { startTime: new Date().toISOString() })
  // Auto-flush every 30s
  flushInterval = setInterval(() => flushToServer(), 30000)
  window.addEventListener('beforeunload', flushToServer)
}

export function restoreSession() {
  try {
    const saved = localStorage.getItem(SESSION_STORAGE_KEY)
    if (!saved) return null
    const meta = JSON.parse(saved)
    if (!meta.participantId || !meta.taskId) return null
    SESSION_META = meta
    flushInterval = setInterval(() => flushToServer(), 30000)
    window.addEventListener('beforeunload', flushToServer)
    return meta
  } catch { return null }
}

export function updateTaskId(taskId) {
  if (!SESSION_META) return
  // End previous task segment
  logEvent('task_end', { taskId: SESSION_META.taskId })
  flushToServer()
  // Start new task segment
  SESSION_META = { ...SESSION_META, taskId, sessionStartTime: Date.now() }
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(SESSION_META))
  logEvent('task_start', { taskId })
}

function _buildEntry(eventType, payload) {
  const elapsedMs = Date.now() - SESSION_META.sessionStartTime
  const totalSec = Math.floor(elapsedMs / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return {
    timestamp: `${min}_${String(sec).padStart(2, '0')}`,
    participantId: SESSION_META.participantId,
    condition: SESSION_META.condition,
    taskId: SESSION_META.taskId,
    event: eventType,
    ...payload
  }
}

export function logEvent(eventType, payload = {}) {
  if (!SESSION_META) return

  // Debounce slider/continuous changes — only keep the final value per key
  if (DEBOUNCE_EVENTS.has(eventType)) {
    const key = `${eventType}:${payload.property || payload.optionId || ''}`
    // If pending entry is for a DIFFERENT key, flush it first
    if (_debounceEntry && _debounceEntry.key !== key) {
      LOG_BUFFER.push(_debounceEntry.entry)
      _debounceEntry = null
    }
    if (_debounceTimer) clearTimeout(_debounceTimer)
    _debounceEntry = { key, entry: _buildEntry(eventType, payload) }
    _debounceTimer = setTimeout(() => {
      if (_debounceEntry) LOG_BUFFER.push(_debounceEntry.entry)
      _debounceEntry = null
      _debounceTimer = null
    }, DEBOUNCE_MS)
    return
  }

  // Flush any pending debounced entry before logging a different event
  if (_debounceEntry) {
    LOG_BUFFER.push(_debounceEntry.entry)
    clearTimeout(_debounceTimer)
    _debounceEntry = null
    _debounceTimer = null
  }

  LOG_BUFFER.push(_buildEntry(eventType, payload))
}

export async function endSession() {
  logEvent('session_end', { endTime: new Date().toISOString() })
  await reliableFlush()
  if (flushInterval) clearInterval(flushInterval)
  window.removeEventListener('beforeunload', flushToServer)
  SESSION_META = null
  localStorage.removeItem(SESSION_STORAGE_KEY)
}

// Replace the last element_select in the buffer with a scope_select
export function replacePendingSelect(eventType, payload) {
  if (!SESSION_META) return
  // Find and remove the last element_select
  for (let i = LOG_BUFFER.length - 1; i >= 0; i--) {
    if (LOG_BUFFER[i].event === 'element_select') {
      LOG_BUFFER.splice(i, 1)
      break
    }
  }
  LOG_BUFFER.push(_buildEntry(eventType, payload))
}

// Reliable flush using fetch (for End button — page is still alive)
async function reliableFlush() {
  if (LOG_BUFFER.length === 0) return
  const events = [...LOG_BUFFER]
  LOG_BUFFER.length = 0
  const body = JSON.stringify({ participantId: SESSION_META?.participantId, events })
  try {
    const res = await fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    if (!res.ok) console.warn('Log flush failed:', res.status)
  } catch (e) {
    console.warn('Log flush failed:', e)
    // Put events back so they aren't lost
    LOG_BUFFER.push(...events)
  }
}

// sendBeacon flush (for beforeunload / periodic — fire-and-forget)
export function flushToServer() {
  if (LOG_BUFFER.length === 0) return
  const events = [...LOG_BUFFER]
  LOG_BUFFER.length = 0
  try {
    // Use sendBeacon for beforeunload reliability, fetch otherwise
    const body = JSON.stringify({ participantId: SESSION_META?.participantId, events })
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/log', new Blob([body], { type: 'application/json' }))
    } else {
      fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    }
  } catch (e) { console.warn('Log flush failed:', e) }
}

export function downloadLog() {
  const lines = LOG_BUFFER.map(e => JSON.stringify(e)).join('\n')
  const pid = SESSION_META?.participantId || 'unknown'
  const task = SESSION_META?.taskId || ''
  const blob = new Blob([lines], { type: 'application/jsonl' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${pid}_${task}_${Date.now()}.jsonl`
  a.click()
}

export function isSessionActive() { return SESSION_META !== null }

export function getSessionMeta() { return SESSION_META }
