import { useEffect, useRef, useState, useCallback } from 'react'
import { withApiKey, IS_STATIC_DEMO, hasApiBase, apiUrl } from '../utils/apiKey'
import './ConnectionWidget.css'

// Sanitize widget options — same logic as ChatAgent
const CHAT_SELECT_RULES = [
  { test: /scheme|색상.*테마|color.*theme/i, options: ['category10','category20','category20b','category20c','accent','dark2','paired','pastel1','pastel2','set1','set2','set3','tableau10','tableau20'] },
  { test: /interpolate|scale.*type/i, options: ['linear','log','pow','sqrt','symlog'] },
  { test: /orient|방향/i, options: ['left','right','top','bottom'] },
  { test: /anchor|align|정렬/i, options: ['start','middle','end'] },
  { test: /fontweight|font.*weight|굵기/i, options: ['normal','bold','lighter','100','200','300','400','500','600','700','800','900'] },
  { test: /fontstyle|font.*style/i, options: ['normal','italic'] },
  { test: /mark.*type|차트.*종류|차트.*타입/i, options: ['bar','line','area','point','circle','rect','arc','tick','rule'] },
]
const CHAT_NUMBER_RULES = [
  { test: /angle|rotate|rotation|labelangle|각도|회전/i, min: -360, max: 360, step: 1 },
  { test: /opacity|fillopacity|strokeopacity|투명|불투명/i, min: 0, max: 1, step: 0.05 },
  { test: /fontsize|titlefontsize|labelfontsize|글꼴.*크기|폰트.*크기|글자.*크기/i, min: 6, max: 48, step: 1 },
  { test: /strokewidth|domainwidth|gridwidth|선.*두께|테두리.*두께/i, min: 0, max: 10, step: 0.5 },
  { test: /cornerradius|모서리.*반경|둥글기/i, min: 0, max: 20, step: 1 },
  { test: /\bsize\b|크기/i, min: 0, max: 500, step: 10 },
  { test: /paddinginner|paddingouter|bandpadding/i, min: 0, max: 1, step: 0.05 },
  { test: /offset|오프셋|위치|\bdx\b|\bdy\b/i, min: -200, max: 200, step: 1 },
  { test: /padding|spacing|간격|패딩|여백/i, min: 0, max: 50, step: 1 },
  { test: /ticksize|tickwidth|눈금.*크기/i, min: 0, max: 20, step: 1 },
  { test: /\bwidth\b|\bheight\b|너비|높이/i, min: 50, max: 1200, step: 10 },
]
const _colorCtx = typeof document !== 'undefined'
  ? document.createElement('canvas').getContext('2d') : null
function colorToHex(color) {
  if (!color || !_colorCtx) return color
  if (/^#([0-9a-f]{3}){1,2}$/i.test(color)) return color
  _colorCtx.fillStyle = '#000000'
  _colorCtx.fillStyle = color
  return _colorCtx.fillStyle
}
function sanitizeChatWidgets(widgets) {
  if (!Array.isArray(widgets)) return widgets
  return widgets.map(opt => {
    if (opt.type === 'number') {
      const hint = [opt.id, opt.label, opt.path].join(' ')
      const rule = CHAT_NUMBER_RULES.find(r => r.test.test(hint))
      if (rule) {
        const fixed = { ...opt, min: rule.min, max: rule.max, step: opt.step ?? rule.step }
        if (fixed.value != null) fixed.value = Math.max(rule.min, Math.min(rule.max, fixed.value))
        return fixed
      }
    }
    if (opt.type === 'color') return { ...opt, value: colorToHex(opt.value) }
    if (opt.type === 'select') {
      if (!Array.isArray(opt.options) || opt.options.length === 0) {
        const hint = [opt.id, opt.label, opt.path].join(' ')
        const inferred = CHAT_SELECT_RULES.find(r => r.test.test(hint))
        if (inferred) return { ...opt, options: inferred.options }
        return { ...opt, type: 'text' }
      }
    }
    return opt
  })
}

// Helper: set value at a dot/bracket path in an object (deep clone)
function setSpecValueAtPath(spec, path, value) {
  const newSpec = JSON.parse(JSON.stringify(spec))
  const parts = path.match(/([^.\[\]]+|\[\d+\])/g)
  if (!parts) return newSpec
  let current = newSpec
  for (let i = 0; i < parts.length - 1; i++) {
    let key = parts[i]
    if (key.startsWith('[') && key.endsWith(']')) key = parseInt(key.slice(1, -1))
    if (current[key] === undefined) return newSpec
    current = current[key]
  }
  let lastKey = parts[parts.length - 1]
  if (lastKey.startsWith('[') && lastKey.endsWith(']')) lastKey = parseInt(lastKey.slice(1, -1))
  current[lastKey] = value
  return newSpec
}

function ConnectionWidget({ chartId, command, widgetTitle, intent, widgetOptions, onOptionChange, conversationHistory, changeType, chartSpec, onContinueChatApply, onPreviewChange }) {
  const [modifyOpen, setModifyOpen] = useState(true)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatMode, setChatMode] = useState(false) // inline editable chat
  const [chatMessages, setChatMessages] = useState([]) // new messages added during continue
  const [chatInput, setChatInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [pendingSpec, setPendingSpec] = useState(null) // new spec from LLM
  const [pendingWidgets, setPendingWidgets] = useState([]) // accumulated new widgets from all turns
  const chatEndRef = useRef(null)
  const inputRef = useRef(null)
  const widgetRef = useRef(null)

  const isDataTransform = changeType === 'data_transformation'
  const allOptions = widgetOptions || []
  const hasOptions = allOptions.length > 0
  const hasChat = conversationHistory && conversationHistory.length > 0

  // Auto-scroll chat to bottom
  useEffect(() => {
    if (chatMode) chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages, chatMode])

  // Focus input when entering chat mode
  useEffect(() => {
    if (chatMode) inputRef.current?.focus()
  }, [chatMode])

  // Forward wheel events to canvas SVG for pan/zoom passthrough
  useEffect(() => {
    const el = widgetRef.current
    if (!el) return
    const dispatchToCanvas = (e) => {
      const svg = document.querySelector('.canvas-container svg.canvas-svg')
      if (svg) {
        svg.dispatchEvent(new WheelEvent('wheel', {
          deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode,
          clientX: e.clientX, clientY: e.clientY,
          ctrlKey: e.ctrlKey, metaKey: e.metaKey, bubbles: false
        }))
      }
      e.preventDefault()
    }
    const handleWheel = (e) => {
      if (e.ctrlKey || e.metaKey) { dispatchToCanvas(e); return }
      const scrollable = e.target.closest('.widget-section-content')
      if (scrollable) {
        const { scrollTop, scrollHeight, clientHeight } = scrollable
        const atTop = scrollTop <= 0
        const atBottom = scrollTop + clientHeight >= scrollHeight - 1
        if ((!atTop && e.deltaY < 0) || (!atBottom && e.deltaY > 0)) return
      }
      dispatchToCanvas(e)
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [])

  // Notify chart preview when pendingSpec changes
  useEffect(() => {
    if (chatMode && onPreviewChange) {
      onPreviewChange(chartId, pendingSpec)
    }
  }, [pendingSpec]) // eslint-disable-line react-hooks/exhaustive-deps

  // Send message in continue chat mode
  const sendMessage = useCallback(async () => {
    if (!chatInput.trim() || isLoading || !chartSpec) return

    const userMsg = { role: 'user', content: chatInput.trim() }
    if (IS_STATIC_DEMO && !hasApiBase()) {
      setChatMessages(prev => [...prev, userMsg, { role: 'agent', content: 'Connect a backend (Backend button in the top bar) to use AI features.' }])
      setChatInput('')
      return
    }
    setChatMessages(prev => [...prev, userMsg])
    setChatInput('')
    setIsLoading(true)

    try {
      // Build full conversation history for context
      const fullHistory = [
        ...(conversationHistory || []).map(m => ({
          role: m.role === 'agent' ? 'assistant' : m.role,
          content: m.content
        })),
        ...chatMessages.map(m => ({
          role: m.role === 'agent' ? 'assistant' : m.role,
          content: m.content
        })),
        { role: 'user', content: userMsg.content }
      ]

      // Use the latest spec (pending from previous turn, or original)
      const currentSpec = pendingSpec || chartSpec

      const response = await fetch(apiUrl('/api/chat-agent'), {
        method: 'POST',
        headers: withApiKey({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          chartSpec: currentSpec,
          message: userMsg.content,
          conversationHistory: fullHistory,
          elementReferences: null,
          numberedReferences: null
        })
      })

      const text = await response.text()
      if (!text) throw new Error('Empty response')
      const data = JSON.parse(text)
      if (!response.ok) throw new Error(data.error || 'API Error')

      const agentMsg = {
        role: 'agent',
        content: data.message,
        widgetPreview: sanitizeChatWidgets(data.widget_preview || null),
        newSpec: data.new_spec || null
      }
      setChatMessages(prev => [...prev, agentMsg])

      if (data.new_spec) {
        setPendingSpec(data.new_spec)
        // Accumulate widgets from each turn
        if (data.widget_preview) {
          setPendingWidgets(prev => [...prev, ...sanitizeChatWidgets(data.widget_preview)])
        }
      }
    } catch (error) {
      console.error('Continue chat error:', error)
      setChatMessages(prev => [...prev, {
        role: 'agent',
        content: `Error: ${error.message}`,
        isError: true
      }])
    } finally {
      setIsLoading(false)
    }
  }, [chatInput, isLoading, chartSpec, conversationHistory, chatMessages, pendingSpec])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  // Widget preview value change → update message widget + preview spec
  const handlePreviewWidgetChange = useCallback((msgIndex, widgetIndex, newValue) => {
    setChatMessages(prev => {
      const updated = [...prev]
      const msg = { ...updated[msgIndex] }
      const widgets = [...msg.widgetPreview]
      const widget = { ...widgets[widgetIndex], value: newValue }
      widgets[widgetIndex] = widget
      msg.widgetPreview = widgets

      // Update spec with the new value
      if (msg.newSpec && widget.path) {
        msg.newSpec = setSpecValueAtPath(msg.newSpec, widget.path, newValue)
        // Also update pendingSpec for chart preview
        setPendingSpec(msg.newSpec)
      }

      updated[msgIndex] = msg
      return updated
    })
    // Also update the widget in pendingWidgets so apply picks up the latest value
    setPendingWidgets(prev => prev.map(w =>
      w.id === chatMessages[msgIndex]?.widgetPreview?.[widgetIndex]?.id
        ? { ...w, value: newValue }
        : w
    ))
  }, [chatMessages])

  // Remove a widget from chat preview
  const handlePreviewWidgetRemove = useCallback((msgIndex, widgetIndex) => {
    setChatMessages(prev => {
      const updated = [...prev]
      const msg = { ...updated[msgIndex] }
      const widgets = [...msg.widgetPreview]
      const removed = widgets.splice(widgetIndex, 1)[0]
      msg.widgetPreview = widgets
      updated[msgIndex] = msg
      // Also remove from pendingWidgets
      if (removed) {
        setPendingWidgets(pw => pw.filter(w => w.id !== removed.id))
      }
      return updated
    })
  }, [])

  // Render interactive widget preview control
  const renderPreviewWidget = (option, msgIndex, widgetIndex) => {
    const onChange = (value) => handlePreviewWidgetChange(msgIndex, widgetIndex, value)
    switch (option.type) {
      case 'color':
        return (
          <div className="option-control color-control">
            <label>{option.label}</label>
            <input type="color" value={option.value && /^#[0-9a-fA-F]{6}$/.test(option.value) ? option.value : '#000000'} onChange={(e) => onChange(e.target.value)} />
          </div>
        )
      case 'number': {
        const value = option.value ?? 0
        if (!(option.id in initialValuesRef.current)) {
          initialValuesRef.current[option.id] = value
        }
        const _stableValue = initialValuesRef.current[option.id]
        let min = option.min, max = option.max, step = option.step
        const _hint = [option.id, option.label, option.path].join(' ')
        const _rule = CHAT_NUMBER_RULES.find(r => r.test.test(_hint))
        if (_rule) { min = _rule.min; max = _rule.max; step = step ?? _rule.step }
        else if (min === undefined || max === undefined) {
          if (/투명|opacity/i.test(_hint)) { min = min ?? 0; max = max ?? 1; step = step ?? 0.05 }
          else { min = min ?? 0; max = max ?? Math.max(10, Math.ceil(Math.abs(_stableValue) * 3) || 10); step = step ?? (_stableValue >= 10 ? 1 : 0.5) }
        }
        return (
          <div className="option-control number-control">
            <label>{option.label}</label>
            <input type="number" className="number-input" min={min} max={max} step={step} value={option.value} onChange={(e) => onChange(parseFloat(e.target.value))} />
            <input type="range" min={min} max={max} step={step} value={option.value} onChange={(e) => onChange(parseFloat(e.target.value))} />
          </div>
        )
      }
      case 'select': {
        const hasOpts = Array.isArray(option.options) && option.options.length > 0
        return (
          <div className="option-control select-control">
            <label>{option.label}</label>
            {hasOpts
              ? <select value={option.value} onChange={(e) => onChange(e.target.value)}>{option.options.map(o => { const v = typeof o === 'object' ? o.value : o; const l = typeof o === 'object' ? o.label : o; return <option key={v} value={v}>{l}</option> })}</select>
              : <input type="text" value={option.value ?? ''} onChange={(e) => onChange(e.target.value)} />}
          </div>
        )
      }
      case 'text':
        return (
          <div className="option-control text-control">
            <label>{option.label}</label>
            <input type="text" value={option.value ?? ''} onChange={(e) => onChange(e.target.value)} />
          </div>
        )
      case 'boolean':
        return (
          <div className="option-control boolean-control">
            <label>{option.label}</label>
            <input type="checkbox" checked={!!option.value} onChange={(e) => onChange(e.target.checked)} />
          </div>
        )
      default: return null
    }
  }

  // Apply continued chat result
  const handleApply = useCallback(() => {
    if (!pendingSpec || !onContinueChatApply) return

    const fullHistory = [...(conversationHistory || []), ...chatMessages]
    const existingIds = new Set((widgetOptions || []).map(w => w.id))
    const mergedWidgets = [
      ...(widgetOptions || []),
      ...pendingWidgets.filter(w => !existingIds.has(w.id))
    ]

    // Clear preview before applying
    if (onPreviewChange) onPreviewChange(chartId, null)

    onContinueChatApply(chartId, {
      spec: pendingSpec,
      widgetOptions: mergedWidgets,
      conversationHistory: fullHistory
    })

    setChatMode(false)
    setChatMessages([])
    setPendingSpec(null)
    setPendingWidgets([])
  }, [pendingSpec, onContinueChatApply, chartId, conversationHistory, chatMessages, widgetOptions, pendingWidgets, onPreviewChange])

  // Cancel continued chat
  const handleCancel = useCallback(() => {
    // Clear chart preview — restore original
    if (onPreviewChange) onPreviewChange(chartId, null)
    setChatMode(false)
    setChatMessages([])
    setPendingSpec(null)
    setPendingWidgets([])
  }, [onPreviewChange, chartId])

  const handleChange = (optionId, value) => {
    onOptionChange(chartId, optionId, value)
  }

  // Stable initial values for slider range computation (prevents range jumping when value changes)
  const initialValuesRef = useRef({})

  const renderOptionControl = (option) => {
    switch (option.type) {
      case 'color':
        return (
          <div className="option-control color-control" key={option.id}>
            <label>{option.label}</label>
            <input type="color" value={option.value && /^#[0-9a-fA-F]{6}$/.test(option.value) ? option.value : '#000000'} onChange={(e) => handleChange(option.id, e.target.value)} />
          </div>
        )
      case 'number': {
        const value = option.value ?? 0
        // Store initial value on first encounter for stable range calculation
        if (!(option.id in initialValuesRef.current)) {
          initialValuesRef.current[option.id] = value
        }
        const stableValue = initialValuesRef.current[option.id]
        let min = option.min, max = option.max, step = option.step
        const _hint2 = [option.id, option.label, option.path].join(' ')
        const _rule2 = CHAT_NUMBER_RULES.find(r => r.test.test(_hint2))
        if (_rule2) { min = _rule2.min; max = _rule2.max; step = step ?? _rule2.step }
        else if (min === undefined || max === undefined) {
          min = min ?? 0; max = max ?? Math.max(10, Math.ceil(Math.abs(stableValue) * 3) || 10); step = step ?? (stableValue >= 10 ? 1 : 0.5)
        }
        return (
          <div className="option-control number-control" key={option.id}>
            <label>{option.label}</label>
            <input type="number" className="number-input" min={min} max={max} step={step} value={option.value} onChange={(e) => handleChange(option.id, parseFloat(e.target.value))} />
            <input type="range" min={min} max={max} step={step} value={option.value} onChange={(e) => handleChange(option.id, parseFloat(e.target.value))} />
          </div>
        )
      }
      case 'select': {
        const hasOpts = Array.isArray(option.options) && option.options.length > 0
        return (
          <div className="option-control select-control" key={option.id}>
            <label>{option.label}</label>
            {hasOpts
              ? <select value={option.value} onChange={(e) => handleChange(option.id, e.target.value)}>{option.options.map(o => { const isObj = typeof o === 'object' && o !== null; return <option key={isObj ? o.value : o} value={isObj ? o.value : o}>{isObj ? o.label : o}</option> })}</select>
              : <input type="text" value={option.value ?? ''} onChange={(e) => handleChange(option.id, e.target.value)} />}
          </div>
        )
      }
      case 'boolean':
        return (
          <div className="option-control boolean-control" key={option.id}>
            <label>{option.label}</label>
            <input type="checkbox" checked={option.value} onChange={(e) => handleChange(option.id, e.target.checked)} />
          </div>
        )
      case 'text':
        return (
          <div className="option-control text-control" key={option.id}>
            <label>{option.label}</label>
            <input type="text" value={option.value ?? ''} onChange={(e) => handleChange(option.id, e.target.value)} />
          </div>
        )
      default: return null
    }
  }

  // If nothing to show, just display the command (+ continue button)
  if (!hasChat && !hasOptions && !chatMode) {
    return (
      <div className={`connection-widget ${isDataTransform ? 'data-transform' : ''}`} ref={widgetRef}>
        {command && (
          <div className="widget-command-only">
            {widgetTitle || (command?.length > 25 ? command.slice(0, 25) + '...' : command)}
          </div>
        )}
        {onContinueChatApply && (
          <div className="widget-section-content">
            <button className="widget-continue-chat-btn" onClick={(e) => { e.stopPropagation(); setChatMode(true); setChatOpen(true) }}>
              + Continue editing
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={`connection-widget ${isDataTransform ? 'data-transform' : ''} ${chatMode ? 'chat-active' : ''}`} ref={widgetRef}>
      {/* Widget section — all options unified */}
      {hasOptions && (
        <div className="widget-section">
          <div className="widget-section-header" onClick={() => setModifyOpen(!modifyOpen)}>
            <span className="widget-section-icon">⚙</span>
            <span className="widget-section-title">widget</span>
            <span className={`widget-toggle ${modifyOpen ? 'open' : ''}`}>▼</span>
          </div>
          {modifyOpen && (
            <div className="widget-section-content">
              {allOptions.map(renderOptionControl)}
            </div>
          )}
        </div>
      )}

      {/* Chat section — bottom */}
      <div className="widget-section">
        <div className="widget-section-header" onClick={() => setChatOpen(!chatOpen)}>
          <span className="widget-section-icon">💬</span>
          <span className="widget-section-title">chat</span>
          <span className={`widget-toggle ${chatOpen ? 'open' : ''}`}>▼</span>
        </div>
        {chatOpen && (
          <div className={`widget-section-content widget-chat-content ${chatMode ? 'chat-mode-active' : ''}`}>
            {/* Existing conversation history */}
            {conversationHistory
              .filter(msg => msg.content)
              .map((msg, i) => (
                <div key={`h-${i}`} className={`chat-bubble ${msg.role}`}>
                  {msg.content}
                </div>
              ))}

            {/* New messages from continue chat */}
            {chatMessages.map((msg, i) => (
              <div key={`n-${i}`} className="widget-chat-msg-group">
                <div className={`chat-bubble ${msg.role} ${msg.isError ? 'error' : ''}`}>
                  {msg.content}
                </div>
                {/* Interactive widget preview for agent messages */}
                {msg.widgetPreview && msg.widgetPreview.length > 0 && (
                  <div className="widget-inline-preview">
                    <div className="widget-inline-preview-header">Widget Preview</div>
                    {msg.widgetPreview.map((widget, wi) => (
                      <div key={widget.id || wi} className="widget-inline-preview-row">
                        {renderPreviewWidget(widget, i, wi)}
                        <button
                          className="widget-preview-remove"
                          onClick={() => handlePreviewWidgetRemove(i, wi)}
                          title="Remove widget"
                        >&times;</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}

            {/* Loading indicator */}
            {isLoading && (
              <div className="chat-bubble agent loading">
                <span className="widget-typing">●●●</span>
              </div>
            )}

            <div ref={chatEndRef} />

            {/* Chat input area (only in chatMode) */}
            {chatMode && (
              <div className="widget-chat-input">
                <textarea
                  ref={inputRef}
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Additional modifications..."
                  rows={1}
                  disabled={isLoading}
                />
                <button className="widget-chat-send" onClick={sendMessage} disabled={!chatInput.trim() || isLoading}>
                  Send
                </button>
              </div>
            )}

            {/* Apply / Cancel (when there's a pending spec) */}
            {chatMode && pendingSpec && !isLoading && (
              <div className="widget-chat-actions">
                <button className="widget-chat-apply" onClick={handleApply}>Apply</button>
                <button className="widget-chat-cancel" onClick={handleCancel}>Cancel</button>
              </div>
            )}

            {/* Cancel only (chatMode but no spec yet) */}
            {chatMode && !pendingSpec && !isLoading && (
              <div className="widget-chat-actions">
                <button className="widget-chat-cancel" onClick={handleCancel}>Cancel</button>
              </div>
            )}

            {/* Continue button (not in chatMode) */}
            {!chatMode && onContinueChatApply && (
              <button className="widget-continue-chat-btn" onClick={(e) => { e.stopPropagation(); setChatMode(true) }}>
                + Continue editing
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default ConnectionWidget
