import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import * as d3 from 'd3'
import vegaEmbed from 'vega-embed'
import ConnectionWidget from './ConnectionWidget'
import ModificationPanel from './ModificationPanel'
import { detectElementType, extractDatum, getLayerIndex } from '../utils/elementUtils'
import { inferSelectionIntent, findMatchingElements } from '../utils/selectionInference'
import { isAnnotationLayer, analyzeLayerContext, classifyLayer } from '../utils/scopeUtils'
import { generateScopeHierarchy } from '../utils/scopeHierarchy'
import { logEvent } from '../utils/experimentLogger'
import MinimapOverlay from './MinimapOverlay'
import './Canvas.css'

// A faceted spec ({facet, spec}) keeps its real per-cell size in the inner `.spec`;
// the outer width/height are derived totals. Return the object that owns width/height.
const specSizeHost = (spec) => (spec && spec.facet && spec.spec ? spec.spec : spec)
// Build a resized copy, writing width/height to the inner unit spec when faceted
// (and dropping the stale outer values so Vega recomputes the total).
const withSpecSize = (spec, w, h) => {
  const next = JSON.parse(JSON.stringify(spec))
  const host = next.facet && next.spec ? next.spec : next
  host.width = w
  host.height = h
  if (host !== next) { delete next.width; delete next.height }
  return next
}
// Number of facet columns/rows so a drag on the whole chart maps to a per-cell delta.
// (Faceted width/height are PER cell; total ≈ cols·cellW, so Δcell = Δtotal / cols.)
const facetCounts = (spec) => {
  const f = spec?.facet
  if (!f) return { cols: 1, rows: 1 }
  const data = spec?.data?.values || spec?.spec?.data?.values || []
  const distinct = (field) => field ? (new Set(data.map(d => d?.[field])).size || 1) : 1
  let cols = 1, rows = 1
  if (f.column?.field) cols = distinct(f.column.field)
  if (f.row?.field) rows = distinct(f.row.field)
  if (f.field) { // wrapped facet shorthand {facet:{field, columns}}
    const n = distinct(f.field)
    cols = f.columns || n
    rows = Math.max(1, Math.ceil(n / cols))
  }
  return { cols: Math.max(1, cols), rows: Math.max(1, rows) }
}
// Map a resize drag (on the whole chart's bounding box) to a new spec size.
// Non-facet: cell size = total − padding. Facet: the inner size is PER cell and the
// total spans `cols`/`rows` cells, so a Δtotal must be divided across them — otherwise
// each cell grows by the full drag and the chart overshoots by a factor of cols/rows.
const computeResizedSpec = (chartObj, curW, curH, startW, startH, padW, padH) => {
  const spec = chartObj.spec
  if (spec?.facet && spec?.spec) {
    const { cols, rows } = facetCounts(spec)
    const host = specSizeHost(spec)
    const startCellW = host.width || 400
    const startCellH = host.height || 250
    const newW = Math.max(40, Math.round(startCellW + (curW - startW) / cols))
    const newH = Math.max(40, Math.round(startCellH + (curH - startH) / rows))
    return withSpecSize(spec, newW, newH)
  }
  return withSpecSize(spec, Math.max(100, Math.round(curW - padW)), Math.max(80, Math.round(curH - padH)))
}

function Canvas({
  chartObjects,
  selectedChartIds,
  onSelectChart,
  onToggleChartSelection,
  onSelectCharts,
  onUpdateChart,
  onDeleteChart,
  onCopyChart,
  onBranchChart,
  onWidgetOptionChange,
  onElementSelect,
  onOpenChat,
  onTransformChange,
  previewChart,
  onScopeChange,
  onDeleteModification,
  onModificationClick,
  onModificationValueChange,
  activeModificationId,
  onRenderError,
  onUndo,
  panToRef,
  externalSelectedElement,  // { chartId, selector } from App — for syncing Layer panel selection
  activeChatId,
  onElementReference,
  elementBadges,
  onWidgetContinueChat,
  onWidgetPreviewChange,
  dataSources,
}) {
  const svgRef = useRef(null)
  const selectedChartIdsRef = useRef(selectedChartIds)
  selectedChartIdsRef.current = selectedChartIds
  const onOpenChatRef = useRef(onOpenChat)
  onOpenChatRef.current = onOpenChat
  const onElementSelectRef = useRef(onElementSelect)
  onElementSelectRef.current = onElementSelect
  const onElementReferenceRef = useRef(onElementReference)
  onElementReferenceRef.current = onElementReference
  const activeChatIdRef = useRef(activeChatId)
  activeChatIdRef.current = activeChatId
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 })
  const transformRef = useRef({ x: 0, y: 0, k: 1 })
  const [contextMenu, setContextMenu] = useState(null) // { x, y, chartId }
  const [widgetOffsets, setWidgetOffsets] = useState({}) // { [chartId]: { dx, dy } } — canvas coords
  const widgetOffsetsRef = useRef(widgetOffsets)
  widgetOffsetsRef.current = widgetOffsets
  const hoveredChartIdRef = useRef(null)
  const [canvasDims, setCanvasDims] = useState({ w: 800, h: 600 })

  // Expose programmatic pan function to parent via ref
  // Supports animated transition: panToRef.current(newTransform, { animate: true })
  useEffect(() => {
    if (panToRef) {
      panToRef.current = (newTransform, options) => {
        const { animate = false, duration = 600 } = options || {}
        if (!animate || !svgRef.current) {
          transformRef.current = newTransform
          setTransform(newTransform)
          return
        }
        // Smooth animated pan using d3 transition on the main <g>
        const mainGroup = d3.select(svgRef.current).select('g')
        if (mainGroup.empty()) {
          transformRef.current = newTransform
          setTransform(newTransform)
          return
        }
        const startTransform = { ...transformRef.current }
        // Cancel any in-flight animation
        mainGroup.interrupt()
        // Use requestAnimationFrame-based animation for synced SVG + HTML overlay updates
        const startTime = performance.now()
        const ease = (t) => {
          // cubic-in-out easing
          return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
        }
        const step = (now) => {
          const elapsed = now - startTime
          const rawT = Math.min(elapsed / duration, 1)
          const t = ease(rawT)
          const cur = {
            x: startTransform.x + (newTransform.x - startTransform.x) * t,
            y: startTransform.y + (newTransform.y - startTransform.y) * t,
            k: startTransform.k + (newTransform.k - startTransform.k) * t,
          }
          transformRef.current = cur
          mainGroup.attr('transform', `translate(${cur.x},${cur.y}) scale(${cur.k})`)
          setTransform({ ...cur })
          if (rawT < 1) {
            requestAnimationFrame(step)
          } else {
            if (onTransformChange) onTransformChange(newTransform)
          }
        }
        requestAnimationFrame(step)
      }
    }
  }, [panToRef, onTransformChange])

  // Track canvas container dimensions for minimap
  useEffect(() => {
    const el = svgRef.current?.parentElement
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      setCanvasDims({ w: entry.contentRect.width, h: entry.contentRect.height })
    })
    ro.observe(el)
    setCanvasDims({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // Element multi-select state (ref to avoid re-renders)
  // Each entry: { chartId, element (DOM node), selector, elementInfo, overlay (SVG rect) }
  const selectedElementsRef = useRef([])
  const selectionTimestampRef = useRef(0) // timestamp of last Canvas-initiated selection (guards against multiple re-renders)
  const prevExternalSelectionRef = useRef(null) // content key of last processed external selection

  // Semi-auto selection suggestion state
  const selectionSuggestionsRef = useRef([])
  const suggestionIndexRef = useRef(0)
  const previewElementsRef = useRef([])
  const [suggestionTooltip, setSuggestionTooltip] = useState(null)

  // Scope hierarchy state (Tab cycling)
  const [scopeHierarchy, setScopeHierarchy] = useState([])
  const [scopeLevel, setScopeLevel] = useState(0)
  const [scopePreviewLevel, setScopePreviewLevel] = useState(null) // null = no preview; number = previewing that level
  const scopeHighlightsRef = useRef([]) // SVG overlay rects for scope-included elements
  const [scopeBadgeCanvasPos, setScopeBadgeCanvasPos] = useState(null) // { x, y } in canvas coords

  // ─── Per-chart Vega render cache (incremental rendering) ───
  // Reuse a chart's already-rendered DOM across render passes instead of re-embedding
  // every chart on every change. Key = hash of spec + svgOverrides.
  const chartCacheRef = useRef(new Map()) // chartId -> { key, div, view, width, height, snapshotUrl }
  const cacheHolderRef = useRef(null)     // detached <div> that parks rendered charts during the wipe

  // ─── Pan/zoom rasterization ───
  // While the canvas is being panned/zoomed, swap each chart's live SVG (many nodes →
  // expensive to re-rasterize every frame) for a single pre-rendered bitmap, then restore
  // the editable SVG when the gesture ends. Keeps editing/layers/data; just smooth movement.
  const panRasterActiveRef = useRef(false)
  const panRasterTimerRef = useRef(null)

  const enterPanRaster = useCallback(() => {
    if (panRasterActiveRef.current) return
    panRasterActiveRef.current = true
    for (const entry of chartCacheRef.current.values()) {
      if (!entry.snapshotUrl || !entry.div) continue
      const svg = entry.div.querySelector('svg')
      if (!svg || svg.style.display === 'none') continue
      let img = entry.div.querySelector('img.chart-pan-snapshot')
      if (!img) {
        img = document.createElement('img')
        img.className = 'chart-pan-snapshot'
        img.style.pointerEvents = 'none'
        entry.div.appendChild(img)
      }
      img.src = entry.snapshotUrl
      img.style.width = (parseFloat(svg.getAttribute('width')) || svg.clientWidth) + 'px'
      img.style.height = (parseFloat(svg.getAttribute('height')) || svg.clientHeight) + 'px'
      img.style.display = 'block'
      svg.style.display = 'none'
    }
  }, [])

  const exitPanRaster = useCallback(() => {
    if (!panRasterActiveRef.current) return
    panRasterActiveRef.current = false
    for (const entry of chartCacheRef.current.values()) {
      if (!entry.div) continue
      const svg = entry.div.querySelector('svg')
      if (svg) svg.style.display = ''
      const img = entry.div.querySelector('img.chart-pan-snapshot')
      if (img) img.style.display = 'none'
    }
  }, [])

  // Encoding panel & axis label popover state

  // Create an SVG overlay that traces the element's actual shape
  const createOverlayRect = useCallback((el, color) => {
    try {
      const svgRoot = el.ownerSVGElement
      if (!svgRoot) return null
      const ns = 'http://www.w3.org/2000/svg'
      const tag = el.tagName.toLowerCase()

      // Compute transform from element's local space to SVG root space
      const ctm = el.getCTM()
      const svgCTM = svgRoot.getCTM()
      if (!ctm || !svgCTM) return null
      const toRoot = svgCTM.inverse().multiply(ctm)

      // Offset: scale the shape slightly from its bbox center to create a gap
      const isText = tag === 'text' || tag === 'tspan'
      const gap = isText ? 0.5 : 1.5 // smaller gap for text elements
      const bbox = el.getBBox()
      const cx = bbox.x + bbox.width / 2
      const cy = bbox.y + bbox.height / 2
      // Scale factor: expand by `gap` px on each side
      const sx = bbox.width > 0 ? (bbox.width + gap * 2) / bbox.width : 1
      const sy = bbox.height > 0 ? (bbox.height + gap * 2) / bbox.height : 1
      // Combined: toRoot * translate(cx,cy) * scale(sx,sy) * translate(-cx,-cy)
      const offsetMatrix = svgRoot.createSVGMatrix()
        .translate(cx, cy).scaleNonUniform(sx, sy).translate(-cx, -cy)
      const finalMatrix = toRoot.multiply(offsetMatrix)
      const m = finalMatrix
      const transformStr = `matrix(${m.a},${m.b},${m.c},${m.d},${m.e},${m.f})`

      // Clone the element's shape for the overlay
      let overlay
      if (shapeTag(tag)) {
        overlay = el.cloneNode(false)
      } else {
        // For groups or text, fall back to bounding rect
        const pad = isText ? 1 : 3
        overlay = document.createElementNS(ns, 'rect')
        overlay.setAttribute('x', bbox.x - pad)
        overlay.setAttribute('y', bbox.y - pad)
        overlay.setAttribute('width', bbox.width + pad * 2)
        overlay.setAttribute('height', bbox.height + pad * 2)
        overlay.setAttribute('rx', '2')
      }

      // Style as highlight outline — clear inherited SVG attrs from clone
      overlay.removeAttribute('class')
      overlay.removeAttribute('style')
      for (const attr of ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'stroke-opacity', 'fill-opacity']) {
        overlay.removeAttribute(attr)
      }
      overlay.setAttribute('fill', 'none')
      overlay.setAttribute('stroke', color)
      overlay.setAttribute('stroke-width', '1.2')
      overlay.setAttribute('pointer-events', 'none')
      overlay.setAttribute('transform', transformStr)
      overlay.classList.add('element-highlight-overlay')

      svgRoot.appendChild(overlay)
      return overlay
    } catch {
      return null
    }

    function shapeTag(t) {
      return t === 'rect' || t === 'circle' || t === 'ellipse' || t === 'path' || t === 'line' || t === 'polygon' || t === 'polyline'
    }
  }, [])

  const addHighlight = useCallback((el, color) => {
    el.classList.add('element-selected')
    // Remove any existing hover overlay
    if (el._hoverOverlay) { el._hoverOverlay.remove(); el._hoverOverlay = null }
    // Create persistent selection overlay
    if (el._selectOverlay) el._selectOverlay.remove()
    const highlightColor = color || (activeChatIdRef.current ? '#7C3AED' : '#0d99ff')
    el._selectOverlay = createOverlayRect(el, highlightColor)
  }, [createOverlayRect])

  const removeHighlight = useCallback((el) => {
    el.classList.remove('element-selected')
    if (el._selectOverlay) { el._selectOverlay.remove(); el._selectOverlay = null }
  }, [])

  const clearScopeHighlights = useCallback(() => {
    scopeHighlightsRef.current.forEach(overlay => overlay?.remove())
    scopeHighlightsRef.current = []
  }, [])

  const updateScopeHighlights = useCallback((elements, primaryElements) => {
    clearScopeHighlights()
    const primarySet = new Set(primaryElements || [])
    for (const el of elements) {
      if (primarySet.has(el)) continue // skip primary — already highlighted
      const overlay = createOverlayRect(el, '#0d99ff')
      if (overlay) {
        overlay.setAttribute('stroke-dasharray', '3 2')
        overlay.setAttribute('stroke-width', '1.5')
        overlay.setAttribute('opacity', '0.8')
        overlay.classList.add('scope-highlight-overlay')
        scopeHighlightsRef.current.push(overlay)
      }
    }
  }, [clearScopeHighlights, createOverlayRect])

  const clearElementSelection = useCallback(() => {
    selectedElementsRef.current.forEach(e => {
      if (e.element) removeHighlight(e.element)
    })
    selectedElementsRef.current = []
    // Clean up orphaned selection overlays from stale DOM references (e.g. after chart re-render)
    document.querySelectorAll('.element-highlight-overlay:not(.scope-highlight-overlay)').forEach(o => o.remove())
    document.querySelectorAll('.element-selected').forEach(el => el.classList.remove('element-selected'))
    clearSuggestionPreview()
    selectionSuggestionsRef.current = []
    setSuggestionTooltip(null)
    // Clear scope state
    setScopeHierarchy([])
    setScopeLevel(0)
    setScopePreviewLevel(null)
    setScopeBadgeCanvasPos(null)
    clearScopeHighlights()
  }, [removeHighlight, clearScopeHighlights])

  // --- Semi-auto selection preview ---
  const createPreviewOverlay = useCallback((el) => {
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
      const pMinX = Math.min(...xs), pMinY = Math.min(...ys)
      const pW = Math.max(...xs) - pMinX, pH = Math.max(...ys) - pMinY
      if (!isFinite(pMinX) || !isFinite(pMinY) || !isFinite(pW) || !isFinite(pH) || pW <= 0 || pH <= 0) return null
      const overlay = document.createElementNS(ns, 'rect')
      overlay.setAttribute('x', pMinX)
      overlay.setAttribute('y', pMinY)
      overlay.setAttribute('width', pW)
      overlay.setAttribute('height', pH)
      overlay.setAttribute('rx', '2')
      overlay.setAttribute('fill', 'none')
      overlay.setAttribute('stroke', '#2979FF')
      overlay.setAttribute('stroke-width', '1.5')
      overlay.setAttribute('stroke-dasharray', '3 2')
      overlay.setAttribute('opacity', '0.6')
      overlay.setAttribute('pointer-events', 'none')
      overlay.classList.add('suggestion-preview-overlay')
      svgRoot.appendChild(overlay)
      return overlay
    } catch { return null }
  }, [])

  function clearSuggestionPreview() {
    for (const item of previewElementsRef.current) {
      if (item.overlay) item.overlay.remove()
    }
    previewElementsRef.current = []
    setSuggestionTooltip(null)
  }

  const showSuggestionPreview = useCallback((suggestion, chartObj) => {
    clearSuggestionPreview()

    const container = document.getElementById(`vega-chart-${chartObj.id}`)
    const svgEl = container?.querySelector('svg')
    if (!svgEl) return

    const alreadySelected = new Set(selectedElementsRef.current.map(e => e.selector))
    const candidates = findMatchingElements(svgEl, chartObj.spec, suggestion.matchFn)
      .filter(c => !alreadySelected.has(c.elementInfo.selector))

    if (candidates.length === 0) return

    for (const candidate of candidates) {
      const overlay = createPreviewOverlay(candidate.element)
      previewElementsRef.current.push({ ...candidate, overlay })
    }

    // Show tooltip near first candidate
    const firstEl = candidates[0].element
    const bbox = firstEl.getBoundingClientRect()
    setSuggestionTooltip({
      text: `Tab: ${suggestion.label} (+${candidates.length})`,
      x: bbox.right + 8,
      y: bbox.top
    })
  }, [createPreviewOverlay])

  const runSelectionInference = useCallback((chartId) => {
    if (selectedElementsRef.current.length < 2) {
      clearSuggestionPreview()
      selectionSuggestionsRef.current = []
      return
    }
    const elementInfos = selectedElementsRef.current.map(e => e.elementInfo)
    const chartObj = chartObjects.find(c => c.id === chartId)
    if (!chartObj) return

    const suggestions = inferSelectionIntent(elementInfos, chartObj.spec)
    selectionSuggestionsRef.current = suggestions
    suggestionIndexRef.current = 0

    if (suggestions.length > 0) {
      showSuggestionPreview(suggestions[0], chartObj)
    } else {
      clearSuggestionPreview()
    }
  }, [chartObjects, showSuggestionPreview])

  const handleElementSelection = useCallback((chartId, elementInfo, isShiftClick) => {
    const entry = { chartId, element: elementInfo.element, selector: elementInfo.selector, elementInfo }
    // During active chat, new clicks use blue (not purple) — purple is reserved for pre-chat snapshot
    const chatHighlightColor = activeChatIdRef.current ? '#0d99ff' : undefined

    if (isShiftClick) {
      // Toggle: if already selected, deselect; otherwise add
      const existingIndex = selectedElementsRef.current.findIndex(
        e => e.selector === elementInfo.selector && e.chartId === chartId
      )
      if (existingIndex >= 0) {
        removeHighlight(selectedElementsRef.current[existingIndex].element)
        selectedElementsRef.current.splice(existingIndex, 1)
      } else {
        addHighlight(entry.element, chatHighlightColor)
        selectedElementsRef.current.push(entry)
      }
    } else {
      // Single click: clear previous, select only this
      clearElementSelection()
      addHighlight(entry.element, chatHighlightColor)
      selectedElementsRef.current = [entry]
    }

    // Notify parent with the clicked element + full selection array
    // Use ref to always get the latest onElementSelect (avoids stale closure in D3 drag handler)
    if (onElementSelectRef.current && elementInfo.selector) {
      selectionTimestampRef.current = Date.now()
      const allSelectors = selectedElementsRef.current.map(e => e.selector).filter(Boolean)
      const allElementInfos = selectedElementsRef.current.map(e => e.elementInfo).filter(Boolean)
      onElementSelectRef.current(chartId, elementInfo, allSelectors, allElementInfos)
    }

    // Run semi-auto selection inference
    runSelectionInference(chartId)

    // Generate scope hierarchy for Tab cycling
    const chartObj = chartObjects.find(c => c.id === chartId)
    if (chartObj) {
      const container = document.getElementById(`vega-chart-${chartId}`)
      const svgEl = container?.querySelector('svg')
      if (svgEl) {
        const allInfos = selectedElementsRef.current.map(e => e.elementInfo).filter(Boolean)
        const hierarchy = generateScopeHierarchy(allInfos, chartObj.spec, svgEl)
        setScopeHierarchy(hierarchy)
        setScopeLevel(0)
        clearScopeHighlights()
        // When scope hierarchy has 2+ levels, clear semi-auto suggestions
        // so Tab goes to scope cycling instead of suggestion acceptance
        if (hierarchy.length >= 2) {
          clearSuggestionPreview()
          selectionSuggestionsRef.current = []
          setSuggestionTooltip(null)
          // Show candidate list but nothing highlighted yet
          setScopePreviewLevel(null)
        }

        // Store canvas-local position for the scope badge
        const primaryEl = elementInfo.element
        if (primaryEl) {
          try {
            const elRect = primaryEl.getBoundingClientRect()
            const k = transformRef.current.k
            const tx = transformRef.current.x
            const ty = transformRef.current.y
            // Reverse the transform to get canvas coordinates
            const canvasX = (elRect.left - svgRef.current.getBoundingClientRect().left - tx) / k
            const canvasY = (elRect.top - svgRef.current.getBoundingClientRect().top - ty) / k
            setScopeBadgeCanvasPos({ x: canvasX - 12, y: canvasY - 24 })
          } catch { /* ignore */ }
        }
      }
    }
  }, [addHighlight, removeHighlight, clearElementSelection, runSelectionInference, chartObjects, clearScopeHighlights])

  // Detect clicked element at click point — returns elementInfo or null
  const detectClickedElement = useCallback((chartId, sourceEvent) => {
    const clientX = sourceEvent.clientX
    const clientY = sourceEvent.clientY
    const container = document.getElementById(`vega-chart-${chartId}`)
    const svgEl = container?.querySelector('svg')
    if (!svgEl) return null

    const visualTags = ['rect', 'circle', 'ellipse', 'line', 'path', 'polyline', 'polygon', 'text']

    const findNearest = (x, y, radius = 8) => {
      const offsets = [
        [0, 0], [-radius, 0], [radius, 0], [0, -radius], [0, radius],
        [-radius/2, -radius/2], [radius/2, -radius/2], [-radius/2, radius/2], [radius/2, radius/2]
      ]
      for (const [dx, dy] of offsets) {
        const el = document.elementFromPoint(x + dx, y + dy)
        if (el && svgEl.contains(el) && visualTags.includes(el.tagName?.toLowerCase())) {
          const cls = (typeof el.className === 'string' ? el.className : el.className?.baseVal) || ''
          if (cls === 'background' || cls === 'foreground') continue
          if (el.tagName?.toLowerCase() === 'rect') {
            const w = parseFloat(el.getAttribute('width') || 0)
            const h = parseFloat(el.getAttribute('height') || 0)
            if (w > 350 && h > 200) continue
          }
          return el
        }
      }
      return null
    }

    // Prefer the currently hovered element (handles z-order issues)
    const hoveredEl = svgEl._hoveredElement
    const pointEl = document.elementFromPoint(clientX, clientY)
    let target = hoveredEl || pointEl

    if (hoveredEl) {
      const hCls = hoveredEl.className?.baseVal || ''
      const hTag = hoveredEl.tagName?.toLowerCase()
      const hW = hTag === 'rect' ? parseFloat(hoveredEl.getAttribute('width') || 0) : 0
      const hH = hTag === 'rect' ? parseFloat(hoveredEl.getAttribute('height') || 0) : 0
    }

    if (!target || !svgEl.contains(target) || !visualTags.includes(target.tagName?.toLowerCase())) {
      target = findNearest(clientX, clientY)
    }
    if (target) {
      const cls = (typeof target.className === 'string' ? target.className : target.className?.baseVal) || ''
      if (cls === 'background' || cls === 'foreground') {
        target = findNearest(clientX, clientY)
      }
    }
    if (target && target.tagName?.toLowerCase() === 'rect') {
      const w = parseFloat(target.getAttribute('width') || 0)
      const h = parseFloat(target.getAttribute('height') || 0)
      if (w > 350 && h > 200) {
        target = findNearest(clientX, clientY)
      }
    }


    if (target) {
      const chartObj = chartObjects.find(c => c.id === chartId)
      const elementInfo = detectElementType(target, chartObj?.spec, svgEl)
      if (elementInfo) {
        elementInfo.datum = extractDatum(target)
        elementInfo.element = target
        elementInfo.layerIndex = getLayerIndex(target, svgEl)

        // Detect layer context (annotation / highlight / data-mark)
        if (chartObj?.spec?.layer && elementInfo.layerIndex != null) {
          const layerSpec = chartObj.spec.layer[elementInfo.layerIndex]
          const dataValues = chartObj.dataSourceId && dataSources?.[chartObj.dataSourceId]
            ? dataSources[chartObj.dataSourceId].values
            : chartObj.spec?.data?.values
          const layerContext = analyzeLayerContext(layerSpec, chartObj.spec, dataValues || [])
          elementInfo.layerContext = layerContext
          elementInfo.isAnnotation = layerContext.layerType !== 'data-mark'

          // Unified layer classification for annotation strategy routing
          const mainDataFields = dataValues && dataValues.length > 0 ? Object.keys(dataValues[0]) : []
          const layerClassification = classifyLayer(layerSpec, mainDataFields, dataValues || [])
          elementInfo.layerClassification = layerClassification
          if (layerClassification.type !== 'data-mark') {
            elementInfo.isAnnotation = true
          }
        } else {
          elementInfo.isAnnotation = false
        }

        if (elementInfo.selector) {
          return elementInfo
        }
      }
    }
    return null
  }, [chartObjects, dataSources])

  // Sync external selection (e.g. from Layer panel) with Canvas overlays + run inference
  useEffect(() => {
    // Skip if external selection data hasn't actually changed (content comparison)
    const newKey = externalSelectedElement
      ? `${externalSelectedElement.chartId}:${externalSelectedElement.selectors?.slice().sort().join(',')}`
      : null
    if (prevExternalSelectionRef.current === newKey) return
    prevExternalSelectionRef.current = newKey

    // Skip sync for 200ms after Canvas-initiated selection
    // This guards against multiple re-renders from a single click action
    if (Date.now() - selectionTimestampRef.current < 200) return

    if (!externalSelectedElement) {
      clearElementSelection()
      return
    }
    const { chartId, selectors } = externalSelectedElement
    if (!chartId || !selectors || selectors.length === 0) return

    // Check if current selection matches exactly
    const currentSelectors = selectedElementsRef.current
      .filter(e => e.chartId === chartId)
      .map(e => e.selector)
      .sort()
    const targetSelectors = [...selectors].sort()
    if (JSON.stringify(currentSelectors) === JSON.stringify(targetSelectors)) return

    // Find DOM elements and highlight all
    const container = document.getElementById(`vega-chart-${chartId}`)
    const svgEl = container?.querySelector('svg')
    if (!svgEl) return

    clearElementSelection()
    const chartObj = chartObjects.find(c => c.id === chartId)
    const newEntries = []
    for (const sel of selectors) {
      try {
        const el = svgEl.querySelector(sel)
        if (el) {
          addHighlight(el)
          // Build proper elementInfo using detectElementType (same as Canvas click path)
          const elementInfo = detectElementType(el, chartObj?.spec, svgEl)
          if (elementInfo) {
            elementInfo.datum = extractDatum(el)
            elementInfo.element = el
            elementInfo.layerIndex = getLayerIndex(el, svgEl)
          }
          newEntries.push({ chartId, element: el, selector: sel, elementInfo: elementInfo || externalSelectedElement })
        }
      } catch (e) { /* invalid selector */ }
    }
    selectedElementsRef.current = newEntries

    // Run semi-auto selection inference (same as Canvas click path)
    runSelectionInference(chartId)

    // Generate scope hierarchy (same as Canvas click path)
    if (chartObj && newEntries.length > 0) {
      const allInfos = newEntries.map(e => e.elementInfo).filter(Boolean)
      const hierarchy = generateScopeHierarchy(allInfos, chartObj.spec, svgEl)
      setScopeHierarchy(hierarchy)
      setScopeLevel(0)
      clearScopeHighlights()
      if (hierarchy.length >= 2) {
        clearSuggestionPreview()
        selectionSuggestionsRef.current = []
        setSuggestionTooltip(null)
        setScopePreviewLevel(null)
      }

      // Store canvas-local position for the scope badge
      const primaryEl = newEntries[0]?.element
      if (primaryEl) {
        try {
          const elRect = primaryEl.getBoundingClientRect()
          const k = transformRef.current.k
          const tx = transformRef.current.x
          const ty = transformRef.current.y
          const canvasX = (elRect.left - svgRef.current.getBoundingClientRect().left - tx) / k
          const canvasY = (elRect.top - svgRef.current.getBoundingClientRect().top - ty) / k
          setScopeBadgeCanvasPos({ x: canvasX - 12, y: canvasY - 24 })
        } catch { /* ignore */ }
      }
    }
  }, [externalSelectedElement, clearElementSelection, addHighlight, chartObjects, runSelectionInference, clearScopeHighlights])

  // Re-color element overlays when chat opens/closes
  useEffect(() => {
    const color = activeChatId ? '#7C3AED' : '#0d99ff'
    selectedElementsRef.current.forEach(entry => {
      if (entry.element?._selectOverlay) {
        entry.element._selectOverlay.setAttribute('stroke', color)
      }
    })
  }, [activeChatId])

  // Confirm scope selection — shared by Enter key and click
  const confirmScopeSelection = useCallback((level) => {
    const scopeEntry = scopeHierarchy[level]
    if (!scopeEntry) return
    logEvent('scope_confirm', { level, scopeType: scopeEntry.scopeType || scopeEntry.label, elementCount: scopeEntry.elements?.length || 0 })
    const chartId = selectedElementsRef.current[0]?.chartId

    // Reset to primary elements (base scope level 0) before applying new scope
    const baseElements = scopeHierarchy[0]?.elements || []
    const baseSet = new Set(baseElements)
    // Remove highlights from non-primary elements added by a previous scope confirmation
    for (const entry of selectedElementsRef.current) {
      if (!baseSet.has(entry.element)) {
        removeHighlight(entry.element)
      }
    }
    // Reset selectedElementsRef to only primary entries
    selectedElementsRef.current = selectedElementsRef.current.filter(e2 => baseSet.has(e2.element))

    const primaryEls = selectedElementsRef.current.map(e2 => e2.element)
    setScopeLevel(level)
    setScopePreviewLevel(null)
    clearScopeHighlights()
    const container = document.getElementById(`vega-chart-${chartId}`)
    const svgEl = container?.querySelector('svg')
    const chartObj = chartObjects.find(c => c.id === chartId)
    const existingSelectors = new Set(selectedElementsRef.current.map(e2 => e2.selector))
    const scopeColor = activeChatIdRef.current ? '#0d99ff' : undefined
    for (const el of (scopeEntry.elements || [])) {
      if (!primaryEls.includes(el)) {
        addHighlight(el, scopeColor)
        if (svgEl && chartObj) {
          try {
            const elInfo = detectElementType(el, chartObj.spec, svgEl)
            if (elInfo && elInfo.selector && !existingSelectors.has(elInfo.selector)) {
              elInfo.datum = extractDatum(el)
              elInfo.element = el
              elInfo.layerIndex = getLayerIndex(el, svgEl)
              selectedElementsRef.current.push({ chartId, element: el, selector: elInfo.selector, elementInfo: elInfo })
              existingSelectors.add(elInfo.selector)
            }
          } catch { /* skip */ }
        }
      }
    }
    if (onElementSelect && chartId && scopeEntry.elements?.length > 0) {
      if (svgEl && chartObj) {
        // Only the "Entire Legend" scope collapses to a single legend-group selection.
        // "All Legend Symbols" / "All Legend Labels" must stay as their individual elements
        // (else branch) so only those get selected AND their edits land in the mod stack.
        const firstEl = scopeEntry.elements[0]
        const legendAncestor = firstEl.closest('[aria-roledescription="legend"]')
        const isEntireLegend = scopeEntry.scopeType === 'entire-legend' && legendAncestor

        if (isEntireLegend) {
          // Single legend selection — detect legend group as one element
          const legendInfo = detectElementType(legendAncestor, chartObj.spec, svgEl)
          if (legendInfo) {
            legendInfo.element = legendAncestor
            // Collapse the INTERNAL selection to just the legend group. Otherwise the 7
            // individual legend symbols/labels stay in selectedElementsRef, and the first
            // modification's re-render restores them as a "7 elements selected" group —
            // dropping the "Entire Legend" scope and forcing a re-select. One legend-group
            // entry restores as one legend element, so the scope sticks.
            for (const entry of selectedElementsRef.current) removeHighlight(entry.element)
            selectedElementsRef.current = [{ chartId, element: legendAncestor, selector: legendInfo.selector, elementInfo: legendInfo }]
            addHighlight(legendAncestor, scopeColor)
            selectionTimestampRef.current = Date.now()
            onElementSelect(chartId, legendInfo, [legendInfo.selector].filter(Boolean), [legendInfo], { skipLog: true })
          }
        } else {
          const elInfo = detectElementType(firstEl, chartObj.spec, svgEl)
          if (elInfo) {
            elInfo.datum = extractDatum(firstEl)
            elInfo.element = firstEl
            elInfo.layerIndex = getLayerIndex(firstEl, svgEl)
            const allInfos = []
            const allSelectors = []
            for (const el2 of scopeEntry.elements) {
              try {
                const info2 = detectElementType(el2, chartObj.spec, svgEl)
                if (info2 && info2.selector) {
                  info2.datum = extractDatum(el2)
                  info2.element = el2
                  info2.layerIndex = getLayerIndex(el2, svgEl)
                  info2._scopeType = scopeEntry.scopeType
                  info2._scopeData = scopeEntry.scopeData
                  info2._scopeLabel = scopeEntry.label
                  info2._scopeLabelEn = scopeEntry.labelEn
                  info2._scopeElementCount = scopeEntry.elements?.length || 0
                  allSelectors.push(info2.selector)
                  allInfos.push(info2)
                }
              } catch { /* skip */ }
            }
            const infoBySelector = new Map(allInfos.map(info => [info.selector, info]))
            for (const entry of selectedElementsRef.current) {
              if (entry.chartId === chartId && entry.elementInfo) {
                const matchingInfo = infoBySelector.get(entry.selector)
                if (matchingInfo?._scopeType) {
                  entry.elementInfo._scopeType = matchingInfo._scopeType
                  entry.elementInfo._scopeData = matchingInfo._scopeData
                  entry.elementInfo._scopeLabel = matchingInfo._scopeLabel
                  entry.elementInfo._scopeLabelEn = matchingInfo._scopeLabelEn
                  entry.elementInfo._scopeElementCount = matchingInfo._scopeElementCount
                }
              }
            }
            selectionTimestampRef.current = Date.now()
            onElementSelect(chartId, elInfo, allSelectors, allInfos, { skipLog: true })
          }
        }
      }
    }
  }, [scopeHierarchy, chartObjects, addHighlight, removeHighlight, clearScopeHighlights, onElementSelect])

  // Handle keyboard delete + Escape to clear element selection + Tab for semi-auto selection
  useEffect(() => {
    const handleKeyDown = (e) => {
      const isInputFocused = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA'
        || e.target.isContentEditable || !!e.target.closest?.('.cm-editor')

      // Allow Tab/Enter for scope cycling even when chat textarea is focused
      if (isInputFocused) {
        const isScopeKey = (e.key === 'Tab' || e.key === 'Enter') &&
          scopeHierarchy.length >= 2 && selectedElementsRef.current.length > 0
        if (!isScopeKey) return
      }

      if (e.key === 'Escape') {
        // Cancel scope preview if active
        if (scopePreviewLevel !== null) {
          setScopePreviewLevel(null)
          clearScopeHighlights()
          return
        }
        if (selectionSuggestionsRef.current.length > 0) {
          clearSuggestionPreview()
          selectionSuggestionsRef.current = []
          setSuggestionTooltip(null)
          return
        }
        clearElementSelection()
        return
      }

      // Enter: confirm scope preview
      if (e.key === 'Enter' && scopePreviewLevel !== null && scopeHierarchy.length >= 2) {
        e.preventDefault()
        confirmScopeSelection(scopePreviewLevel)
        return
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedChartIds.length > 0) {
        // Don't delete charts when typing in an input/textarea or DataTable panel
        const tag = document.activeElement?.tagName?.toLowerCase()
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return
        if (document.activeElement?.closest?.('.data-table-panel, .datatable-overlay-panel')) return
        selectedChartIds.forEach(id => onDeleteChart(id))
        return
      }

      // Tab: semi-auto suggestions (multi-select) OR scope hierarchy cycling (single/multi select)
      if (e.key === 'Tab') {
        // Priority 1: Semi-auto selection suggestions
        if (selectionSuggestionsRef.current.length > 0) {
          e.preventDefault()
          const suggestions = selectionSuggestionsRef.current
          const currentIndex = suggestionIndexRef.current

          if (e.shiftKey) {
            if (currentIndex > 0) {
              suggestionIndexRef.current = currentIndex - 1
              const chartId = selectedElementsRef.current[0]?.chartId
              const chartObj = chartObjects.find(c => c.id === chartId)
              if (chartObj) showSuggestionPreview(suggestions[currentIndex - 1], chartObj)
            }
            return
          }

          if (previewElementsRef.current.length > 0) {
            const chartId = selectedElementsRef.current[0]?.chartId
            for (const candidate of previewElementsRef.current) {
              if (candidate.overlay) candidate.overlay.remove()
              addHighlight(candidate.element)
              selectedElementsRef.current.push({
                chartId,
                element: candidate.element,
                selector: candidate.elementInfo.selector,
                elementInfo: { ...candidate.elementInfo, datum: candidate.datum }
              })
            }
            previewElementsRef.current = []
            setSuggestionTooltip(null)

            if (onElementSelect && chartId) {
              const allSelectors = selectedElementsRef.current.map(e => e.selector).filter(Boolean)
              const allInfos = selectedElementsRef.current.map(e => e.elementInfo).filter(Boolean)
              const lastInfo = selectedElementsRef.current[selectedElementsRef.current.length - 1].elementInfo
              onElementSelect(chartId, lastInfo, allSelectors, allInfos)
            }
            if (chartId) runSelectionInference(chartId)
          } else if (currentIndex + 1 < suggestions.length) {
            suggestionIndexRef.current = currentIndex + 1
            const chartId = selectedElementsRef.current[0]?.chartId
            const chartObj = chartObjects.find(c => c.id === chartId)
            if (chartObj) showSuggestionPreview(suggestions[currentIndex + 1], chartObj)
          }
          return
        }

        // Priority 2: Scope hierarchy cycling — Tab cycles preview, Enter confirms
        if (scopeHierarchy.length >= 2 && selectedElementsRef.current.length > 0) {
          e.preventDefault()
          const primaryEls = selectedElementsRef.current.map(e2 => e2.element)

          const maxLevel = scopeHierarchy.length - 1
          if (e.shiftKey) {
            // Shift+Tab: highlight previous (wrap around)
            let prevLevel
            if (scopePreviewLevel === null) prevLevel = maxLevel
            else if (scopePreviewLevel > 1) prevLevel = scopePreviewLevel - 1
            else prevLevel = maxLevel
            setScopePreviewLevel(prevLevel)
            const scopeEntry = scopeHierarchy[prevLevel]
            if (scopeEntry) {
              updateScopeHighlights(scopeEntry.elements || [], primaryEls)
              logEvent('scope_cycle', { level: prevLevel, scopeType: scopeEntry.scopeType || scopeEntry.label, totalLevels: scopeHierarchy.length, direction: 'back' })
            }
          } else {
            // Tab: highlight next (wrap around)
            let nextLevel
            if (scopePreviewLevel === null) nextLevel = 1
            else if (scopePreviewLevel < maxLevel) nextLevel = scopePreviewLevel + 1
            else nextLevel = 1
            setScopePreviewLevel(nextLevel)
            const scopeEntry = scopeHierarchy[nextLevel]
            if (scopeEntry) {
              updateScopeHighlights(scopeEntry.elements || [], primaryEls)
              logEvent('scope_cycle', { level: nextLevel, scopeType: scopeEntry.scopeType || scopeEntry.label, totalLevels: scopeHierarchy.length })
            }
          }
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedChartIds, onDeleteChart, clearElementSelection, chartObjects, addHighlight, onElementSelect, showSuggestionPreview, runSelectionInference, scopeHierarchy, updateScopeHighlights, scopePreviewLevel, clearScopeHighlights, confirmScopeSelection])

  // Helper to convert rgb to hex
  const rgbToHex = (rgb) => {
    const match = rgb.match(/\d+/g)
    if (!match || match.length < 3) return rgb
    const r = parseInt(match[0]).toString(16).padStart(2, '0')
    const g = parseInt(match[1]).toString(16).padStart(2, '0')
    const b = parseInt(match[2]).toString(16).padStart(2, '0')
    return `#${r}${g}${b}`
  }

  const applySvgOverrides = (svgElement, overrides) => {
    if (!svgElement || !overrides) return

    const svgAttrMap = {
      fill: 'fill',
      stroke: 'stroke',
      strokeWidth: 'stroke-width',
      opacity: 'opacity',
      strokeDasharray: 'stroke-dasharray',
      fontSize: 'font-size',
      fontWeight: 'font-weight',
      color: 'fill'
    }

    const visualElements = ['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'text', 'image']

    Object.entries(overrides).forEach(([selector, props]) => {
      try {
        const elements = svgElement.querySelectorAll(selector)
        elements.forEach(el => {
          Object.entries(props).forEach(([propName, value]) => {
            if (propName === 'transform') {
              el.setAttribute('transform', value)
              return
            }

            // dx/dy → translate offset (preserves original Vega transform)
            if (propName === 'dx' || propName === 'dy') {
              // Save original transform on first encounter (lost on Vega re-render, which is fine)
              if (el.dataset.origTransform == null) {
                el.dataset.origTransform = el.getAttribute('transform') || ''
              }
              const orig = el.dataset.origTransform
              const dx = parseFloat(props.dx) || 0
              const dy = parseFloat(props.dy) || 0
              if (dx !== 0 || dy !== 0) {
                el.setAttribute('transform', `${orig} translate(${dx},${dy})`.trim())
              } else {
                el.setAttribute('transform', orig)
              }
              return
            }

            if (propName.startsWith('children')) {
              const childProp = propName.replace('children', '').toLowerCase()
              const visualSelector = 'rect, circle, ellipse, line, polyline, polygon, path, text, image'
              let children = Array.from(el.children || []).filter(c =>
                visualElements.includes(c.tagName?.toLowerCase())
              )
              if (children.length === 0) {
                children = Array.from(el.querySelectorAll(visualSelector))
              }
              children.forEach(child => {
                if (childProp === 'fill' || childProp === 'stroke') {
                  child.setAttribute(childProp, value)
                } else if (childProp === 'strokewidth') {
                  child.setAttribute('stroke-width', value)
                } else if (childProp === 'opacity') {
                  child.setAttribute('opacity', value)
                }
                else if (childProp === 'color' && child.tagName?.toLowerCase() === 'text') {
                  child.setAttribute('fill', value)
                } else if (childProp === 'fontsize' && child.tagName?.toLowerCase() === 'text') {
                  child.setAttribute('font-size', value)
                } else if (childProp === 'fontweight' && child.tagName?.toLowerCase() === 'text') {
                  child.setAttribute('font-weight', value)
                } else if (childProp === 'rotate' && child.tagName?.toLowerCase() === 'text') {
                  const existingTransform = child.getAttribute('transform') || ''
                  const baseTransform = existingTransform.replace(/\s*rotate\([^)]*\)/g, '').trim()
                  const cx = parseFloat(child.getAttribute('x')) || 0
                  const cy = parseFloat(child.getAttribute('y')) || 0

                  if (value === 0) {
                    if (baseTransform) {
                      child.setAttribute('transform', baseTransform)
                    } else {
                      child.removeAttribute('transform')
                    }
                  } else {
                    const rotatePart = `rotate(${value}, ${cx}, ${cy})`
                    if (baseTransform) {
                      child.setAttribute('transform', `${baseTransform} ${rotatePart}`)
                    } else {
                      child.setAttribute('transform', rotatePart)
                    }
                  }
                }
              })
              return
            }

            const attrName = svgAttrMap[propName]
            if (attrName) {
              if (propName === 'strokeDasharray' && value === 'solid') {
                el.removeAttribute('stroke-dasharray')
              } else {
                // Set both SVG attribute AND inline style to override Vega's style attribute.
                // font-weight/font-size are included because Vega emits them via `style`,
                // which beats a bare presentation attribute (so bold/normal wouldn't apply).
                el.setAttribute(attrName, value)
                if (['fill', 'stroke', 'opacity', 'font-weight', 'font-size'].includes(attrName)) {
                  const existingStyle = el.getAttribute('style') || ''
                  // Replace or append the CSS property in the style attribute
                  const cssProp = attrName === 'opacity' ? 'opacity' : attrName
                  const styleWithoutProp = existingStyle
                    .split(';')
                    .filter(s => !s.trim().startsWith(cssProp))
                    .join(';')
                  el.setAttribute('style', `${styleWithoutProp};${cssProp}:${value}`.replace(/^;/, ''))
                }
              }
            }
            if (propName === 'text' && el.tagName.toLowerCase() === 'text') {
              el.textContent = value
            }
          })
        })
      } catch (e) {
      }
    })
  }

  // Render Vega-Lite chart
  const renderVegaChart = useCallback(async (container, spec, _chartId, svgOverrides, onSizeReady) => {
    if (!container) return

    try {
      // Clear previous content
      container.innerHTML = ''

      // Embed Vega-Lite chart
      const result = await vegaEmbed(container, spec, {
        actions: false,
        renderer: 'svg',
        config: {
          background: 'white'
        }
      })
      const vegaView = result.view

      // Store view reference on container for external access
      container._vegaView = vegaView

      // Add click handlers to SVG elements for property editing
      const svgElement = container.querySelector('svg')

      if (svgElement && svgOverrides && Object.keys(svgOverrides).length > 0) {
        applySvgOverrides(svgElement, svgOverrides)
        requestAnimationFrame(() => {
          if (svgElement.isConnected) {
            applySvgOverrides(svgElement, svgOverrides)
          }
        })
      }

      if (svgElement) {
        svgElement.style.overflow = 'visible'

        requestAnimationFrame(() => {
          const svgWidth = parseFloat(svgElement.getAttribute('width')) || 0
          const svgHeight = parseFloat(svgElement.getAttribute('height')) || 0

          if (onSizeReady && svgWidth > 0 && svgHeight > 0) {
            const padding = 20
            onSizeReady(svgWidth + padding * 2, svgHeight + padding * 2)
          }
        })
      }

      if (svgElement) {
        // Make every mark/guide element individually hittable for click selection —
        // elementFromPoint (detectClickedElement) needs pointer-events ON the element, and
        // inheriting it from the root doesn't reliably cover axes/legend/text. This is a
        // cheap style-only pass: NO getBBox/reflow and NO per-element listeners (those are
        // what killed perf with many points — hover stays delegated below).
        const interactiveMarks = svgElement.querySelectorAll('rect, path, circle, line, text, ellipse, polygon, polyline')
        interactiveMarks.forEach(el => {
          const cls = (typeof el.className === 'string' ? el.className : el.className?.baseVal) || ''
          if (cls === 'background' || cls === 'foreground') return
          el.style.cursor = 'pointer'
          el.style.pointerEvents = 'all'
        })

        // Should this element get a hover highlight? (heavy checks run lazily, per hovered
        // element — not for every mark at render time)
        const isHoverableMark = (el) => {
          if (!el || el === svgElement) return false
          const tagName = el.tagName?.toLowerCase()
          if (!['rect', 'path', 'circle', 'line', 'text', 'ellipse', 'polygon', 'polyline'].includes(tagName)) return false
          const elClass = (typeof el.className === 'string' ? el.className : el.className?.baseVal) || ''
          if (elClass === 'background' || elClass === 'foreground') return false
          if (tagName === 'rect') {
            const w = parseFloat(el.getAttribute('width') || 0)
            const h = parseFloat(el.getAttribute('height') || 0)
            if (w > 350 && h > 200) return false // background rect
          }
          const opacity = el.getAttribute('opacity')
          const hasStroke = el.getAttribute('stroke') && el.getAttribute('stroke') !== 'none'
          if (opacity === '0' && !hasStroke) return false
          if (!['line', 'path', 'text'].includes(tagName)) {
            const bbox = el.getBBox?.()
            if (bbox && bbox.width < 2 && bbox.height < 2) return false
          }
          return true
        }

        // Hover highlight via event delegation — two listeners total instead of two per mark.
        // mouseover/mouseout bubble (unlike mouseenter/mouseleave), so delegation works.
        svgElement.addEventListener('mouseover', (e) => {
          const el = e.target
          if (!isHoverableMark(el)) return
          if (!el.classList.contains('element-selected')) {
            if (el._hoverOverlay) el._hoverOverlay.remove()
            el._hoverOverlay = createOverlayRect(el, activeChatIdRef.current ? '#A78BFA' : '#4a9eff')
          }
          svgElement._hoveredElement = el
        })

        svgElement.addEventListener('mouseout', (e) => {
          const el = e.target
          if (el && el._hoverOverlay) { el._hoverOverlay.remove(); el._hoverOverlay = null }
          if (svgElement._hoveredElement === el) svgElement._hoveredElement = null
        })
      }

    } catch (error) {
      console.error('Error rendering Vega-Lite chart:', error)
      // Extract the most useful part of the error message
      const msg = error?.message || String(error)
      const shortMsg = msg.length > 120 ? msg.slice(0, 120) + '…' : msg

      container.innerHTML = `
        <div class="chart-render-error">
          <div class="chart-render-error-icon">⚠</div>
          <div class="chart-render-error-title">Rendering Error</div>
          <div class="chart-render-error-msg">${shortMsg}</div>
          <button class="chart-render-error-undo" data-chartid="${_chartId}">↩ Undo</button>
        </div>
      `
      // Attach undo handler to the button
      const btn = container.querySelector('.chart-render-error-undo')
      if (btn && onUndo) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation()
          onUndo()
        })
      }
      if (onRenderError) onRenderError(_chartId, msg)
    }
  }, [onUndo, onRenderError, createOverlayRect])

  // Render numbered reference badges on chart elements
  const renderBadges = useCallback((badges) => {
    if (!svgRef.current) return
    // Remove old badges
    svgRef.current.querySelectorAll('.element-ref-badge').forEach(b => b.remove())
    if (!badges || badges.length === 0) return

    // Only render badges on the chart with active chat
    const chatId = activeChatIdRef.current
    if (!chatId) return
    const container = svgRef.current.querySelector(`#vega-chart-${chatId}`)
    if (container) {
      const svgEl = container.querySelector('svg')
      if (!svgEl) return
      for (const badge of badges) {
        const target = svgEl.querySelector(badge.selector)
        if (!target) continue
        try {
          const bbox = target.getBBox()
          const ns = 'http://www.w3.org/2000/svg'
          const badgeG = document.createElementNS(ns, 'g')
          badgeG.setAttribute('class', 'element-ref-badge')
          badgeG.setAttribute('pointer-events', 'none')

          // Apply element's own transform if any
          const elTransform = target.getAttribute('transform')

          const cx = bbox.x + bbox.width - 2
          const cy = bbox.y + 2

          const circle = document.createElementNS(ns, 'circle')
          circle.setAttribute('cx', cx)
          circle.setAttribute('cy', cy)
          circle.setAttribute('r', '10')
          circle.setAttribute('fill', '#2563EB')
          circle.setAttribute('stroke', '#fff')
          circle.setAttribute('stroke-width', '1.5')

          const text = document.createElementNS(ns, 'text')
          text.setAttribute('x', cx)
          text.setAttribute('y', cy + 4)
          text.setAttribute('text-anchor', 'middle')
          text.setAttribute('fill', 'white')
          text.setAttribute('font-size', '11')
          text.setAttribute('font-weight', '700')
          text.setAttribute('font-family', 'sans-serif')
          text.textContent = String(badge.number)

          badgeG.appendChild(circle)
          badgeG.appendChild(text)

          if (elTransform) {
            const wrapper = document.createElementNS(ns, 'g')
            wrapper.setAttribute('transform', elTransform)
            wrapper.appendChild(badgeG)
            target.parentNode.appendChild(wrapper)
          } else {
            target.parentNode.appendChild(badgeG)
          }
        } catch { /* element may not support getBBox */ }
      }
    }
  }, [])

  // Re-render badges when they change or after chart re-render
  useEffect(() => {
    // Delay slightly to ensure Vega has finished rendering
    const timer = setTimeout(() => renderBadges(elementBadges), 200)
    return () => clearTimeout(timer)
  }, [elementBadges, renderBadges, chartObjects])

  // Main render
  useEffect(() => {
    if (!svgRef.current) return

    const svg = d3.select(svgRef.current)
    const width = svgRef.current.clientWidth
    const height = svgRef.current.clientHeight

    // Park already-rendered charts in a detached holder so the wipe below doesn't destroy
    // them — unchanged charts are moved back into fresh foreignObjects without re-embedding.
    if (!cacheHolderRef.current) cacheHolderRef.current = document.createElement('div')
    for (const [, entry] of chartCacheRef.current) {
      if (entry.div && entry.div.parentNode) cacheHolderRef.current.appendChild(entry.div)
    }

    svg.selectAll('*').remove()

    // Preserve element selection entries (selectors + chartId) so they can be
    // re-applied after Vega re-renders inside the new foreignObjects.
    // DOM nodes are destroyed above, so we only keep metadata.
    const pendingReselections = selectedElementsRef.current.map(entry => ({
      chartId: entry.chartId,
      selector: entry.selector,
      elementInfo: entry.elementInfo,
    }))
    selectedElementsRef.current = []

    // Background
    svg.append('rect')
      .attr('class', 'canvas-background')
      .attr('width', width)
      .attr('height', height)
      .attr('fill', '#F5F5F5')
      .style('cursor', 'default')

    const mainGroup = svg.append('g')
      .attr('class', 'main-group')
      .attr('transform', `translate(${transformRef.current.x},${transformRef.current.y}) scale(${transformRef.current.k})`)

    // Rubber-band (marquee) selection on background
    let marquee = null
    let marqueeStart = null
    let marqueeHasDragged = false
    let zoomDuringDrag = false // true if wheel/zoom occurred between drag start and end
    let dragStartScreenPos = null // screen position at drag start for distance check

    const bgDrag = d3.drag()
      .on('start', function(event) {
        const t = transformRef.current
        const canvasX = (event.x - t.x) / t.k
        const canvasY = (event.y - t.y) / t.k
        marqueeStart = { x: canvasX, y: canvasY }
        marqueeHasDragged = false
        zoomDuringDrag = false
        dragStartScreenPos = { x: event.sourceEvent?.clientX || event.x, y: event.sourceEvent?.clientY || event.y }
      })
      .on('drag', function(event) {
        marqueeHasDragged = true
        const t = transformRef.current
        const canvasX = (event.x - t.x) / t.k
        const canvasY = (event.y - t.y) / t.k

        if (!marquee) {
          marquee = mainGroup.append('rect')
            .attr('class', 'marquee-selection')
            .attr('fill', 'rgba(74, 158, 255, 0.08)')
            .attr('stroke', '#4a9eff')
            .attr('stroke-width', 1 / t.k)
            .attr('stroke-dasharray', `${3 / t.k}`)
            .attr('pointer-events', 'none')
        }

        const x = Math.min(marqueeStart.x, canvasX)
        const y = Math.min(marqueeStart.y, canvasY)
        const w = Math.abs(canvasX - marqueeStart.x)
        const h = Math.abs(canvasY - marqueeStart.y)

        marquee.attr('x', x).attr('y', y).attr('width', w).attr('height', h)
      })
      .on('end', function(event) {
        if (marqueeHasDragged && marqueeStart) {
          const t = transformRef.current
          const canvasX = (event.x - t.x) / t.k
          const canvasY = (event.y - t.y) / t.k

          const rx1 = Math.min(marqueeStart.x, canvasX)
          const ry1 = Math.min(marqueeStart.y, canvasY)
          const rx2 = Math.max(marqueeStart.x, canvasX)
          const ry2 = Math.max(marqueeStart.y, canvasY)

          const hitIds = chartObjects
            .filter(c => !(c.x > rx2 || c.x + c.width < rx1 || c.y > ry2 || c.y + c.height < ry1))
            .map(c => c.id)

          if (event.sourceEvent.shiftKey) {
            onSelectCharts([...new Set([...selectedChartIdsRef.current, ...hitIds])])
          } else {
            onSelectCharts(hitIds.length > 0 ? hitIds : [])
          }
        } else if (!zoomDuringDrag) {
          // Click on background (no drag, no zoom gesture) → deselect all
          // Also check screen distance to filter out incidental micro-movements from zoom gestures
          const endX = event.sourceEvent?.clientX || event.x
          const endY = event.sourceEvent?.clientY || event.y
          const dist = dragStartScreenPos
            ? Math.hypot(endX - dragStartScreenPos.x, endY - dragStartScreenPos.y)
            : 0
          if (dist < 5 && !event.sourceEvent?._handledByChart) {
            clearElementSelection()
            onSelectChart(null)
          }
        }

        if (marquee) { marquee.remove(); marquee = null }
        marqueeStart = null
        zoomDuringDrag = false
        dragStartScreenPos = null
      })

    svg.select('.canvas-background').call(bgDrag)

    const handleWheel = (e) => {
      e.preventDefault()
      zoomDuringDrag = true // flag so bgDrag end doesn't clear selection

      const t = transformRef.current
      let newTransform

      if (e.ctrlKey || e.metaKey) {
        const zoomFactor = 1 - e.deltaY * 0.01
        const newScale = Math.min(4, Math.max(0.1, t.k * zoomFactor))

        const rect = svgRef.current.getBoundingClientRect()
        const mouseX = e.clientX - rect.left
        const mouseY = e.clientY - rect.top

        const newX = mouseX - (mouseX - t.x) * (newScale / t.k)
        const newY = mouseY - (mouseY - t.y) * (newScale / t.k)

        newTransform = { x: newX, y: newY, k: newScale }
      } else {
        // Two-finger pan
        newTransform = {
          x: t.x - e.deltaX,
          y: t.y - e.deltaY,
          k: t.k
        }
      }

      transformRef.current = newTransform
      setTransform(newTransform)
      if (onTransformChange) onTransformChange(newTransform)
      mainGroup.attr('transform', `translate(${newTransform.x},${newTransform.y}) scale(${newTransform.k})`)
    }

    svgRef.current.addEventListener('wheel', handleWheel, { passive: false })

    // --- Middle-mouse-button drag-to-pan + Spacebar+drag pan ---
    let isMiddleMousePanning = false
    let middlePanStart = { x: 0, y: 0, tx: 0, ty: 0 }
    let isSpaceHeld = false

    const handlePanMouseDown = (e) => {
      if (e.button === 1 || (isSpaceHeld && e.button === 0)) {
        e.preventDefault()
        isMiddleMousePanning = true
        middlePanStart = {
          x: e.clientX,
          y: e.clientY,
          tx: transformRef.current.x,
          ty: transformRef.current.y
        }
        svgRef.current.style.cursor = 'grabbing'
      }
    }

    const handlePanMouseMove = (e) => {
      if (!isMiddleMousePanning) return
      const dx = e.clientX - middlePanStart.x
      const dy = e.clientY - middlePanStart.y
      const newTransform = {
        x: middlePanStart.tx + dx,
        y: middlePanStart.ty + dy,
        k: transformRef.current.k
      }
      transformRef.current = newTransform
      setTransform(newTransform)
      if (onTransformChange) onTransformChange(newTransform)
      const mg = svgRef.current.querySelector('g')
      if (mg) {
        mg.setAttribute('transform', `translate(${newTransform.x},${newTransform.y}) scale(${newTransform.k})`)
      }
    }

    const handlePanMouseUp = (e) => {
      if (e.button === 1 || isMiddleMousePanning) {
        isMiddleMousePanning = false
        svgRef.current.style.cursor = isSpaceHeld ? 'grab' : ''
      }
    }

    const handleAuxClick = (e) => {
      if (e.button === 1) e.preventDefault()
    }

    const handlePanKeyDown = (e) => {
      if (e.code === 'Space' && !e.target.closest('input, textarea, [contenteditable]')) {
        e.preventDefault()
        isSpaceHeld = true
        if (!isMiddleMousePanning) {
          svgRef.current.style.cursor = 'grab'
        }
      }
    }

    const handlePanKeyUp = (e) => {
      if (e.code === 'Space') {
        isSpaceHeld = false
        if (!isMiddleMousePanning) {
          svgRef.current.style.cursor = ''
        }
      }
    }

    svgRef.current.addEventListener('mousedown', handlePanMouseDown)
    window.addEventListener('mousemove', handlePanMouseMove)
    window.addEventListener('mouseup', handlePanMouseUp)
    svgRef.current.addEventListener('auxclick', handleAuxClick)
    window.addEventListener('keydown', handlePanKeyDown)
    window.addEventListener('keyup', handlePanKeyUp)

    // Compute connected chart IDs for highlight (full ancestor/descendant chain)
    const connectedChartIds = new Set()
    if (selectedChartIdsRef.current.length > 0) {
      const selectedSet = new Set(selectedChartIdsRef.current)
      for (const sid of selectedChartIdsRef.current) {
        // Traverse UP: collect ancestors only
        let cur = chartObjects.find(c => c.id === sid)
        while (cur && cur.parentId != null) {
          if (connectedChartIds.has(cur.parentId) || selectedSet.has(cur.parentId)) break
          connectedChartIds.add(cur.parentId)
          cur = chartObjects.find(c => c.id === cur.parentId)
        }
        // Traverse DOWN: collect descendants only
        const dfsQueue = [sid]
        while (dfsQueue.length > 0) {
          const cid = dfsQueue.pop()
          const children = chartObjects.filter(c => c.parentId === cid)
          children.forEach(child => {
            if (!selectedSet.has(child.id)) connectedChartIds.add(child.id)
            dfsQueue.push(child.id)
          })
        }
      }
      // Remove the selected charts themselves from connected set
      selectedChartIdsRef.current.forEach(id => connectedChartIds.delete(id))
    }
    const allHighlightedIds = new Set([...selectedChartIdsRef.current, ...connectedChartIds])

    // Draw connection lines between parent-child charts, routed through widget midpoint
    const connectionsGroup = mainGroup.append('g').attr('class', 'connections')
    const widgetOffsetsSnap = widgetOffsetsRef.current

    chartObjects.forEach(chartObj => {
      if (chartObj.parentId) {
        const parentChart = chartObjects.find(c => c.id === chartObj.parentId)
        if (parentChart) {
          const isDataTransform = chartObj.changeType === 'data_transformation'
          const lineColor = isDataTransform ? '#dd6b20' : '#4a9eff'

          let startX, startY, endX, endY, arrowPoints

          // Calculate default widget midpoint (canvas coords)
          let wmx, wmy
          if (isDataTransform) {
            startX = parentChart.x + parentChart.width / 2
            startY = parentChart.y + parentChart.height
            endX = chartObj.x + chartObj.width / 2
            endY = chartObj.y
            wmx = (startX + endX) / 2
            wmy = (startY + endY) / 2
          } else {
            startX = parentChart.x + parentChart.width
            startY = parentChart.y + parentChart.height / 2
            endX = chartObj.x
            endY = chartObj.y + chartObj.height / 2
            wmx = (startX + endX) / 2
            wmy = (startY + endY) / 2
          }

          // Apply widget drag offset
          const off = widgetOffsetsSnap[chartObj.id]
          if (off) { wmx += off.dx; wmy += off.dy }

          // Draw two-segment bezier: start → widget midpoint → end
          const path1 = d3.path()
          path1.moveTo(startX, startY)
          if (isDataTransform) {
            path1.bezierCurveTo(startX, (startY + wmy) / 2, wmx, (startY + wmy) / 2, wmx, wmy)
          } else {
            path1.bezierCurveTo((startX + wmx) / 2, startY, (startX + wmx) / 2, wmy, wmx, wmy)
          }

          const path2 = d3.path()
          path2.moveTo(wmx, wmy)
          if (isDataTransform) {
            path2.bezierCurveTo(wmx, (wmy + endY) / 2, endX, (wmy + endY) / 2, endX, endY)
          } else {
            path2.bezierCurveTo((wmx + endX) / 2, wmy, (wmx + endX) / 2, endY, endX, endY)
          }

          // Boost connection line when both ends are in the highlighted chain
          const isConnectionHighlighted = allHighlightedIds.has(chartObj.id) && allHighlightedIds.has(parentChart.id)
          const lineOpacity = isConnectionHighlighted ? 1 : 0.45
          const lineWidth = isConnectionHighlighted ? 3 : 1.5

          const lineAttrs = { fill: 'none', stroke: lineColor, 'stroke-width': lineWidth, 'stroke-dasharray': isConnectionHighlighted ? 'none' : '4,4', opacity: lineOpacity }
          const seg1 = connectionsGroup.append('path').attr('d', path1.toString())
          const seg2 = connectionsGroup.append('path').attr('d', path2.toString())
          Object.entries(lineAttrs).forEach(([k, v]) => { seg1.attr(k, v); seg2.attr(k, v) })

          // Arrow (larger when highlighted)
          const as = isConnectionHighlighted ? 12 : 8
          const ah = isConnectionHighlighted ? 7 : 5
          if (isDataTransform) {
            arrowPoints = `${endX},${endY} ${endX-ah},${endY-as} ${endX+ah},${endY-as}`
          } else {
            arrowPoints = `${endX},${endY} ${endX-as},${endY-ah} ${endX-as},${endY+ah}`
          }
          connectionsGroup.append('polygon')
            .attr('points', arrowPoints)
            .attr('fill', lineColor)
            .attr('opacity', lineOpacity)
        }
      }
    })

    // Render charts
    chartObjects.forEach(chartObj => {
      const isSelected = selectedChartIdsRef.current.includes(chartObj.id)
      const isSingleSelected = selectedChartIdsRef.current.length === 1 && selectedChartIdsRef.current[0] === chartObj.id
      const isConnected = connectedChartIds.has(chartObj.id)

      const chartGroup = mainGroup.append('g')
        .attr('class', `chart-group chart-${chartObj.id}`)
        .attr('transform', `translate(${chartObj.x}, ${chartObj.y})`)

      const isTaskImage = !!chartObj.taskImageSrc
      chartGroup.append('rect')
        .attr('class', 'chart-background')
        .attr('width', chartObj.width)
        .attr('height', chartObj.height)
        .attr('fill', 'white')
        .attr('rx', isTaskImage ? 8 : 12)
        .attr('stroke', '#ccc')
        .attr('stroke-width', 1)
        // .style('filter', isTaskImage ? 'none' : 'drop-shadow(0 4px 12px rgba(0,0,0,0.3))')

      // Chart ID label
      chartGroup.append('text')
        .attr('x', 12)
        .attr('y', -8)
        .attr('fill', isSelected ? '#4a9eff' : isConnected ? '#7bbfff' : '#666')
        .attr('font-size', '12px')
        .attr('font-weight', '600')
        .text(isTaskImage ? '#instruction' : `#${chartObj.id}`)

      // Dataset name label (top-right)
      const dsName = chartObj.dataSourceId && dataSources?.[chartObj.dataSourceId]
        ? dataSources[chartObj.dataSourceId].name
        : null
      if (dsName) {
        chartGroup.append('text')
          .attr('x', chartObj.width - 8)
          .attr('y', -8)
          .attr('text-anchor', 'end')
          .attr('fill', '#999')
          .attr('font-size', '10px')
          .text(dsName)
      }

      // Selection box for all selected charts
      if (isSelected) {
        const scale = transformRef.current.k
        chartGroup.append('rect')
          .attr('class', 'selection-box')
          .attr('x', 0).attr('y', 0)
          .attr('width', chartObj.width)
          .attr('height', chartObj.height)
          .attr('fill', 'none')
          .attr('stroke', '#0d99ff')
          .attr('stroke-width', 1 / scale)
          .attr('pointer-events', 'none')
      }

      // Connected chart: subtle dashed border (no background fill)
      if (isConnected && !isSelected) {
        const scale = transformRef.current.k
        chartGroup.append('rect')
          .attr('class', 'connected-highlight')
          .attr('x', 0).attr('y', 0)
          .attr('width', chartObj.width)
          .attr('height', chartObj.height)
          .attr('fill', 'none')
          .attr('stroke', '#4a9eff')
          .attr('stroke-width', 3 / scale)
          .attr('stroke-opacity', 0.9)
          .attr('stroke-dasharray', '6,3')
          .attr('rx', 12)
          .attr('pointer-events', 'none')
      }

      // Figma-style resize handles (only for single selection)
      if (isSingleSelected) {
        const scale = transformRef.current.k
        const handleSize = 8 / scale
        const halfHandle = handleSize / 2

        let currentWidth = chartObj.width
        let currentHeight = chartObj.height
        let startWidth, startHeight, startX, startY
        let aspectRatio = 1
        let paddingW = 0, paddingH = 0
        let posX = chartObj.x, posY = chartObj.y

        const handles = [
          ['nw', 0, 0, 'nwse-resize', -1, -1],
          ['ne', 1, 0, 'nesw-resize', 1, -1],
          ['sw', 0, 1, 'nesw-resize', -1, 1],
          ['se', 1, 1, 'nwse-resize', 1, 1],
          ['n', 0.5, 0, 'ns-resize', 0, -1],
          ['s', 0.5, 1, 'ns-resize', 0, 1],
          ['w', 0, 0.5, 'ew-resize', -1, 0],
          ['e', 1, 0.5, 'ew-resize', 1, 0],
        ]

        // Helper to update visual elements during resize
        const updateResizeVisuals = (w, h, anchorX, anchorY) => {
          chartGroup.select('.chart-background')
            .attr('width', w)
            .attr('height', h)
          chartGroup.select('.selection-box')
            .attr('width', w)
            .attr('height', h)
          chartGroup.select('foreignObject')
            .attr('width', w - 40)
            .attr('height', h - 40)
          handles.forEach(([id, xRatio, yRatio]) => {
            chartGroup.select(`.handle-${id}`)
              .attr('x', w * xRatio - halfHandle)
              .attr('y', h * yRatio - halfHandle)
          })
        }

        handles.forEach(([id, xRatio, yRatio, cursor, resizeX, resizeY]) => {
          const handle = chartGroup.append('rect')
            .attr('class', `resize-handle handle-${id}`)
            .attr('x', chartObj.width * xRatio - halfHandle)
            .attr('y', chartObj.height * yRatio - halfHandle)
            .attr('width', handleSize)
            .attr('height', handleSize)
            .attr('fill', 'white')
            .attr('stroke', '#0d99ff')
            .attr('stroke-width', 1 / scale)
            .attr('cursor', cursor)

          handle.call(
            d3.drag()
              .on('start', function(event) {
                event.sourceEvent.stopPropagation()
                const bg = chartGroup.select('.chart-background')
                startWidth = parseFloat(bg.attr('width')) || chartObj.width
                startHeight = parseFloat(bg.attr('height')) || chartObj.height
                currentWidth = startWidth
                currentHeight = startHeight
                aspectRatio = startWidth / startHeight
                paddingW = startWidth - (specSizeHost(chartObj.spec).width || 400)
                paddingH = startHeight - (specSizeHost(chartObj.spec).height || 250)
                startX = event.x
                startY = event.y
                posX = chartObj.x
                posY = chartObj.y
              })
              .on('drag', function(event) {
                const dx = event.x - startX
                const dy = event.y - startY
                const shiftKey = event.sourceEvent.shiftKey

                let newWidth = startWidth
                let newHeight = startHeight
                let newPosX = chartObj.x
                let newPosY = chartObj.y

                if (resizeX === 1) {
                  newWidth = Math.max(150, startWidth + dx)
                } else if (resizeX === -1) {
                  newWidth = Math.max(150, startWidth - dx)
                  newPosX = chartObj.x + (startWidth - newWidth)
                }
                if (resizeY === 1) {
                  newHeight = Math.max(100, startHeight + dy)
                } else if (resizeY === -1) {
                  newHeight = Math.max(100, startHeight - dy)
                  newPosY = chartObj.y + (startHeight - newHeight)
                }

                if (shiftKey) {
                  if (resizeX !== 0 && resizeY !== 0) {
                    if (Math.abs(dx) > Math.abs(dy)) {
                      newHeight = newWidth / aspectRatio
                      if (resizeY === -1) newPosY = chartObj.y + (startHeight - newHeight)
                    } else {
                      newWidth = newHeight * aspectRatio
                      if (resizeX === -1) newPosX = chartObj.x + (startWidth - newWidth)
                    }
                  } else if (resizeX !== 0) {
                    newHeight = newWidth / aspectRatio
                    if (resizeY === -1) newPosY = chartObj.y + (startHeight - newHeight)
                  } else if (resizeY !== 0) {
                    newWidth = newHeight * aspectRatio
                    if (resizeX === -1) newPosX = chartObj.x + (startWidth - newWidth)
                  }
                  newWidth = Math.max(150, newWidth)
                  newHeight = Math.max(100, newHeight)
                }

                currentWidth = newWidth
                currentHeight = newHeight
                posX = newPosX
                posY = newPosY

                chartGroup.attr('transform', `translate(${posX}, ${posY})`)
                updateResizeVisuals(newWidth, newHeight)
              })
              .on('end', function() {
                const newSpec = computeResizedSpec(chartObj, currentWidth, currentHeight, startWidth, startHeight, paddingW, paddingH)
                onUpdateChart(chartObj.id, {
                  x: Math.round(posX),
                  y: Math.round(posY),
                  width: Math.round(currentWidth),
                  height: Math.round(currentHeight),
                  spec: newSpec
                })
              })
          )
        })
      }

      // Task image: render <img> instead of Vega chart
      if (chartObj.taskImageSrc) {
        const foreignObject = chartGroup.append('foreignObject')
          .attr('x', 10)
          .attr('y', 10)
          .attr('width', chartObj.width - 20)
          .attr('height', chartObj.height - 20)
          .style('overflow', 'hidden')

        foreignObject.append('xhtml:img')
          .attr('src', chartObj.taskImageSrc)
          .style('width', '100%')
          .style('height', '100%')
          .style('object-fit', 'contain')
          .style('pointer-events', 'none')
          .style('border-radius', '4px')
      }

      if (!chartObj.taskImageSrc) {
      // Chart content using foreignObject
      const foreignObject = chartGroup.append('foreignObject')
        .attr('x', 20)
        .attr('y', 20)
        .attr('width', chartObj.width - 40)
        .attr('height', chartObj.height - 40)
        .style('overflow', 'visible')

      // Post-render: size background/handles, persist size, re-apply selection.
      // Called from the embed callback (fresh render) AND synchronously on cache reuse.
      const applyChartPostRender = (actualWidth, actualHeight) => {
        const scale = transformRef.current.k
        const handleSize = 8 / scale
        const halfHandle = handleSize / 2

        chartGroup.select('.chart-background')
          .attr('width', actualWidth)
          .attr('height', actualHeight)

        foreignObject
          .attr('width', actualWidth - 40)
          .attr('height', actualHeight - 40)

        if (isSelected) {
          chartGroup.select('.selection-box')
            .attr('width', actualWidth)
            .attr('height', actualHeight)

          const handlePositions = [
            ['nw', 0, 0], ['ne', 1, 0], ['sw', 0, 1], ['se', 1, 1],
            ['n', 0.5, 0], ['s', 0.5, 1], ['w', 0, 0.5], ['e', 1, 0.5]
          ]
          handlePositions.forEach(([id, xRatio, yRatio]) => {
            chartGroup.select(`.handle-${id}`)
              .attr('x', actualWidth * xRatio - halfHandle)
              .attr('y', actualHeight * yRatio - halfHandle)
          })
        }

        // Persist actual rendered size to chartObj for accurate connection lines
        if (Math.abs(chartObj.width - actualWidth) > 2 || Math.abs(chartObj.height - actualHeight) > 2) {
          onUpdateChart(chartObj.id, { width: actualWidth, height: actualHeight })
        }

        // Re-apply persistent highlights after Vega re-render (DOM nodes are replaced)
        // Use both current selectedElementsRef AND pendingReselections (saved before DOM wipe)
        const svgEl = document.getElementById(`vega-chart-${chartObj.id}`)?.querySelector('svg')
        if (svgEl) {
          // Merge pending reselections for this chart into current ref (if not already present)
          const currentSelectors = new Set(selectedElementsRef.current.map(e => e.selector))
          for (const pending of pendingReselections) {
            if (pending.chartId === chartObj.id && pending.selector && !currentSelectors.has(pending.selector)) {
              selectedElementsRef.current.push({ ...pending, element: null })
            }
          }

          selectedElementsRef.current = selectedElementsRef.current.map(entry => {
            if (entry.chartId !== chartObj.id) return entry
            const newEl = svgEl.querySelector(entry.selector)
            if (newEl) {
              const elInfo = detectElementType(newEl, chartObj.spec, svgEl)
              if (elInfo) {
                elInfo.datum = extractDatum(newEl)
                elInfo.element = newEl
                elInfo.layerIndex = getLayerIndex(newEl, svgEl)
                // Restore layer classification for annotation detection
                if (elInfo.layerIndex != null && chartObj.spec?.layer?.[elInfo.layerIndex]) {
                  const dataValues = chartObj.dataSourceId && dataSources?.[chartObj.dataSourceId]
                    ? dataSources[chartObj.dataSourceId].values
                    : chartObj.spec?.data?.values
                  const layerSpec = chartObj.spec.layer[elInfo.layerIndex]
                  const mainDataFields = dataValues && dataValues.length > 0 ? Object.keys(dataValues[0]) : []
                  elInfo.layerClassification = classifyLayer(layerSpec, mainDataFields, dataValues || [])
                  const layerContext = analyzeLayerContext(layerSpec, chartObj.spec, dataValues || [])
                  elInfo.layerContext = layerContext
                  elInfo.isAnnotation = layerContext.layerType !== 'data-mark' || elInfo.layerClassification.type !== 'data-mark'
                }
              }
              // Preserve scope metadata from previous elementInfo (survives Vega re-render)
              if (elInfo && entry.elementInfo) {
                if (entry.elementInfo._scopeType) {
                  elInfo._scopeType = entry.elementInfo._scopeType
                  elInfo._scopeData = entry.elementInfo._scopeData
                  elInfo._scopeLabel = entry.elementInfo._scopeLabel
                  elInfo._scopeLabelEn = entry.elementInfo._scopeLabelEn
                  elInfo._scopeElementCount = entry.elementInfo._scopeElementCount
                }
              }
              addHighlight(newEl)
              return { ...entry, element: newEl, elementInfo: elInfo || entry.elementInfo }
            }
            // Element no longer exists after re-render — remove from selection
            return null
          }).filter(Boolean)

          // Re-generate scope hierarchy if we restored selections
          const restoredForChart = selectedElementsRef.current.filter(e => e.chartId === chartObj.id)
          if (restoredForChart.length > 0) {
            const allInfos = restoredForChart.map(e => e.elementInfo).filter(Boolean)
            if (allInfos.length > 0) {
              const hierarchy = generateScopeHierarchy(allInfos, chartObj.spec, svgEl)
              setScopeHierarchy(hierarchy)
              setScopeLevel(0)
              // Restore scope badge position
              const primaryEl = restoredForChart[0].element
              if (primaryEl && svgRef.current) {
                try {
                  const elRect = primaryEl.getBoundingClientRect()
                  const k = transformRef.current.k
                  const tx = transformRef.current.x
                  const ty = transformRef.current.y
                  const canvasX = (elRect.left - svgRef.current.getBoundingClientRect().left - tx) / k
                  const canvasY = (elRect.top - svgRef.current.getBoundingClientRect().top - ty) / k
                  setScopeBadgeCanvasPos({ x: canvasX - 12, y: canvasY - 24 })
                } catch { /* ignore */ }
              }
              // Notify parent of restored selection
              if (onElementSelectRef.current) {
                const lastInfo = allInfos[allInfos.length - 1]
                const allSelectors = restoredForChart.map(e => e.selector).filter(Boolean)
                onElementSelectRef.current(chartObj.id, lastInfo, allSelectors, allInfos, { skipLog: true })
              }
            }
          }
        }
      }

      // Spec already contains embedded data — deep copy to avoid mutating state
      const renderSpec = JSON.parse(JSON.stringify(chartObj.spec))
      const specKey = JSON.stringify(renderSpec) + '::' + JSON.stringify(chartObj.svgOverrides || {})
      const cached = chartCacheRef.current.get(chartObj.id)

      if (cached && cached.key === specKey && cached.div) {
        // REUSE: move the already-rendered chart into the new foreignObject — no vegaEmbed
        foreignObject.node().appendChild(cached.div)
        // Selection/scope/hover overlays are children of this svg, so they travelled with the
        // move — clear them before re-applying so highlights don't duplicate.
        const reusedSvg = cached.div.querySelector('svg')
        if (reusedSvg) {
          // A prior pan may have left this chart rasterized (live SVG hidden behind a
          // bitmap snapshot). A content re-render must show the live SVG again, else the
          // chart looks frozen until the next pan triggers exitPanRaster.
          reusedSvg.style.display = ''
          reusedSvg.querySelectorAll('.element-highlight-overlay, .scope-highlight-overlay, .suggestion-preview-overlay').forEach(o => o.remove())
          reusedSvg.querySelectorAll('.element-selected').forEach(el => el.classList.remove('element-selected'))
        }
        const staleSnapshot = cached.div.querySelector('img.chart-pan-snapshot')
        if (staleSnapshot) staleSnapshot.style.display = 'none'
        scopeHighlightsRef.current = []
        applyChartPostRender(cached.width, cached.height)
      } else {
        // FRESH: spec/overrides changed (or first render) — embed once, then cache the result
        if (cached?.view) { try { cached.view.finalize() } catch { /* already finalized */ } }
        const chartDiv = foreignObject.append('xhtml:div')
          .attr('id', `vega-chart-${chartObj.id}`)
          .style('display', 'inline-block')
          .style('overflow', 'visible')
        renderVegaChart(chartDiv.node(), renderSpec, chartObj.id, chartObj.svgOverrides, (actualWidth, actualHeight) => {
          applyChartPostRender(actualWidth, actualHeight)
          const node = chartDiv.node()
          const view = node._vegaView
          chartCacheRef.current.set(chartObj.id, {
            key: specKey,
            div: node,
            view,
            width: actualWidth,
            height: actualHeight,
            snapshotUrl: null,
          })
          // Pre-render a bitmap for smooth pan/zoom (async; SVG renderer still drives editing).
          // toImageURL rasterizes the Vega SCENEGRAPH — which does NOT include svgOverrides
          // (those are DOM-only patches). So a chart with overrides would rasterize with the
          // OLD colors and look stale during pan. Skip the snapshot for such charts; they
          // simply pan as live SVG (correct), which is what the user sees when idle.
          const hasSvgOverrides = chartObj.svgOverrides && Object.keys(chartObj.svgOverrides).length > 0
          if (view?.toImageURL && !hasSvgOverrides) {
            view.toImageURL('png', window.devicePixelRatio || 1).then(url => {
              const e = chartCacheRef.current.get(chartObj.id)
              if (e && e.view === view) e.snapshotUrl = url
            }).catch(() => { /* snapshot is best-effort */ })
          }
        })
      }
      }

      chartGroup.on('contextmenu', function(event) {
        event.preventDefault()
        event.stopPropagation()
        setContextMenu({ x: event.clientX, y: event.clientY, chartId: chartObj.id })
      })

      chartGroup.on('mouseenter', function() {
        hoveredChartIdRef.current = chartObj.id
        const btn = document.querySelector(`.add-button-position[data-chart-id="${chartObj.id}"]`)
        if (btn) btn.classList.add('visible')
        const encBtn = document.querySelector(`.enc-button-position[data-chart-id="${chartObj.id}"]`)
        if (encBtn) encBtn.classList.add('visible')
      }).on('mouseleave', function() {
        if (hoveredChartIdRef.current === chartObj.id) hoveredChartIdRef.current = null
        const btn = document.querySelector(`.add-button-position[data-chart-id="${chartObj.id}"]`)
        if (btn) btn.classList.remove('visible')
        const encBtn = document.querySelector(`.enc-button-position[data-chart-id="${chartObj.id}"]`)
        if (encBtn) encBtn.classList.remove('visible')
      })

      // Drag behavior
      let currentX = chartObj.x
      let currentY = chartObj.y
      let hasDragged = false
      let startScreenX = 0
      let startScreenY = 0
      const DRAG_THRESHOLD = 3 // pixels before treating as drag

      const drag = d3.drag()
        .on('start', function(event) {
          event.sourceEvent.stopPropagation()
          // Don't raise() here — it reorders the DOM and breaks elementFromPoint on first click.
          // Raise only when actual dragging starts (see 'drag' handler below).
          hasDragged = false
          startScreenX = event.sourceEvent.clientX
          startScreenY = event.sourceEvent.clientY
          currentX = chartObj.x
          currentY = chartObj.y
        })
        .on('drag', function(event) {
          // Only start drag after movement exceeds threshold
          if (!hasDragged) {
            const sx = event.sourceEvent.clientX - startScreenX
            const sy = event.sourceEvent.clientY - startScreenY
            if (sx * sx + sy * sy < DRAG_THRESHOLD * DRAG_THRESHOLD) return
            hasDragged = true
            chartGroup.raise() // Raise to top only when actually dragging
          }
          const dx = event.dx
          const dy = event.dy
          currentX += dx
          currentY += dy
          chartGroup.attr('transform', `translate(${currentX}, ${currentY})`)

          // Group drag: move other selected charts together
          const curIds = selectedChartIdsRef.current
          if (curIds.includes(chartObj.id) && curIds.length > 1) {
            curIds.forEach(otherId => {
              if (otherId === chartObj.id) return
              const otherGroup = mainGroup.select(`.chart-${otherId}`)
              if (!otherGroup.empty()) {
                const otherChart = chartObjects.find(c => c.id === otherId)
                if (otherChart) {
                  const el = otherGroup.node()
                  el.__dragOffsetX = (el.__dragOffsetX || 0) + dx
                  el.__dragOffsetY = (el.__dragOffsetY || 0) + dy
                  otherGroup.attr('transform',
                    `translate(${otherChart.x + el.__dragOffsetX}, ${otherChart.y + el.__dragOffsetY})`
                  )
                }
              }
            })
          }
        })
        .on('end', function(event) {
          if (hasDragged) {
            logEvent('chart_move', { chartId: chartObj.id })
            const curIds = selectedChartIdsRef.current
            if (curIds.includes(chartObj.id) && curIds.length > 1) {
              // Batch update all selected charts
              const dx = currentX - chartObj.x
              const dy = currentY - chartObj.y
              curIds.forEach(id => {
                const c = chartObjects.find(ch => ch.id === id)
                if (c) onUpdateChart(id, { x: c.x + dx, y: c.y + dy })
                const g = mainGroup.select(`.chart-${id}`).node()
                if (g) { g.__dragOffsetX = 0; g.__dragOffsetY = 0 }
              })
            } else {
              onUpdateChart(chartObj.id, { x: currentX, y: currentY })
            }
            // After drag: keep current selection (Figma behavior)
            if (!event.sourceEvent.shiftKey && !curIds.includes(chartObj.id)) {
              onSelectChart(chartObj.id)
            }
          } else {
            // Click (no drag) — always attempt element detection
            const clickedElement = detectClickedElement(chartObj.id, event.sourceEvent)

            if (clickedElement) {
              // Mark that this click was handled by a chart element (prevents bgDrag from clearing selection)
              event.sourceEvent._handledByChart = true
              // Always do normal selection (enables Tab scope cycling).
              handleElementSelection(chartObj.id, clickedElement, event.sourceEvent.shiftKey)
              // During active chat: also add as numbered reference ([1], [2], ...)
              if (activeChatIdRef.current && chartObj.id === activeChatIdRef.current) {
                onElementReferenceRef.current?.(chartObj.id, clickedElement)
              }
            } else {
              // Clicked on chart background / empty area
              clearElementSelection()
              if (event.sourceEvent.shiftKey) {
                onToggleChartSelection(chartObj.id)
              } else {
                onSelectChart(chartObj.id)
              }
            }
          }
        })

      chartGroup.call(drag)
      chartGroup.style('cursor', 'move')
    })

    // Drop cached views for charts that no longer exist (finalize to free Vega resources)
    const liveChartIds = new Set(chartObjects.map(c => c.id))
    for (const [id, entry] of chartCacheRef.current) {
      if (!liveChartIds.has(id)) {
        try { entry.view?.finalize() } catch { /* already finalized */ }
        entry.div?.parentNode?.removeChild(entry.div)
        chartCacheRef.current.delete(id)
      }
    }

    if (previewChart) {
      const previewGroup = mainGroup.append('g')
        .attr('class', 'preview-chart')
        .attr('transform', `translate(${previewChart.x}, ${previewChart.y})`)
        .style('opacity', 0.6)

      previewGroup.append('rect')
        .attr('class', 'preview-background')
        .attr('width', previewChart.width)
        .attr('height', previewChart.height)
        .attr('fill', 'white')
        .attr('rx', 12)
        .attr('stroke', '#4a9eff')
        .attr('stroke-width', 3)
        .attr('stroke-dasharray', '8,4')
        .style('filter', 'drop-shadow(0 4px 12px rgba(74,158,255,0.3))')

      previewGroup.append('text')
        .attr('x', 12)
        .attr('y', -8)
        .attr('fill', '#4a9eff')
        .attr('font-size', '12px')
        .attr('font-weight', '600')
        .text('Preview')

      // Chart content
      const previewForeignObject = previewGroup.append('foreignObject')
        .attr('x', 20)
        .attr('y', 20)
        .attr('width', previewChart.width - 40)
        .attr('height', previewChart.height - 40)
        .style('overflow', 'visible')

      const chartDiv = previewForeignObject.append('xhtml:div')
        .attr('id', 'vega-preview-chart')
        .style('display', 'inline-block')
        .style('overflow', 'visible')

      renderVegaChart(chartDiv.node(), previewChart.spec, 'preview', null, (actualWidth, actualHeight) => {
        previewGroup.select('.preview-background')
          .attr('width', actualWidth)
          .attr('height', actualHeight)
        previewForeignObject
          .attr('width', actualWidth - 40)
          .attr('height', actualHeight - 40)
      })

      // Connection line from source chart
      const sourceChart = chartObjects.find(c => c.id === previewChart.sourceChartId)
      if (sourceChart) {
        const startX = sourceChart.x + sourceChart.width
        const startY = sourceChart.y + sourceChart.height / 2
        const endX = previewChart.x
        const endY = previewChart.y + previewChart.height / 2
        const midX = (startX + endX) / 2

        const path = d3.path()
        path.moveTo(startX, startY)
        path.bezierCurveTo(midX, startY, midX, endY, endX, endY)

        previewGroup.append('path')
          .attr('d', path.toString())
          .attr('transform', `translate(${-previewChart.x}, ${-previewChart.y})`)
          .attr('fill', 'none')
          .attr('stroke', '#4a9eff')
          .attr('stroke-width', 2)
          .attr('stroke-dasharray', '8,4')
          .attr('opacity', 0.8)

        // Arrow
        previewGroup.append('polygon')
          .attr('points', `${endX - previewChart.x},${endY - previewChart.y} ${endX - previewChart.x - 10},${endY - previewChart.y - 6} ${endX - previewChart.x - 10},${endY - previewChart.y + 6}`)
          .attr('fill', '#4a9eff')
          .attr('opacity', 0.8)
      }
    }

    // Empty state — fixed to viewport center (not affected by pan/zoom)
    if (chartObjects.length === 0 && !previewChart) {
      svg.append('text')
        .attr('class', 'empty-canvas-hint')
        .attr('x', width / 2)
        .attr('y', height / 2)
        .attr('text-anchor', 'middle')
        .style('fill', '#999')
        .style('font-size', '15px')
        .style('pointer-events', 'none')
        .text('No Chart yet')
    }

    // Cleanup
    const svgElement = svgRef.current
    return () => {
      if (svgElement) {
        svgElement.removeEventListener('wheel', handleWheel)
        svgElement.removeEventListener('mousedown', handlePanMouseDown)
        svgElement.removeEventListener('auxclick', handleAuxClick)
      }
      window.removeEventListener('mousemove', handlePanMouseMove)
      window.removeEventListener('mouseup', handlePanMouseUp)
      window.removeEventListener('keydown', handlePanKeyDown)
      window.removeEventListener('keyup', handlePanKeyUp)
    }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartObjects, onSelectChart, onUpdateChart, previewChart, widgetOffsets])

  // Finalize all cached Vega views on unmount only (NOT on every render — the main effect's
  // cleanup runs on each dep change and must not destroy the cache it just parked).
  useEffect(() => {
    const cache = chartCacheRef.current
    return () => {
      for (const [, entry] of cache) { try { entry.view?.finalize() } catch { /* ignore */ } }
      cache.clear()
      cacheHolderRef.current = null
    }
  }, [])

  // Pan/zoom rasterization: any transform change means the canvas is moving — show bitmaps,
  // then restore editable SVG ~200ms after movement stops.
  useEffect(() => {
    enterPanRaster()
    if (panRasterTimerRef.current) clearTimeout(panRasterTimerRef.current)
    panRasterTimerRef.current = setTimeout(exitPanRaster, 200)
    return () => { if (panRasterTimerRef.current) clearTimeout(panRasterTimerRef.current) }
  }, [transform, enterPanRaster, exitPanRaster])

  // Lightweight effect: update selection box visuals when selectedChartIds changes
  // without re-running the full D3 setup (which would destroy element overlays)
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const mainGroup = svg.querySelector('.main-group')
    if (!mainGroup) return

    // Compute connected chart IDs (only direct ancestor/descendant chain)
    const connectedIds = new Set()
    if (selectedChartIds.length > 0) {
      const selectedSet = new Set(selectedChartIds)
      for (const sid of selectedChartIds) {
        // Traverse UP: ancestors only
        let cur = chartObjects.find(c => c.id === sid)
        while (cur && cur.parentId != null) {
          if (connectedIds.has(cur.parentId) || selectedSet.has(cur.parentId)) break
          connectedIds.add(cur.parentId)
          cur = chartObjects.find(c => c.id === cur.parentId)
        }
        // Traverse DOWN: descendants only
        const dfsQueue = [sid]
        while (dfsQueue.length > 0) {
          const cid = dfsQueue.pop()
          chartObjects.filter(c => c.parentId === cid).forEach(child => {
            if (!selectedSet.has(child.id)) connectedIds.add(child.id)
            dfsQueue.push(child.id)
          })
        }
      }
      selectedChartIds.forEach(id => connectedIds.delete(id))
    }

    // Update connection lines & arrows based on selection state
    const connectionsGroup = mainGroup.querySelector('.connections')
    if (connectionsGroup) {
      // Remove existing connections and redraw
      connectionsGroup.innerHTML = ''
      const d3Connections = d3.select(connectionsGroup)
      chartObjects.forEach(chartObj => {
        if (!chartObj.parentId) return
        const parentChart = chartObjects.find(c => c.id === chartObj.parentId)
        if (!parentChart) return

        const isDataTransform = chartObj.changeType === 'data_transformation'
        const lineColor = isDataTransform ? '#dd6b20' : '#4a9eff'
        const allHighlighted = new Set([...selectedChartIds, ...connectedIds])
        const isConnectionHighlighted = allHighlighted.has(chartObj.id) && allHighlighted.has(parentChart.id)
        const lineOpacity = isConnectionHighlighted ? 1 : 0.45
        const lineWidth = isConnectionHighlighted ? 3 : 1.5

        let startX, startY, endX, endY
        let wmx, wmy
        if (isDataTransform) {
          startX = parentChart.x + parentChart.width / 2
          startY = parentChart.y + parentChart.height
          endX = chartObj.x + chartObj.width / 2
          endY = chartObj.y
        } else {
          startX = parentChart.x + parentChart.width
          startY = parentChart.y + parentChart.height / 2
          endX = chartObj.x
          endY = chartObj.y + chartObj.height / 2
        }
        wmx = (startX + endX) / 2
        wmy = (startY + endY) / 2
        const off = widgetOffsetsRef.current[chartObj.id]
        if (off) { wmx += off.dx; wmy += off.dy }

        const path1 = d3.path()
        path1.moveTo(startX, startY)
        if (isDataTransform) {
          path1.bezierCurveTo(startX, (startY + wmy) / 2, wmx, (startY + wmy) / 2, wmx, wmy)
        } else {
          path1.bezierCurveTo((startX + wmx) / 2, startY, (startX + wmx) / 2, wmy, wmx, wmy)
        }
        const path2 = d3.path()
        path2.moveTo(wmx, wmy)
        if (isDataTransform) {
          path2.bezierCurveTo(wmx, (wmy + endY) / 2, endX, (wmy + endY) / 2, endX, endY)
        } else {
          path2.bezierCurveTo((wmx + endX) / 2, wmy, (wmx + endX) / 2, endY, endX, endY)
        }

        const lineAttrs = { fill: 'none', stroke: lineColor, 'stroke-width': lineWidth, 'stroke-dasharray': isConnectionHighlighted ? 'none' : '4,4', opacity: lineOpacity }
        const seg1 = d3Connections.append('path').attr('d', path1.toString())
        const seg2 = d3Connections.append('path').attr('d', path2.toString())
        Object.entries(lineAttrs).forEach(([k, v]) => { seg1.attr(k, v); seg2.attr(k, v) })

        const as = isConnectionHighlighted ? 12 : 8
        const ah = isConnectionHighlighted ? 7 : 5
        let arrowPoints
        if (isDataTransform) {
          arrowPoints = `${endX},${endY} ${endX-ah},${endY-as} ${endX+ah},${endY-as}`
        } else {
          arrowPoints = `${endX},${endY} ${endX-as},${endY-ah} ${endX-as},${endY+ah}`
        }
        d3Connections.append('polygon')
          .attr('points', arrowPoints)
          .attr('fill', lineColor)
          .attr('opacity', lineOpacity)
      })
    }

    chartObjects.forEach(chartObj => {
      const chartGroup = mainGroup.querySelector(`.chart-${chartObj.id}`)
      if (!chartGroup) return
      const isSelected = selectedChartIds.includes(chartObj.id)
      const isSingleSelected = selectedChartIds.length === 1 && selectedChartIds[0] === chartObj.id
      const isConnected = connectedIds.has(chartObj.id)

      // Update chart ID label color
      const idLabel = chartGroup.querySelector(':scope > text')
      if (idLabel) idLabel.setAttribute('fill', isSelected ? '#4a9eff' : isConnected ? '#7bbfff' : '#666')

      // Toggle selection box
      const existingBox = chartGroup.querySelector('.selection-box')
      if (isSelected && !existingBox) {
        const scale = transformRef.current.k
        const box = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
        box.setAttribute('class', 'selection-box')
        box.setAttribute('x', 0); box.setAttribute('y', 0)
        box.setAttribute('width', chartObj.width)
        box.setAttribute('height', chartObj.height)
        box.setAttribute('fill', 'none')
        box.setAttribute('stroke', '#0d99ff')
        box.setAttribute('stroke-width', 1 / scale)
        box.setAttribute('pointer-events', 'none')
        chartGroup.appendChild(box)
      } else if (!isSelected && existingBox) {
        existingBox.remove()
      }

      // Toggle connected highlight (dashed border only)
      const existingConnected = chartGroup.querySelector('.connected-highlight')
      if (isConnected && !isSelected && !existingConnected) {
        const scale = transformRef.current.k
        const hl = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
        hl.setAttribute('class', 'connected-highlight')
        hl.setAttribute('x', '0'); hl.setAttribute('y', '0')
        hl.setAttribute('width', chartObj.width)
        hl.setAttribute('height', chartObj.height)
        hl.setAttribute('fill', 'none')
        hl.setAttribute('stroke', '#4a9eff')
        hl.setAttribute('stroke-width', 3 / scale)
        hl.setAttribute('stroke-opacity', '0.9')
        hl.setAttribute('stroke-dasharray', '6,3')
        hl.setAttribute('rx', '12')
        hl.setAttribute('pointer-events', 'none')
        chartGroup.appendChild(hl)
      } else if ((!isConnected || isSelected) && existingConnected) {
        existingConnected.remove()
      }

      // Toggle resize handles
      const existingHandles = chartGroup.querySelectorAll('.resize-handle')
      if (isSingleSelected && existingHandles.length === 0) {
        // Create resize handles inline (selection changed without full D3 re-render)
        const scale = transformRef.current.k
        const handleSize = 8 / scale
        const halfHandle = handleSize / 2
        const d3Group = d3.select(chartGroup)

        let currentWidth = chartObj.width
        let currentHeight = chartObj.height
        let startWidth, startHeight, startX, startY
        let aspectRatio = 1
        let paddingW = 0, paddingH = 0
        let posX = chartObj.x, posY = chartObj.y

        const handles = [
          ['nw', 0, 0, 'nwse-resize', -1, -1],
          ['ne', 1, 0, 'nesw-resize', 1, -1],
          ['sw', 0, 1, 'nesw-resize', -1, 1],
          ['se', 1, 1, 'nwse-resize', 1, 1],
          ['n', 0.5, 0, 'ns-resize', 0, -1],
          ['s', 0.5, 1, 'ns-resize', 0, 1],
          ['w', 0, 0.5, 'ew-resize', -1, 0],
          ['e', 1, 0.5, 'ew-resize', 1, 0],
        ]

        const updateResizeVisuals = (w, h) => {
          d3Group.select('.chart-background').attr('width', w).attr('height', h)
          d3Group.select('.selection-box').attr('width', w).attr('height', h)
          d3Group.select('foreignObject').attr('width', w - 40).attr('height', h - 40)
          handles.forEach(([id, xRatio, yRatio]) => {
            d3Group.select(`.handle-${id}`)
              .attr('x', w * xRatio - halfHandle)
              .attr('y', h * yRatio - halfHandle)
          })
        }

        handles.forEach(([id, xRatio, yRatio, cursor, resizeX, resizeY]) => {
          const handle = d3Group.append('rect')
            .attr('class', `resize-handle handle-${id}`)
            .attr('x', chartObj.width * xRatio - halfHandle)
            .attr('y', chartObj.height * yRatio - halfHandle)
            .attr('width', handleSize)
            .attr('height', handleSize)
            .attr('fill', 'white')
            .attr('stroke', '#0d99ff')
            .attr('stroke-width', 1 / scale)
            .attr('cursor', cursor)

          handle.call(
            d3.drag()
              .on('start', function(event) {
                event.sourceEvent.stopPropagation()
                const bg = d3Group.select('.chart-background')
                startWidth = parseFloat(bg.attr('width')) || chartObj.width
                startHeight = parseFloat(bg.attr('height')) || chartObj.height
                currentWidth = startWidth
                currentHeight = startHeight
                aspectRatio = startWidth / startHeight
                paddingW = startWidth - (specSizeHost(chartObj.spec).width || 400)
                paddingH = startHeight - (specSizeHost(chartObj.spec).height || 250)
                startX = event.x
                startY = event.y
                posX = chartObj.x
                posY = chartObj.y
              })
              .on('drag', function(event) {
                const dx = event.x - startX
                const dy = event.y - startY
                const shiftKey = event.sourceEvent.shiftKey

                let newWidth = startWidth
                let newHeight = startHeight
                let newPosX = chartObj.x
                let newPosY = chartObj.y

                if (resizeX === 1) newWidth = Math.max(150, startWidth + dx)
                else if (resizeX === -1) { newWidth = Math.max(150, startWidth - dx); newPosX = chartObj.x + (startWidth - newWidth) }
                if (resizeY === 1) newHeight = Math.max(100, startHeight + dy)
                else if (resizeY === -1) { newHeight = Math.max(100, startHeight - dy); newPosY = chartObj.y + (startHeight - newHeight) }

                if (shiftKey) {
                  if (resizeX !== 0 && resizeY !== 0) {
                    if (Math.abs(dx) > Math.abs(dy)) { newHeight = newWidth / aspectRatio; if (resizeY === -1) newPosY = chartObj.y + (startHeight - newHeight) }
                    else { newWidth = newHeight * aspectRatio; if (resizeX === -1) newPosX = chartObj.x + (startWidth - newWidth) }
                  } else if (resizeX !== 0) { newHeight = newWidth / aspectRatio; if (resizeY === -1) newPosY = chartObj.y + (startHeight - newHeight) }
                  else if (resizeY !== 0) { newWidth = newHeight * aspectRatio; if (resizeX === -1) newPosX = chartObj.x + (startWidth - newWidth) }
                  newWidth = Math.max(150, newWidth)
                  newHeight = Math.max(100, newHeight)
                }

                currentWidth = newWidth
                currentHeight = newHeight
                posX = newPosX
                posY = newPosY
                d3Group.attr('transform', `translate(${posX}, ${posY})`)
                updateResizeVisuals(newWidth, newHeight)
              })
              .on('end', function() {
                const newSpec = computeResizedSpec(chartObj, currentWidth, currentHeight, startWidth, startHeight, paddingW, paddingH)
                onUpdateChart(chartObj.id, { x: Math.round(posX), y: Math.round(posY), width: Math.round(currentWidth), height: Math.round(currentHeight), spec: newSpec })
              })
          )
        })
      } else if (!isSingleSelected && existingHandles.length > 0) {
        existingHandles.forEach(h => h.remove())
      }
    })
  }, [selectedChartIds, chartObjects, onUpdateChart])

  // Calculate widget positions — centered on the connection line, with drag offset applied
  const WIDGET_WIDTH = 250
  const widgetPositions = useMemo(() => {
    return chartObjects
      .filter(chartObj => chartObj.command && chartObj.parentId && (chartObj.widgetOptions?.length > 0 || chartObj.conversationHistory?.length > 0))
      .map(chartObj => {
        const parentChart = chartObjects.find(c => c.id === chartObj.parentId)
        let canvasX, canvasY

        if (parentChart) {
          const isDataTransform = chartObj.changeType === 'data_transformation'
          if (isDataTransform) {
            const sx = parentChart.x + parentChart.width / 2
            const sy = parentChart.y + parentChart.height
            const ex = chartObj.x + chartObj.width / 2
            const ey = chartObj.y
            canvasX = (sx + ex) / 2
            canvasY = (sy + ey) / 2
          } else {
            const sx = parentChart.x + parentChart.width
            const sy = parentChart.y + parentChart.height / 2
            const ex = chartObj.x
            const ey = chartObj.y + chartObj.height / 2
            canvasX = (sx + ex) / 2
            canvasY = (sy + ey) / 2
          }
        } else {
          canvasX = chartObj.x
          canvasY = chartObj.y
        }

        // Apply drag offset (canvas coords)
        const off = widgetOffsets[chartObj.id]
        if (off) { canvasX += off.dx; canvasY += off.dy }

        return {
          chartId: chartObj.id,
          x: canvasX * transform.k + transform.x,
          y: canvasY * transform.k + transform.y,
          command: chartObj.command,
          intent: chartObj.intent,
          widgetOptions: chartObj.widgetOptions || [],
          conversationHistory: chartObj.conversationHistory || [],
          changeType: chartObj.changeType,
          chartSpec: chartObj.spec
        }
      })
  }, [chartObjects, transform, widgetOffsets])

  // Calculate ModificationPanel positions for charts that have modifications
  const modPanelPositions = useMemo(() => {
    return chartObjects
      .filter(chartObj => chartObj.modifications && chartObj.modifications.length > 0)
      .map(chartObj => ({
        chartId: chartObj.id,
        x: (chartObj.x + chartObj.width / 2) * transform.k + transform.x,
        y: (chartObj.y + chartObj.height + 10) * transform.k + transform.y,
        width: chartObj.width,
        modifications: chartObj.modifications,
        baseSpec: chartObj.baseSpec || chartObj.spec
      }))
  }, [chartObjects, transform])

  return (
    <div className="canvas-container">
      {suggestionTooltip && (
        <div
          className="suggestion-tooltip"
          style={{
            position: 'fixed',
            left: suggestionTooltip.x,
            top: suggestionTooltip.y,
            background: '#1a1a2e',
            color: '#fff',
            padding: '4px 10px',
            borderRadius: '4px',
            fontSize: '12px',
            fontWeight: 500,
            pointerEvents: 'none',
            zIndex: 9999,
            whiteSpace: 'nowrap',
            boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
          }}
        >
          {suggestionTooltip.text}
        </div>
      )}

      {/* Scope candidate list — fixed vertical list of all scope levels */}
      {scopeHierarchy.length >= 2 && scopeBadgeCanvasPos && selectedElementsRef.current.length > 0 && (() => {
        const badgeX = scopeBadgeCanvasPos.x * transform.k + transform.x
        const badgeY = scopeBadgeCanvasPos.y * transform.k + transform.y

        return (
          <div
            className="scope-candidate-list"
            style={{ position: 'absolute', left: badgeX, top: badgeY, transform: 'translate(-100%, -100%)', zIndex: 9998 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {scopeHierarchy
              .filter((_, idx) => idx > 0)
              .map((entry, displayIdx) => {
                const actualLevel = displayIdx + 1
                const isPreview = actualLevel === scopePreviewLevel
                const isConfirmed = scopePreviewLevel === null && actualLevel === scopeLevel
                const isHighlighted = isPreview || isConfirmed
                return (
                  <div
                    key={actualLevel}
                    className={`scope-candidate-item ${isHighlighted ? 'highlighted' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      confirmScopeSelection(actualLevel)
                    }}
                  >
                    {isHighlighted && <span className="scope-candidate-arrow">▶</span>}
                    <span className="scope-candidate-label">{entry.label}</span>
                  </div>
                )
              })}
            <div className="scope-candidate-hints">
              Tab ↕ &nbsp; Enter ↩ &nbsp; Esc ✕
            </div>
          </div>
        )
      })()}
      {/* <div className="canvas-info">
        <span>Zoom: {transform.k.toFixed(2)}x</span>
        <span>Position: ({transform.x.toFixed(0)}, {transform.y.toFixed(0)})</span>
        {selectedChartIds.length === 1 && <span className="selected-indicator">Chart #{selectedChartIds[0]}</span>}
        {selectedChartIds.length > 1 && <span className="selected-indicator">{selectedChartIds.length} charts selected</span>}
      </div> */}
      <svg ref={svgRef} className="canvas-svg"></svg>

      {/* Data source label overlay */}
      <div className="datasource-label-overlay">
        {chartObjects.map(chartObj => {
          if (!chartObj.dataSourceId || !dataSources?.[chartObj.dataSourceId]) return null
          const labelX = (chartObj.x + chartObj.width - 8) * transform.k + transform.x
          const labelY = (chartObj.y + 8) * transform.k + transform.y
          return (
            <div
              key={`dslabel-${chartObj.id}`}
              className="datasource-label"
              style={{
                left: labelX,
                top: labelY,
                transform: `translate(-100%, 0) scale(${transform.k})`,
                transformOrigin: 'top right',
              }}
            >
              {dataSources[chartObj.dataSourceId].name}
            </div>
          )
        })}
      </div>

      {/* Widget overlay layer */}
      <div className="widget-overlay">
        {widgetPositions.map(widget => (
          <div
            key={widget.chartId}
            className="widget-position"
            style={{
              left: widget.x,
              top: widget.y,
              transform: `translate(-50%, -50%) scale(${transform.k})`,
              transformOrigin: 'center center',
              width: WIDGET_WIDTH
            }}
            onMouseDown={(e) => {
              // Only drag from the widget header / background, not from inputs or
              // chat text (so saved chat history can be selected/copied, not dragged)
              if (e.target.closest('input, select, button, textarea, .chat-bubble')) return
              e.preventDefault()
              e.stopPropagation()
              const startMX = e.clientX
              const startMY = e.clientY
              const chartId = widget.chartId
              const prev = widgetOffsets[chartId] || { dx: 0, dy: 0 }
              const handleMove = (ev) => {
                const ddx = (ev.clientX - startMX) / transform.k
                const ddy = (ev.clientY - startMY) / transform.k
                setWidgetOffsets(o => ({ ...o, [chartId]: { dx: prev.dx + ddx, dy: prev.dy + ddy } }))
              }
              const handleUp = () => {
                window.removeEventListener('mousemove', handleMove)
                window.removeEventListener('mouseup', handleUp)
              }
              window.addEventListener('mousemove', handleMove)
              window.addEventListener('mouseup', handleUp)
            }}
          >
            <ConnectionWidget
              chartId={widget.chartId}
              command={widget.command}
              widgetTitle={widget.widgetTitle}
              intent={widget.intent}
              widgetOptions={widget.widgetOptions}
              onOptionChange={onWidgetOptionChange}
              conversationHistory={widget.conversationHistory}
              changeType={widget.changeType}
              chartSpec={widget.chartSpec}
              onContinueChatApply={onWidgetContinueChat}
              onPreviewChange={onWidgetPreviewChange}
            />
          </div>
        ))}
      </div>

      {/* + Button overlay — above widgets */}
      <div className="add-button-overlay">
        {chartObjects.map(chartObj => {
          const btnX = (chartObj.x + chartObj.width + 36) * transform.k + transform.x
          const btnY = (chartObj.y + chartObj.height / 2) * transform.k + transform.y
          return (
            <div
              key={`add-${chartObj.id}`}
              className="add-button-position"
              data-chart-id={chartObj.id}
              style={{ left: btnX, top: btnY, transform: `translate(-50%, -50%) scale(${transform.k})` }}
              ref={(el) => {
                if (!el) return
                el._wheelHandler && el.removeEventListener('wheel', el._wheelHandler)
                el._wheelHandler = (e) => {
                  const svg = svgRef.current
                  if (svg) {
                    svg.dispatchEvent(new WheelEvent('wheel', {
                      deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode,
                      clientX: e.clientX, clientY: e.clientY,
                      ctrlKey: e.ctrlKey, metaKey: e.metaKey, bubbles: false
                    }))
                    e.preventDefault()
                  }
                }
                el.addEventListener('wheel', el._wheelHandler, { passive: false })
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onMouseEnter={() => {
                hoveredChartIdRef.current = chartObj.id
                const el = document.querySelector(`.add-button-position[data-chart-id="${chartObj.id}"]`)
                if (el) el.classList.add('visible')
              }}
              onMouseLeave={() => {
                if (hoveredChartIdRef.current === chartObj.id) hoveredChartIdRef.current = null
                const el = document.querySelector(`.add-button-position[data-chart-id="${chartObj.id}"]`)
                if (el) el.classList.remove('visible')
              }}
              onClick={(e) => {
                e.stopPropagation()
                if (onOpenChat) {
                  logEvent('chat_open', { chartId: chartObj.id })
                  onOpenChat(chartObj.id, {
                    x: chartObj.x + chartObj.width + 70,
                    y: chartObj.y + chartObj.height / 2 - 200
                  })
                }
              }}
            >
              <svg width="40" height="40" viewBox="-16 -16 32 32">
                <circle r="16" fill="#4a9eff" stroke="#fff" strokeWidth="2" />
                <path d="M-6,0 L6,0 M0,-6 L0,6" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
            </div>
          )
        })}
      </div>



      {/* Modification panel overlay */}
      <div className="mod-panel-overlay">
        {modPanelPositions.map(panel => (
          <div
            key={panel.chartId}
            className="mod-panel-position"
            style={{
              left: panel.x,
              top: panel.y,
              width: panel.width,
              transform: `translate(-50%, 0) scale(${transform.k})`,
              transformOrigin: 'top center'
            }}
          >
            <ModificationPanel
              chartId={panel.chartId}
              spec={panel.baseSpec}
              modifications={panel.modifications}
              onScopeChange={onScopeChange}
              onDelete={onDeleteModification}
              onModificationClick={onModificationClick}
              onValueChange={onModificationValueChange}
              activeModificationId={activeModificationId}
            />
          </div>
        ))}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="canvas-context-overlay"
          onClick={() => setContextMenu(null)}
          onContextMenu={(e) => { e.preventDefault(); setContextMenu(null) }}
        >
          <div
            className="canvas-context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button onClick={() => {
              if (onCopyChart) onCopyChart(contextMenu.chartId)
              setContextMenu(null)
            }}>
              Copy <span className="ctx-shortcut">⌘D</span>
            </button>
            <button onClick={() => {
              if (onBranchChart) onBranchChart(contextMenu.chartId)
              setContextMenu(null)
            }}>
              Duplicate as branch <span className="ctx-shortcut">⇧⌘D</span>
            </button>
            <button onClick={() => {
              if (onDeleteChart) onDeleteChart(contextMenu.chartId)
              setContextMenu(null)
            }}>
              Delete <span className="ctx-shortcut">⌫</span>
            </button>
            <hr style={{ margin: '4px 0', border: 'none', borderTop: '1px solid #eee' }} />
            <button onClick={() => {
              const chartContainer = document.getElementById(`vega-chart-${contextMenu.chartId}`)
              if (chartContainer) {
                const svgEl = chartContainer.querySelector('svg')
                if (svgEl) {
                  const clone = svgEl.cloneNode(true)
                  // Ensure xmlns for standalone SVG
                  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
                  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink')
                  // Inline computed styles for portability
                  const allEls = clone.querySelectorAll('*')
                  const sourceEls = svgEl.querySelectorAll('*')
                  allEls.forEach((el, i) => {
                    const computed = window.getComputedStyle(sourceEls[i])
                    const important = ['fill', 'stroke', 'stroke-width', 'opacity', 'font-family', 'font-size', 'font-weight', 'text-anchor', 'dominant-baseline']
                    important.forEach(prop => {
                      const val = computed.getPropertyValue(prop)
                      if (val) el.style.setProperty(prop, val)
                    })
                  })
                  const serializer = new XMLSerializer()
                  const svgString = '<?xml version="1.0" encoding="UTF-8"?>\n' + serializer.serializeToString(clone)
                  const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  const chartObj = chartObjects.find(c => c.id === contextMenu.chartId)
                  a.href = url
                  a.download = `chart-${chartObj?.name || contextMenu.chartId}.svg`
                  document.body.appendChild(a)
                  a.click()
                  document.body.removeChild(a)
                  URL.revokeObjectURL(url)
                }
              }
              setContextMenu(null)
            }}>
              Export SVG
            </button>
          </div>
        </div>
      )}

      {/* Minimap */}
      {chartObjects.length > 0 && (
        <MinimapOverlay
          chartObjects={chartObjects}
          transform={transform}
          canvasWidth={canvasDims.w}
          canvasHeight={canvasDims.h}
          onPan={(newTransform) => {
            if (panToRef?.current) {
              panToRef.current(newTransform, { animate: true, duration: 200 })
            } else {
              transformRef.current = newTransform
              setTransform(newTransform)
            }
          }}
        />
      )}
    </div>
  )
}

export default Canvas
