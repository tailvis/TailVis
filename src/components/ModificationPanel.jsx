import { getOriginalModificationValues } from '../utils/modificationValues'
import { useEffect, useMemo, useRef, useState } from 'react'
import './ModificationPanel.css'

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
    overlay.setAttribute('rx', '0')
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
    const selectors = mod.selectedSelectors || mod.group.map(item => item.selector)
    for (const selector of selectors) {
      if (!selector) continue
      try {
        const el = svg.querySelector(selector)
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

function ModificationPanel({ chartId, spec, modifications, onDelete, onModificationClick, onValueChange, activeModificationId }) {
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
          onDelete={onDelete}
          onValueChange={onValueChange}
          rebindNotice={rebindNotice}
        />
      ))}

      {/* Unbind confirmation dialog */}
    </div>
  )
}

function ModificationGroup({ group, chartId, spec, activeModificationId, onModificationClick, onDelete, onValueChange, rebindNotice }) {
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
          onDelete={onDelete}
          rebindNotice={rebindNotice}
          onValueChange={onValueChange}
        />
      ))}
    </div>
  )
}

function ModificationRow({ mod, chartId, spec, compact, activeModificationId, onModificationClick, onDelete, onValueChange, rebindNotice }) {
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(mod.value)

  const isColor = ['fill', 'stroke', 'color'].includes(mod.property)
  const isNumber = typeof mod.value === 'number'
  const isDelete = mod.property === '__delete__'
  const originalValues = getOriginalModificationValues(mod)
  const hasMixedOriginals = originalValues.length > 1
  const originalValue = originalValues[0]


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
    if (e.key === 'Enter' && mod.property !== 'text') e.target.blur()
    if (e.key === 'Escape') setIsEditing(false)
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
        {hasMixedOriginals ? (
          <span className="mod-orig-val" title={originalValues.map(value => value == null ? 'Unavailable' : String(value)).join(', ')}>Mixed</span>
        ) : originalValue == null ? (
          <span className="mod-orig-val" title="Original value was not saved">—</span>
        ) : isColor ? (
          <span className="mod-swatch mod-swatch-orig" style={{ background: originalValue }} title={String(originalValue)} />
        ) : (
          <span className="mod-orig-val">{String(originalValue)}</span>
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
          ) : mod.property === 'text' ? (
            <textarea
              className="mod-inline-input mod-inline-text"
              rows={2}
              value={editValue}
              onChange={(e) => {
                setEditValue(e.target.value)
                if (onValueChange) onValueChange(chartId, mod.id, mod.property, e.target.value)
              }}
              onBlur={() => setIsEditing(false)}
              onKeyDown={handleInputKeyDown}
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
