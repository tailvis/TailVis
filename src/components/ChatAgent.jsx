import { useState, useRef, useEffect, useCallback } from 'react'
import { logEvent } from '../utils/experimentLogger'
import { withApiKey, IS_STATIC_DEMO, hasApiBase, apiUrl } from '../utils/apiKey'
import './ChatAgent.css'

// Convert CSS named color to HEX using a temporary canvas context
const _colorCtx = typeof document !== 'undefined'
  ? document.createElement('canvas').getContext('2d')
  : null
function colorToHex(color) {
  if (!color || !_colorCtx) return color
  if (/^#([0-9a-f]{3}){1,2}$/i.test(color)) return color
  _colorCtx.fillStyle = '#000000'
  _colorCtx.fillStyle = color
  const computed = _colorCtx.fillStyle
  return computed // canvas context always returns '#rrggbb'
}

// Auto-populate options for known select types when LLM omits them
const CHAT_CHAT_SELECT_RULES = [
  { test: /scheme|색상.*테마|color.*theme/i, options: [
    'category10', 'category20', 'category20b', 'category20c',
    'accent', 'dark2', 'paired', 'pastel1', 'pastel2', 'set1', 'set2', 'set3',
    'tableau10', 'tableau20',
  ]},
  { test: /interpolate|scale.*type/i, options: ['linear', 'log', 'pow', 'sqrt', 'symlog'] },
  { test: /orient|방향/i, options: ['left', 'right', 'top', 'bottom'] },
  { test: /anchor|align|정렬/i, options: ['start', 'middle', 'end'] },
  { test: /fontweight|font.*weight|굵기/i, options: ['normal', 'bold', 'lighter', '100', '200', '300', '400', '500', '600', '700', '800', '900'] },
  { test: /fontstyle|font.*style/i, options: ['normal', 'italic'] },
  { test: /mark.*type|차트.*종류|차트.*타입/i, options: ['bar', 'line', 'area', 'point', 'circle', 'rect', 'arc', 'tick', 'rule'] },
]

// Sanitize widget options from chat LLM responses — clamp number values to property-aware ranges
const CHAT_NUMBER_RULES = [
  { test: /angle|rotate|rotation|labelangle|각도|회전/i, min: -360, max: 360, step: 1 },
  { test: /opacity|fillopacity|strokeopacity|투명|불투명/i, min: 0, max: 1, step: 0.05 },
  { test: /fontsize|titlefontsize|labelfontsize|글꼴.*크기|폰트.*크기|글자.*크기/i, min: 6, max: 48, step: 1 },
  { test: /strokewidth|domainwidth|gridwidth|선.*두께|테두리.*두께/i, min: 0, max: 10, step: 0.5 },
  { test: /cornerradius|모서리.*반경|둥글기/i, min: 0, max: 20, step: 1 },
  { test: /\bsize\b|크기/i, min: 0, max: 500, step: 10 },
  { test: /paddinginner|paddingouter|bandpadding/i, min: 0, max: 1, step: 0.05 },
  { test: /offset|오프셋/i, min: -200, max: 200, step: 1 },
  { test: /padding|spacing|간격|패딩|여백/i, min: 0, max: 50, step: 1 },
  { test: /ticksize|tickwidth|눈금.*크기/i, min: 0, max: 20, step: 1 },
  { test: /\bwidth\b|\bheight\b|너비|높이/i, min: 50, max: 1200, step: 10 },
]
function sanitizeChatWidgets(widgets) {
  if (!widgets) return null
  if (!Array.isArray(widgets)) {
    // LLM sometimes returns object instead of array — convert
    try { widgets = Object.values(widgets) } catch { return null }
    if (!Array.isArray(widgets)) return null
  }
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
    if (opt.type === 'color') {
      return { ...opt, value: colorToHex(opt.value) }
    }
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

function ChatAgent({ chartId, chartSpec, canvasPos, canvasTransform, canvasWrapperRef, onClose, onApply, onPreviewChange, initialMessages, readOnly, elementReferences, scopeInfo, chatReferences, onChatReferencesChange, focusRef, showToast }) {
  const [messages, setMessages] = useState(initialMessages || [])
  const [input, setInput] = useState('')
  const inputRef = useRef(null)
  // Expose focus method to parent via focusRef
  useEffect(() => {
    if (focusRef) focusRef.current = { focus: () => inputRef.current?.focus() }
  }, [focusRef])
  const [elemRefs, setElemRefs] = useState(elementReferences || null)
  const [scopeRef, setScopeRef] = useState(scopeInfo || null)
  const prevRefsLength = useRef(0)

  // Sync internal state when parent updates scope/element references (e.g., Tab scope change during chat)
  useEffect(() => { setElemRefs(elementReferences || null) }, [elementReferences])
  useEffect(() => { setScopeRef(scopeInfo || null) }, [scopeInfo])
  const [isLoading, setIsLoading] = useState(false)
  const [loadingText, setLoadingText] = useState('')
  const [pendingAction, setPendingAction] = useState(null)
  const [currentPreviewSpec, setCurrentPreviewSpec] = useState(null)
  const [specHistory, setSpecHistory] = useState([]) // stack of previous specs for multi-turn undo
  const [removedWidgets, setRemovedWidgets] = useState([]) // undo stack for removed widgets
  const messagesEndRef = useRef(null)

  // Animated loading text
  useEffect(() => {
    if (!isLoading) return
    const phrase = 'AI is thinking'
    let dotCount = 0
    setLoadingText(phrase + '.')
    const timer = setInterval(() => {
      dotCount = (dotCount + 1) % 3
      setLoadingText(phrase + '.'.repeat(dotCount + 1))
    }, 500)
    return () => clearInterval(timer)
  }, [isLoading])

  // Insert token when new reference is added via canvas click, clean up orphaned tokens when refs decrease
  useEffect(() => {
    const prevLen = prevRefsLength.current
    const curLen = chatReferences ? chatReferences.length : 0
    if (curLen > prevLen) {
      // New reference added — insert token at cursor
      const newRef = chatReferences[chatReferences.length - 1]
      const token = `[${newRef.number}]`
      const textarea = inputRef.current
      if (textarea) {
        const start = textarea.selectionStart || input.length
        const newValue = input.slice(0, start) + token + ' ' + input.slice(start)
        setInput(newValue)
        requestAnimationFrame(() => {
          textarea.selectionStart = textarea.selectionEnd = start + token.length + 1
          textarea.focus()
        })
      } else {
        setInput(prev => prev + token + ' ')
      }
    } else if (prevLen > 0 && curLen < prevLen) {
      // References decreased (e.g., scope replaced individual refs) — clean up orphaned tokens
      let newInput = input
      for (let i = curLen + 1; i <= prevLen; i++) {
        newInput = newInput.replace(new RegExp(`\\[${i}\\]\\s?`, 'g'), '')
      }
      if (newInput !== input) setInput(newInput)
    }
    prevRefsLength.current = curLen
  }, [chatReferences]) // eslint-disable-line react-hooks/exhaustive-deps

  // Remove a numbered reference
  const removeReference = useCallback((number) => {
    if (!onChatReferencesChange || !chatReferences) return
    const updated = chatReferences.filter(r => r.number !== number)
      .map((r, i) => ({ ...r, number: i + 1 }))
    onChatReferencesChange(updated)
    // Remove token from input text and renumber
    let newInput = input
    newInput = newInput.replace(new RegExp(`\\[${number}\\]\\s?`, 'g'), '')
    for (let i = number + 1; i <= chatReferences.length; i++) {
      newInput = newInput.replace(new RegExp(`\\[${i}\\]`, 'g'), `[${i - 1}]`)
    }
    setInput(newInput)
  }, [chatReferences, onChatReferencesChange, input])

  const [canvasXY, setCanvasXY] = useState({ x: canvasPos.x, y: canvasPos.y })
  const [isDragging, setIsDragging] = useState(false)
  const dragStartRef = useRef({ mouseX: 0, mouseY: 0, cx: 0, cy: 0, k: 1 })

  // Resizing state
  const [size, setSize] = useState({ width: 320, height: 400 })
  const [isResizing, setIsResizing] = useState(false)
  const resizeStart = useRef({ x: 0, y: 0, width: 0, height: 0 })

  const t = canvasTransform || { x: 0, y: 0, k: 1 }
  const wrapperRect = canvasWrapperRef?.current?.getBoundingClientRect()
  const wrapperOffsetX = wrapperRect?.left || 0
  const wrapperOffsetY = wrapperRect?.top || 0
  const screenX = canvasXY.x * t.k + t.x + wrapperOffsetX
  const screenY = canvasXY.y * t.k + t.y + wrapperOffsetY
  const screenScale = t.k

  // Auto scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Initial greeting (only if no initial messages)
  useEffect(() => {
    if (!initialMessages || initialMessages.length === 0) {
      setMessages([{
        role: 'agent',
        content: 'Describe your modification.',
        timestamp: Date.now()
      }])
    }
  }, [])

  // Update position when prop changes
  useEffect(() => {
    setCanvasXY({ x: canvasPos.x, y: canvasPos.y })
  }, [canvasPos.x, canvasPos.y])

  const handleDragStart = useCallback((e) => {
    if (e.target.closest('.close-btn') || e.target.closest('.chat-messages') ||
        e.target.closest('.chat-input-area') || e.target.closest('.resize-handle')) return
    setIsDragging(true)
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      cx: canvasXY.x,
      cy: canvasXY.y,
      k: t.k
    }
  }, [canvasXY, t.k])

  const handleDrag = useCallback((e) => {
    if (!isDragging) return
    const { mouseX, mouseY, cx, cy, k } = dragStartRef.current
    setCanvasXY({
      x: cx + (e.clientX - mouseX) / k,
      y: cy + (e.clientY - mouseY) / k
    })
  }, [isDragging])

  const handleDragEnd = useCallback(() => {
    setIsDragging(false)
  }, [])

  // Resize handlers
  const handleResizeStart = useCallback((e) => {
    e.stopPropagation()
    setIsResizing(true)
    resizeStart.current = {
      x: e.clientX,
      y: e.clientY,
      width: size.width,
      height: size.height
    }
  }, [size])

  const handleResize = useCallback((e) => {
    if (!isResizing) return
    const dx = e.clientX - resizeStart.current.x
    const dy = e.clientY - resizeStart.current.y
    setSize({
      width: Math.max(280, resizeStart.current.width + dx),
      height: Math.max(300, resizeStart.current.height + dy)
    })
  }, [isResizing])

  const handleResizeEnd = useCallback(() => {
    setIsResizing(false)
  }, [])

  // Global mouse events for drag/resize
  useEffect(() => {
    if (isDragging || isResizing) {
      const handleMouseMove = (e) => {
        if (isDragging) handleDrag(e)
        if (isResizing) handleResize(e)
      }
      const handleMouseUp = () => {
        handleDragEnd()
        handleResizeEnd()
      }
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
      return () => {
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)
      }
    }
  }, [isDragging, isResizing, handleDrag, handleResize, handleDragEnd, handleResizeEnd])

  const chatRef = useRef(null)
  useEffect(() => {
    const el = chatRef.current
    if (!el) return

    const dispatchToCanvas = (e) => {
      const svg = document.querySelector('.canvas-container svg.canvas-svg')
        || el.closest('.canvas-wrapper')?.querySelector('svg')
      if (svg) {
        svg.dispatchEvent(new WheelEvent('wheel', {
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          deltaMode: e.deltaMode,
          clientX: e.clientX,
          clientY: e.clientY,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          bubbles: false
        }))
      }
      e.preventDefault()
    }

    const handleWheel = (e) => {
      if (e.ctrlKey || e.metaKey) {
        dispatchToCanvas(e)
        return
      }

      const scrollable = e.target.closest('.chat-messages') || e.target.closest('.widget-preview-area')
      if (scrollable) {
        const { scrollTop, scrollHeight, clientHeight } = scrollable
        const atTop = scrollTop <= 0
        const atBottom = scrollTop + clientHeight >= scrollHeight - 1
        if ((!atTop && e.deltaY < 0) || (!atBottom && e.deltaY > 0)) {
          return
        }
      }

      dispatchToCanvas(e)
    }

    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [])

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return
    if (IS_STATIC_DEMO && !hasApiBase()) { showToast?.('Connect a backend (Backend button) to use AI features'); return }

    const userMessage = {
      role: 'user',
      content: input.trim(),
      timestamp: Date.now(),
      elementRefs: elemRefs || null,
      scopeInfo: scopeRef || null
    }

    setMessages(prev => [...prev, userMessage])
    setInput('')
    setIsLoading(true)

    logEvent('nli_submit', { prompt: userMessage.content, hasScopeInfo: !!scopeRef, scopeType: scopeRef?.scopeType })
    const sendTimestamp = Date.now()

    try {
      const response = await fetch(apiUrl('/api/chat-agent'), {
        method: 'POST',
        headers: withApiKey({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          chartSpec,
          message: userMessage.content,
          conversationHistory: messages.map(m => ({
            role: m.role === 'agent' ? 'assistant' : 'user',
            content: m.content
          })),
          elementReferences: scopeRef
            ? [{
                ref: 1,
                scopeType: scopeRef.scopeType,
                scopeLabel: scopeRef.labelEn,
                scopeData: scopeRef.scopeData,
                elementCount: scopeRef.elementCount,
                markType: elemRefs?.[0]?.markType || 'unknown',
                datum: elemRefs?.[0]?.datum || null,
                properties: elemRefs?.[0]?.properties || {},
                label: scopeRef.labelEn
              }]
            : elemRefs || null,
          numberedReferences: chatReferences && chatReferences.length > 0
            ? chatReferences.map(r => ({
                ref: r.number, markType: r.markType, datum: r.datum,
                properties: r.properties, selector: r.selector, label: r.label
              }))
            : null
        })
      })

      const text = await response.text()
      if (!text) {
        throw new Error('Received empty response from server')
      }

      let data
      try {
        data = JSON.parse(text)
      } catch (parseError) {
        console.error('Server response:', text)
        throw new Error(`Failed to parse server response: ${text.substring(0, 200)}`)
      }

      if (!response.ok) {
        throw new Error(data.error || 'API request failed')
      }

      // Show toast if server retried due to invalid spec
      if (data.retried && showToast) {
        showToast('Invalid spec generated, retrying')
      }

      logEvent('nli_response', { responseTimeMs: Date.now() - sendTimestamp, hasWidgets: !!(data.widget_options?.length), success: true })

      const agentMessage = {
        role: 'agent',
        content: data.message,
        timestamp: Date.now(),
        actions: data.actions || null,
        widgetPreview: sanitizeChatWidgets(data.widget_preview || null),
        newSpec: data.new_spec || null
      }

      setMessages(prev => [...prev, agentMessage])

      if (data.new_spec && onPreviewChange) {
        setSpecHistory(prev => [...prev, { spec: currentPreviewSpec, changeType: data.clarification?.change_type || 'visual_refinement' }])
        setCurrentPreviewSpec(data.new_spec)
        onPreviewChange(data.new_spec, data.clarification?.change_type || 'visual_refinement')
      }

      if (data.pending_action) {
        setPendingAction(data.pending_action)
      }

    } catch (error) {
      logEvent('nli_response', { responseTimeMs: Date.now() - sendTimestamp, success: false, error: error.message })
      console.error('Chat error:', error)
      setMessages(prev => [...prev, {
        role: 'agent',
        content: `An error occurred: ${error.message}`,
        timestamp: Date.now(),
        isError: true
      }])
    } finally {
      setIsLoading(false)
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const handleAction = async (action) => {
    if (action.type === 'apply') {
      logEvent('chat_apply', { chartId, turnCount: messages.filter(m => m.role === 'user').length })
      // Apply the changes
      const lastMessageWithSpec = [...messages].reverse().find(m => m.newSpec)
      if (lastMessageWithSpec?.newSpec) {
        // Find the user message that triggered this spec
        const specIndex = messages.findIndex(m => m === lastMessageWithSpec)
        const userMessages = messages.slice(0, specIndex).filter(m => m.role === 'user')
        const lastUserMessage = userMessages[userMessages.length - 1]

        if (onPreviewChange) {
          onPreviewChange(null, null)
        }

        // Use currentPreviewSpec if available (includes widget changes), else message spec
        const finalSpec = currentPreviewSpec || lastMessageWithSpec.newSpec

        setSpecHistory([]) // Clear undo stack on apply
        onApply({
          spec: finalSpec,
          widgetOptions: lastMessageWithSpec.widgetPreview || [],
          changeType: action.changeType || 'visual_refinement',
          command: lastUserMessage?.content || 'Modify via chat',
          conversationHistory: messages // Pass entire conversation
        })
      }
    } else if (action.type === 'cancel') {
      logEvent('chat_discard', { chartId, turnCount: messages.filter(m => m.role === 'user').length })
      if (specHistory.length > 0) {
        // Multi-turn: revert to previous turn's spec
        const prev = specHistory[specHistory.length - 1]
        setSpecHistory(h => h.slice(0, -1))
        setCurrentPreviewSpec(prev.spec)
        if (onPreviewChange) {
          onPreviewChange(prev.spec, prev.changeType)
        }
        // Remove last user + agent message pair
        setMessages(msgs => {
          const copy = [...msgs]
          // Remove last agent message
          for (let i = copy.length - 1; i >= 0; i--) {
            if (copy[i].role === 'agent') { copy.splice(i, 1); break }
          }
          // Remove last user message
          for (let i = copy.length - 1; i >= 0; i--) {
            if (copy[i].role === 'user') { copy.splice(i, 1); break }
          }
          return copy
        })
        setPendingAction(null)
      } else {
        // First turn cancel: close entirely
        if (onPreviewChange) {
          onPreviewChange(null, null)
        }
        onClose()
      }
    } else if (action.type === 'custom') {
      // Send the action as a message
      setInput(action.label)
    }
  }

  const handleClose = () => {
    logEvent('chat_close', { chartId })
    if (onPreviewChange) {
      onPreviewChange(null, null)
    }
    onClose()
  }

  // Helper: set value at a dot/bracket path in an object
  const setSpecValueAtPath = (spec, path, value) => {
    const newSpec = JSON.parse(JSON.stringify(spec))
    const parts = path.match(/([^.\[\]]+|\[\d+\])/g)
    if (!parts) return newSpec
    let current = newSpec
    for (let i = 0; i < parts.length - 1; i++) {
      let key = parts[i]
      if (key.startsWith('[') && key.endsWith(']')) {
        key = parseInt(key.slice(1, -1))
      }
      if (current[key] === undefined) return newSpec
      current = current[key]
    }
    let lastKey = parts[parts.length - 1]
    if (lastKey.startsWith('[') && lastKey.endsWith(']')) {
      lastKey = parseInt(lastKey.slice(1, -1))
    }
    current[lastKey] = value
    return newSpec
  }

  // Widget value change → update message widget + preview spec
  const handleWidgetChange = (msgIndex, widgetIndex, newValue) => {
    setMessages(prev => {
      const updated = [...prev]
      const msg = { ...updated[msgIndex] }
      const widgets = [...msg.widgetPreview]
      const widget = { ...widgets[widgetIndex], value: newValue }
      logEvent('widget_change', { property: widget.path, value: newValue, source: 'chat_widget' })
      widgets[widgetIndex] = widget
      msg.widgetPreview = widgets

      // Update spec with the new value
      if (msg.newSpec && widget.path) {
        msg.newSpec = setSpecValueAtPath(msg.newSpec, widget.path, newValue)
        // Update preview
        if (onPreviewChange) {
          onPreviewChange(msg.newSpec, 'visual_refinement')
        }
        setCurrentPreviewSpec(msg.newSpec)
      }

      updated[msgIndex] = msg
      return updated
    })
  }

  // Remove a widget from the preview list (with undo support)
  const handleWidgetRemove = (msgIndex, widgetIndex) => {
    setMessages(prev => {
      const updated = [...prev]
      const msg = { ...updated[msgIndex] }
      const widgets = [...msg.widgetPreview]
      const removed = widgets.splice(widgetIndex, 1)[0]
      msg.widgetPreview = widgets
      updated[msgIndex] = msg
      // Push to undo stack
      setRemovedWidgets(stack => [...stack, { msgIndex, widgetIndex, widget: removed }])
      return updated
    })
  }

  // Undo last widget removal (Cmd+Z / Ctrl+Z)
  useEffect(() => {
    const handleUndo = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && removedWidgets.length > 0) {
        e.preventDefault()
        const last = removedWidgets[removedWidgets.length - 1]
        setRemovedWidgets(stack => stack.slice(0, -1))
        setMessages(prev => {
          const updated = [...prev]
          const msg = { ...updated[last.msgIndex] }
          const widgets = [...(msg.widgetPreview || [])]
          widgets.splice(last.widgetIndex, 0, last.widget)
          msg.widgetPreview = widgets
          updated[last.msgIndex] = msg
          return updated
        })
      }
    }
    window.addEventListener('keydown', handleUndo)
    return () => window.removeEventListener('keydown', handleUndo)
  }, [removedWidgets])

  // Render widget control — same logic as ConnectionWidget.renderOptionControl
  const renderWidgetControl = (option, msgIndex, widgetIndex) => {
    const onChange = (value) => handleWidgetChange(msgIndex, widgetIndex, value)

    switch (option.type) {
      case 'color':
        return (
          <div className="option-control color-control">
            <label>{option.label}</label>
            <input
              type="color"
              value={option.value || '#000000'}
              onChange={(e) => onChange(e.target.value)}
            />
          </div>
        )

      case 'number': {
        const value = option.value ?? 0
        let min = option.min
        let max = option.max
        let step = option.step

        // Property-aware fallback (same logic as ConnectionWidget)
        const _hint = [option.id, option.label, option.path].join(' ')
        const _rules = [
          { test: /angle|rotate|rotation|labelangle|각도|회전/i, min: -360, max: 360, step: 1 },
          { test: /opacity|fillopacity|strokeopacity|투명|불투명/i, min: 0, max: 1, step: 0.05 },
          { test: /fontsize|titlefontsize|labelfontsize|글꼴.*크기|폰트.*크기|글자.*크기/i, min: 6, max: 48, step: 1 },
          { test: /strokewidth|domainwidth|gridwidth|선.*두께|테두리.*두께/i, min: 0, max: 10, step: 0.5 },
          { test: /cornerradius|모서리.*반경|둥글기/i, min: 0, max: 20, step: 1 },
          { test: /\bsize\b|크기/i, min: 0, max: 500, step: 10 },
          { test: /paddinginner|paddingouter|bandpadding/i, min: 0, max: 1, step: 0.05 },
          { test: /offset|오프셋|위치/i, min: -200, max: 200, step: 1 },
          { test: /padding|spacing|간격|패딩|여백/i, min: 0, max: 50, step: 1 },
          { test: /ticksize|tickwidth|눈금.*크기/i, min: 0, max: 20, step: 1 },
          { test: /\bwidth\b|\bheight\b|너비|높이/i, min: 50, max: 1200, step: 10 },
        ]
        const _rule = _rules.find(r => r.test.test(_hint))
        if (_rule) {
          min = _rule.min; max = _rule.max; step = step ?? _rule.step
          // Clamp value to valid range
        } else if (min === undefined || max === undefined) {
          if (/투명|opacity/i.test(_hint) || (value > 0 && value <= 1)) {
            min = min ?? 0; max = max ?? 1; step = step ?? 0.05
          } else {
            min = min ?? 0; max = max ?? Math.max(10, Math.ceil(value * 3)); step = step ?? (value >= 10 ? 1 : 0.5)
          }
        }

        return (
          <div className="option-control number-control">
            <label>{option.label}</label>
            <input
              type="number"
              className="number-input"
              min={min}
              max={max}
              step={step}
              value={option.value}
              onChange={(e) => onChange(parseFloat(e.target.value))}
            />
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={option.value}
              onChange={(e) => onChange(parseFloat(e.target.value))}
            />
          </div>
        )
      }

      case 'select': {
        const hasOptions = Array.isArray(option.options) && option.options.length > 0
        return (
          <div className="option-control select-control">
            <label>{option.label}</label>
            {hasOptions ? (
              <select
                value={option.value}
                onChange={(e) => onChange(e.target.value)}
              >
                {option.options.map((opt) => {
                  const isObject = typeof opt === 'object' && opt !== null
                  const optValue = isObject ? opt.value : opt
                  const optLabel = isObject ? opt.label : opt
                  return (
                    <option key={optValue} value={optValue}>{optLabel}</option>
                  )
                })}
              </select>
            ) : (
              <input
                type="text"
                value={option.value ?? ''}
                onChange={(e) => onChange(e.target.value)}
              />
            )}
          </div>
        )
      }

      case 'boolean':
        return (
          <div className="option-control boolean-control">
            <label>{option.label}</label>
            <input
              type="checkbox"
              checked={!!option.value}
              onChange={(e) => onChange(e.target.checked)}
            />
          </div>
        )

      case 'text':
        return (
          <div className="option-control text-control">
            <label>{option.label}</label>
            <input
              type="text"
              value={option.value ?? ''}
              onChange={(e) => onChange(e.target.value)}
            />
          </div>
        )

      default:
        return null
    }
  }

  const renderMessageWithBadges = (text) => {
    if (!text) return text
    const parts = text.split(/(\[\d+\])/)
    if (parts.length === 1) return text
    return parts.map((part, i) => {
      const match = part.match(/^\[(\d+)\]$/)
      if (match) {
        return <span key={i} className="inline-ref-badge">{parseInt(match[1])}</span>
      }
      return part
    })
  }

  const renderMessage = (message, index) => {
    return (
      <div key={index} className={`chat-message ${message.role}`}>
        <div className="message-content">
          {renderMessageWithBadges(message.content)}
        </div>
        {message.elementRefs && message.elementRefs.length > 0 && (
          <div className="message-element-refs">
            {message.elementRefs.length === 1
              ? <span className="message-ref-badge">{message.elementRefs[0].label}</span>
              : <span className="message-ref-badge">
                  {message.scopeInfo ? message.scopeInfo.labelEn : `${message.elementRefs.length} elements multi-selected`}
                </span>
            }
          </div>
        )}

        {/* Interactive Widget Preview — same logic as ConnectionWidget */}
        {message.widgetPreview && message.widgetPreview.length > 0 && !readOnly && (
          <div className="widget-preview widget-preview-area">
            <div className="preview-header">Widget Preview</div>
            {message.widgetPreview.map((widget, i) => (
              <div key={widget.id || i} className="preview-widget-interactive widget-slider-row">
                {renderWidgetControl(widget, index, i)}
                <button
                  className="widget-remove-inline"
                  onClick={() => handleWidgetRemove(index, i)}
                  title="Remove widget (Cmd+Z to restore)"
                >&times;</button>
              </div>
            ))}
          </div>
        )}
        {/* Read-only widget display */}
        {message.widgetPreview && message.widgetPreview.length > 0 && readOnly && (
          <div className="widget-preview">
            <div className="preview-header">Widgets:</div>
            {message.widgetPreview.map((widget, i) => (
              <div key={i} className="preview-widget">
                <span className="widget-label">{widget.label}</span>
                <span className="widget-type">{widget.type}</span>
              </div>
            ))}
          </div>
        )}

        {/* Action buttons (hidden in readOnly mode). Whenever there's a new_spec to
            apply, guarantee an apply button even if the LLM's actions omit it or are
            empty — otherwise the apply button silently disappears. */}
        {!readOnly && (message.actions?.length > 0 || message.newSpec) && (() => {
          const actions = message.actions || []
          const hasApply = actions.some(a => a.type === 'apply')
          const hasCancel = actions.some(a => a.type === 'cancel')
          return (
            <div className="message-actions">
              {message.newSpec && !hasApply && (
                <button className="action-btn primary" onClick={() => handleAction({ type: 'apply', label: '적용' })}>적용</button>
              )}
              {actions.map((action, i) => (
                <button
                  key={i}
                  className={`action-btn ${action.primary ? 'primary' : ''}`}
                  onClick={() => handleAction(action)}
                >
                  {action.label}
                </button>
              ))}
              {message.newSpec && !hasCancel && (
                <button className="action-btn" onClick={() => handleAction({ type: 'cancel', label: '취소' })}>취소</button>
              )}
            </div>
          )
        })()}
      </div>
    )
  }

  return (
    <div
      ref={chatRef}
      className={`chat-agent ${isDragging ? 'dragging' : ''}`}
      style={{
        left: screenX,
        top: screenY,
        width: size.width,
        height: size.height,
        transformOrigin: '0 0',
        transform: `scale(${screenScale})`
      }}
    >
      <div
        className="chat-header"
        onMouseDown={handleDragStart}
        style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
      >
        <span>{readOnly ? `#${chartId} chat history` : `Chart #${chartId}`}</span>
        <button className="close-btn" onClick={handleClose}>×</button>
      </div>

      <div className="chat-messages">
        {messages.map(renderMessage)}
        {isLoading && (
          <div className="chat-message agent loading">
            <div className="message-content">
              <span className="typing-indicator">{loadingText}</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {!readOnly && (
        <div className="chat-input-area">
          {(elemRefs?.length > 0 || chatReferences?.length > 0) && (
            <div className="ref-token-strip">
              {elemRefs && elemRefs.length === 1 && (
                <span key="elem-0" className="ref-token-chip elem-ref">
                  
                  <span className="ref-token-number elem-ref">1</span>
                  <span className="ref-token-label">{elemRefs[0].label}</span>
                  {elemRefs?.length > 0 && (
                <button className="ref-token-clear" onClick={() => setElemRefs(null)} title="Clear selection reference">&times;</button>
              )}
                </span>
              )}
              {elemRefs && elemRefs.length > 1 && (
                <span className="ref-token-chip elem-ref">
                  <span className="ref-token-number elem-ref">{scopeRef ? '⊕' : elemRefs.length}</span>
                  <span className="ref-token-label">{scopeRef ? scopeRef.labelEn : 'multi-selected'}</span>
                  {elemRefs?.length > 0 && (
                <button className="ref-token-clear" onClick={() => setElemRefs(null)} title="Clear selection reference">&times;</button>
              )}
                </span>
              )}
              {chatReferences && chatReferences.map(ref => (
                <span key={`chat-${ref.number}`} className="ref-token-chip">
                  <span className="ref-token-number">{ref.number}</span>
                  <span className="ref-token-label">{ref.label}</span>
                  <button className="ref-token-remove" onClick={() => removeReference(ref.number)}>&times;</button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={chatReferences?.length > 0 ? "Click chart elements and type a message..." : "Type a message..."}
            rows={1}
            disabled={isLoading}
          />
          <button
            className="send-btn"
            onClick={sendMessage}
            disabled={!input.trim() || isLoading}
          >
            Send
          </button>
        </div>
      )}

      {readOnly && (
        <div className="chat-readonly-footer">
          Previous conversation (read-only)
        </div>
      )}

      {/* Resize handle */}
      <div
        className="resize-handle"
        onMouseDown={handleResizeStart}
      />
    </div>
  )
}

export default ChatAgent
