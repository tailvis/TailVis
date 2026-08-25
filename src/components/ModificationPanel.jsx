import { useEffect, useMemo, useRef, useState } from 'react'
import { generateScopeOptions, getScopeBindingTag } from '../utils/scopeUtils'
import './ModificationPanel.css'

function ScopeDropdown({ value, options, optionValue, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const menuRef = useRef(null)

  useEffect(() => {
    if (!open) return

    const handleOutsideClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false)
      }
    }

    const handleEscape = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }

    setTimeout(() => {
      document.addEventListener('mousedown', handleOutsideClick)
      document.addEventListener('keydown', handleEscape)
    }, 0)

    return () => {
      document.removeEventListener('mousedown', handleOutsideClick)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  const currentOpt = options.find(opt => optionValue(opt) === value)

  return (
    <div className="scope-dropdown" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button
        className={`scope-dropdown-trigger${open ? ' scope-dropdown-trigger-open' : ''}`}
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v) }}
        type="button"
      >
        <span className="scope-dropdown-label">{currentOpt?.label ?? value}</span>
        <svg className="scope-dropdown-arrow" width="10" height="6" viewBox="0 0 10 6" fill="none">
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && (
        <div className="scope-dropdown-menu" ref={menuRef} onClick={(e) => e.stopPropagation()}>
          {options.map((opt, i) => {
            const val = optionValue(opt)
            const isActive = val === value
            return (
              <button
                key={`${val}-${i}`}
                className={`scope-dropdown-item${isActive ? ' scope-dropdown-item-active' : ''}`}
                onClick={(e) => { e.stopPropagation(); onChange(val); setOpen(false) }}
                type="button"
              >
                {isActive && <span className="scope-dropdown-check">✓</span>}
                {opt.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// SVG overlay rect highlight (same approach as Canvas.jsx)
function createModOverlay(el, color) {
  try {
    const svgRoot = el.ownerSVGElement
    if (!svgRoot) return null
    const bbox = el.getBBox()
    const pad = 3
    const ns = 'http://www.w3.org/2000/svg'
    const ctm = el.getCTM()
    const svgCTM = svgRoot.getCTM()
    if (!ctm || !svgCTM) return null
    const toRoot = svgCTM.inverse().multiply(ctm)
    const corners = [
      [bbox.x - pad, bbox.y - pad],
      [bbox.x + bbox.width + pad, bbox.y - pad],
      [bbox.x + bbox.width + pad, bbox.y + bbox.height + pad],
      [bbox.x - pad, bbox.y + bbox.height + pad],
    ].map(([cx, cy]) => {
      const pt = svgRoot.createSVGPoint()
      pt.x = cx; pt.y = cy
      const t = pt.matrixTransform(toRoot)
      return [t.x, t.y]
    })
    const xs = corners.map(c => c[0])
    const ys = corners.map(c => c[1])
    const overlay = document.createElementNS(ns, 'rect')
    overlay.setAttribute('x', Math.min(...xs))
    overlay.setAttribute('y', Math.min(...ys))
    overlay.setAttribute('width', Math.max(...xs) - Math.min(...xs))
    overlay.setAttribute('height', Math.max(...ys) - Math.min(...ys))
    overlay.setAttribute('rx', '2')
    overlay.setAttribute('fill', 'none')
    overlay.setAttribute('stroke', color)
    overlay.setAttribute('stroke-width', '2')
    overlay.setAttribute('pointer-events', 'none')
    overlay.classList.add('mod-highlight-overlay')
    svgRoot.appendChild(overlay)
    return overlay
  } catch { return null }
}

function clearModOverlays(svg) {
  if (!svg) return
  svg.querySelectorAll('.mod-highlight-overlay').forEach(o => o.remove())
  svg.querySelectorAll('.mod-hover').forEach(el => el.classList.remove('mod-hover'))
  svg.classList.remove('has-mod-hover')
}

function highlightElements(svg, elements, color = '#F59E0B') {
  let highlighted = false
  for (const el of elements) {
    el.classList.add('mod-hover')
    createModOverlay(el, color)
    highlighted = true
  }
  if (highlighted) svg.classList.add('has-mod-hover')
}

function findScopeElements(svg, mod) {
  if (!mod.scope || !mod.markGroup) return []
  // Faceted charts render one mark group PER facet column, so collect marks from
  // ALL matching groups — querySelector would grab only the first facet (leftmost).
  const markGroupEls = svg.querySelectorAll(`.${mod.markGroup}`)
  if (markGroupEls.length === 0) return []
  const marks = []
  for (const g of markGroupEls) marks.push(...g.querySelectorAll('rect, circle, path, line, ellipse'))

  if (mod.scope.type === 'all-marks' || mod.scope.type === 'all') return marks
  if (mod.scope.type === 'by-field' && mod.scope.field && mod.scope.fieldValue != null) {
    // Filter by aria-label which contains field=value info
    return marks.filter(el => {
      const label = el.getAttribute('aria-label') || ''
      return label.includes(String(mod.scope.fieldValue))
    })
  }
  return marks
}

function applyHoverHighlight(chartId, mod, apply) {
  const container = document.getElementById(`vega-chart-${chartId}`)
  const svg = container?.querySelector('svg')
  if (!svg) return
  clearModOverlays(svg)
  if (!apply) return

  // Grouped modification: highlight all elements in the group
  if (mod.group && Array.isArray(mod.group)) {
    const elements = []
    for (const item of mod.group) {
      if (!item.selector) continue
      try {
        const el = svg.querySelector(item.selector)
        if (el) elements.push(el)
      } catch { /* invalid selector */ }
    }
    highlightElements(svg, elements)
    return
  }

  // Selector-based (this-only)
  if (mod.selector) {
    try {
      const el = svg.querySelector(mod.selector)
      if (el) highlightElements(svg, [el])
    } catch { /* invalid selector */ }
    return
  }

  // Scope-based (by-field, all-marks, fromScopeSelection)
  const scopeEls = findScopeElements(svg, mod)
  if (scopeEls.length > 0) highlightElements(svg, scopeEls)
}

function applyGroupHoverHighlight(chartId, mods, apply) {
  const container = document.getElementById(`vega-chart-${chartId}`)
  const svg = container?.querySelector('svg')
  if (!svg) return
  clearModOverlays(svg)
  if (!apply) return

  const elements = []
  for (const mod of mods) {
    if (mod.selector) {
      try {
        const el = svg.querySelector(mod.selector)
        if (el) elements.push(el)
      } catch { /* invalid selector */ }
    } else {
      elements.push(...findScopeElements(svg, mod))
    }
  }
  // Deduplicate
  highlightElements(svg, [...new Set(elements)])
}

function ModificationPanel({ chartId, spec, modifications, onScopeChange, onDelete, onModificationClick, onValueChange, activeModificationId }) {
  const [collapsed, setCollapsed] = useState(false)
  const rebindNotice = null
  const panelRef = useRef(null)

  // Forward wheel events to canvas SVG for pan/zoom passthrough
  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    const handleWheel = (e) => {
      const scrollable = e.target.closest('.mod-panel-content')
      if (scrollable) {
        const { scrollTop, scrollHeight, clientHeight } = scrollable
        const atTop = scrollTop <= 0
        const atBottom = scrollTop + clientHeight >= scrollHeight - 1
        if ((!atTop && e.deltaY < 0) || (!atBottom && e.deltaY > 0)) return
      }
      const svg = document.querySelector('.canvas-container svg')
      if (svg) {
        svg.dispatchEvent(new WheelEvent('wheel', {
          deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode,
          clientX: e.clientX, clientY: e.clientY,
          ctrlKey: e.ctrlKey, metaKey: e.metaKey, bubbles: false
        }))
      }
      e.preventDefault()
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [])

  // Group modifications by element identity or batchId
  const groups = useMemo(() => {
    if (!modifications || modifications.length === 0) return []

    const groupMap = new Map()
    for (const mod of modifications) {
      // Batch modifications (same batchId) are grouped together
      let key
      if (mod.batchId) {
        key = `batch:${mod.batchId}`
      } else if (mod.selector) {
        key = mod.selector
      } else {
        // Include scope info in key so different scopes don't merge
        const scopeKey = mod.scope?.type === 'by-field' ? `${mod.scope.field}=${mod.scope.fieldValue}`
          : mod.scope?.type === 'all-marks' ? 'all-marks'
          : mod.scope?.type === 'condition-match' ? `cond:${mod.scope.conditionIndex}`
          : mod.scope?.type || ''
        key = (mod.compositeMarkType && mod.compositeSubPart
            ? `${mod.compositeMarkType}:${mod.compositeSubPart}`
            : mod.targetType || mod.markGroup || 'unknown')
          + (scopeKey ? `:${scopeKey}` : '')
      }
      if (!groupMap.has(key)) {
        groupMap.set(key, { key, label: mod.targetType || key, mods: [], isBatch: !!mod.batchId })
      }
      groupMap.get(key).mods.push(mod)
    }
    // Update batch group labels with count
    for (const group of groupMap.values()) {
      if (group.isBatch && group.mods.length > 1) {
        group.label = `${group.mods[0].targetType || 'BATCH'} · ${group.mods.length} items`
      }
    }
    return Array.from(groupMap.values())
  }, [modifications])

  if (!modifications || modifications.length === 0) return null

  const getScopeSelectValue = (scope) => {
    if (scope.type === 'this-only') return 'this-only'
    if (scope.type === 'by-field') return `by-field:${scope.field}`
    if (scope.type === 'composite-sub-all') return 'composite-sub-all'
    if (scope.type === 'same-type-in-axis') return `same-type-in-axis:${scope.axisChannel}:${scope.axisSubType}`
    if (scope.type === 'same-type-all-axes') return `same-type-all-axes:${scope.axisSubType}`
    if (scope.type === 'all-in-axis') return `all-in-axis:${scope.axisChannel}`
    if (scope.type === 'all-axes') return 'all-axes'
    if (scope.type === 'legend-with-data') return 'legend-with-data'
    if (scope.type === 'legend-item-only') return 'legend-item-only'
    if (scope.type === 'all-legend-symbols') return 'all-legend-symbols'
    if (scope.type === 'all-legend-labels') return 'all-legend-labels'
    if (scope.type === 'legend-title') return 'legend-title'
    if (scope.type === 'all-in-legend') return 'all-in-legend'
    if (scope.type === 'all-text') return 'all-text'
    if (scope.type === 'scale-modify') return `scale-modify:${scope.channel}`
    if (scope.type === 'condition-match') return `condition-match:${scope.channel}:${scope.conditionIndex}`
    if (scope.type === 'condition-default') return `condition-default:${scope.channel}`
    if (scope.type === 'all' || scope.type === 'all-marks') return 'all-marks'
    if (scope.type === 'annotation-direct' || scope.type === 'annotation-layer') return 'annotation-direct'
    if (scope.type === 'all-in-layer') return 'all-in-layer'
    if (scope.type === 'this-element') return 'this-element'
    return 'all-marks'
  }

  const handleScopeSelectChange = (modId, selectValue, mod) => {
    // If switching to this-only from a bound scope, show confirmation
    applyScopeChange(modId, selectValue, mod)
  }

  const applyScopeChange = (modId, selectValue, mod) => {
    // (rebind notice removed — was more distracting than helpful)

    let newScope
    if (selectValue === 'this-only') {
      newScope = { type: 'this-only' }
    } else if (selectValue === 'all-marks') {
      newScope = { type: 'all-marks' }
    } else if (selectValue.startsWith('by-field:')) {
      const field = selectValue.slice('by-field:'.length)
      const fieldValue = mod.datum ? mod.datum[field] ?? null : null
      newScope = { type: 'by-field', field, fieldValue }
    } else if (selectValue === 'composite-sub-all') {
      newScope = { type: 'composite-sub-all', compositeMarkType: mod.compositeMarkType, compositeSubPart: mod.compositeSubPart }
    } else if (selectValue.startsWith('same-type-in-axis:')) {
      const parts = selectValue.split(':')
      newScope = { type: 'same-type-in-axis', axisChannel: parts[1], axisSubType: parts[2] }
    } else if (selectValue.startsWith('same-type-all-axes:')) {
      const axisSubType = selectValue.split(':')[1]
      newScope = { type: 'same-type-all-axes', axisSubType }
    } else if (selectValue.startsWith('all-in-axis:')) {
      newScope = { type: 'all-in-axis', axisChannel: selectValue.split(':')[1] }
    } else if (selectValue === 'all-axes') {
      newScope = { type: 'all-axes' }
    } else if (selectValue === 'legend-with-data') {
      newScope = { type: 'legend-with-data', legendField: mod.legendField, legendValue: mod.legendValue }
    } else if (selectValue === 'legend-item-only') {
      newScope = { type: 'legend-item-only' }
    } else if (selectValue === 'all-legend-symbols') {
      newScope = { type: 'all-legend-symbols' }
    } else if (selectValue === 'all-legend-labels') {
      newScope = { type: 'all-legend-labels' }
    } else if (selectValue === 'legend-title') {
      newScope = { type: 'legend-title' }
    } else if (selectValue === 'all-in-legend') {
      newScope = { type: 'all-in-legend' }
    } else if (selectValue === 'all-text') {
      newScope = { type: 'all-text' }
    } else if (selectValue.startsWith('scale-modify:')) {
      const channel = selectValue.slice('scale-modify:'.length)
      newScope = { type: 'scale-modify', channel, field: mod.datum ? Object.keys(mod.datum)[0] : null }
    } else if (selectValue.startsWith('condition-match:')) {
      const parts = selectValue.split(':')
      newScope = { type: 'condition-match', channel: parts[1], conditionIndex: parseInt(parts[2]) }
    } else if (selectValue.startsWith('condition-default:')) {
      const channel = selectValue.slice('condition-default:'.length)
      newScope = { type: 'condition-default', channel }
    } else if (selectValue === 'annotation-direct') {
      newScope = { type: 'annotation-direct', layerIndex: mod.layerIndex }
    } else if (selectValue === 'all-in-layer') {
      newScope = { type: 'all-in-layer', layerIndex: mod.layerIndex }
    } else if (selectValue === 'this-element') {
      newScope = { type: 'this-element', layerIndex: mod.layerIndex }
    } else {
      newScope = { type: selectValue }
    }
    onScopeChange(chartId, modId, newScope)
  }

  return (
    <div className="mod-panel" ref={panelRef}>
      <div className="mod-panel-header" onClick={() => setCollapsed(!collapsed)}>
        <span className="mod-panel-label">
          <span className="mod-toggle-arrow">{collapsed ? '\u25B6' : '\u25BC'}</span>
          {' '}Modifications
        </span>
        <span className="mod-count">{modifications.length} active</span>
      </div>

      {!collapsed && groups.map((group) => (
        <ModificationGroup
          key={group.key}
          group={group}
          chartId={chartId}
          spec={spec}
          activeModificationId={activeModificationId}
          onModificationClick={onModificationClick}
          onScopeChange={handleScopeSelectChange}
          onDelete={onDelete}
          onValueChange={onValueChange}
          getScopeSelectValue={getScopeSelectValue}
          rebindNotice={rebindNotice}
        />
      ))}

      {/* Unbind confirmation dialog */}
    </div>
  )
}

function ModificationGroup({ group, chartId, spec, activeModificationId, onModificationClick, onScopeChange, onDelete, onValueChange, getScopeSelectValue, rebindNotice }) {
  const [groupCollapsed, setGroupCollapsed] = useState(true)
  const hasMultiple = group.mods.length > 1

  return (
    <div
      className="mod-group"
      onMouseEnter={() => applyGroupHoverHighlight(chartId, group.mods, true)}
      onMouseLeave={() => applyGroupHoverHighlight(chartId, group.mods, false)}
    >
      {hasMultiple && (
        <div className="mod-group-header" onClick={() => setGroupCollapsed(!groupCollapsed)}>
          <span className="mod-group-toggle">{groupCollapsed ? '\u25B6' : '\u25BC'}</span>
          <span className="mod-group-label">{group.label}</span>
          <span className="mod-group-count">{group.mods.length}</span>
          {group.isBatch && (
            <button
              className="mod-batch-delete"
              title={`Delete all ${group.mods.length} items`}
              onClick={(e) => {
                e.stopPropagation()
                group.mods.forEach(m => onDelete(chartId, m.id))
              }}
            >
              Delete All
            </button>
          )}
        </div>
      )}

      {(!hasMultiple || !groupCollapsed) && group.mods.map((mod) => (
        <ModificationRow
          key={mod.id}
          mod={mod}
          chartId={chartId}
          spec={spec}
          compact={hasMultiple}
          activeModificationId={activeModificationId}
          onModificationClick={onModificationClick}
          onScopeChange={onScopeChange}
          onDelete={onDelete}
          rebindNotice={rebindNotice}
          onValueChange={onValueChange}
          getScopeSelectValue={getScopeSelectValue}
        />
      ))}
    </div>
  )
}

function ModificationRow({ mod, chartId, spec, compact, activeModificationId, onModificationClick, onScopeChange, onDelete, onValueChange, getScopeSelectValue, rebindNotice }) {
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(mod.value)

  const scopeOptions = useMemo(() => {
    const elementInfo = {
      semanticRole: mod.semanticRole || 'data-mark',
      markGroup: mod.markGroup,
      axisChannel: mod.axisChannel,
      axisSubType: mod.axisSubType,
      legendField: mod.legendField,
      legendValue: mod.legendValue,
      legendSubType: mod.legendSubType || null,
      compositeMarkType: mod.compositeMarkType || null,
      compositeSubPart: mod.compositeSubPart || null,
      layerContext: mod.layerContext || null,
      layerClassification: mod.layerClassification || null,
      layerIndex: mod.layerIndex ?? null,
    }
    return generateScopeOptions(spec, mod.datum, elementInfo, mod.property)
  }, [spec, mod.datum, mod.semanticRole, mod.markGroup, mod.axisChannel, mod.axisSubType, mod.legendField, mod.legendValue, mod.legendSubType, mod.compositeMarkType, mod.compositeSubPart, mod.layerContext, mod.layerClassification, mod.layerIndex])

  const bindingTag = getScopeBindingTag(mod.scope)
  const isColor = ['fill', 'stroke', 'color'].includes(mod.property)
  const isNumber = typeof mod.value === 'number'
  const isDelete = mod.property === '__delete__'

  // Scope-locked mods: the change is inherently not re-scopable, so show a static label
  // instead of the scope dropdown. Text content (one string, one element) and legend
  // config (orient/direction/… apply to the whole legend regardless of scope).
  const LEGEND_CONFIG_PROPS = new Set(['orient', 'direction', 'title', 'padding', 'offset', 'labelFontSize', 'symbolSize', 'fillColor', 'strokeColor'])
  const lockedScopeLabel =
    mod.property === 'text' ? 'this element'
    : (mod.semanticRole === 'legend' && LEGEND_CONFIG_PROPS.has(mod.property)) ? 'legend'
    : null

  // Delete mods get a simplified row: a "Deleted" label + a restore (×) button.
  // Removing the mod re-adds the filtered-out data.
  const deleteLabel = (() => {
    const s = mod.scope || {}
    if (s.type === 'by-field' && s.field != null) return `${s.field} = ${s.fieldValue}`
    if (s.type === 'legend-with-data' && s.legendField != null) return `${s.legendField} = ${s.legendValue}`
    return mod.targetType || 'element'
  })()

  const handleValueClick = (e) => {
    e.stopPropagation()
    setEditValue(mod.value)
    setIsEditing(true)
  }

  const handleInputKeyDown = (e) => {
    if (e.key === 'Enter') e.target.blur()
    if (e.key === 'Escape') setIsEditing(false)
  }

  const optionValue = (opt) => {
    const t = opt.value.type
    if (t === 'this-only') return 'this-only'
    if (t === 'all' || t === 'all-marks') return 'all-marks'
    if (t === 'composite-sub-all') return 'composite-sub-all'
    if (t === 'by-field') return `by-field:${opt.value.field}`
    if (t === 'same-type-in-axis') return `same-type-in-axis:${opt.value.axisChannel}:${opt.value.axisSubType}`
    if (t === 'same-type-all-axes') return `same-type-all-axes:${opt.value.axisSubType}`
    if (t === 'all-in-axis') return `all-in-axis:${opt.value.axisChannel}`
    if (t === 'scale-modify') return `scale-modify:${opt.value.channel}`
    if (t === 'condition-match') return `condition-match:${opt.value.channel}:${opt.value.conditionIndex}`
    if (t === 'condition-default') return `condition-default:${opt.value.channel}`
    if (t === 'annotation-direct') return 'annotation-direct'
    if (t === 'all-in-layer') return 'all-in-layer'
    if (t === 'this-element') return 'this-element'
    return t
  }

  if (isDelete) {
    return (
      <div className={`mod-row-wrapper ${compact ? 'mod-row-wrapper-compact' : ''}`}>
        <div
          className={`mod-row ${compact ? 'mod-row-compact' : ''} ${activeModificationId === mod.id ? 'mod-row-active' : ''}`}
          onMouseEnter={(e) => { e.stopPropagation(); applyHoverHighlight(chartId, mod, true) }}
          onMouseLeave={(e) => { e.stopPropagation(); applyHoverHighlight(chartId, mod, false) }}
        >
          <span className="mod-prop-name">Deleted</span>
          <span className="mod-group-scope-label" title="Removed from chart" style={{ flex: 1 }}>{deleteLabel}</span>
          <button
            className="mod-delete"
            onClick={(e) => { e.stopPropagation(); onDelete(chartId, mod.id) }}
            title="Restore (undo delete)"
          >
            &times;
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={`mod-row-wrapper ${compact ? 'mod-row-wrapper-compact' : ''}`}>
      {/* Target tag: outside the white card */}
      {!compact && mod.targetType && (
        <span className="mod-target-type">{mod.targetType}</span>
      )}

      <div
        className={`mod-row ${compact ? 'mod-row-compact' : ''} ${activeModificationId === mod.id ? 'mod-row-active' : ''}`}
        onClick={() => onModificationClick && onModificationClick(chartId, mod)}
        onMouseEnter={(e) => { e.stopPropagation(); applyHoverHighlight(chartId, mod, true) }}
        onMouseLeave={(e) => { e.stopPropagation(); applyHoverHighlight(chartId, mod, false) }}
      >
      {/* Col 1: property name — fixed width */}
      <span className="mod-prop-name">{mod.property}</span>

      {/* Col 3: [orig] → [new] */}
      <span className="mod-change">
        {isColor && mod.originalValue && (
          <span className="mod-swatch mod-swatch-orig" style={{ background: mod.originalValue }} title={mod.originalValue} />
        )}
        {!isColor && mod.originalValue != null && (
          <span className="mod-orig-val">{typeof mod.originalValue === 'number' ? mod.originalValue : String(mod.originalValue)}</span>
        )}
        <span className="mod-arrow">&rarr;</span>
        {isEditing ? (
          isColor ? (
            <input
              type="color"
              className="mod-inline-color"
              value={editValue}
              onChange={(e) => {
                setEditValue(e.target.value)
                if (onValueChange) onValueChange(chartId, mod.id, mod.property, e.target.value)
              }}
              onBlur={() => setIsEditing(false)}
              onClick={(e) => e.stopPropagation()}
              autoFocus
            />
          ) : (
            <input
              type={isNumber ? 'number' : 'text'}
              className="mod-inline-input"
              value={editValue}
              onChange={(e) => {
                const newVal = isNumber ? parseFloat(e.target.value) || 0 : e.target.value
                setEditValue(newVal)
                if (onValueChange) onValueChange(chartId, mod.id, mod.property, newVal)
              }}
              onBlur={() => setIsEditing(false)}
              onKeyDown={handleInputKeyDown}
              onClick={(e) => e.stopPropagation()}
              autoFocus
            />
          )
        ) : (
          <span className="mod-new-val" onClick={handleValueClick}>
            {isColor && <span className="mod-swatch" style={{ background: mod.value }} />}
            {!isColor && (typeof mod.value === 'number' ? mod.value : String(mod.value))}
          </span>
        )}
      </span>

      {/* Col 5: scope select (1fr) — for grouped mods show count label instead */}
      {mod.group ? (
        <span className="mod-group-scope-label" title={`Applied to ${mod.group.length} elements`}>
          {mod.group.length} elements
        </span>
      ) : lockedScopeLabel ? (
        // Not re-scopable (text content / legend config) — static label, no scope dropdown.
        <span className="mod-group-scope-label" title="This modification is not re-scopable">
          {lockedScopeLabel}
        </span>
      ) : mod.fromScopeSelection ? (
        <span className="mod-group-scope-label" title="Scope selection">
          {mod.scope?.type === 'all-marks' ? 'All Marks' :
           mod.scope?.type === 'by-field' ? `${mod.scope.field}=${mod.scope.fieldValue}` :
           'Scope'}
        </span>
      ) : (
        <ScopeDropdown
          value={getScopeSelectValue(mod.scope)}
          options={scopeOptions}
          optionValue={optionValue}
          onChange={(val) => onScopeChange(mod.id, val, mod)}
        />
      )}

      {/* Col 6: binding/analysis tags (data-bound / conditional / annotation / intact \u2026) removed */}

      {/* Col 7: delete */}
      <button
        className="mod-delete"
        onClick={(e) => {
          e.stopPropagation()
          onDelete(chartId, mod.id)
        }}
        title="Delete modification"
      >
        &times;
      </button>
      </div>
    </div>
  )
}

export default ModificationPanel
