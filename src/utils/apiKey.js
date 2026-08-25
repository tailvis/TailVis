// Anthropic API key management for the public/open-source build.
// The key is stored locally in the browser and sent with each LLM request as the
// `x-anthropic-key` header. It never leaves the user's machine except to their own
// backend, which forwards it to Anthropic. No key → LLM features are disabled.

const KEY = 'anthropic-api-key'

// Static-demo build (e.g. GitHub Pages) has no backend to reach the LLM. Set at
// build time via VITE_STATIC_DEMO=true; AI features then show a "run locally" notice
// instead of calling /api/* (which would 404 on static hosting).
export const IS_STATIC_DEMO = import.meta.env?.VITE_STATIC_DEMO === 'true'

// User-facing message shown when an AI action is attempted in the static demo.
export const STATIC_DEMO_MESSAGE =
  'This is a static demo — run TailVis locally (with the backend) to use AI features.'

export function getApiKey() {
  try { return (localStorage.getItem(KEY) || '').trim() } catch { return '' }
}

export function hasApiKey() {
  return getApiKey().length > 0
}

export function setApiKey(value) {
  try {
    const v = (value || '').trim()
    if (v) localStorage.setItem(KEY, v)
    else localStorage.removeItem(KEY)
  } catch { /* ignore */ }
}

// Merge the API-key header into a fetch() headers object for /api LLM calls.
export function withApiKey(headers = {}) {
  const k = getApiKey()
  return k ? { ...headers, 'x-anthropic-key': k } : headers
}

// Lightweight looks-like-a-key check for UI validation (not authoritative).
export function looksLikeAnthropicKey(value) {
  return /^sk-ant-/.test((value || '').trim())
}

// ── Backend base URL (static-demo build) ──────────────────────────────────
// The static demo (GitHub Pages) has no backend of its own, so the user points it
// at a backend they run themselves (e.g. http://localhost:5105 or a hosted https URL).
// The backend supplies the Anthropic key from its own .env. Empty base = same-origin
// (local dev, where Vite proxies /api → the local server).
const API_BASE_KEY = 'tailvis-api-base'

export function getApiBase() {
  try { return (localStorage.getItem(API_BASE_KEY) || '').trim().replace(/\/+$/, '') } catch { return '' }
}

export function setApiBase(value) {
  try {
    const v = (value || '').trim().replace(/\/+$/, '')
    if (v) localStorage.setItem(API_BASE_KEY, v)
    else localStorage.removeItem(API_BASE_KEY)
  } catch { /* ignore */ }
}

export function hasApiBase() {
  return getApiBase().length > 0
}

// Prepend the configured backend base to an /api path. Empty base → same-origin.
export function apiUrl(path) {
  return getApiBase() + path
}
