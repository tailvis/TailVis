import { useState, useEffect } from 'react'
import { getApiKey, setApiKey, looksLikeAnthropicKey, IS_STATIC_DEMO, getApiBase, setApiBase } from '../utils/apiKey'
import './ApiKeyModal.css'

// Dialog for connecting the app to the LLM backend (public/open-source build).
//  • Normal build: enter your own Anthropic API key (stored in this browser, sent as a header).
//  • Static demo (GitHub Pages, no backend): enter the URL of a backend YOU run — the
//    frontend routes /api/* there, and that backend supplies the Anthropic key from its .env.
export default function ApiKeyModal({ open, onClose, onSaved }) {
  const [value, setValue] = useState('')
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (open) {
      setValue(IS_STATIC_DEMO ? getApiBase() : getApiKey())
      setShow(false)
    }
  }, [open])

  if (!open) return null

  const save = () => {
    if (IS_STATIC_DEMO) setApiBase(value)
    else setApiKey(value)
    onSaved?.(value.trim())
    onClose?.()
  }
  const clear = () => {
    if (IS_STATIC_DEMO) setApiBase('')
    else setApiKey('')
    setValue('')
    onSaved?.('')
  }

  const hasSaved = IS_STATIC_DEMO ? !!getApiBase() : !!getApiKey()

  if (IS_STATIC_DEMO) {
    const looksOk = /^https?:\/\/.+/i.test(value.trim())
    return (
      <div className="apikey-overlay" onClick={onClose}>
        <div className="apikey-dialog" onClick={(e) => e.stopPropagation()}>
          <h2>Connect a backend</h2>
          <p className="apikey-desc">
            This is a static demo, so the AI features (natural-language chart creation, editing,
            and chat) need a backend you run yourself. Clone the repo, run <code>npm run server</code>
            {' '}with your Anthropic key in <code>.env</code>, and enter its URL below. The frontend
            will send its <code>/api</code> requests there.
          </p>
          <div className="apikey-input-row">
            <input
              type="text"
              className="apikey-input"
              placeholder="http://localhost:5105"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) save() }}
              autoFocus
              spellCheck={false}
            />
          </div>
          {value.trim() && !looksOk && (
            <div className="apikey-warn">Enter a full URL, e.g. <code>http://localhost:5105</code>. Saving anyway is allowed.</div>
          )}
          <div className="apikey-warn">
            Note: this page is served over HTTPS. Chrome/Edge allow <code>http://localhost</code>, but a
            remote backend must use <code>https://</code> (and Safari blocks plain <code>http</code>).
          </div>
          <div className="apikey-actions">
            <span className="apikey-link" style={{ cursor: 'default' }}>Runs against your own backend</span>
            <div className="apikey-buttons">
              {hasSaved && <button className="apikey-btn apikey-clear" onClick={clear}>Remove</button>}
              <button className="apikey-btn apikey-cancel" onClick={onClose}>Cancel</button>
              <button className="apikey-btn apikey-save" onClick={save} disabled={!value.trim()}>Save</button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const valid = looksLikeAnthropicKey(value)

  return (
    <div className="apikey-overlay" onClick={onClose}>
      <div className="apikey-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Anthropic API Key</h2>
        <p className="apikey-desc">
          This app uses Claude for natural-language chart creation and editing. Enter your own
          Anthropic API key to enable those features. The key is stored only in your browser
          (localStorage) and sent with requests to the app’s backend.
        </p>
        <div className="apikey-input-row">
          <input
            type={show ? 'text' : 'password'}
            className="apikey-input"
            placeholder="sk-ant-…"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) save() }}
            autoFocus
            spellCheck={false}
          />
          <button className="apikey-eye" onClick={() => setShow(s => !s)} title={show ? 'Hide' : 'Show'}>
            {show ? '🙈' : '👁'}
          </button>
        </div>
        {value.trim() && !valid && (
          <div className="apikey-warn">Keys usually start with <code>sk-ant-</code>. Saving anyway is allowed.</div>
        )}
        <div className="apikey-actions">
          <a className="apikey-link" href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
            Get an API key ↗
          </a>
          <div className="apikey-buttons">
            {hasSaved && <button className="apikey-btn apikey-clear" onClick={clear}>Remove</button>}
            <button className="apikey-btn apikey-cancel" onClick={onClose}>Cancel</button>
            <button className="apikey-btn apikey-save" onClick={save} disabled={!value.trim()}>Save</button>
          </div>
        </div>
      </div>
    </div>
  )
}
