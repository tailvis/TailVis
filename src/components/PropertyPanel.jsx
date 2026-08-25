import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { inferColumnType } from '../utils/dataUtils'
import { evaluateTestExpression, extractConditions, deleteCondition, updateConditionValue, updateConditionTest, parseTestExpression, buildTestExpression, extractColorMapping } from '../utils/scopeUtils'
import './PropertyPanel.css'

// Number input that allows typing freely (local string state) and commits on blur/Enter
function NumInput({ value, onChange, min, max, step, ...rest }) {
  const [local, setLocal] = useState(String(value ?? ''))
  const [focused, setFocused] = useState(false)

  // Sync from prop when not focused
  useEffect(() => {
    if (!focused) setLocal(String(value ?? ''))
  }, [value, focused])

  const commit = useCallback(() => {
    const parsed = parseFloat(local)
    if (!isNaN(parsed)) {
      const clamped = min != null && max != null
        ? Math.max(min, Math.min(max, parsed))
        : parsed
      onChange(clamped)
    }
  }, [local, onChange, min, max])

  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={focused ? local : (value ?? '')}
      onChange={(e) => setLocal(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); commit() }}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.target.blur() } }}
      {...rest}
    />
  )
}

/**
 * Determine binding status for a property channel in the spec.
 * Returns { status: 'mapped'|'fixed'|'none', label: string }
 */
function getBindingStatus(spec, property, datum) {
  if (!spec?.encoding) return { status: 'none' }

  // Map property to encoding channels to check
  const channelMap = {
    fill: ['color', 'fill'],
    color: ['color', 'fill'],
    stroke: ['stroke', 'color'],
    opacity: ['opacity'],
    size: ['size'],
    strokeWidth: ['strokeWidth'],
    shape: ['shape'],
  }
  const channels = channelMap[property] || []

  // Check layers too
  const encodingSources = []
  if (spec.encoding) encodingSources.push(spec.encoding)
  if (spec.layer) {
    for (const layer of spec.layer) {
      if (layer.encoding) encodingSources.push(layer.encoding)
    }
  }

  for (const encoding of encodingSources) {
    for (const ch of channels) {
      const enc = encoding[ch]
      if (!enc) continue

      if (enc.field) {
        // Has field mapping — check if this specific datum is under a condition
        if (enc.condition && datum) {
          const conditions = Array.isArray(enc.condition) ? enc.condition : [enc.condition]
          for (const cond of conditions) {
            if (cond.test && evaluateTestExpression(cond.test, datum) === true) {
              return { status: 'fixed', label: 'fixed' }
            }
          }
        }
        return { status: 'mapped', label: enc.field }
      }

      if (enc.condition) {
        // Condition-only encoding (no field)
        if (datum) {
          const conditions = Array.isArray(enc.condition) ? enc.condition : [enc.condition]
          for (const cond of conditions) {
            if (cond.test && evaluateTestExpression(cond.test, datum) === true) {
              return { status: 'fixed', label: 'fixed' }
            }
          }
        }
        // Has conditions but datum doesn't match — still show as mapped via default
        if (enc.value != null) return { status: 'mapped', label: 'default' }
      }

      if (enc.value != null && !enc.field) {
        return { status: 'fixed', label: 'fixed' }
      }
    }
  }

  return { status: 'none' }
}

function BindingTag() {
  return null
}

function ColorInput({ value, onChange }) {
  const isNone = !value || value === 'none' || value === ''
  const [hex, setHex] = useState(isNone ? '' : (value || '#000000'))
  const hiddenPickerRef = useRef(null)

  useEffect(() => {
    const none = !value || value === 'none' || value === ''
    setHex(none ? '' : value)
  }, [value])

  const handleHexChange = (e) => {
    const v = e.target.value
    setHex(v)
    if (/^#[0-9a-fA-F]{6}$/.test(v)) {
      onChange(v)
    }
  }

  const handleHexBlur = () => {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
      setHex(isNone ? '' : (value || '#000000'))
    }
  }

  if (isNone) {
    return (
      <div className="color-input-combo">
        <div
          className="no-color-swatch"
          onClick={() => hiddenPickerRef.current?.click()}
          title="Click to select color"
        />
        {/* Hidden color picker — only applies color when user actually picks one */}
        <input
          ref={hiddenPickerRef}
          type="color"
          value="#000000"
          onChange={(e) => { setHex(e.target.value); onChange(e.target.value) }}
          style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', width: 0, height: 0 }}
        />
        <input
          type="text"
          className="hex-input"
          value="none"
          readOnly
          style={{ color: '#999' }}
        />
      </div>
    )
  }

  return (
    <div className="color-input-combo">
      <input
        type="color"
        value={value || '#000000'}
        onChange={(e) => { setHex(e.target.value); onChange(e.target.value) }}
      />
      <input
        type="text"
        className="hex-input"
        value={hex}
        onChange={handleHexChange}
        onBlur={handleHexBlur}
        spellCheck={false}
      />
      <div
        className="no-color-btn"
        onClick={() => onChange('none')}
        title="No color"
      />
    </div>
  )
}

const colorToHex = (color, defaultColor = '#000000') => {
  if (!color || color === 'none' || color === 'transparent') return defaultColor
  if (color.startsWith('#')) {
    if (color.length === 4) {
      return '#' + color[1] + color[1] + color[2] + color[2] + color[3] + color[3]
    }
    return color
  }

  const rgbMatch = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1]).toString(16).padStart(2, '0')
    const g = parseInt(rgbMatch[2]).toString(16).padStart(2, '0')
    const b = parseInt(rgbMatch[3]).toString(16).padStart(2, '0')
    return `#${r}${g}${b}`
  }

  try {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = color
    const computedColor = ctx.fillStyle
    if (computedColor.startsWith('#')) {
      return computedColor
    }
    const match = computedColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
    if (match) {
      const r = parseInt(match[1]).toString(16).padStart(2, '0')
      const g = parseInt(match[2]).toString(16).padStart(2, '0')
      const b = parseInt(match[3]).toString(16).padStart(2, '0')
      return `#${r}${g}${b}`
    }
  } catch (e) {
  }

  return defaultColor
}

const getElementColor = (element, attrName, defaultColor = '#000000') => {
  if (!element) return defaultColor

  const attrValue = element.getAttribute(attrName)
  if (attrValue && attrValue !== 'none' && attrValue !== 'inherit' && attrValue !== '') {
    const converted = colorToHex(attrValue, null)
    if (converted) return converted
  }

  if (attrValue === null || attrValue === 'none') {
    return defaultColor
  }

  const styleValue = element.style?.[attrName]
  if (styleValue && styleValue !== 'none' && styleValue !== 'inherit' && styleValue !== '') {
    const converted = colorToHex(styleValue, null)
    if (converted) return converted
  }

  return defaultColor
}

const getElementNumber = (element, attrName, defaultValue = 0) => {
  if (!element) return defaultValue

  const attrValue = element.getAttribute(attrName)
  if (attrValue !== null && attrValue !== '') {
    const num = parseFloat(attrValue)
    if (!isNaN(num)) return num
  }

  const styleValue = element.style?.[attrName.replace(/-([a-z])/g, (g) => g[1].toUpperCase())]
  if (styleValue) {
    const num = parseFloat(styleValue)
    if (!isNaN(num)) return num
  }

  // 3. computedStyle
  try {
    const computed = getComputedStyle(element)
    const camelCase = attrName.replace(/-([a-z])/g, (g) => g[1].toUpperCase())
    const computedValue = computed?.[camelCase]
    if (computedValue) {
      const num = parseFloat(computedValue)
      if (!isNaN(num)) return num
    }
  } catch (e) {}

  return defaultValue
}

const VISUAL_SELECTOR = 'rect, circle, ellipse, line, polyline, polygon, path, text, image'
const VISUAL_TAGS = ['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'text', 'image']

const findVisualElements = (groupElement) => {
  if (!groupElement) return []
  const direct = Array.from(groupElement.children || []).filter(c =>
    VISUAL_TAGS.includes(c.tagName?.toLowerCase())
  )
  if (direct.length > 0) return direct
  return Array.from(groupElement.querySelectorAll(VISUAL_SELECTOR))
}

const analyzeGroupChildren = (groupElement) => {
  if (!groupElement) return { isHomogeneous: false, childType: null, count: 0 }

  const filteredChildren = findVisualElements(groupElement)

  if (filteredChildren.length === 0) {
    const children = Array.from(groupElement.children || [])
    const childTags = children.map(c => c.tagName?.toLowerCase()).filter(Boolean)
    const uniqueTags = [...new Set(childTags)]
    return {
      isHomogeneous: false,
      childType: null,
      count: children.length,
      uniqueTags
    }
  }

  const childTags = filteredChildren.map(c => c.tagName?.toLowerCase())
  const uniqueTags = [...new Set(childTags)]

  return {
    isHomogeneous: uniqueTags.length === 1,
    childType: uniqueTags.length === 1 ? uniqueTags[0] : null,
    count: filteredChildren.length,
    uniqueTags
  }
}

const parseTransform = (el) => {
  if (!el) return { x: 0, y: 0 }
  const transform = el.getAttribute('transform') || ''
  const match = transform.match(/translate\(([^,]+),\s*([^)]+)\)/)
  if (match) {
    return { x: parseFloat(match[1]) || 0, y: parseFloat(match[2]) || 0 }
  }
  return { x: 0, y: 0 }
}

const getGroupChildrenProperties = (groupElement, childType) => {
  if (!groupElement || !childType) return {}

  const children = findVisualElements(groupElement)
  const firstChild = children.find(c => c.tagName?.toLowerCase() === childType) || children[0]
  if (!firstChild) return {}

  const isLineType = ['line', 'path', 'polyline'].includes(childType)

  const fill = getElementColor(firstChild, 'fill', isLineType ? 'none' : '#4c78a8')

  const stroke = getElementColor(firstChild, 'stroke', 'none')

  // strokeWidth
  const strokeWidth = getElementNumber(firstChild, 'stroke-width', isLineType ? 1 : 0)

  // opacity
  const opacity = getElementNumber(firstChild, 'opacity', 1)

  const hasStroke = stroke && stroke !== 'none' && stroke !== 'rgba(0, 0, 0, 0)'

  return {
    fill: (!fill || fill === 'none' || fill === 'transparent') ? (isLineType ? '#ffffff' : '#4c78a8') : fill,
    stroke: hasStroke ? stroke : 'none',
    strokeWidth,
    opacity,
    hasFill: fill !== 'none',
    hasStroke: hasStroke || isLineType
  }
}

const getGroupTextProperties = (groupElement) => {
  if (!groupElement) return {}
  const allVisual = findVisualElements(groupElement)
  const firstText = allVisual.find(c => c.tagName?.toLowerCase() === 'text')
  if (!firstText) return {}

  const color = getElementColor(firstText, 'fill', '#000000')

  // font-size
  const fontSize = getElementNumber(firstText, 'font-size', 11)

  // font-weight
  let fontWeight = firstText.getAttribute('font-weight')
  if (!fontWeight) {
    try {
      const computed = getComputedStyle(firstText)
      fontWeight = computed?.fontWeight
    } catch (e) {}
  }
  if (!fontWeight || fontWeight === '400' || fontWeight === 'normal') fontWeight = 'normal'
  else if (fontWeight === '700' || fontWeight === 'bold') fontWeight = 'bold'
  else if (fontWeight === '300' || fontWeight === '100' || fontWeight === '200' || fontWeight === 'lighter') fontWeight = 'lighter'

  let rotate = 0
  const textTransform = firstText.getAttribute('transform') || ''
  const rotateMatch = textTransform.match(/rotate\(([^,)]+)/)
  if (rotateMatch) {
    rotate = parseFloat(rotateMatch[1]) || 0
  }

  return {
    color,
    fontSize,
    fontWeight,
    rotate
  }
}

function GroupProperties({ getElement, onGroupPropertyChange, selectorKey }) {
  const pendingUpdatesRef = useRef({})
  const saveTimeoutRef = useRef(null)

  const computeInitialValues = () => {
    const el = getElement()
    const analysis = analyzeGroupChildren(el)
    const t = parseTransform(el)

    const isLineType = ['line', 'path', 'polyline'].includes(analysis.childType)

    let values = {
      transformX: t.x,
      transformY: t.y,
      transformRotate: 0,
      childFill: isLineType ? '#ffffff' : '#4c78a8',
      childStroke: '#000000',
      childStrokeWidth: isLineType ? 1 : 0,
      childOpacity: 1,
      childColor: '#000000',
      childFontSize: 11,
      childFontWeight: 'normal',
      groupAnalysis: analysis,
      isTextGroup: analysis.isHomogeneous && analysis.childType === 'text'
    }

    if (analysis.isHomogeneous && analysis.childType === 'text') {
      const props = getGroupTextProperties(el)
      values.childColor = props.color
      values.childFontSize = props.fontSize
      values.childFontWeight = props.fontWeight
      values.transformRotate = props.rotate
    } else if (analysis.count > 0) {
      const effectiveType = analysis.childType || findVisualElements(el)[0]?.tagName?.toLowerCase()
      if (effectiveType) {
        const props = getGroupChildrenProperties(el, effectiveType)
        values.childFill = props.fill
        values.childStroke = props.stroke
        values.childStrokeWidth = props.strokeWidth
        values.childOpacity = props.opacity
      }
    }

    return values
  }

  const initRef = useRef(null)
  const prevSelectorRef = useRef(selectorKey)

  if (prevSelectorRef.current !== selectorKey || !initRef.current) {
    initRef.current = computeInitialValues()
    prevSelectorRef.current = selectorKey
  }

  const init = initRef.current

  const [groupAnalysis, setGroupAnalysis] = useState(init.groupAnalysis)
  const [isTextGroup, setIsTextGroup] = useState(init.isTextGroup)
  const [transformX, setTransformX] = useState(init.transformX)
  const [transformY, setTransformY] = useState(init.transformY)
  const [transformRotate, setTransformRotate] = useState(init.transformRotate)
  const [childFill, setChildFill] = useState(init.childFill)
  const [childStroke, setChildStroke] = useState(init.childStroke)
  const [childStrokeWidth, setChildStrokeWidth] = useState(init.childStrokeWidth)
  const [childOpacity, setChildOpacity] = useState(init.childOpacity)
  const [childColor, setChildColor] = useState(init.childColor)
  const [childFontSize, setChildFontSize] = useState(init.childFontSize)
  const [childFontWeight, setChildFontWeight] = useState(init.childFontWeight)

  useEffect(() => {
    const newInit = computeInitialValues()
    setGroupAnalysis(newInit.groupAnalysis)
    setIsTextGroup(newInit.isTextGroup)
    setTransformX(newInit.transformX)
    setTransformY(newInit.transformY)
    setTransformRotate(newInit.transformRotate)
    setChildFill(newInit.childFill)
    setChildStroke(newInit.childStroke)
    setChildStrokeWidth(newInit.childStrokeWidth)
    setChildOpacity(newInit.childOpacity)
    setChildColor(newInit.childColor)
    setChildFontSize(newInit.childFontSize)
    setChildFontWeight(newInit.childFontWeight)
    pendingUpdatesRef.current = {}
  }, [selectorKey])

  const debouncedSave = (propName, value) => {
    pendingUpdatesRef.current[propName] = value

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
    }

    saveTimeoutRef.current = setTimeout(() => {
      Object.entries(pendingUpdatesRef.current).forEach(([name, val]) => {
        onGroupPropertyChange(name, val)
      })
      pendingUpdatesRef.current = {}
    }, 300)
  }

  const flushSave = () => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
    }
    Object.entries(pendingUpdatesRef.current).forEach(([name, val]) => {
      onGroupPropertyChange(name, val)
    })
    pendingUpdatesRef.current = {}
  }

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }
      Object.entries(pendingUpdatesRef.current).forEach(([name, val]) => {
        onGroupPropertyChange(name, val)
      })
    }
  }, [onGroupPropertyChange])

  const handleGroupTransform = (axis, value) => {
    const el = getElement()
    if (!el) return

    const newX = axis === 'x' ? value : transformX
    const newY = axis === 'y' ? value : transformY

    if (axis === 'x') setTransformX(value)
    if (axis === 'y') setTransformY(value)

    el.setAttribute('transform', `translate(${newX}, ${newY})`)
    debouncedSave('transform', `translate(${newX}, ${newY})`)
  }

  const handleTextRotation = (angle, immediate = false) => {
    const el = getElement()
    if (!el) return

    setTransformRotate(angle)

    const textChildren = findVisualElements(el).filter(c =>
      c.tagName?.toLowerCase() === 'text'
    )

    textChildren.forEach(child => {
      const existingTransform = child.getAttribute('transform') || ''

      // Strip any existing rotate(...) but preserve translate/scale/etc.
      const baseTransform = existingTransform.replace(/\s*rotate\([^)]*\)/g, '').trim()

      // Rotation center = text's local x,y (relative to its translated position)
      const x = parseFloat(child.getAttribute('x')) || 0
      const y = parseFloat(child.getAttribute('y')) || 0

      if (angle === 0) {
        if (baseTransform) {
          child.setAttribute('transform', baseTransform)
        } else {
          child.removeAttribute('transform')
        }
      } else {
        const rotatePart = `rotate(${angle},${x},${y})`
        if (baseTransform) {
          child.setAttribute('transform', `${baseTransform} ${rotatePart}`)
        } else {
          child.setAttribute('transform', rotatePart)
        }
      }
    })

    if (immediate) {
      onGroupPropertyChange('childrenRotate', angle)
    } else {
      debouncedSave('childrenRotate', angle)
    }
  }

  const handleChildrenProperty = (propName, value, immediate = false) => {
    const el = getElement()
    if (!el) return

    if (propName === 'fill') setChildFill(value)
    if (propName === 'stroke') setChildStroke(value)
    if (propName === 'strokeWidth') setChildStrokeWidth(value)
    if (propName === 'opacity') setChildOpacity(value)

    const children = findVisualElements(el)

    children.forEach(child => {
      if (propName === 'fill' || propName === 'stroke') {
        child.setAttribute(propName, value)
      } else if (propName === 'strokeWidth') {
        child.setAttribute('stroke-width', value)
      } else if (propName === 'opacity') {
        child.setAttribute('opacity', value)
      }
    })

    const overridePropName = 'children' + propName.charAt(0).toUpperCase() + propName.slice(1)
    if (immediate) {
      onGroupPropertyChange(overridePropName, value)
    } else {
      debouncedSave(overridePropName, value)
    }
  }

  const handleChildrenTextProperty = (propName, value, immediate = false) => {
    const el = getElement()
    if (!el) return

    if (propName === 'color') setChildColor(value)
    if (propName === 'fontSize') setChildFontSize(value)
    if (propName === 'fontWeight') setChildFontWeight(value)

    const textChildren = findVisualElements(el).filter(c =>
      c.tagName?.toLowerCase() === 'text'
    )

    textChildren.forEach(child => {
      if (propName === 'color') {
        child.setAttribute('fill', value)
      } else if (propName === 'fontSize') {
        child.setAttribute('font-size', value)
      } else if (propName === 'fontWeight') {
        child.setAttribute('font-weight', value)
      }
    })

    const overridePropName = 'children' + propName.charAt(0).toUpperCase() + propName.slice(1)
    if (immediate) {
      onGroupPropertyChange(overridePropName, value)
    } else {
      debouncedSave(overridePropName, value)
    }
  }

  return (
    <div className="property-group">
      <h3>Group Properties</h3>
      <p style={{ color: '#888', fontSize: '11px', marginBottom: '12px' }}>
        {groupAnalysis.count} elements
        {groupAnalysis.isHomogeneous
          ? ` (${groupAnalysis.childType})`
          : ` (${groupAnalysis.uniqueTags?.join(', ')})`}
      </p>

      <div className="property-row">
        <label>Position</label>
        <div className="transform-inputs">
          <div className="transform-field">
            <span className="transform-label">X</span>
            <input
              type="number"
              value={transformX}
              onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) handleGroupTransform('x', v) }}
              onBlur={flushSave}
            />
          </div>
          <div className="transform-field">
            <span className="transform-label">Y</span>
            <input
              type="number"
              value={transformY}
              onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) handleGroupTransform('y', v) }}
              onBlur={flushSave}
            />
          </div>
        </div>
      </div>

      {isTextGroup && (
        <>
          <div className="property-row">
            <label>Rotation</label>
            <div className="slider-combo">
              <input
                type="number"
                min={-90}
                max={90}
                value={transformRotate}
                onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) handleTextRotation(v, true) }}
              />
              <input
                type="range"
                min={-90}
                max={90}
                step={1}
                value={transformRotate}
                onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) handleTextRotation(v) }}
                onMouseUp={flushSave}
              />
            </div>
          </div>

          <div className="property-row">
            <label>Font</label>
            <div className="transform-inputs">
              <div className="transform-field">
                <span className="transform-label">Weight</span>
                <select
                  value={childFontWeight}
                  onChange={(e) => handleChildrenTextProperty('fontWeight', e.target.value, true)}
                >
                  <option value="normal">Normal</option>
                  <option value="bold">Bold</option>
                  <option value="lighter">Light</option>
                </select>
              </div>
              <div className="transform-field">
                <span className="transform-label">Size</span>
                <input
                  type="number"
                  min={8}
                  max={72}
                  value={childFontSize}
                  onChange={(e) => handleChildrenTextProperty('fontSize', parseInt(e.target.value))}
                  onBlur={flushSave}
                />
              </div>
            </div>
          </div>

          <div className="property-row">
            <label>Color</label>
            <ColorInput
              value={childColor}
              onChange={(v) => handleChildrenTextProperty('color', v, true)}
            />
          </div>
        </>
      )}

      {!isTextGroup && groupAnalysis.count > 0 && (
        <>
          <div className="property-row">
            <label>Fill</label>
            <ColorInput
              value={childFill}
              onChange={(v) => handleChildrenProperty('fill', v, true)}
            />
          </div>

          <div className="property-row">
            <label>Stroke</label>
            <ColorInput
              value={childStroke === 'none' ? 'none' : childStroke}
              onChange={(v) => handleChildrenProperty('stroke', v, true)}
            />
          </div>

          <div className="property-row" style={childStroke === 'none' ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
            <label>Stroke Width</label>
            <div className="slider-combo">
              <input
                type="number"
                min={0}
                max={10}
                step={0.1}
                value={childStrokeWidth}
                onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) handleChildrenProperty('strokeWidth', v) }}
                onBlur={flushSave}
              />
              <input
                type="range"
                min={0}
                max={10}
                step={0.1}
                value={childStrokeWidth}
                onChange={(e) => handleChildrenProperty('strokeWidth', parseFloat(e.target.value))}
                onMouseUp={flushSave}
                onTouchEnd={flushSave}
              />
            </div>
          </div>

          <div className="property-row">
            <label>Opacity</label>
            <div className="slider-combo">
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={childOpacity}
                onChange={(e) => {
                  const v = parseFloat(e.target.value); if (!isNaN(v)) handleChildrenProperty('opacity', Math.max(0, Math.min(1, v)))
                }}
                onBlur={flushSave}
              />
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={childOpacity}
                onChange={(e) => handleChildrenProperty('opacity', parseFloat(e.target.value))}
                onMouseUp={flushSave}
                onTouchEnd={flushSave}
              />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// User-friendly type names
const typeLabels = {
  'chart-size': 'Chart Size',
  'title': 'Chart Title',
  'mark': 'Mark (Bar/Line/Point)',
  'axis-x': 'X Axis',
  'axis-y': 'Y Axis',
  'text': 'Text',
  'line': 'Line',
  'path': 'Path',
  'point': 'Point',
  'rect': 'Rect',
  'circle': 'Circle',
  'legend': 'Legend',
  'group': 'Group'
}

function ChartProperties({ readOnly = false, chart, onChartPropertyChange, dataSources, onUpdateChart }) {
  const spec = chart?.spec
  if (!spec) return null

  // A faceted spec wraps its real marks/encodings inside `.spec` ({facet, spec}).
  // Read & write through that inner spec so Mark Options / Colors / Legend keep
  // working (they look at top-level encoding/layer/mark, which is empty when faceted).
  const innerOf = (s) => (s && s.spec && s.facet ? s.spec : s)
  const innerSpec = innerOf(spec)

  // The encoding the panel edits is top-level for simple specs, but lives inside the
  // first layer for layered specs (e.g. histograms: layer[0].encoding.x.bin). Resolve
  // read AND write to that host so field/type/aggregate/bin controls actually apply.
  const findEncodingHost = (root) => {
    const inner = innerOf(root)
    if (inner?.encoding && Object.keys(inner.encoding).length) return inner
    if (Array.isArray(inner?.layer)) {
      const l = inner.layer.find(ly => ly.encoding && Object.keys(ly.encoding).length)
      if (l) return l
    }
    if (inner && !inner.encoding) inner.encoding = {}
    return inner
  }

  // Declarative chart property definitions: { key, label, group, type, read, props }
  const readTitle = (field, fallback) =>
    typeof spec.title === 'object' ? (spec.title?.[field] ?? fallback) : fallback

  const CHART_PROPS = [
    { key: 'width',    label: 'W', group: 'Size', type: 'number', read: (innerSpec.width ?? spec.width) || 400, props: { min: 100, max: 1200, step: 10 } },
    { key: 'height',   label: 'H', group: 'Size', type: 'number', read: (innerSpec.height ?? spec.height) || 250, props: { min: 100, max: 1200, step: 10 } },
    { key: 'title',    label: 'Text',     group: 'Title', type: 'text', read: typeof spec.title === 'string' ? spec.title : spec.title?.text || '', props: { placeholder: 'Chart title' } },
    { key: 'subtitle', label: 'Subtitle', group: 'Title', type: 'text', read: readTitle('subtitle', ''), props: { placeholder: 'Chart subtitle' } },
  ]

  const background = spec.background || '#ffffff'
  const padding = typeof spec.padding === 'number' ? spec.padding : 0

  // Encoding panel data — use chart's embedded data (respects area selection), not full data source
  const dataValues = spec?.data?.values || (
    chart.dataSourceId && dataSources?.[chart.dataSourceId]
      ? dataSources[chart.dataSourceId].values
      : null
  )
  const columnKeys = dataValues?.[0] ? Object.keys(dataValues[0]) : []
  const encoding = findEncodingHost(spec)?.encoding || {}

  // Channel shelf, filtered to the channels relevant for the current mark (Vega-Lite ignores
  // irrelevant channels anyway, but hiding them keeps the panel clean). Any channel that is
  // already encoded stays visible so existing encodings can always be seen/edited.
  const ALL_CHANNELS = ['x', 'y', 'xOffset', 'color', 'theta', 'size', 'shape', 'opacity', 'column', 'row']
  const CHANNELS_BY_MARK = {
    bar:     ['x', 'y', 'xOffset', 'color', 'opacity', 'column', 'row'],
    line:    ['x', 'y', 'color', 'size', 'opacity', 'column', 'row'],
    trail:   ['x', 'y', 'color', 'size', 'opacity'],
    area:    ['x', 'y', 'color', 'opacity', 'column', 'row'],
    point:   ['x', 'y', 'color', 'size', 'shape', 'opacity', 'column', 'row'],
    circle:  ['x', 'y', 'color', 'size', 'opacity', 'column', 'row'],
    square:  ['x', 'y', 'color', 'size', 'opacity', 'column', 'row'],
    arc:     ['theta', 'color', 'opacity'],
    rect:    ['x', 'y', 'color', 'opacity', 'column', 'row'],
    boxplot: ['x', 'y', 'color', 'size', 'column', 'row'],
    rule:    ['x', 'y', 'color', 'opacity'],
    tick:    ['x', 'y', 'color', 'opacity'],
    text:    ['x', 'y', 'color', 'size', 'opacity'],
  }
  const markType = typeof innerSpec?.mark === 'string' ? innerSpec.mark : innerSpec?.mark?.type
  // Stacking only applies to bar/area marks — line, point, etc. don't stack.
  const STACKABLE_MARKS = new Set(['bar', 'area'])
  const allowed = (markType && CHANNELS_BY_MARK[markType]) || ALL_CHANNELS
  // Layered specs have no top-level mark → show everything.
  const baseAllowed = spec?.layer ? ALL_CHANNELS : allowed
  const channels = ALL_CHANNELS.filter(ch => baseAllowed.includes(ch) || encoding[ch]?.field)
  const TYPE_MAP = { Q: 'quantitative', N: 'nominal', O: 'ordinal', T: 'temporal' }
  const TYPE_REVERSE = { quantitative: 'Q', nominal: 'N', ordinal: 'O', temporal: 'T' }
  // Suffix marking a field derived from an integer year via datetime() (see handleTypeChange)
  const YEAR_DATE_SUFFIX = '__year_date'

  // Mark-type-specific options, shown under Encoding. Each option maps to a
  // Vega-Lite mark property (spec.mark.<key>). 'default' is the implicit VL value
  // used when the property is absent.
  const INTERPOLATE_OPTS = ['linear', 'monotone', 'basis', 'cardinal', 'step', 'step-after', 'step-before']
  const MARK_OPTIONS_BY_TYPE = {
    line: [
      { key: 'point', label: 'Points', type: 'boolean', default: false },
      { key: 'interpolate', label: 'Curve', type: 'select', default: 'linear', options: INTERPOLATE_OPTS },
    ],
    area: [
      { key: 'line', label: 'Edge line', type: 'boolean', default: false },
      { key: 'point', label: 'Points', type: 'boolean', default: false },
      { key: 'interpolate', label: 'Curve', type: 'select', default: 'linear', options: INTERPOLATE_OPTS },
    ],
    trail: [
      { key: 'point', label: 'Points', type: 'boolean', default: false },
    ],
    bar: [
      { key: 'cornerRadiusEnd', label: 'Corner radius', type: 'number', default: 0, min: 0, max: 40, step: 1 },
    ],
    // Vega-Lite default for `point` is filled:false (hollow); circle/square default
    // to filled:true. The default must match VL or the toggle's first click is a no-op.
    point: [
      { key: 'filled', label: 'Filled', type: 'boolean', default: false },
    ],
    circle: [
      { key: 'filled', label: 'Filled', type: 'boolean', default: true },
    ],
    square: [
      { key: 'filled', label: 'Filled', type: 'boolean', default: true },
    ],
    tick: [
      { key: 'thickness', label: 'Thickness', type: 'number', default: 1, min: 1, max: 20, step: 1 },
    ],
    arc: [
      { key: 'innerRadius', label: 'Donut hole', type: 'number', default: 0, min: 0, max: 150, step: 5 },
    ],
    boxplot: [
      { key: 'size', label: 'Box width', type: 'number', default: 14, min: 4, max: 80, step: 1 },
      { key: 'outliers', label: 'Outliers', type: 'boolean', default: true },
    ],
  }
  // Current mark object (for reading option values). For layered specs, read the
  // first layer that carries a mark.
  const primaryMark = innerSpec?.layer ? innerSpec.layer.find(l => l.mark)?.mark : innerSpec?.mark
  const markObj = typeof primaryMark === 'string' ? { type: primaryMark } : (primaryMark || {})
  const effMarkType = markType || markObj.type
  const markOptions = (effMarkType && MARK_OPTIONS_BY_TYPE[effMarkType]) || []

  // Apply a mark option to spec.mark (and every layer's mark), updating both the
  // current spec and baseSpec so it survives later modification re-application.
  const handleMarkOption = (key, value, isDefault) => {
    if (!onUpdateChart) return
    const mutateMark = (m) => {
      const obj = typeof m === 'string' ? { type: m } : { ...m }
      if (isDefault) delete obj[key]
      else obj[key] = value
      return obj
    }
    const mutateSpec = (s) => {
      const ns = JSON.parse(JSON.stringify(s))
      const inner = innerOf(ns)
      if (inner.layer) {
        inner.layer = inner.layer.map(l => (l.mark ? { ...l, mark: mutateMark(l.mark) } : l))
        // A top-level mark is dead weight in a layered spec (Vega-Lite ignores it);
        // drop it so it can't shadow/confuse the per-layer marks.
        if (inner.mark) delete inner.mark
      } else if (inner.mark) {
        inner.mark = mutateMark(inner.mark)
      }
      return ns
    }
    const updates = { spec: mutateSpec(spec) }
    if (chart.baseSpec) updates.baseSpec = mutateSpec(chart.baseSpec)
    onUpdateChart(chart.id, updates)
  }

  // ── Legend show/hide ────────────────────────────────────────────────────────
  // A legend appears when one of these channels is bound to a field. Toggling sets
  // (or clears) `legend: null` on every such channel across the spec & its layers.
  const LEGEND_CHANNELS = ['color', 'fill', 'size', 'shape', 'opacity', 'strokeWidth']
  const collectEncodings = (s) => {
    const encs = []
    if (s?.encoding) encs.push(s.encoding)
    if (Array.isArray(s?.layer)) for (const l of s.layer) if (l.encoding) encs.push(l.encoding)
    return encs
  }
  let legendChannel = null
  for (const enc of collectEncodings(innerSpec)) {
    for (const ch of LEGEND_CHANNELS) { if (enc[ch]?.field) { legendChannel = ch; break } }
    if (legendChannel) break
  }
  // Shown unless any bound channel explicitly sets legend:null.
  let legendShown = !!legendChannel
  if (legendChannel) {
    for (const enc of collectEncodings(innerSpec)) {
      const e = enc[legendChannel]
      if (e?.field && e.legend === null) { legendShown = false; break }
    }
  }
  const handleLegendToggle = (show) => {
    if (!onUpdateChart) return
    const mutateSpec = (s) => {
      const ns = JSON.parse(JSON.stringify(s))
      for (const enc of collectEncodings(innerOf(ns))) {
        for (const ch of LEGEND_CHANNELS) {
          if (!enc[ch]?.field) continue
          if (show) { if ('legend' in enc[ch]) delete enc[ch].legend }
          else enc[ch].legend = null
        }
      }
      return ns
    }
    const updates = { spec: mutateSpec(spec) }
    if (chart.baseSpec) updates.baseSpec = mutateSpec(chart.baseSpec)
    onUpdateChart(chart.id, updates)
  }

  // ── Treemap (raw Vega) options ──────────────────────────────────────────────
  // Treemaps are raw Vega specs (array-form data + a `marks` array), so they have
  // no spec.mark — edits target the treemap transform and the rect/text marks.
  const isTreemap = Array.isArray(spec?.data) && Array.isArray(spec?.marks) &&
    spec.data.some(d => (d.transform || []).some(t => t.type === 'treemap'))
  const findTreemapBits = (s) => {
    const dataset = s.data.find(d => (d.transform || []).some(t => t.type === 'treemap'))
    return {
      tmTransform: dataset?.transform?.find(t => t.type === 'treemap'),
      rectMark: s.marks.find(m => m.type === 'rect'),
      textMark: s.marks.find(m => m.type === 'text'),
    }
  }
  let treemapVals = null
  if (isTreemap) {
    const { tmTransform, rectMark, textMark } = findTreemapBits(spec)
    treemapVals = {
      padding: tmTransform?.padding ?? 1,
      borderWidth: rectMark?.encode?.enter?.strokeWidth?.value ?? 1,
      labels: (textMark?.encode?.update?.opacity?.value ?? 1) !== 0,
    }
  }
  const handleTreemapOption = (key, value) => {
    if (!onUpdateChart) return
    const mutateSpec = (s) => {
      const ns = JSON.parse(JSON.stringify(s))
      const { tmTransform, rectMark, textMark } = findTreemapBits(ns)
      if (key === 'padding' && tmTransform) {
        tmTransform.padding = value
      } else if (key === 'borderWidth' && rectMark) {
        rectMark.encode = rectMark.encode || {}
        rectMark.encode.enter = rectMark.encode.enter || {}
        rectMark.encode.enter.strokeWidth = { value }
      } else if (key === 'labels' && textMark) {
        textMark.encode = textMark.encode || {}
        textMark.encode.update = textMark.encode.update || {}
        textMark.encode.update.opacity = { value: value ? 1 : 0 }
      }
      return ns
    }
    const updates = { spec: mutateSpec(spec) }
    if (chart.baseSpec) updates.baseSpec = mutateSpec(chart.baseSpec)
    onUpdateChart(chart.id, updates)
  }

  // ── Color swatches ──────────────────────────────────────────────────────────
  // When color/fill is bound to a categorical field (e.g. Species), expose one
  // swatch per category. We read the ACTUAL current colors (extractColorMapping
  // reads the rendered Vega scale) and write an explicit scale domain+range, so
  // changing one category never disturbs the others.
  const colorMapping = (() => {
    try { return extractColorMapping(innerSpec, null, chart.id) } catch { return null }
  })()
  const handleCategoryColor = (channel, mapping, fieldValue, newColor) => {
    if (!onUpdateChart) return
    const domain = mapping.map(m => m.fieldValue)
    const range = mapping.map(m => (String(m.fieldValue) === String(fieldValue) ? newColor : m.color))
    const applyScale = (enc) => {
      if (enc?.[channel]?.field) {
        const next = { ...enc[channel], scale: { ...(enc[channel].scale || {}), domain, range } }
        if (next.scale.scheme) delete next.scale.scheme
        enc[channel] = next
        return true
      }
      return false
    }
    const mutateSpec = (s) => {
      const ns = JSON.parse(JSON.stringify(s))
      const inner = innerOf(ns)
      let done = applyScale(inner.encoding)
      if (!done && Array.isArray(inner.layer)) for (const l of inner.layer) { if (applyScale(l.encoding)) { done = true; break } }
      return ns
    }
    const updates = { spec: mutateSpec(spec) }
    if (chart.baseSpec) updates.baseSpec = mutateSpec(chart.baseSpec)
    onUpdateChart(chart.id, updates)
  }
  // Continuous (quantitative) color: set an explicit 2-stop scale range [low, high]
  // (e.g. heatmaps, gradient encodings). Replaces the scheme so the endpoints stick.
  const handleGradientColor = (channel, range) => {
    if (!onUpdateChart) return
    const applyScale = (enc) => {
      if (enc?.[channel]?.field) {
        const next = { ...enc[channel], scale: { ...(enc[channel].scale || {}), range } }
        if (next.scale.scheme) delete next.scale.scheme
        enc[channel] = next
        return true
      }
      return false
    }
    const mutateSpec = (s) => {
      const ns = JSON.parse(JSON.stringify(s))
      const inner = innerOf(ns)
      let done = applyScale(inner.encoding)
      if (!done && Array.isArray(inner.layer)) for (const l of inner.layer) { if (applyScale(l.encoding)) { done = true; break } }
      return ns
    }
    const updates = { spec: mutateSpec(spec) }
    if (chart.baseSpec) updates.baseSpec = mutateSpec(chart.baseSpec)
    onUpdateChart(chart.id, updates)
  }
  // Single (non-field) mark color — for charts without a categorical color encoding.
  const singleColorValue = markObj.color || markObj.fill || innerSpec?.encoding?.color?.value || innerSpec?.encoding?.fill?.value || null

  const handleFieldChange = (channel, newField) => {
    const newSpec = JSON.parse(JSON.stringify(spec))
    const enc0 = findEncodingHost(newSpec)
    if (!enc0.encoding) enc0.encoding = {}
    // Clean up a prior year→date derived field/transform on this channel
    const prev = enc0.encoding[channel]
    if (prev && typeof prev.field === 'string' && prev.field.endsWith(YEAR_DATE_SUFFIX)) {
      newSpec.transform = (newSpec.transform || []).filter(t => t.as !== prev.field)
      if (newSpec.transform.length === 0) delete newSpec.transform
      delete prev.title
      if (prev.axis?.format === '%Y') {
        delete prev.axis.format
        if (Object.keys(prev.axis).length === 0) delete prev.axis
      }
    }
    if (newField === '') {
      delete enc0.encoding[channel]
    } else if (newField === COUNT_FIELD) {
      // "Count of Records": aggregate count with NO field (e.g. stacked-bar y).
      enc0.encoding[channel] = { aggregate: 'count', type: 'quantitative' }
    } else {
      const inferredType = dataValues
        ? TYPE_MAP[inferColumnType(dataValues.map(r => r[newField]))] || 'nominal'
        : 'nominal'
      enc0.encoding[channel] = { ...(enc0.encoding[channel] || {}), field: newField, type: inferredType }
      delete enc0.encoding[channel].aggregate  // clear a leftover count aggregate
    }
    onUpdateChart(chart.id, { spec: newSpec })
  }

  // Time unit for temporal fields (e.g. `date` → "month of the year").
  const handleTimeUnitChange = (channel, tu) => {
    const newSpec = JSON.parse(JSON.stringify(spec))
    const enc = findEncodingHost(newSpec).encoding?.[channel]
    if (!enc) return
    if (tu === '') delete enc.timeUnit
    else enc.timeUnit = tu
    onUpdateChart(chart.id, { spec: newSpec })
  }

  const handleTypeChange = (channel, newTypeShort) => {
    const newSpec = JSON.parse(JSON.stringify(spec))
    const enc = findEncodingHost(newSpec).encoding?.[channel]
    if (!enc) return
    const newType = TYPE_MAP[newTypeShort] || 'nominal'

    // If this channel currently uses a year→date derived field, revert it first
    // (restore the base field, drop the calculate transform, clear our extras).
    if (typeof enc.field === 'string' && enc.field.endsWith(YEAR_DATE_SUFFIX)) {
      const derived = enc.field
      enc.field = derived.slice(0, -YEAR_DATE_SUFFIX.length)
      newSpec.transform = (newSpec.transform || []).filter(t => t.as !== derived)
      if (newSpec.transform.length === 0) delete newSpec.transform
      if (enc.title === enc.field) delete enc.title
      if (enc.axis?.format === '%Y') {
        delete enc.axis.format
        if (Object.keys(enc.axis).length === 0) delete enc.axis
      }
    }

    // Integer years (e.g. 1875) as temporal are read by Vega-Lite as epoch
    // milliseconds → a broken sub-second axis (".990", ":02"). Convert the year to
    // a real date via datetime() and encode that derived field so the axis shows years.
    const field = enc.field
    const sample = dataValues ? dataValues.map(r => r[field]).filter(v => v != null) : []
    const looksLikeYear = sample.length > 0 && sample.every(v => Number.isInteger(v) && v >= 1000 && v <= 9999)

    if (newType === 'temporal' && looksLikeYear) {
      const derived = `${field}${YEAR_DATE_SUFFIX}`
      newSpec.transform = newSpec.transform || []
      if (!newSpec.transform.some(t => t.as === derived)) {
        newSpec.transform.push({ calculate: `datetime(datum['${field}'], 0, 1)`, as: derived })
      }
      enc.field = derived
      enc.type = 'temporal'
      enc.title = field
      enc.axis = { ...(enc.axis || {}), format: '%Y' }
    } else {
      enc.type = newType
    }

    onUpdateChart(chart.id, { spec: newSpec })
  }

  const handleAggregateChange = (channel, newAggregate) => {
    const newSpec = JSON.parse(JSON.stringify(spec))
    const host = findEncodingHost(newSpec)
    if (!host.encoding?.[channel]) return
    if (newAggregate === '') {
      delete host.encoding[channel].aggregate
    } else {
      host.encoding[channel].aggregate = newAggregate
    }
    onUpdateChart(chart.id, { spec: newSpec })
  }

  // Bin a quantitative field (histograms, binned heatmaps)
  const handleBinChange = (channel, on) => {
    const newSpec = JSON.parse(JSON.stringify(spec))
    const host = findEncodingHost(newSpec)
    if (!host.encoding?.[channel]) return
    if (on) { host.encoding[channel].bin = true; delete host.encoding[channel].aggregate }
    else delete host.encoding[channel].bin
    onUpdateChart(chart.id, { spec: newSpec })
  }
  // Adjust bin granularity via maxbins (fewer maxbins → wider bins).
  const handleBinMaxbins = (channel, maxbins) => {
    const newSpec = JSON.parse(JSON.stringify(spec))
    const enc = findEncodingHost(newSpec).encoding?.[channel]
    if (!enc?.bin) return
    enc.bin = { ...(typeof enc.bin === 'object' ? enc.bin : {}), maxbins }
    onUpdateChart(chart.id, { spec: newSpec })
  }
  const binMaxbinsOf = (enc) => (typeof enc?.bin === 'object' ? (enc.bin.maxbins ?? 10) : 10)

  // Stack mode for the value axis (stacked / 100% / overlaid) — drives stacked & normalized charts
  const handleStackChange = (channel, mode) => {
    const newSpec = JSON.parse(JSON.stringify(spec))
    const host = findEncodingHost(newSpec)
    if (!host.encoding?.[channel]) return
    if (mode === 'stacked') delete host.encoding[channel].stack // VL default = stacked
    else if (mode === 'none') host.encoding[channel].stack = null
    else host.encoding[channel].stack = mode // 'normalize'
    onUpdateChart(chart.id, { spec: newSpec })
  }

  const AGGREGATES = ['sum', 'mean', 'median', 'min', 'max', 'count', 'distinct', 'variance', 'stdev']
  const COUNT_FIELD = '__count__'
  // Temporal binning units. yearmonth = a real month on a timeline; month = "month of the
  // year" (Jan–Dec, ignoring year) — that's what the stacked-weather-by-month chart uses.
  const TIME_UNITS = [
    ['month', 'month of year'], ['yearmonth', 'year-month'], ['year', 'year'],
    ['quarter', 'quarter'], ['yearquarter', 'year-quarter'], ['yearmonthdate', 'date'],
    ['day', 'weekday'], ['date', 'day of month'], ['hours', 'hour'],
  ]

  const hasXY = !!(spec.encoding?.x && spec.encoding?.y)

  return (
    <div className="property-panel">
      <div className="panel-header">
        <span className="element-type">Chart Properties</span>
      </div>
      <div className="panel-content">
        {Object.entries(Object.groupBy(CHART_PROPS, p => p.group)).map(([group, props]) => (
          <div className="property-group" key={group}>
            <h3>{group}</h3>
            {group === 'Size' ? (
              <div className="property-row">
                <label>Size</label>
                <div className="transform-inputs">
                  {props.map(p => (
                    <div className="transform-field" key={p.key}>
                      <span className="transform-label">{p.label}</span>
                      <input type="number" value={p.read} {...p.props}
                        onChange={(e) => onChartPropertyChange(p.key, parseInt(e.target.value) || p.read)} />
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              props.map(p => (
                <div className="property-row" key={p.key}>
                  <label>{p.label}</label>
                  <input type={p.type} value={p.read} {...p.props}
                    onChange={(e) => onChartPropertyChange(p.key, p.type === 'number' ? (parseInt(e.target.value) || p.read) : e.target.value)} />
                </div>
              ))
            )}
          </div>
        ))}

        {/* <div className="property-group">
          <h3>Background</h3>
          <div className="property-row">
            <label>Color</label>
            <ColorInput
              value={background}
              onChange={(v) => onChartPropertyChange('background', v)}
            />
          </div>
          <div className="property-row">
            <label>Padding</label>
            <input
              type="number"
              min={0}
              max={100}
              value={padding}
              onChange={(e) => onChartPropertyChange('padding', parseInt(e.target.value) || 0)}
            />
          </div>
        </div> */}

        {hasXY && (
          <div className="property-group">
            <h3>Layout</h3>
            <div className="property-row">
              <label>Swap</label>
              <button
                className="transpose-btn"
                onClick={() => onChartPropertyChange('transpose', true)}
                title="Swap X and Y axis encodings"
              >
                Transpose (X ↔ Y)
              </button>
            </div>
          </div>
        )}

        {columnKeys.length > 0 && !chart?.parentId && !readOnly && (
          <div className="property-group">
            <h3>Encoding</h3>
            {channels.map(ch => {
              const enc = encoding[ch]
              const rawField = enc?.field || ''
              const isCount = enc?.aggregate === 'count' && !enc?.field
              // Show the base field name for a year→date derived field (e.g. year__year_date → year)
              const currentField = isCount ? COUNT_FIELD
                : (rawField.endsWith(YEAR_DATE_SUFFIX) ? rawField.slice(0, -YEAR_DATE_SUFFIX.length) : rawField)
              const currentType = enc?.type ? (TYPE_REVERSE[enc.type] || 'N') : 'N'
              const currentAggregate = enc?.aggregate || ''
              const hasRealField = currentField && currentField !== COUNT_FIELD
              return (
                <div key={ch} className="property-row enc-panel-row">
                  <span className="enc-panel-channel">{ch}</span>
                  <div className="enc-panel-controls">
                    {/* Line 1: field + data type. Modifiers below wrap to line 2,
                        aligned to this column's left edge (under the field). */}
                    <select
                      className="enc-panel-field"
                      value={currentField}
                      onChange={(e) => handleFieldChange(ch, e.target.value)}
                    >
                      <option value="">— none —</option>
                      <option value={COUNT_FIELD}>count()</option>
                      {columnKeys.map(col => <option key={col} value={col}>{col}</option>)}
                    </select>
                    {hasRealField && (
                      <select
                        className="enc-panel-type"
                        value={currentType}
                        onChange={(e) => handleTypeChange(ch, e.target.value)}
                      >
                        <option value="Q">Q</option>
                        <option value="N">N</option>
                        <option value="O">O</option>
                        <option value="T">T</option>
                      </select>
                    )}
                    {hasRealField && currentType === 'T' && (
                      <select
                        className="enc-panel-timeunit"
                        value={enc?.timeUnit || ''}
                        onChange={(e) => handleTimeUnitChange(ch, e.target.value)}
                        title="Time unit (e.g. month of the year)"
                      >
                        <option value="">full date</option>
                        {TIME_UNITS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                      </select>
                    )}
                    {hasRealField && currentType === 'Q' && (
                      <select
                        className="enc-panel-agg"
                        value={currentAggregate}
                        onChange={(e) => handleAggregateChange(ch, e.target.value)}
                      >
                        <option value="">raw</option>
                        {AGGREGATES.map(agg => <option key={agg} value={agg}>{agg}</option>)}
                      </select>
                    )}
                    {hasRealField && currentType === 'Q' && !currentAggregate && (
                      <label className="enc-panel-bin" title="Bin this field (histograms)">
                        <input type="checkbox" checked={!!enc?.bin} onChange={(e) => handleBinChange(ch, e.target.checked)} />
                        bin
                      </label>
                    )}
                    {currentField && currentType === 'Q' && !currentAggregate && !!enc?.bin && (
                      <div className="enc-panel-binsize" title="Max number of bins (fewer = wider bins)">
                        <input type="number" className="enc-binsize-num" min={2} max={100} step={1}
                          value={binMaxbinsOf(enc)}
                          onChange={(e) => { const v = parseInt(e.target.value); if (!isNaN(v)) handleBinMaxbins(ch, v) }} />
                        <input type="range" className="enc-binsize-range" min={2} max={100} step={1}
                          value={binMaxbinsOf(enc)}
                          onChange={(e) => handleBinMaxbins(ch, parseInt(e.target.value))} />
                      </div>
                    )}
                    {currentField && currentType === 'Q' && (ch === 'x' || ch === 'y') && STACKABLE_MARKS.has(markType) && (
                      <select
                        className="enc-panel-stack"
                        value={enc?.stack === null ? 'none' : enc?.stack === 'normalize' ? 'normalize' : 'stacked'}
                        onChange={(e) => handleStackChange(ch, e.target.value)}
                        title="Stacking (needs a color/detail field)"
                      >
                        <option value="stacked">stacked</option>
                        <option value="normalize">100%</option>
                        <option value="none">overlaid</option>
                      </select>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {markOptions.length > 0 && (
          <div className="property-group">
            <h3>Mark Options</h3>
            {markOptions.map(opt => {
              const current = markObj[opt.key] ?? opt.default
              if (opt.type === 'boolean') {
                const on = !!current
                return (
                  <div className="property-row" key={opt.key}>
                    <label>{opt.label}</label>
                    <button
                      className={`mark-option-toggle${on ? ' on' : ''}`}
                      onClick={() => handleMarkOption(opt.key, !on, !on === opt.default)}
                      title={`Toggle ${opt.label.toLowerCase()}`}
                    >
                      {on ? 'On' : 'Off'}
                    </button>
                  </div>
                )
              }
              if (opt.type === 'select') {
                return (
                  <div className="property-row" key={opt.key}>
                    <label>{opt.label}</label>
                    <select
                      value={current}
                      onChange={(e) => handleMarkOption(opt.key, e.target.value, e.target.value === opt.default)}
                    >
                      {opt.options.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </div>
                )
              }
              // number
              return (
                <div className="property-row" key={opt.key}>
                  <label>{opt.label}</label>
                  <div className="slider-combo">
                    <input
                      type="number"
                      min={opt.min} max={opt.max} step={opt.step || 1}
                      value={current}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value)
                        if (!isNaN(v)) handleMarkOption(opt.key, v, v === opt.default)
                      }}
                    />
                    <input
                      type="range"
                      min={opt.min} max={opt.max} step={opt.step || 1}
                      value={current}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value)
                        handleMarkOption(opt.key, v, v === opt.default)
                      }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {colorMapping?.type === 'categorical' && colorMapping.mapping?.length > 0 && (
          <div className="property-group">
            <h3>Colors</h3>
            {colorMapping.mapping.map(m => (
              <div className="property-row" key={String(m.fieldValue)}>
                <label title={String(m.fieldValue)}>{String(m.fieldValue)}</label>
                <ColorInput
                  value={m.color || '#888888'}
                  onChange={(v) => handleCategoryColor(colorMapping.channel, colorMapping.mapping, m.fieldValue, v)}
                />
              </div>
            ))}
          </div>
        )}

        {colorMapping?.type === 'continuous' && (
          <div className="property-group">
            <h3>Color Scale</h3>
            <div className="property-row">
              <label>Low</label>
              <ColorInput
                value={colorMapping.lowColor || '#f7fbff'}
                onChange={(v) => handleGradientColor(colorMapping.channel, [v, colorMapping.highColor || '#08306b'])}
              />
            </div>
            <div className="property-row">
              <label>High</label>
              <ColorInput
                value={colorMapping.highColor || '#08306b'}
                onChange={(v) => handleGradientColor(colorMapping.channel, [colorMapping.lowColor || '#f7fbff', v])}
              />
            </div>
          </div>
        )}

        {effMarkType && !isTreemap && (!colorMapping || colorMapping.type === 'static') && (
          <div className="property-group">
            <h3>Color</h3>
            <div className="property-row">
              <label>Mark color</label>
              <ColorInput
                value={singleColorValue || '#4c78a8'}
                onChange={(v) => handleMarkOption('color', v, false)}
              />
            </div>
          </div>
        )}

        {legendChannel && (
          <div className="property-group">
            <h3>Legend</h3>
            <div className="property-row">
              <label>Show legend</label>
              <button
                className={`mark-option-toggle${legendShown ? ' on' : ''}`}
                onClick={() => handleLegendToggle(!legendShown)}
                title="Toggle legend"
              >{legendShown ? 'On' : 'Off'}</button>
            </div>
          </div>
        )}

        {isTreemap && treemapVals && (
          <div className="property-group">
            <h3>Treemap Options</h3>
            <div className="property-row">
              <label>Tile gap</label>
              <div className="slider-combo">
                <input type="number" min={0} max={20} step={1} value={treemapVals.padding}
                  onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) handleTreemapOption('padding', v) }} />
                <input type="range" min={0} max={20} step={1} value={treemapVals.padding}
                  onChange={(e) => handleTreemapOption('padding', parseFloat(e.target.value))} />
              </div>
            </div>
            <div className="property-row">
              <label>Border width</label>
              <div className="slider-combo">
                <input type="number" min={0} max={10} step={0.5} value={treemapVals.borderWidth}
                  onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) handleTreemapOption('borderWidth', v) }} />
                <input type="range" min={0} max={10} step={0.5} value={treemapVals.borderWidth}
                  onChange={(e) => handleTreemapOption('borderWidth', parseFloat(e.target.value))} />
              </div>
            </div>
            <div className="property-row">
              <label>Labels</label>
              <button
                className={`mark-option-toggle${treemapVals.labels ? ' on' : ''}`}
                onClick={() => handleTreemapOption('labels', !treemapVals.labels)}
                title="Toggle tile labels"
              >{treemapVals.labels ? 'On' : 'Off'}</button>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}

function mergeElementProperties(elements) {
  if (!elements || elements.length <= 1) return null

  const allProps = elements.map(e => e.properties || {})
  const allKeys = new Set()
  allProps.forEach(p => Object.keys(p).forEach(k => allKeys.add(k)))

  const merged = {}
  for (const key of allKeys) {
    const values = allProps.map(p => p[key]).filter(v => v !== undefined)
    if (values.length === 0) continue
    const allSame = values.length === allProps.length && values.every(v => v === values[0])
    merged[key] = { value: values[0], isMixed: !allSame }
  }

  const types = [...new Set(elements.map(e => e.type))]
  const roles = [...new Set(elements.map(e => e.semanticRole))]
  const markGroups = [...new Set(elements.map(e => e.markGroup).filter(Boolean))]
  const allLine = elements.every(e => e.type === 'line')
  const allAnnotation = elements.every(e => e.isAnnotation || e.semanticRole === 'annotation')
  const anyNonData = elements.some(e => e.isAnnotation || e.semanticRole !== 'data-mark')
  return { merged, commonType: types.length === 1 ? types[0] : 'mixed', commonSemanticRole: roles.length === 1 ? roles[0] : 'mixed', count: elements.length, allLine, allAnnotation, anyNonData }
}

function PropertyPanel({ readOnly = false, selectedElement, selectedElements, chartId, selectedChart, onPropertyChange, onDeleteElement, onChartPropertyChange, onClose, dataSources, onUpdateChart, onDeselectElements, _backLabel, _inlineMode }) {
  const isMultiSelect = selectedElements && selectedElements.length > 1

  if (!selectedElement) {
    if (selectedChart) {
      return <ChartProperties readOnly={readOnly} chart={selectedChart} onChartPropertyChange={onChartPropertyChange} dataSources={dataSources} onUpdateChart={onUpdateChart} />
    }
    return (
      <div className="property-panel empty">
        <p>Click a chart element to edit its properties</p>
      </div>
    )
  }

  // Multi-select: show merged properties
  if (isMultiSelect) {
    const handleDeselectType = onDeselectElements ? (type) => {
      const remaining = selectedElements.filter(el => el.type !== type)
      onDeselectElements(remaining)
    } : null
    return <MultiSelectPanel elements={selectedElements} chartId={chartId} selectedChart={selectedChart} onPropertyChange={onPropertyChange} onDeleteElement={onDeleteElement} onDeselectType={handleDeselectType} />
  }

  const { type, properties, elementPath, element, selector, semanticRole, axisChannel, markGroup } = selectedElement
  const spec = selectedChart?.spec
  const datum = selectedElement?.datum
  // Line marks render as an open <path> with no fill — a fill would fill the open
  // path into a meaningless wedge. Hide the Fill control for them (stroke is the color).
  const isLineMark = markGroup === 'mark-line' || type === 'line'

  // Build display label with context
  const getDisplayLabel = () => {
    const base = typeLabels[type] || type
    if (semanticRole === 'axis' && type !== 'axis-x' && type !== 'axis-y') {
      const axisLabel = axisChannel === 'x' ? 'X Axis' : axisChannel === 'y' ? 'Y Axis' : 'Axis'
      return `${base} (${axisLabel})`
    }
    if (semanticRole === 'legend' && type !== 'legend') {
      return `${base} (Legend)`
    }
    return base
  }

  const getElement = () => {
    if (!chartId || !selector) return element

    const container = document.getElementById(`vega-chart-${chartId}`)
    const svg = container?.querySelector('svg')
    if (!svg) return element

    try {
      const freshElement = svg.querySelector(selector)
      return freshElement || element
    } catch (e) {
      return element
    }
  }

  const handleChange = (propName, value) => {
    onPropertyChange(elementPath, propName, value)
  }

  // Convert any color value (rgb, named, hex) to hex for display
  const toHex = (color, fallback) => {
    if (!color || color === 'none' || color === 'transparent' || color === '') return fallback
    const converted = colorToHex(color, null)
    return converted || fallback
  }

  // Legend property change — route through the modification system so the edit shows up
  // in the modification stack (and cascades / undoes like any other element edit) instead
  // of silently rewriting the spec. applyModificationsToSpec writes it to the field-bound
  // legend channel's `legend` object.
  const handleLegendPropChange = (prop, value) => {
    if (!onPropertyChange) return
    onPropertyChange('legend', prop, value)
  }

  const renderLegendProperties = () => (
    <div className="property-group">
      <h3>Legend</h3>
      <div className="property-row">
        <label>Orient</label>
        <select value={properties.orient || 'right'} onChange={(e) => handleLegendPropChange('orient', e.target.value)}>
          <option value="top">Top</option>
          <option value="right">Right</option>
          <option value="bottom">Bottom</option>
          <option value="left">Left</option>
          <option value="top-right">Top Right</option>
          <option value="top-left">Top Left</option>
          <option value="bottom-right">Bottom Right</option>
          <option value="bottom-left">Bottom Left</option>
        </select>
      </div>
      <div className="property-row">
        <label>Direction</label>
        <select value={properties.direction || 'vertical'} onChange={(e) => handleLegendPropChange('direction', e.target.value)}>
          <option value="vertical">Vertical</option>
          <option value="horizontal">Horizontal</option>
        </select>
      </div>
      <div className="property-row">
        <label>Title</label>
        <input type="text" value={properties.title ?? ''} placeholder="Legend title"
          onChange={(e) => handleLegendPropChange('title', e.target.value || null)} />
      </div>
      {/* <div className="property-row">
        <label>Label Size</label>
        <input type="number" min={6} max={24} value={properties.labelFontSize || 11}
          onChange={(e) => handleLegendPropChange('labelFontSize', parseInt(e.target.value) || 11)} />
      </div> */}
      {/* <div className="property-row">
        <label>Symbol Size</label>
        <input type="number" min={10} max={500} step={10} value={properties.symbolSize || 100}
          onChange={(e) => handleLegendPropChange('symbolSize', parseInt(e.target.value) || 100)} />
      </div> */}
      <div className="property-row">
        <label>Padding</label>
        <input type="number" min={0} max={40} value={properties.padding || 0}
          onChange={(e) => handleLegendPropChange('padding', parseInt(e.target.value) || 0)} />
      </div>
      {/* <div className="property-row">
        <label>Offset</label>
        <input type="number" min={-50} max={50} value={properties.offset || 0}
          onChange={(e) => handleLegendPropChange('offset', parseInt(e.target.value) || 0)} />
      </div> */}
      <div className="property-row">
        <label>Fill</label>
        <ColorInput value={properties.fillColor || 'none'} onChange={(v) => handleLegendPropChange('fillColor', v)} />
      </div>
      <div className="property-row">
        <label>Stroke</label>
        <ColorInput value={properties.strokeColor || 'none'} onChange={(v) => handleLegendPropChange('strokeColor', v)} />
      </div>
    </div>
  )

  const renderTextProperties = () => (
    <div className="property-group">
      <h3>Text Properties</h3>

      <div className="property-row">
        <label>Content</label>
        <input
          type="text"
          value={properties.text || ''}
          onChange={(e) => handleChange('text', e.target.value)}
        />
      </div>

      <div className="property-row">
        <label>Style</label>
        <div className="transform-inputs">
          <div className="transform-field" style={{ flex: 1.3 }}>
            <span className="transform-label">Weight</span>
            <select
              value={properties.fontWeight || 'normal'}
              onChange={(e) => handleChange('fontWeight', e.target.value)}
            >
              <option value="normal">Normal</option>
              <option value="bold">Bold</option>
              <option value="lighter">Light</option>
            </select>
          </div>
          <div className="transform-field" style={{ flex: 1 }}>
            <span className="transform-label">Size</span>
            <input
              type="number"
              min={8}
              max={72}
              value={properties.fontSize || 12}
              onChange={(e) => handleChange('fontSize', parseInt(e.target.value))}
            />
          </div>
        </div>
      </div>

      <div className="property-row">
        <label>Color</label>
        <ColorInput
          value={toHex(properties.color, '#000000')}
          onChange={(v) => handleChange('color', v)}
        />
      </div>

      <div className="property-row">
        <label>Angle</label>
        <input
          type="number"
          min={0}
          max={360}
          value={properties.angle || 0}
          onChange={(e) => handleChange('angle', parseInt(e.target.value))}
        />
      </div>
    </div>
  )

  const renderAxisProperties = () => (
    <div className="property-group">
      <h3>Axis Properties</h3>

      <div className="property-row">
        <label>Axis Title</label>
        <input
          type="text"
          value={properties.title || ''}
          onChange={(e) => handleChange('title', e.target.value)}
        />
      </div>

      <div className="property-row">
        <label>Title Size</label>
        <input
          type="number"
          min={8}
          max={24}
          value={properties.titleFontSize || 11}
          onChange={(e) => handleChange('titleFontSize', parseInt(e.target.value))}
        />
      </div>

      <div className="property-row">
        <label>Label Size</label>
        <input
          type="number"
          min={8}
          max={24}
          value={properties.labelFontSize || 10}
          onChange={(e) => handleChange('labelFontSize', parseInt(e.target.value))}
        />
      </div>

      <div className="property-row">
        <label>Label Angle</label>
        <input
          type="number"
          min={-90}
          max={90}
          value={properties.labelAngle || 0}
          onChange={(e) => handleChange('labelAngle', parseInt(e.target.value))}
        />
      </div>

      <div className="property-row">
        <label>Show Grid</label>
        <input
          type="checkbox"
          checked={properties.grid !== false}
          onChange={(e) => handleChange('grid', e.target.checked)}
        />
      </div>
    </div>
  )

  const handleDeleteTitle = () => {
    if (!selectedChart || !onUpdateChart) return
    const newSpec = JSON.parse(JSON.stringify(selectedChart.spec))
    delete newSpec.title
    onUpdateChart(selectedChart.id, { spec: newSpec })
    onClose?.()
  }

  const handleDeleteAxisTitle = (channel) => {
    if (!selectedChart || !onUpdateChart) return
    const ch = channel || axisChannel
    if (!ch) return
    const newSpec = JSON.parse(JSON.stringify(selectedChart.spec))
    // Top-level encoding
    if (newSpec.encoding?.[ch]) {
      if (!newSpec.encoding[ch].axis) newSpec.encoding[ch].axis = {}
      newSpec.encoding[ch].axis.title = null
    }
    // Also handle layers
    if (newSpec.layer) {
      for (const layer of newSpec.layer) {
        if (layer.encoding?.[ch]) {
          if (!layer.encoding[ch].axis) layer.encoding[ch].axis = {}
          layer.encoding[ch].axis.title = null
        }
      }
    }
    onUpdateChart(selectedChart.id, { spec: newSpec })
  }

  const handleSubtitleChange = (propName, value) => {
    const subtitlePropMap = {
      text: 'subtitle',
      fontSize: 'subtitleFontSize',
      color: 'subtitleColor',
      fontWeight: 'subtitleFontWeight',
    }
    onPropertyChange('title', subtitlePropMap[propName] || propName, value)
  }

  const handleDeleteSubtitle = () => {
    if (!selectedChart || !onUpdateChart) return
    const newSpec = JSON.parse(JSON.stringify(selectedChart.spec))
    if (typeof newSpec.title === 'object') {
      delete newSpec.title.subtitle
      delete newSpec.title.subtitleFontSize
      delete newSpec.title.subtitleFontWeight
      delete newSpec.title.subtitleColor
    }
    onUpdateChart(selectedChart.id, { spec: newSpec })
  }

  const renderTitleProperties = () => (
    <>
      <div className="property-group">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3>Title</h3>
          <button className="delete-element-btn-small" onClick={handleDeleteTitle}>Delete</button>
        </div>

        <div className="property-row">
          <label>Text</label>
          <input type="text" value={properties.text || ''} onChange={(e) => handleChange('text', e.target.value)} />
        </div>

        <div className="property-row">
          <label>Style</label>
          <div className="transform-inputs">
            <div className="transform-field" style={{ flex: 1.3 }}>
              <span className="transform-label">Weight</span>
              <select value={properties.fontWeight || 'bold'} onChange={(e) => handleChange('fontWeight', e.target.value)}>
                <option value="normal">Normal</option>
                <option value="bold">Bold</option>
                <option value="lighter">Light</option>
              </select>
            </div>
            <div className="transform-field" style={{ flex: 1 }}>
              <span className="transform-label">Size</span>
              <input type="number" min={8} max={72} value={properties.fontSize || 14}
                onChange={(e) => handleChange('fontSize', parseInt(e.target.value))} />
            </div>
          </div>
        </div>

        <div className="property-row">
          <label>Color</label>
          <ColorInput value={toHex(properties.color, '#000000')} onChange={(v) => handleChange('color', v)} />
        </div>
      </div>

      <div className="property-group">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3>Subtitle</h3>
          {properties.subtitle && <button className="delete-element-btn-small" onClick={handleDeleteSubtitle}>Delete</button>}
        </div>

        <div className="property-row">
          <label>Text</label>
          <input type="text" value={properties.subtitle || ''} onChange={(e) => handleSubtitleChange('text', e.target.value)} />
        </div>

        {properties.subtitle && (
          <>
            <div className="property-row">
              <label>Style</label>
              <div className="transform-inputs">
                <div className="transform-field" style={{ flex: 1.3 }}>
                  <span className="transform-label">Weight</span>
                  <select value={properties.subtitleFontWeight || 'normal'} onChange={(e) => handleSubtitleChange('fontWeight', e.target.value)}>
                    <option value="normal">Normal</option>
                    <option value="bold">Bold</option>
                    <option value="lighter">Light</option>
                  </select>
                </div>
                <div className="transform-field" style={{ flex: 1 }}>
                  <span className="transform-label">Size</span>
                  <input type="number" min={8} max={48} value={properties.subtitleFontSize || 12}
                    onChange={(e) => handleSubtitleChange('fontSize', parseInt(e.target.value))} />
                </div>
              </div>
            </div>

            <div className="property-row">
              <label>Color</label>
              <ColorInput value={toHex(properties.subtitleColor, '#888888')} onChange={(v) => handleSubtitleChange('color', v)} />
            </div>
          </>
        )}
      </div>

      <div className="property-group">
        <div className="property-row">
          <label>Align</label>
          {/* Vega-Lite's default title anchor for a chart title is "middle" (centered), not "start". */}
          <select value={properties.anchor || 'middle'} onChange={(e) => handleChange('anchor', e.target.value)}>
            <option value="start">Left</option>
            <option value="middle">Center</option>
            <option value="end">Right</option>
          </select>
        </div>
      </div>
    </>
  )

  const renderSubtitleProperties = () => renderTitleProperties()

  const renderChartSizeProperties = () => (
    <div className="property-group">
      <h3>Chart Size</h3>

      <div className="property-row">
        <label>Width</label>
        <input
          type="number"
          min={100}
          max={800}
          step={10}
          value={properties.width || 400}
          onChange={(e) => handleChange('width', parseInt(e.target.value))}
        />
      </div>

      <div className="property-row">
        <label>Height</label>
        <input
          type="number"
          min={100}
          max={600}
          step={10}
          value={properties.height || 250}
          onChange={(e) => handleChange('height', parseInt(e.target.value))}
        />
      </div>
    </div>
  )

  const renderLineProperties = () => {
    const strokeBinding = getBindingStatus(spec, 'stroke', datum)
    const opacityBinding = getBindingStatus(spec, 'opacity', datum)
    return (
    <div className="property-group">
      <h3>Line Properties</h3>

      <div className="property-row">
        <label>Stroke</label>
        <ColorInput
          value={properties.stroke === 'none' ? 'none' : toHex(properties.stroke, '#000000')}
          onChange={(v) => handleChange('stroke', v)}
        />
        <BindingTag status={strokeBinding.status} label={strokeBinding.label} />
      </div>

      <div className="property-row" style={properties.stroke === 'none' ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
        <label>Stroke Width</label>
        <div className="slider-combo">
          <input
            type="number"
            min={0}
            max={10}
            step={0.5}
            value={properties.strokeWidth || 0}
            onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) handleChange('strokeWidth', v) }}
          />
          <input
            type="range"
            min={0}
            max={10}
            step={0.5}
            value={properties.strokeWidth || 0}
            onChange={(e) => handleChange('strokeWidth', parseFloat(e.target.value))}
          />
        </div>
      </div>

      <div className="property-row">
        <label>Opacity</label>
        <div className="slider-combo">
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={properties.opacity || 1}
            onChange={(e) => {
              const v = parseFloat(e.target.value); if (!isNaN(v)) handleChange('opacity', Math.max(0, Math.min(1, v)))
            }}
          />
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={properties.opacity || 1}
            onChange={(e) => handleChange('opacity', parseFloat(e.target.value))}
          />
        </div>
        <BindingTag status={opacityBinding.status} label={opacityBinding.label} />
      </div>

      <div className="property-row">
        <label>Line Style</label>
        <select
          value={properties.strokeDasharray || 'solid'}
          onChange={(e) => handleChange('strokeDasharray', e.target.value)}
        >
          <option value="solid">Solid</option>
          <option value="4,4">Dotted</option>
          <option value="8,4">Dashed</option>
          <option value="8,4,2,4">Dash-Dot</option>
        </select>
      </div>
    </div>
  )
  }

  const renderPathProperties = () => {
    const fillBinding = getBindingStatus(spec, 'fill', datum)
    const strokeBinding = getBindingStatus(spec, 'stroke', datum)
    const opacityBinding = getBindingStatus(spec, 'opacity', datum)
    return (
    <div className="property-group">
      <h3>Path Properties</h3>

      {!isLineMark && (
      <div className="property-row">
        <label>Fill</label>
        <ColorInput
          value={properties.fill === 'none' ? 'none' : toHex(properties.fill, '#4c78a8')}
          onChange={(v) => handleChange('fill', v)}
        />
        <BindingTag status={fillBinding.status} label={fillBinding.label} />
      </div>
      )}

      <div className="property-row">
        <label>Stroke</label>
        <ColorInput
          value={properties.stroke === 'none' ? 'none' : toHex(properties.stroke, '#000000')}
          onChange={(v) => handleChange('stroke', v)}
        />
        <BindingTag status={strokeBinding.status} label={strokeBinding.label} />
      </div>

      <div className="property-row" style={properties.stroke === 'none' ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
        <label>Stroke Width</label>
        <div className="slider-combo">
          <input
            type="number"
            min={0}
            max={10}
            step={0.5}
            value={properties.strokeWidth || 0}
            onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) handleChange('strokeWidth', v) }}
          />
          <input
            type="range"
            min={0}
            max={10}
            step={0.5}
            value={properties.strokeWidth || 0}
            onChange={(e) => handleChange('strokeWidth', parseFloat(e.target.value))}
          />
        </div>
      </div>

      <div className="property-row">
        <label>Opacity</label>
        <div className="slider-combo">
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={properties.opacity || 1}
            onChange={(e) => {
              const v = parseFloat(e.target.value); if (!isNaN(v)) handleChange('opacity', Math.max(0, Math.min(1, v)))
            }}
          />
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={properties.opacity || 1}
            onChange={(e) => handleChange('opacity', parseFloat(e.target.value))}
          />
        </div>
        <BindingTag status={opacityBinding.status} label={opacityBinding.label} />
      </div>
    </div>
  )
  }

  const renderRectProperties = () => {
    const fillBinding = getBindingStatus(spec, 'fill', datum)
    const strokeBinding = getBindingStatus(spec, 'stroke', datum)
    const opacityBinding = getBindingStatus(spec, 'opacity', datum)
    return (
    <div className="property-group">
      <h3>Rect Properties</h3>

      <div className="property-row">
        <label>Fill</label>
        <ColorInput
          value={properties.fill === 'none' ? 'none' : toHex(properties.fill, '#4c78a8')}
          onChange={(v) => handleChange('fill', v)}
        />
        <BindingTag status={fillBinding.status} label={fillBinding.label} />
      </div>

      <div className="property-row">
        <label>Stroke</label>
        <ColorInput
          value={properties.stroke === 'none' ? 'none' : toHex(properties.stroke, '#000000')}
          onChange={(v) => handleChange('stroke', v)}
        />
        <BindingTag status={strokeBinding.status} label={strokeBinding.label} />
      </div>

      <div className="property-row" style={properties.stroke === 'none' ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
        <label>Stroke Width</label>
        <div className="slider-combo">
          <input
            type="number"
            min={0}
            max={10}
            step={0.5}
            value={properties.strokeWidth || 0}
            onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) handleChange('strokeWidth', v) }}
          />
          <input
            type="range"
            min={0}
            max={10}
            step={0.5}
            value={properties.strokeWidth || 0}
            onChange={(e) => handleChange('strokeWidth', parseFloat(e.target.value))}
          />
        </div>
      </div>

      <div className="property-row">
        <label>Opacity</label>
        <div className="slider-combo">
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={properties.opacity || 1}
            onChange={(e) => {
              const v = parseFloat(e.target.value); if (!isNaN(v)) handleChange('opacity', Math.max(0, Math.min(1, v)))
            }}
          />
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={properties.opacity || 1}
            onChange={(e) => handleChange('opacity', parseFloat(e.target.value))}
          />
        </div>
        <BindingTag status={opacityBinding.status} label={opacityBinding.label} />
      </div>
    </div>
  )
  }

  if (_inlineMode) {
    return (
      <div className="panel-content">
        {type === 'chart-size' && renderChartSizeProperties()}
        {type === 'legend' && renderLegendProperties()}
        {type === 'title' && renderTitleProperties()}
        {type === 'subtitle' && renderSubtitleProperties()}
        {(type === 'axis-x' || type === 'axis-y') && renderAxisProperties()}
        {type === 'text' && renderTextProperties()}
        {type === 'line' && renderLineProperties()}
        {type === 'path' && renderPathProperties()}
        {type === 'rect' && renderRectProperties()}
        {type === 'point' && (() => {
          const fillBinding = getBindingStatus(spec, 'fill', datum)
          const strokeBinding = getBindingStatus(spec, 'stroke', datum)
          const opacityBinding = getBindingStatus(spec, 'opacity', datum)
          const sizeBinding = getBindingStatus(spec, 'size', datum)
          return (
          <div className="property-group">
            <h3>Point Properties</h3>
            <div className="property-row"><label>Size</label>
              <div className="slider-combo">
                <input type="number" min={1} max={1000} step={10} value={properties.size || 60}
                  onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) handleChange('size', v) }} />
                <input type="range" min={1} max={500} step={10} value={properties.size || 60}
                  onChange={(e) => handleChange('size', parseFloat(e.target.value))} />
              </div>
              <BindingTag status={sizeBinding.status} label={sizeBinding.label} />
            </div>
            <div className="property-row"><label>Fill</label>
              <ColorInput value={properties.fill === 'none' ? 'none' : toHex(properties.fill, '#4c78a8')} onChange={(v) => handleChange('fill', v)} />
              <BindingTag status={fillBinding.status} label={fillBinding.label} />
            </div>
            <div className="property-row"><label>Stroke</label>
              <ColorInput value={properties.stroke === 'none' ? 'none' : toHex(properties.stroke, '#000000')} onChange={(v) => handleChange('stroke', v)} />
              <BindingTag status={strokeBinding.status} label={strokeBinding.label} />
            </div>
            <div className="property-row"><label>Opacity</label>
              <div className="slider-combo">
                <input type="number" min={0} max={1} step={0.05} value={properties.opacity ?? 1}
                  onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) handleChange('opacity', v) }} />
                <input type="range" min={0} max={1} step={0.05} value={properties.opacity ?? 1}
                  onChange={(e) => handleChange('opacity', parseFloat(e.target.value))} />
              </div>
              <BindingTag status={opacityBinding.status} label={opacityBinding.label} />
            </div>
          </div>
          )
        })()}
        {type === 'circle' && renderCircleProperties()}
      </div>
    )
  }

  return (
    <div className="property-panel">
      <div className="panel-header">
        {_backLabel ? (
          <>
            <button className="multi-type-back-btn" onClick={onClose}>←</button>
            <span className="element-type">{_backLabel}</span>
          </>
        ) : (
          <>
            <span className="element-type">{getDisplayLabel()}</span>
            <button className="close-btn" onClick={onClose}>x</button>
          </>
        )}
      </div>

      <div className="panel-content">
        {type === 'chart-size' && renderChartSizeProperties()}
        {type === 'legend' && renderLegendProperties()}
        {type === 'title' && renderTitleProperties()}
        {type === 'subtitle' && renderSubtitleProperties()}
        {(type === 'axis-x' || type === 'axis-y') && renderAxisProperties()}
        {type === 'text' && renderTextProperties()}
        {type === 'line' && renderLineProperties()}
        {type === 'path' && renderPathProperties()}
        {type === 'rect' && renderRectProperties()}
        {type === 'point' && (() => {
          const fillBinding = getBindingStatus(spec, 'fill', datum)
          const strokeBinding = getBindingStatus(spec, 'stroke', datum)
          const opacityBinding = getBindingStatus(spec, 'opacity', datum)
          const sizeBinding = getBindingStatus(spec, 'size', datum)
          return (
          <div className="property-group">
            <h3>Point Properties</h3>

            <div className="property-row">
              <label>Size</label>
              <div className="slider-combo">
                <input
                  type="number"
                  min={1}
                  max={1000}
                  step={10}
                  value={properties.size || 60}
                  onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) handleChange('size', v) }}
                />
                <input
                  type="range"
                  min={1}
                  max={500}
                  step={10}
                  value={properties.size || 60}
                  onChange={(e) => handleChange('size', parseFloat(e.target.value))}
                />
              </div>
              <BindingTag status={sizeBinding.status} label={sizeBinding.label} />
            </div>

            <div className="property-row">
              <label>Fill</label>
              <ColorInput
                value={properties.fill === 'none' ? 'none' : toHex(properties.fill, '#4c78a8')}
                onChange={(v) => handleChange('fill', v)}
              />
              <BindingTag status={fillBinding.status} label={fillBinding.label} />
            </div>

            <div className="property-row">
              <label>Stroke</label>
              <ColorInput
                value={properties.stroke === 'none' ? 'none' : toHex(properties.stroke, '#000000')}
                onChange={(v) => handleChange('stroke', v)}
              />
              <BindingTag status={strokeBinding.status} label={strokeBinding.label} />
            </div>

            <div className="property-row" style={properties.stroke === 'none' ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
              <label>Stroke Width</label>
              <div className="slider-combo">
                <input
                  type="number"
                  min={0}
                  max={10}
                  step={0.5}
                  value={properties.strokeWidth || 0}
                  onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) handleChange('strokeWidth', v) }}
                />
                <input
                  type="range"
                  min={0}
                  max={10}
                  step={0.5}
                  value={properties.strokeWidth || 0}
                  onChange={(e) => handleChange('strokeWidth', parseFloat(e.target.value))}
                />
              </div>
            </div>

            <div className="property-row">
              <label>Opacity</label>
              <div className="slider-combo">
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={properties.opacity || 1}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value); if (!isNaN(v)) handleChange('opacity', Math.max(0, Math.min(1, v)))
                  }}
                />
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={properties.opacity || 1}
                  onChange={(e) => handleChange('opacity', parseFloat(e.target.value))}
                />
              </div>
              <BindingTag status={opacityBinding.status} label={opacityBinding.label} />
            </div>
          </div>
          )
        })()}
        {(type === 'group' || type === 'mark') && (
          <GroupProperties
            getElement={getElement}
            selectorKey={selector}
            onGroupPropertyChange={(propName, value) => onPropertyChange('group', propName, value)}
          />
        )}
        {/* Position offset — for NON-data elements only (axis title/ticks/grid, legend,
            text, annotations). Data marks are excluded: moving them misrepresents the data. */}
        {selector && type !== 'group' && type !== 'mark' &&
          (semanticRole === 'axis' || semanticRole === 'legend' || semanticRole === 'text' || selectedElement.isAnnotation) && (
          <div className="property-group">
            <h3>Position</h3>
            <div className="property-row">
              <label>Offset</label>
              <div className="transform-inputs">
                <div className="transform-field">
                  <span className="transform-label">X</span>
                  <input type="number"
                    value={selectedChart?.svgOverrides?.[selector]?.dx ?? 0}
                    onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) handleChange('dx', v) }} />
                </div>
                <div className="transform-field">
                  <span className="transform-label">Y</span>
                  <input type="number"
                    value={selectedChart?.svgOverrides?.[selector]?.dy ?? 0}
                    onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) handleChange('dy', v) }} />
                </div>
              </div>
            </div>
          </div>
        )}
        {/* Delete buttons — small, right-aligned */}
        <div className="delete-btn-row">
          {(semanticRole === 'axis' || type === 'axis-x' || type === 'axis-y') && (
            <button className="delete-element-btn-small" onClick={() => handleDeleteAxisTitle()}>Delete Axis Title</button>
          )}
          {semanticRole === 'data-mark' && !selectedElement.isAnnotation && onDeleteElement && (
            <button
              className="delete-element-btn-small"
              title="Remove this element's data from the chart (reversible)"
              onClick={() => { onDeleteElement(selectedElement); onClose?.() }}
            >Delete Element</button>
          )}
        </div>


      </div>
    </div>
  )
}

// Sub-group panel for a single type within multi-select
function SubGroupPanel({ elements, mergeResult, selectedChart, onPropertyChange }) {
  const { merged, commonType, commonSemanticRole, allLine, allAnnotation } = mergeResult

  const isAllText = elements.every(e =>
    e.semanticRole === 'text' || e.semanticRole === 'axis' ||
    (e.properties && (e.properties.fontSize != null || e.properties.fontWeight != null))
  )

  const getEditableProps = () => {
    const props = []
    if (allLine) {
      props.push({ key: 'stroke', label: 'Stroke Color', type: 'color' })
      props.push({ key: 'strokeWidth', label: 'Stroke Width', type: 'number', min: 0, max: 10, step: 0.5 })
      props.push({ key: 'opacity', label: 'Opacity', type: 'range', min: 0, max: 1, step: 0.05 })
      return props
    }
    if (isAllText || commonSemanticRole === 'text') {
      if (merged.color) props.push({ key: 'color', label: 'Color', type: 'color' })
      else if (merged.fill) props.push({ key: 'fill', label: 'Color', type: 'color' })
      if (merged.fontSize) props.push({ key: 'fontSize', label: 'Font Size', type: 'number', min: 8, max: 72 })
      if (merged.opacity) props.push({ key: 'opacity', label: 'Opacity', type: 'range', min: 0, max: 1, step: 0.05 })
      return props
    }
    if (merged.fill) props.push({ key: 'fill', label: 'Fill', type: 'color' })
    if (merged.color && !merged.fill) props.push({ key: 'color', label: 'Color', type: 'color' })
    if (merged.stroke) props.push({ key: 'stroke', label: 'Stroke', type: 'color' })
    if (merged.strokeWidth) props.push({ key: 'strokeWidth', label: 'Width', type: 'number', min: 0, max: 10, step: 0.5 })
    if (merged.opacity) props.push({ key: 'opacity', label: 'Opacity', type: 'range', min: 0, max: 1, step: 0.05 })
    if (merged.size) props.push({ key: 'size', label: 'Size', type: 'number', min: 1, max: 500, step: 5 })
    return props
  }

  const editableProps = getEditableProps()

  const handleBatchChange = (propName, value) => {
    const groupElements = elements.map(el => ({
      elementPath: el.elementPath || el.type,
      selector: el.selector, datum: el.datum,
      semanticRole: el.semanticRole, markGroup: el.markGroup,
      element: el.element, compositeMarkType: el.compositeMarkType,
      compositeSubPart: el.compositeSubPart,
      layerIndex: el.layerIndex ?? null, axisChannel: el.axisChannel,
      axisSubType: el.axisSubType, legendField: el.legendField,
      legendValue: el.legendValue, legendSubType: el.legendSubType,
      properties: el.properties, isAnnotation: el.isAnnotation || false,
      _scopeType: el._scopeType, _scopeData: el._scopeData,
    }))
    onPropertyChange(groupElements[0].elementPath, propName, value, { groupElements })
  }

  return (
    <div className="property-group">
      <h3>Properties</h3>
      {editableProps.length === 0 && (
        <p style={{ color: '#888', fontSize: '12px' }}>No editable properties</p>
      )}
      {editableProps.map(prop => {
        const m = merged[prop.key]
        const isMixed = m?.isMixed
        const val = m?.value
        return (
          <div className="property-row" key={prop.key}>
            <label>{prop.label}</label>
            {prop.type === 'color' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1 }}>
                {isMixed && <span className="mixed-value-indicator">Mixed</span>}
                <ColorInput value={isMixed ? '#888888' : (val || '#000000')} onChange={(v) => handleBatchChange(prop.key, v)} />
              </div>
            )}
            {prop.type === 'number' && (
              <div className="slider-combo">
                <input type="number" min={prop.min} max={prop.max} step={prop.step || 1}
                  placeholder={isMixed ? 'Mixed' : undefined} value={isMixed ? '' : (val ?? '')}
                  onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) handleBatchChange(prop.key, v) }} />
              </div>
            )}
            {prop.type === 'range' && (
              <div className="slider-combo">
                <input type="number" min={prop.min} max={prop.max} step={prop.step}
                  placeholder={isMixed ? 'Mixed' : undefined} value={isMixed ? '' : (val ?? '')}
                  onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) handleBatchChange(prop.key, Math.max(prop.min, Math.min(prop.max, v))) }} />
                <input type="range" min={prop.min} max={prop.max} step={prop.step}
                  value={isMixed ? ((prop.min + prop.max) / 2) : (val ?? prop.max)}
                  onChange={(e) => handleBatchChange(prop.key, parseFloat(e.target.value))} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// Multi-select property panel
function MultiSelectPanel({ elements, chartId, selectedChart, onPropertyChange, onDeleteElement, onDeselectType }) {
  const [focusedType, setFocusedType] = useState(null)
  const mergeResult = mergeElementProperties(elements)
  if (!mergeResult) return null

  const { merged, commonType, commonSemanticRole, count, allLine, allAnnotation, anyNonData } = mergeResult

  // Group elements by type for mixed-type display
  const typeGroups = useMemo(() => {
    const groups = {}
    elements.forEach(el => {
      const t = el.type || 'unknown'
      if (!groups[t]) groups[t] = []
      groups[t].push(el)
    })
    return groups
  }, [elements])

  // Build display label for a type group (include semantic context)
  const getTypeGroupLabel = (type, elems) => {
    const base = (typeLabels[type] || type).toUpperCase()
    const first = elems[0]
    if (first?.semanticRole === 'legend') return `${base} (LEGEND)`
    if (first?.semanticRole === 'axis') return `${base} (AXIS)`
    if (first?.semanticRole === 'data-mark') return base
    return base
  }

  // Scope expansion: elements share a scope — show merged panel, not multi-type list
  const isFromScope = elements.some(el => el._scopeType)

  // If mixed types (and NOT from scope expansion), show accordion-style type list with toggle
  if (commonType === 'mixed' && !isFromScope) {
    return (
      <div className="property-panel">
        <div className="panel-header">
          <span className="element-type">{count} ELEMENTS SELECTED</span>
        </div>
        <div className="multi-type-list">
          {Object.entries(typeGroups).map(([type, elems]) => {
            const isOpen = focusedType === type
            return (
              <div key={type}>
                <div
                  className={`multi-type-item${isOpen ? ' active' : ''}`}
                  onClick={() => setFocusedType(isOpen ? null : type)}
                >
                  <span className="multi-type-label">{getTypeGroupLabel(type, elems)}</span>
                  {onDeselectType && (
                    <button className="multi-type-remove-btn" onClick={(e) => {
                      e.stopPropagation()
                      onDeselectType(type)
                    }}>✕</button>
                  )}
                </div>
                {isOpen && (
                  elems.length === 1 ? (
                    <PropertyPanel
                      selectedElement={elems[0]}
                      selectedElements={[elems[0]]}
                      chartId={chartId}
                      selectedChart={selectedChart}
                      onPropertyChange={onPropertyChange}
                      onClose={() => setFocusedType(null)}
                      _inlineMode
                    />
                  ) : (
                    <SubGroupPanel
                      elements={elems}
                      mergeResult={mergeElementProperties(elems)}
                      selectedChart={selectedChart}
                      onPropertyChange={onPropertyChange}
                    />
                  )
                )}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // Determine header label
  const getHeaderLabel = () => {
    if (commonType !== 'mixed') {
      const label = typeLabels[commonType] || commonType
      return `${label} × ${count}`
    }
    return `${count} elements selected`
  }

  // Check if all elements are text-like (have fontSize or color as primary property)
  const isAllText = elements.every(e =>
    e.semanticRole === 'text' || e.semanticRole === 'axis' ||
    (e.properties && (e.properties.fontSize != null || e.properties.fontWeight != null))
  )

  // For all-line selections, ensure line-specific properties have defaults in merged
  if (allLine) {
    if (!merged.stroke) merged.stroke = { value: '#4c78a8', isMixed: false }
    if (!merged.strokeWidth) merged.strokeWidth = { value: 2, isMixed: false }
    if (!merged.opacity) merged.opacity = { value: 1, isMixed: false }
    if (!merged.strokeDasharray) merged.strokeDasharray = { value: 'solid', isMixed: false }
  }

  // Determine which properties to show based on common type
  const getEditableProps = () => {
    const props = []

    // All SVG <line> elements: show all line-specific properties (before axis/text checks)
    if (allLine) {
      props.push({ key: 'stroke', label: 'Stroke Color', type: 'color' })
      props.push({ key: 'strokeWidth', label: 'Stroke Width', type: 'number', min: 0, max: 10, step: 0.5 })
      props.push({ key: 'opacity', label: 'Opacity', type: 'range', min: 0, max: 1, step: 0.05 })
      props.push({ key: 'strokeDasharray', label: 'Line Style', type: 'select', options: [
        { value: 'solid', label: 'Solid' }, { value: '4,4', label: 'Dotted' },
        { value: '8,4', label: 'Dashed' }, { value: '8,4,2,4', label: 'Dash-Dot' }
      ]})
      return props
    }

    // Text properties: color, fontSize, fontWeight, angle
    if (isAllText || commonSemanticRole === 'text') {
      if (merged.color) props.push({ key: 'color', label: 'Color', type: 'color' })
      else if (merged.fill) props.push({ key: 'fill', label: 'Color', type: 'color' })
      if (merged.fontSize) props.push({ key: 'fontSize', label: 'Font Size', type: 'number', min: 8, max: 72 })
      if (merged.fontWeight) props.push({ key: 'fontWeight', label: 'Font Weight', type: 'select', options: [
        { value: 'normal', label: 'Normal' }, { value: 'bold', label: 'Bold' }, { value: 'lighter', label: 'Light' }
      ]})
      if (merged.angle != null) props.push({ key: 'angle', label: 'Angle', type: 'number', min: 0, max: 360, step: 1 })
      if (merged.opacity) props.push({ key: 'opacity', label: 'Opacity', type: 'range', min: 0, max: 1, step: 0.05 })
      return props
    }

    if (commonSemanticRole === 'axis') {
      if (merged.fill || merged.color) props.push({ key: merged.color ? 'color' : 'fill', label: 'Color', type: 'color' })
      if (merged.fontSize) props.push({ key: 'fontSize', label: 'Font Size', type: 'number', min: 8, max: 72 })
      if (merged.fontWeight) props.push({ key: 'fontWeight', label: 'Font Weight', type: 'select', options: [
        { value: 'normal', label: 'Normal' }, { value: 'bold', label: 'Bold' }
      ]})
      return props
    }

    if (commonSemanticRole === 'data-mark' || commonSemanticRole === 'mixed') {
      if (merged.size) props.push({ key: 'size', label: 'Size', type: 'number', min: 1, max: 500, step: 5 })
      if (merged.fill) props.push({ key: 'fill', label: 'Fill', type: 'color' })
      if (merged.color && !merged.fill) props.push({ key: 'color', label: 'Color', type: 'color' })
      if (merged.stroke) props.push({ key: 'stroke', label: 'Stroke', type: 'color' })
      if (merged.strokeWidth) props.push({ key: 'strokeWidth', label: 'Width', type: 'number', min: 0, max: 10, step: 0.5 })
      if (merged.opacity) props.push({ key: 'opacity', label: 'Opacity', type: 'range', min: 0, max: 1, step: 0.05 })
      if (merged.fontSize) props.push({ key: 'fontSize', label: 'Font Size', type: 'number', min: 8, max: 72 })
      return props
    }

    // Fallback: show whatever color + opacity we have
    if (merged.fill) props.push({ key: 'fill', label: 'Fill', type: 'color' })
    if (merged.color && !merged.fill) props.push({ key: 'color', label: 'Color', type: 'color' })
    if (merged.opacity) props.push({ key: 'opacity', label: 'Opacity', type: 'range', min: 0, max: 1, step: 0.05 })

    // Position properties for non-data (annotation) elements
    if (allAnnotation) {
      if (merged.x != null || merged.y != null) {
        if (merged.x != null) props.push({ key: 'x', label: 'X Position', type: 'number' })
        if (merged.y != null) props.push({ key: 'y', label: 'Y Position', type: 'number' })
      }
      if (merged.x2 != null) props.push({ key: 'x2', label: 'X2', type: 'number' })
      if (merged.y2 != null) props.push({ key: 'y2', label: 'Y2', type: 'number' })
    }

    return props
  }

  const editableProps = getEditableProps()

  const handleBatchChange = (propName, value) => {
    // Send all elements as a single grouped modification
    const groupElements = elements.map(el => ({
      elementPath: el.elementPath || el.type,
      selector: el.selector,
      datum: el.datum,
      semanticRole: el.semanticRole,
      markGroup: el.markGroup,
      element: el.element,
      compositeMarkType: el.compositeMarkType,
      compositeSubPart: el.compositeSubPart,
      layerIndex: el.layerIndex ?? null,
      axisChannel: el.axisChannel,
      axisSubType: el.axisSubType,
      legendField: el.legendField,
      legendValue: el.legendValue,
      legendSubType: el.legendSubType,
      properties: el.properties,
      isAnnotation: el.isAnnotation || false,
      // Pass through scope metadata from scopeHierarchy (set in Canvas.jsx on scope confirm)
      _scopeType: el._scopeType,
      _scopeData: el._scopeData,
    }))
    onPropertyChange(groupElements[0].elementPath, propName, value, {
      groupElements,
    })
  }

  return (
    <div className="property-panel">
      <div className="panel-header">
        <span className="element-type">{getHeaderLabel()}</span>
      </div>
      <div className="panel-content">
        <div className="property-group">
          <h3>Common Properties</h3>

          {editableProps.length === 0 && (
            <p style={{ color: '#888', fontSize: '12px' }}>No editable common properties</p>
          )}

          {editableProps.map(prop => {
            const m = merged[prop.key]
            const isMixed = m?.isMixed
            const val = m?.value

            return (
              <div className="property-row" key={prop.key}>
                <label>{prop.label}</label>

                {prop.type === 'color' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1 }}>
                    {isMixed && <span className="mixed-value-indicator">Mixed</span>}
                    <ColorInput
                      value={isMixed ? '#888888' : (val || '#000000')}
                      onChange={(v) => handleBatchChange(prop.key, v)}
                    />
                  </div>
                )}

                {prop.type === 'number' && (
                  <div className="slider-combo">
                    <input
                      type="number"
                      min={prop.min}
                      max={prop.max}
                      step={prop.step || 1}
                      placeholder={isMixed ? 'Mixed' : undefined}
                      value={isMixed ? '' : (val ?? '')}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value)
                        if (!isNaN(v)) handleBatchChange(prop.key, v)
                      }}
                    />
                    <input
                      type="range"
                      min={prop.min}
                      max={prop.max}
                      step={prop.step || 1}
                      value={isMixed ? ((prop.min + prop.max) / 2) : (val ?? prop.min)}
                      onChange={(e) => handleBatchChange(prop.key, parseFloat(e.target.value))}
                    />
                  </div>
                )}

                {prop.type === 'select' && (
                  <select
                    value={isMixed ? '' : (val || '')}
                    onChange={(e) => handleBatchChange(prop.key, e.target.value)}
                  >
                    {isMixed && <option value="" disabled>Mixed</option>}
                    {prop.options.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                )}

                {prop.type === 'range' && (
                  <div className="slider-combo">
                    <input
                      type="number"
                      min={prop.min}
                      max={prop.max}
                      step={prop.step}
                      placeholder={isMixed ? 'Mixed' : undefined}
                      value={isMixed ? '' : (val ?? '')}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value)
                        if (!isNaN(v)) handleBatchChange(prop.key, Math.max(prop.min, Math.min(prop.max, v)))
                      }}
                    />
                    <input
                      type="range"
                      min={prop.min}
                      max={prop.max}
                      step={prop.step}
                      value={isMixed ? ((prop.min + prop.max) / 2) : (val ?? prop.max)}
                      onChange={(e) => handleBatchChange(prop.key, parseFloat(e.target.value))}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Position offset (X/Y) for NON-data multi-selections (text/axis/legend/annotation) */}
        {elements.length > 0 && elements.every(el => ['axis', 'legend', 'text'].includes(el.semanticRole) || el.isAnnotation) && (
          <div className="property-group">
            <h3>Position</h3>
            <div className="property-row">
              <label>Offset</label>
              <div className="transform-inputs">
                <div className="transform-field">
                  <span className="transform-label">X</span>
                  <input type="number" defaultValue={0}
                    onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) handleBatchChange('dx', v) }} />
                </div>
                <div className="transform-field">
                  <span className="transform-label">Y</span>
                  <input type="number" defaultValue={0}
                    onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) handleBatchChange('dy', v) }} />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Delete all selected data elements (reversible) */}
        {(() => {
          const deletable = elements.filter(el => el.semanticRole === 'data-mark' && !el.isAnnotation)
          if (!onDeleteElement || deletable.length === 0) return null
          return (
            <div className="delete-btn-row">
              <button
                className="delete-element-btn-small"
                title="Remove the selected elements' data from the chart (reversible)"
                onClick={() => onDeleteElement(deletable)}
              >Delete {deletable.length} Element{deletable.length > 1 ? 's' : ''}</button>
            </div>
          )
        })()}
      </div>
    </div>
  )
}


// ============================================================
// CONDITION INSPECTOR COMPONENT
// ============================================================

function ConditionInspector({ spec, layerIndex, chartId, onUpdateChart }) {
  const [isOpen, setIsOpen] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(null) // path of condition pending delete
  const [pendingDeletes, setPendingDeletes] = useState({}) // path -> timestamp for undo

  if (!spec || !onUpdateChart || !chartId) return null

  const conditions = extractConditions(spec, layerIndex !== undefined ? layerIndex : null)
  const hasConditions = conditions.length > 0

  if (!hasConditions) return null

  // Auto-expand when there are conditions
  const effectiveOpen = hasConditions ? (isOpen || hasConditions) : isOpen

  // Get unique field names from spec data
  const getDataFields = () => {
    const values = spec?.data?.values || []
    if (values.length === 0) return []
    return Object.keys(values[0])
  }

  const getFieldValues = (field) => {
    const values = spec?.data?.values || []
    const unique = [...new Set(values.map(d => d[field]))]
    return unique.slice(0, 50)
  }

  const handleDelete = (condInfo) => {
    if (deleteConfirm === condInfo.path) {
      const newSpec = deleteCondition(spec, condInfo)
      onUpdateChart(chartId, { spec: newSpec })
      setDeleteConfirm(null)
    } else {
      setDeleteConfirm(condInfo.path)
      setTimeout(() => setDeleteConfirm(null), 3000)
    }
  }

  const handleValueChange = (condInfo, newValue) => {
    const newSpec = updateConditionValue(spec, condInfo, newValue)
    onUpdateChart(chartId, { spec: newSpec })
  }

  const handleTestPartChange = (condInfo, parsed, updatedPart) => {
    const newParsed = { ...parsed, ...updatedPart }
    const newTest = buildTestExpression(newParsed)
    const newSpec = updateConditionTest(spec, condInfo, newTest)
    onUpdateChart(chartId, { spec: newSpec })
  }

  const handleRawTestChange = (condInfo, newTest) => {
    const newSpec = updateConditionTest(spec, condInfo, newTest)
    onUpdateChart(chartId, { spec: newSpec })
  }

  const renderTestEditor = (condInfo) => {
    const parsed = parseTestExpression(condInfo.test)
    const fields = getDataFields()
    const ops = ['===', '!==', '>', '<', '>=', '<=']

    if (parsed) {
      const fieldValues = getFieldValues(parsed.field)
      return (
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' }}>
          <select
            value={parsed.field}
            onChange={e => handleTestPartChange(condInfo, parsed, { field: e.target.value })}
            style={{ fontSize: '11px', padding: '2px 4px', borderRadius: '3px', border: '1px solid #ccc' }}
          >
            {fields.map(f => <option key={f} value={f}>{f}</option>)}
            {!fields.includes(parsed.field) && <option value={parsed.field}>{parsed.field}</option>}
          </select>
          <select
            value={parsed.op}
            onChange={e => handleTestPartChange(condInfo, parsed, { op: e.target.value })}
            style={{ fontSize: '11px', padding: '2px 4px', borderRadius: '3px', border: '1px solid #ccc', width: '50px' }}
          >
            {ops.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
          {parsed.valueType === 'number' ? (
            <input
              type="number"
              value={parsed.value}
              onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) handleTestPartChange(condInfo, parsed, { value: v }) }}
              style={{ fontSize: '11px', padding: '2px 4px', borderRadius: '3px', border: '1px solid #ccc', width: '70px' }}
            />
          ) : (
            <select
              value={parsed.value}
              onChange={e => handleTestPartChange(condInfo, parsed, { value: e.target.value })}
              style={{ fontSize: '11px', padding: '2px 4px', borderRadius: '3px', border: '1px solid #ccc' }}
            >
              {fieldValues.map(v => <option key={String(v)} value={String(v)}>{String(v)}</option>)}
              {!fieldValues.map(String).includes(String(parsed.value)) && (
                <option value={String(parsed.value)}>{String(parsed.value)}</option>
              )}
            </select>
          )}
        </div>
      )
    }

    // Complex expression — raw text editor
    return (
      <input
        type="text"
        value={condInfo.test}
        onChange={e => handleRawTestChange(condInfo, e.target.value)}
        style={{
          width: '100%', fontSize: '11px', padding: '3px 6px',
          borderRadius: '3px', border: '1px solid #ccc', fontFamily: 'monospace', boxSizing: 'border-box'
        }}
        title="Complex expression - edit directly"
      />
    )
  }

  const renderValueEditor = (condInfo) => {
    if (condInfo.valueType === 'field' && condInfo.fieldEncoding) {
      return (
        <span style={{ fontSize: '11px', color: '#666', fontStyle: 'italic' }}>
          Encoded by {condInfo.fieldEncoding.field}
        </span>
      )
    }
    if (condInfo.valueType === 'color') {
      return (
        <ColorInput
          value={condInfo.value || '#000000'}
          onChange={v => handleValueChange(condInfo, v)}
        />
      )
    }
    if (condInfo.valueType === 'number') {
      const isOpacity = condInfo.channel === 'opacity'
      const min = isOpacity ? 0 : 0
      const max = isOpacity ? 1 : (condInfo.channel === 'size' ? 400 : 20)
      const step = isOpacity ? 0.05 : 1
      return (
        <div className="slider-combo" style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
          <input
            type="number" min={min} max={max} step={step}
            value={condInfo.value ?? 0}
            onChange={e => {
              const v = parseFloat(e.target.value)
              if (!isNaN(v)) handleValueChange(condInfo, v)
            }}
            style={{ width: '60px', fontSize: '11px' }}
          />
          <input
            type="range" min={min} max={max} step={step}
            value={condInfo.value ?? 0}
            onChange={e => handleValueChange(condInfo, parseFloat(e.target.value))}
            style={{ flex: 1 }}
          />
        </div>
      )
    }
    // String or unknown
    return (
      <input
        type="text"
        value={condInfo.value != null ? String(condInfo.value) : ''}
        onChange={e => handleValueChange(condInfo, e.target.value)}
        style={{ fontSize: '11px', padding: '2px 6px', borderRadius: '3px', border: '1px solid #ccc', width: '100%' }}
      />
    )
  }

  const formatTestSummary = (test) => {
    const parsed = parseTestExpression(test)
    if (parsed) {
      const opLabels = { '===': '=', '!==': '≠', '>': '>', '<': '<', '>=': '≥', '<=': '≤' }
      return `${parsed.field} ${opLabels[parsed.op] || parsed.op} ${parsed.value}`
    }
    return test.length > 30 ? test.slice(0, 30) + '...' : test
  }

  return (
    <div className="property-group condition-inspector">
      <h3
        style={{ cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', gap: '6px' }}
        onClick={() => setIsOpen(!effectiveOpen)}
      >
        <span style={{ fontSize: '10px' }}>{effectiveOpen ? '▼' : '▶'}</span>
        Conditional Encoding
        {hasConditions && (
          <span style={{
            fontSize: '10px', background: '#e8f4fd', color: '#1a73e8',
            borderRadius: '10px', padding: '1px 7px', marginLeft: '4px'
          }}>{conditions.length}</span>
        )}
      </h3>

      {effectiveOpen && (
        <div>
          {!hasConditions && (
            <p style={{ color: '#aaa', fontSize: '12px', margin: '8px 0' }}>No conditions applied</p>
          )}
          {conditions.map((condInfo, idx) => {
            const isPendingDelete = deleteConfirm === condInfo.path
            return (
              <div
                key={condInfo.path + '_' + idx}
                style={{
                  border: '1px solid' + (isPendingDelete ? ' #ff6b6b' : ' #e0e0e0'),
                  borderRadius: '6px', padding: '8px 10px', marginBottom: '8px',
                  background: isPendingDelete ? '#fff5f5' : '#fafafa',
                  transition: 'border-color 0.2s, background 0.2s'
                }}
              >
                {/* Header row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{
                      fontSize: '11px', fontWeight: '600', background: '#e8f0fe', color: '#1a73e8',
                      padding: '1px 6px', borderRadius: '3px'
                    }}>{condInfo.channel}</span>
                    <span style={{ fontSize: '11px', color: '#555' }}>{formatTestSummary(condInfo.test)}</span>
                    {condInfo.valueType === 'color' && condInfo.value && (
                      <span style={{
                        display: 'inline-block', width: '12px', height: '12px',
                        background: condInfo.value, borderRadius: '2px', border: '1px solid #ccc'
                      }} />
                    )}
                    {condInfo.valueType === 'number' && (
                      <span style={{ fontSize: '11px', color: '#888' }}>{condInfo.value}</span>
                    )}
                  </div>
                  <button
                    onClick={() => handleDelete(condInfo)}
                    title={isPendingDelete ? 'Click again to delete' : 'Delete condition'}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer', fontSize: '14px',
                      color: isPendingDelete ? '#e53935' : '#999',
                      padding: '2px 6px', borderRadius: '3px',
                      transition: 'color 0.2s'
                    }}
                  >{isPendingDelete ? '⚠️' : '🗑️'}</button>
                </div>

                {/* Test editor */}
                <div style={{ marginBottom: '6px' }}>
                  <div style={{ fontSize: '10px', color: '#999', marginBottom: '3px' }}>Condition</div>
                  {renderTestEditor(condInfo)}
                </div>

                {/* Value editor */}
                <div style={{ marginBottom: '4px' }}>
                  <div style={{ fontSize: '10px', color: '#999', marginBottom: '3px' }}>Value</div>
                  {renderValueEditor(condInfo)}
                </div>

                {/* Default value */}
                {condInfo.defaultValue != null && (
                  <div style={{ fontSize: '10px', color: '#aaa', marginTop: '4px' }}>
                    Default: {String(condInfo.defaultValue)}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default PropertyPanel
