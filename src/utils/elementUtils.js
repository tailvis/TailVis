/**
 * Shared element detection utilities.
 * Used by both Canvas click and Layer click paths to produce identical elementInfo.
 */

/**
 * Generate a unique CSS selector path for a DOM element relative to an SVG root.
 */
function generateSelector(el, svgElement) {
  if (!el || el === svgElement) return null

  const tag = el.tagName?.toLowerCase()
  if (!tag) return null

  const pathParts = []
  let current = el

  while (current && current !== svgElement && current.parentElement) {
    const currentTag = current.tagName?.toLowerCase()
    if (!currentTag) break

    const parent = current.parentElement

    const ariaLabel = current.getAttribute('aria-label')
    if (ariaLabel) {
      // Escape backslashes and double-quotes so the CSS attribute selector stays valid
      const escaped = ariaLabel.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      pathParts.unshift(`${currentTag}[aria-label="${escaped}"]`)
      // Only break if this selector is unique within the SVG
      const candidateSelector = pathParts.join(' > ')
      try {
        const matches = svgElement.querySelectorAll(candidateSelector)
        if (matches.length <= 1) break
      } catch { break }
      // Not unique — continue building path upward for disambiguation
      current = parent
      continue
    }

    const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName)
    const index = siblings.indexOf(current)
    pathParts.unshift(`${currentTag}:nth-of-type(${index + 1})`)

    current = parent
  }

  return pathParts.join(' > ') || null
}

/**
 * Detect axis channel (x or y) from an axis <g> element.
 * Uses domain line orientation as the primary signal — much more reliable
 * than aria-label text matching which can false-positive on letters like 'x'.
 */
function detectAxisChannel(axisG) {
  // Strategy 1: Find the domain line via role-axis-domain class (not the longest line,
  // because grid lines can be longer and run perpendicular to the domain).
  const domainGroup = axisG.querySelector('.role-axis-domain')
  const domainLine = domainGroup ? domainGroup.querySelector('line') : null
  if (domainLine) {
    const x1 = parseFloat(domainLine.getAttribute('x1') || 0)
    const y1 = parseFloat(domainLine.getAttribute('y1') || 0)
    const x2 = parseFloat(domainLine.getAttribute('x2') || 0)
    const y2 = parseFloat(domainLine.getAttribute('y2') || 0)
    const result = Math.abs(x2 - x1) >= Math.abs(y2 - y1) ? 'x' : 'y'
    return result
  }

  // Strategy 1b: Fallback — find domain line as direct child line of axis group
  // (in case role-axis-domain class is missing)
  const directLines = Array.from(axisG.children).filter(c => c.tagName?.toLowerCase() === 'line')
  if (directLines.length > 0) {
    const line = directLines[0]
    const x1 = parseFloat(line.getAttribute('x1') || 0)
    const y1 = parseFloat(line.getAttribute('y1') || 0)
    const x2 = parseFloat(line.getAttribute('x2') || 0)
    const y2 = parseFloat(line.getAttribute('y2') || 0)
    if (Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2) > 5) {
      const result = Math.abs(x2 - x1) >= Math.abs(y2 - y1) ? 'x' : 'y'
      return result
    }
  }

  // Strategy 2: Check label positions — X-axis labels spread horizontally,
  // Y-axis labels spread vertically.
  const textElements = axisG.querySelectorAll('text')
  if (textElements.length >= 2) {
    const b1 = textElements[0].getBoundingClientRect()
    const b2 = textElements[1].getBoundingClientRect()
    const dx = Math.abs(b2.left - b1.left)
    const dy = Math.abs(b2.top - b1.top)
    if (dx !== dy) {
      const result = dx > dy ? 'x' : 'y'
      return result
    }
  }

  // Strategy 3: Fallback to translate Y position (X-axis is at the bottom)
  const transform = axisG.getAttribute('transform') || ''
  const translateMatch = transform.match(/translate\(([^,]+),\s*([^)]+)\)/)
  const translateY = translateMatch ? parseFloat(translateMatch[2]) : 0
  const result = translateY > 100 ? 'x' : 'y'
  return result
}

/**
 * Detect axis channel from line orientation within an axis sub-group
 * (for grid/tick groups rendered outside the axis <g> element).
 * Grid lines perpendicular to x-axis (vertical) → x-axis grid.
 * Grid lines perpendicular to y-axis (horizontal) → y-axis grid.
 * For ticks: x-axis ticks are vertical, y-axis ticks are horizontal.
 */
function detectAxisChannelFromLines(group) {
  const lines = group.querySelectorAll('line')
  if (lines.length === 0) return 'x' // fallback

  // Sample first few lines to determine orientation
  let verticalCount = 0
  let horizontalCount = 0
  const sampleSize = Math.min(lines.length, 5)
  for (let i = 0; i < sampleSize; i++) {
    const line = lines[i]
    const x1 = parseFloat(line.getAttribute('x1') || 0)
    const y1 = parseFloat(line.getAttribute('y1') || 0)
    const x2 = parseFloat(line.getAttribute('x2') || 0)
    const y2 = parseFloat(line.getAttribute('y2') || 0)
    const dx = Math.abs(x2 - x1)
    const dy = Math.abs(y2 - y1)
    if (dy > dx) verticalCount++
    else horizontalCount++
  }
  // Vertical grid/tick lines belong to x-axis, horizontal to y-axis
  const result = verticalCount > horizontalCount ? 'x' : 'y'
  return result
}

/**
 * Detect axis sub-element type from clicked element within axis group.
 */
function detectAxisSubType(el, axisG) {
  if (!el || el === axisG) return null
  const tag = el.tagName.toLowerCase()

  let cur = el
  for (let i = 0; i < 4 && cur && cur !== axisG; i++) {
    const classes = cur.classList ? Array.from(cur.classList) : []
    if (classes.some(c => c.includes('role-axis-grid'))) return 'grid'
    if (classes.some(c => c.includes('role-axis-domain'))) return 'domain'
    if (classes.some(c => c.includes('role-axis-tick'))) return 'tick'
    if (classes.some(c => c.includes('role-axis-label'))) return 'label'
    if (classes.some(c => c.includes('role-axis-title'))) return 'title'
    cur = cur.parentElement
  }

  if (tag === 'line') {
    return el.parentElement === axisG ? 'domain' : 'tick'
  }
  if (tag === 'text') {
    const parent = el.parentElement
    if (parent === axisG) return 'title'
    const textSiblings = parent ? Array.from(parent.children).filter(c => c.tagName?.toLowerCase() === 'text') : []
    return textSiblings.length > 1 ? 'label' : 'title'
  }
  return null
}

/**
 * Composite mark definitions: maps mark group class to sub-part name.
 */
const COMPOSITE_MARKS = {
  boxplot: {
    subParts: {
      'mark-rect': 'box',
      'mark-tick': 'median',
      'mark-rule': 'rule',
      'mark-symbol': 'outliers',
    }
  },
  errorbar: {
    subParts: {
      'mark-rule': 'rule',
      'mark-tick': 'ticks',
    }
  },
  errorband: {
    subParts: {
      'mark-area': 'band',
      'mark-line': 'borders',
    }
  }
}

/**
 * Detect composite mark info from spec, mark group, AND the element itself.
 * Falls back to element-based heuristics when markGroup mapping is ambiguous
 * (e.g., boxplot where median lines share the same parent group as boxes).
 */
function detectCompositeInfo(spec, markGroup, element) {
  const specMarkType = typeof spec.mark === 'string' ? spec.mark : spec.mark?.type

  // Also check layer specs
  let compositeType = null
  if (specMarkType && COMPOSITE_MARKS[specMarkType]) {
    compositeType = specMarkType
  } else if (spec.layer) {
    for (const layer of spec.layer) {
      const lmt = typeof layer.mark === 'string' ? layer.mark : layer.mark?.type
      if (lmt && COMPOSITE_MARKS[lmt]) { compositeType = lmt; break }
    }
  }

  if (!compositeType) return { compositeMarkType: null, compositeSubPart: null }

  // Try markGroup-based mapping first
  const subPartFromGroup = markGroup ? (COMPOSITE_MARKS[compositeType].subParts[markGroup] || null) : null

  // Primary: use aria-roledescription set by Vega runtime — most reliable method.
  // Vega often puts this on the parent <g> group, not the SVG element itself,
  // so walk up the tree (max 4 levels) to find it.
  if (element) {
    const roleToSubPart = {
      'box': 'box', 'tick': 'median', 'rule': 'rule', 'point': 'outliers',
      'band': 'band', 'borders': 'borders', 'ticks': 'ticks',
    }
    let cur = element
    for (let i = 0; i < 4 && cur; i++) {
      const ariaRole = cur.getAttribute?.('aria-roledescription')
      if (ariaRole && roleToSubPart[ariaRole]) {
        return { compositeMarkType: compositeType, compositeSubPart: roleToSubPart[ariaRole] }
      }
      cur = cur.parentElement
    }
  }

  // Fallback heuristics when aria-roledescription is not available
  if (compositeType === 'boxplot' && element) {
    const tag = element.tagName?.toLowerCase()
    if (tag === 'line') {
      const x1 = parseFloat(element.getAttribute('x1') || 0)
      const y1 = parseFloat(element.getAttribute('y1') || 0)
      const x2 = parseFloat(element.getAttribute('x2') || 0)
      const y2 = parseFloat(element.getAttribute('y2') || 0)
      const isHorizontal = Math.abs(y2 - y1) < Math.abs(x2 - x1) || (y1 === y2)
      const isVertical = Math.abs(y2 - y1) > Math.abs(x2 - x1)
      if (isHorizontal) return { compositeMarkType: compositeType, compositeSubPart: 'median' }
      if (isVertical) return { compositeMarkType: compositeType, compositeSubPart: 'rule' }
      return { compositeMarkType: compositeType, compositeSubPart: 'median' }
    }
    if (tag === 'rect') {
      if (subPartFromGroup === 'median' || subPartFromGroup === 'ticks') {
        return { compositeMarkType: compositeType, compositeSubPart: subPartFromGroup }
      }
      const w = parseFloat(element.getAttribute('width') || 0)
      const h = parseFloat(element.getAttribute('height') || 0)
      const minDim = Math.min(w, h)
      const maxDim = Math.max(w, h)
      if (minDim <= 5 || (maxDim > 0 && minDim / maxDim < 0.2 && minDim < 8)) {
        return { compositeMarkType: compositeType, compositeSubPart: 'median' }
      }
      return { compositeMarkType: compositeType, compositeSubPart: 'box' }
    }
    if (tag === 'path') {
      // Parse d attribute to estimate width/height from h/v commands
      // e.g. "M59,128h14v1h-14Z" → h totals=14, v totals=1
      const d = element.getAttribute('d') || ''
      const hMatches = d.match(/h(-?[\d.]+)/gi)
      const vMatches = d.match(/v(-?[\d.]+)/gi)
      if (hMatches && vMatches) {
        const totalH = hMatches.reduce((sum, m) => Math.max(sum, Math.abs(parseFloat(m.slice(1)))), 0)
        const totalV = vMatches.reduce((sum, m) => Math.max(sum, Math.abs(parseFloat(m.slice(1)))), 0)
        const minDim = Math.min(totalH, totalV)
        const maxDim = Math.max(totalH, totalV)
        if (maxDim > 0 && (minDim <= 3 || minDim / maxDim < 0.2)) {
          return { compositeMarkType: compositeType, compositeSubPart: 'median' }
        }
      }
      return { compositeMarkType: compositeType, compositeSubPart: 'box' }
    }
    if (tag === 'circle') return { compositeMarkType: compositeType, compositeSubPart: 'outliers' }
  }

  if (compositeType === 'errorbar' && element) {
    const tag = element.tagName?.toLowerCase()
    if (tag === 'line') {
      const x1 = parseFloat(element.getAttribute('x1') || 0)
      const y1 = parseFloat(element.getAttribute('y1') || 0)
      const x2 = parseFloat(element.getAttribute('x2') || 0)
      const y2 = parseFloat(element.getAttribute('y2') || 0)
      const isHorizontal = Math.abs(y2 - y1) <= Math.abs(x2 - x1)
      return { compositeMarkType: compositeType, compositeSubPart: isHorizontal ? 'ticks' : 'rule' }
    }
  }

  if (compositeType === 'errorband' && element) {
    const tag = element.tagName?.toLowerCase()
    if (tag === 'path' || tag === 'area') return { compositeMarkType: compositeType, compositeSubPart: 'band' }
    if (tag === 'line') return { compositeMarkType: compositeType, compositeSubPart: 'borders' }
  }

  // Fallback to markGroup-based mapping
  return { compositeMarkType: compositeType, compositeSubPart: subPartFromGroup }
}

/**
 * Extract Vega mark group class from parent <g> element.
 */
function getMarkGroup(el, svgElement) {
  let cur = el
  for (let i = 0; i < 5 && cur; i++) {
    const classList = cur.classList ? Array.from(cur.classList) : []
    const markClass = classList.find(c => c.startsWith('mark-'))
    if (markClass) {
      return {
        markGroup: markClass,
        groupElement: cur,
        groupSelector: generateSelector(cur, svgElement)
      }
    }
    cur = cur.parentElement
  }
  return null
}

/**
 * Find semantic ancestors (axis/legend) for a given element.
 */
function findSemanticAncestors(element, svgElement) {
  let current = element
  let allClasses = []
  let axisAncestor = null
  let legendAncestor = null
  let axisSubGroup = null
  let facetHeaderAncestor = null // faceted column/row header (labels + title) — NOT the chart title
  let facetHeaderInfo = null      // { orient: 'column'|'row', subType: 'title'|'label' }

  for (let i = 0; i < 15 && current && current !== svgElement; i++) {
    // Faceted column/row headers (e.g. "Species" title + "Adelie"/"Chinstrap" labels) live
    // in groups whose role/class combines column|row with title|header|label|footer. They
    // ARE the faceting axis — recognize them so axis scope/editing applies (and they're
    // never mistaken for the chart title).
    if (!facetHeaderAncestor && current !== element && current.getAttribute) {
      const role2 = current.getAttribute('aria-roledescription') || ''
      const clsStr2 = current.classList ? Array.from(current.classList).join(' ') : ''
      const hay = `${role2} ${clsStr2}`.toLowerCase()
      if ((hay.includes('column') || hay.includes('row')) &&
          (hay.includes('title') || hay.includes('header') || hay.includes('label') || hay.includes('footer'))) {
        facetHeaderAncestor = current
        facetHeaderInfo = {
          orient: hay.includes('row') ? 'row' : 'column',
          subType: hay.includes('title') ? 'title' : 'label',
        }
      }
    }
    if (current.classList) {
      const classes = Array.from(current.classList)
      allClasses.push(...classes)
      // Also detect legend/axis via CSS class (Vega sometimes uses role-legend class)
      if (!legendAncestor && current !== element && classes.some(c => c === 'role-legend')) {
        legendAncestor = current
      }
      if (!axisAncestor && current !== element && classes.some(c => c === 'role-axis')) {
        axisAncestor = current
      }
      // Detect axis sub-groups (role-axis-grid, role-axis-tick, etc.)
      // In Vega, these may be rendered OUTSIDE the axis <g> group
      if (!axisSubGroup && current !== element &&
          classes.some(c => c.startsWith('role-axis-'))) {
        axisSubGroup = current
      }
    }
    if (current.getAttribute) {
      const role = current.getAttribute('aria-roledescription')
      if (role) {
        allClasses.push(role)
        if (role === 'axis' && !axisAncestor && current !== element) axisAncestor = current
        if (role === 'legend' && !legendAncestor && current !== element) legendAncestor = current
      }
      // Also check aria-label for legend identification
      const ariaLabel = current.getAttribute('aria-label')
      if (ariaLabel && !legendAncestor && current !== element) {
        if (ariaLabel.toLowerCase().includes('legend')) {
          legendAncestor = current
        }
      }
    }
    current = current.parentElement
  }

  return { allClasses, axisAncestor, legendAncestor, axisSubGroup, facetHeaderAncestor, facetHeaderInfo }
}

/**
 * Detect legend sub-element type (symbol, label, or title) from clicked element.
 */
function detectLegendSubType(element, legendAncestor) {
  if (!element || !legendAncestor) return null
  const tag = element.tagName?.toLowerCase()

  // Walk up from element to legendAncestor checking for Vega role classes
  let cur = element
  for (let i = 0; i < 8 && cur && cur !== legendAncestor; i++) {
    const classes = cur.classList ? Array.from(cur.classList) : []
    if (classes.some(c => c.includes('role-legend-title'))) return 'title'
    if (classes.some(c => c.includes('role-legend-label'))) return 'label'
    if (classes.some(c => c.includes('role-legend-symbol') || c.includes('role-legend-entry'))) return 'symbol'
    // mark-text group inside legend → label
    if (classes.some(c => c === 'mark-text')) return 'label'
    // mark-symbol / mark-rect / mark-path groups inside legend → symbol
    if (classes.some(c => c === 'mark-symbol' || c === 'mark-rect' || c === 'mark-path')) return 'symbol'
    cur = cur.parentElement
  }

  // Fallback heuristic based on element tag
  if (tag === 'text') {
    // Check if this is the legend title: typically a direct child of legend group
    // or in a small sub-group directly under legend with no symbol siblings
    const parent = element.parentElement
    if (parent === legendAncestor) return 'title'
    // If parent's parent is the legend ancestor and parent has only text children → title
    if (parent?.parentElement === legendAncestor) {
      const siblings = Array.from(parent.children)
      const allText = siblings.every(s => s.tagName?.toLowerCase() === 'text')
      if (allText && siblings.length === 1) return 'title'
    }
    return 'label'
  }

  // Non-text elements (rect, circle, path) inside legend → symbol
  if (['rect', 'circle', 'path', 'ellipse'].includes(tag)) {
    return 'symbol'
  }

  return null
}

/**
 * Extract legend field and value from spec and element.
 */
function extractLegendInfo(spec, element) {
  let legendField = null
  let legendValue = null
  const encObj = spec.encoding || {}

  for (const ch of ['color', 'fill', 'stroke', 'shape', 'size']) {
    if (encObj[ch]?.field) { legendField = encObj[ch].field; break }
  }
  if (!legendField && spec.layer) {
    for (const layer of spec.layer) {
      for (const ch of ['color', 'fill', 'stroke', 'shape', 'size']) {
        if (layer.encoding?.[ch]?.field) { legendField = layer.encoding[ch].field; break }
      }
      if (legendField) break
    }
  }

  const vegaItem = element?.__data__
  if (vegaItem && legendField) {
    const itemDatum = vegaItem.datum || vegaItem
    legendValue = itemDatum?.value ?? itemDatum?.label ?? itemDatum?.[legendField] ?? null
  } else {
  }

  return { legendField, legendValue }
}

/**
 * Resolve a color attribute from an SVG element.
 * Checks: direct attribute → inline style → computedStyle → default.
 */
function resolveColor(element, attrName, defaultColor) {
  // 1. Direct attribute
  const attr = element.getAttribute(attrName)
  const camelCase = attrName.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
  const styleVal = element.style?.[camelCase] || ''
  let computed = ''
  try { computed = getComputedStyle(element)?.[camelCase] || '' } catch (e) {}


  if (attr && attr !== 'none' && attr !== 'inherit' && attr !== '') {
    return attr
  }

  // If attribute is explicitly 'none' or absent (null), this property is not set.
  // Don't fall through to computed style which may return inherited/default values.
  if (attr === null || attr === 'none') {
    return defaultColor
  }

  // 2. Inline style (only if attr was empty string, not null/none)
  if (styleVal && styleVal !== 'none' && styleVal !== 'inherit' && styleVal !== '') {
    return styleVal
  }

  return defaultColor
}

/**
 * Build visual properties for a visual element (text, line, rect, circle, path, etc.)
 */
function buildVisualProperties(element) {
  const tagName = element.tagName?.toLowerCase()

  if (tagName === 'text') {
    const textContent = element.textContent?.trim() || ''
    let fontSize = 12
    let fontWeight = 'normal'
    // Try attribute first, then computed style
    const fsa = element.getAttribute('font-size')
    if (fsa) {
      fontSize = parseFloat(fsa) || 12
    } else {
      try { fontSize = parseInt(getComputedStyle(element).fontSize) || 12 } catch (e) {}
    }
    const fwa = element.getAttribute('font-weight')
    if (fwa) {
      fontWeight = fwa === '700' ? 'bold' : fwa === '400' ? 'normal' : fwa
    } else {
      try { fontWeight = getComputedStyle(element).fontWeight || 'normal' } catch (e) {}
    }
    if (fontWeight === '400') fontWeight = 'normal'
    if (fontWeight === '700') fontWeight = 'bold'

    let angle = 0
    const transform = element.getAttribute('transform') || ''
    const rotateMatch = transform.match(/rotate\(([^,)]+)/)
    if (rotateMatch) angle = parseFloat(rotateMatch[1]) || 0

    return {
      text: textContent,
      fontSize,
      fontWeight,
      color: resolveColor(element, 'fill', '#000000'),
      angle
    }
  }

  if (tagName === 'line') {
    return {
      stroke: resolveColor(element, 'stroke', '#000000'),
      strokeWidth: parseFloat(element.getAttribute('stroke-width')) || 1,
      opacity: parseFloat(element.getAttribute('opacity')) || 1,
      strokeDasharray: element.getAttribute('stroke-dasharray') || 'solid'
    }
  }

  // rect, circle, path, ellipse, polygon, polyline
  return {
    fill: resolveColor(element, 'fill', 'none'),
    stroke: resolveColor(element, 'stroke', 'none'),
    strokeWidth: parseFloat(element.getAttribute('stroke-width')) || 0,
    opacity: parseFloat(element.getAttribute('opacity')) || 1
  }
}

/**
 * Detect element type from a DOM element within a Vega-rendered SVG.
 * This is the SINGLE authoritative detection function used by both Canvas and Layer paths.
 *
 * KEY DESIGN:
 * - Individual elements (text, line, rect...) always return their own visual type/properties
 *   even when inside axis/legend. semanticRole tracks the context for the modification system.
 * - Only clicking the axis/legend <g> group itself returns axis/legend type with group properties.
 * - <g> groups always return group type (with position in PropertyPanel's GroupProperties).
 */
export function detectElementType(element, spec, svgElement) {
  if (!element || !svgElement) return null

  const tagName = element.tagName?.toLowerCase()
  if (!tagName) return null

  const selector = generateSelector(element, svgElement)
  const { allClasses, axisAncestor, legendAncestor, axisSubGroup, facetHeaderAncestor, facetHeaderInfo } = findSemanticAncestors(element, svgElement)

  // --- Determine semantic context (for modification scope) ---
  let semanticRole = 'other'
  let axisChannel = null
  let axisSubType = null
  let legendField = null
  let legendValue = null

  if (axisAncestor) {
    semanticRole = 'axis'
    axisChannel = detectAxisChannel(axisAncestor)
    axisSubType = detectAxisSubType(element, axisAncestor)
  } else if (axisSubGroup && !legendAncestor) {
    // Grid/tick/domain group rendered OUTSIDE axis <g> (Vega rendering optimization)
    // Detect axis sub-type from the group's class
    semanticRole = 'axis'
    const subClasses = Array.from(axisSubGroup.classList || [])
    if (subClasses.some(c => c.includes('role-axis-grid'))) axisSubType = 'grid'
    else if (subClasses.some(c => c.includes('role-axis-tick'))) axisSubType = 'tick'
    else if (subClasses.some(c => c.includes('role-axis-domain'))) axisSubType = 'domain'
    else if (subClasses.some(c => c.includes('role-axis-label'))) axisSubType = 'label'
    else if (subClasses.some(c => c.includes('role-axis-title'))) axisSubType = 'title'
    // Detect axis channel from line orientation within the group
    axisChannel = detectAxisChannelFromLines(axisSubGroup)
  } else if (legendAncestor) {
    semanticRole = 'legend'
    const info = extractLegendInfo(spec, element)
    legendField = info.legendField
    legendValue = info.legendValue
  } else if (facetHeaderAncestor && tagName === 'text') {
    // Faceted column/row header = the faceting axis (column → x, row → y). Recognize it as
    // that axis so axis scope-expansion and editing apply (never the chart title).
    semanticRole = 'axis'
    axisChannel = facetHeaderInfo?.orient === 'row' ? 'y' : 'x'
    // Facet category values (Adelie/Chinstrap/…) are LABELS. Bias to 'label' so text/label
    // editing applies; the field-name header ("Species") is the only real 'title'.
    axisSubType = 'label'
  }

  // Detect legend sub-type (symbol, label, title)
  let legendSubType = null
  if (semanticRole === 'legend' && legendAncestor) {
    legendSubType = detectLegendSubType(element, legendAncestor)
  }

  // For grid/tick lines, override axisChannel based on the clicked line element's own orientation.
  // Grid lines are perpendicular to their axis: x-axis grids are vertical, y-axis grids are horizontal.
  // This is more reliable than detecting from the parent axis group's domain line.
  if (semanticRole === 'axis' && (axisSubType === 'grid' || axisSubType === 'tick') && tagName === 'line') {
    const lx1 = parseFloat(element.getAttribute('x1') || 0)
    const ly1 = parseFloat(element.getAttribute('y1') || 0)
    const lx2 = parseFloat(element.getAttribute('x2') || 0)
    const ly2 = parseFloat(element.getAttribute('y2') || 0)
    const ldx = Math.abs(lx2 - lx1)
    const ldy = Math.abs(ly2 - ly1)
    if (ldx !== 0 || ldy !== 0) {
      // Vertical line → x-axis grid/tick, Horizontal line → y-axis grid/tick
      const lineChannel = ldy > ldx ? 'x' : 'y'
      axisChannel = lineChannel
    }
  }

  // --- Check for chart title or subtitle (text with 'title' class, not inside axis) ---
  // Exclude faceted column/row headers — they contain 'title' classes but are NOT the chart title.
  if (allClasses.some(c => c.includes('title') && !c.includes('axis')) && !axisAncestor && !legendAncestor && !facetHeaderAncestor) {
    // Determine if this is the subtitle by checking position within the title group
    let isSubtitle = false
    const titleGroup = element.closest('g.mark-group.role-title') || element.closest('g[class*="title"]')
    if (titleGroup && tagName === 'text') {
      const textElements = titleGroup.querySelectorAll('text')
      if (textElements.length > 1) {
        // subtitle is the second (or later) text element in the title group
        const idx = Array.from(textElements).indexOf(element)
        if (idx > 0) isSubtitle = true
      }
    }

    if (isSubtitle) {
      const titleObj = typeof spec.title === 'object' ? spec.title : {}
      return {
        type: 'subtitle',
        elementPath: 'title',
        element,
        selector,
        semanticRole: 'text',
        properties: {
          text: typeof spec.title === 'string' ? spec.title : titleObj.text || '',
          fontSize: titleObj.fontSize || 14,
          fontWeight: titleObj.fontWeight || 'bold',
          color: titleObj.color || '#000000',
          anchor: titleObj.anchor || 'middle', // Vega-Lite default title anchor is centered
          subtitle: titleObj.subtitle || '',
          subtitleFontSize: titleObj.subtitleFontSize || 12,
          subtitleFontWeight: titleObj.subtitleFontWeight || 'normal',
          subtitleColor: titleObj.subtitleColor || '#888888',
        }
      }
    }

    {
      const titleObj = typeof spec.title === 'object' ? spec.title : {}
      return {
        type: 'title',
        elementPath: 'title',
        element,
        selector,
        semanticRole: 'text',
        properties: {
          text: typeof spec.title === 'string' ? spec.title : titleObj.text || '',
          fontSize: titleObj.fontSize || 14,
          fontWeight: titleObj.fontWeight || 'bold',
          color: titleObj.color || '#000000',
          anchor: titleObj.anchor || 'middle', // Vega-Lite default title anchor is centered
          subtitle: titleObj.subtitle || '',
          subtitleFontSize: titleObj.subtitleFontSize || 12,
          subtitleFontWeight: titleObj.subtitleFontWeight || 'normal',
          subtitleColor: titleObj.subtitleColor || '#888888',
        }
      }
    }
  }

  // --- <g> elements: axis group, legend group, mark group, or generic group ---
  if (tagName === 'g') {
    // Axis <g> group itself → show axis properties
    if (element.getAttribute('aria-roledescription') === 'axis') {
      const ch = detectAxisChannel(element)
      const encoding = spec.encoding?.[ch] || {}
      const axisSpec = encoding.axis || {}
      return {
        type: `axis-${ch}`,
        elementPath: `encoding.${ch}.axis`,
        element,
        selector,
        semanticRole: 'axis',
        axisChannel: ch,
        axisSubType: null,
        properties: {
          title: axisSpec.title || encoding.field || '',
          titleFontSize: axisSpec.titleFontSize || 11,
          titleColor: axisSpec.titleColor || '#000',
          labelFontSize: axisSpec.labelFontSize || 10,
          labelColor: axisSpec.labelColor || '#000',
          labelAngle: axisSpec.labelAngle || 0,
          domainColor: axisSpec.domainColor || '#888',
          domainWidth: axisSpec.domainWidth || 1,
          tickColor: axisSpec.tickColor || '#888',
          tickSize: axisSpec.tickSize || 5,
          grid: axisSpec.grid !== false
        }
      }
    }

    // Legend <g> group itself → show as legend with editable properties
    if (element.getAttribute('aria-roledescription') === 'legend') {
      const info = extractLegendInfo(spec, element)
      // Read legend properties from spec
      const legendProps = {}
      const enc = spec?.encoding || {}
      const layerEncs = (spec?.layer || []).map(l => l.encoding || {})
      const allEncs = [enc, ...layerEncs]
      // A legend exists for any FIELD-BOUND channel — even with no explicit `legend`
      // object yet (all-default legend). Bind `_channel` to that channel so edits can
      // create the legend config. (Previously we required a pre-existing legend object,
      // so a default legend couldn't be edited at all — every change silently no-op'd.)
      for (const e of allEncs) {
        for (const ch of ['color', 'fill', 'stroke', 'shape', 'size', 'opacity']) {
          const chEnc = e[ch]
          if (!chEnc?.field) continue          // no field → no legend on this channel
          if (chEnc.legend === null) continue   // legend explicitly hidden
          const leg = (chEnc.legend && typeof chEnc.legend === 'object') ? chEnc.legend : {}
          legendProps.orient = leg.orient || 'right'
          legendProps.direction = leg.direction || (leg.orient === 'top' || leg.orient === 'bottom' ? 'horizontal' : 'vertical')
          legendProps.title = leg.title ?? chEnc.field ?? ''
          legendProps.labelFontSize = leg.labelFontSize || 11
          legendProps.symbolSize = leg.symbolSize || 100
          legendProps.padding = leg.padding || 0
          legendProps.offset = leg.offset || 0
          legendProps.fillColor = leg.fillColor || ''
          legendProps.strokeColor = leg.strokeColor || ''
          legendProps._channel = ch
          break
        }
        if (legendProps._channel) break
      }
      return {
        type: 'legend',
        elementPath: 'legend',
        element,
        selector,
        semanticRole: 'legend',
        legendField: info.legendField,
        legendValue: info.legendValue,
        legendSubType: null,
        properties: legendProps
      }
    }

    // Mark <g> group
    const isMarkGroup = allClasses.some(c => c.includes('mark-rect') || c.includes('mark-bar') ||
                                              c.includes('mark-line') || c.includes('mark-point') ||
                                              c.includes('mark-circle') || c.includes('mark-area') ||
                                              c.includes('mark-arc') ||
                                              c.includes('role-mark') || c.includes('mark'))
    if (isMarkGroup) {
      const markSpec = typeof spec.mark === 'string' ? {} : spec.mark || {}
      const markType = typeof spec.mark === 'string' ? spec.mark : spec.mark?.type || 'bar'
      const markGroupInfo = getMarkGroup(element, svgElement)

      // Try to read actual color from the first child element in the group
      let computedFill = markSpec.fill || markSpec.color || '#4c78a8'
      let computedStroke = markSpec.stroke || ''
      const firstVisualChild = Array.from(element.querySelectorAll('rect, circle, path, line, ellipse'))[0]
      if (firstVisualChild) {
        const childFill = resolveColor(firstVisualChild, 'fill', null)
        if (childFill && childFill !== 'none') computedFill = childFill
        const childStroke = resolveColor(firstVisualChild, 'stroke', null)
        if (childStroke && childStroke !== 'none') computedStroke = childStroke
      }

      return {
        type: 'mark',
        elementPath: 'mark',
        markType,
        element,
        selector,
        semanticRole: 'data-mark',
        markGroup: markGroupInfo?.markGroup || null,
        groupSelector: markGroupInfo?.groupSelector || null,
        properties: {
          fill: computedFill,
          stroke: computedStroke,
          strokeWidth: markSpec.strokeWidth || 0,
          opacity: markSpec.opacity || 1,
          cornerRadius: markSpec.cornerRadius || 0
        }
      }
    }

    // Generic <g> group (including sub-groups inside axis/legend) → show group with position
    return {
      type: 'group',
      elementPath: 'group',
      element,
      selector,
      semanticRole,
      axisChannel,
      axisSubType,
      legendField,
      legendValue,
      legendSubType,
      properties: {}
    }
  }

  // --- Individual visual elements: always show their own visual properties ---
  // semanticRole tracks context (axis/legend/data-mark) for modification scope

  // Check if inside a data mark group
  const isMarkElement = allClasses.some(c => c.includes('mark-rect') || c.includes('mark-bar') ||
                                              c.includes('mark-line') || c.includes('mark-point') ||
                                              c.includes('mark-circle') || c.includes('mark-area') ||
                                              c.includes('mark-arc') ||
                                              c.includes('role-mark') || c.includes('mark'))

  if (isMarkElement && semanticRole === 'other') {
    semanticRole = 'data-mark'
  }

  // Text element → always show text properties
  if (tagName === 'text') {
    return {
      type: 'text',
      elementPath: 'text',
      element,
      selector,
      semanticRole,
      axisChannel,
      axisSubType,
      legendField,
      legendValue,
      legendSubType,
      properties: buildVisualProperties(element)
    }
  }

  // Line element → always show line properties
  if (tagName === 'line') {
    const lineMarkGroup = isMarkElement ? (getMarkGroup(element, svgElement)?.markGroup || null) : null
    const lineComposite = detectCompositeInfo(spec, lineMarkGroup, element)
    return {
      type: 'line',
      elementPath: 'line',
      element,
      selector,
      semanticRole,
      axisChannel,
      axisSubType,
      legendField,
      legendValue,
      legendSubType,
      markGroup: lineMarkGroup,
      groupSelector: isMarkElement ? (getMarkGroup(element, svgElement)?.groupSelector || null) : null,
      compositeMarkType: lineComposite.compositeMarkType,
      compositeSubPart: lineComposite.compositeSubPart,
      properties: buildVisualProperties(element)
    }
  }

  // Rect, circle, path, ellipse, polygon, polyline
  const visualTags = ['rect', 'circle', 'ellipse', 'path', 'polyline', 'polygon']
  if (visualTags.includes(tagName)) {
    const markGroupInfo = isMarkElement ? getMarkGroup(element, svgElement) : null
    const composite = detectCompositeInfo(spec, markGroupInfo?.markGroup, element)
    const _w = parseFloat(element.getAttribute('width') || 0)
    const _h = parseFloat(element.getAttribute('height') || 0)
    // Detect marks rendered as <path> by Vega (symbol→point, rect/bar→rect)
    let resolvedType = tagName
    if (tagName === 'path' && markGroupInfo?.markGroup) {
      if (markGroupInfo.markGroup === 'mark-symbol') resolvedType = 'point'
      else if (markGroupInfo.markGroup === 'mark-rect' || markGroupInfo.markGroup === 'mark-bar') resolvedType = 'rect'
    }
    const props = buildVisualProperties(element)
    // Estimate point size from SVG path bounding box (Vega-Lite size = area in px²)
    if (resolvedType === 'point') {
      try {
        const bbox = element.getBBox()
        props.size = Math.round(bbox.width * bbox.height) || 60
      } catch { props.size = 60 }
    }
    return {
      type: resolvedType,
      elementPath: tagName,
      element,
      selector,
      semanticRole,
      axisChannel,
      axisSubType,
      legendField,
      legendValue,
      legendSubType,
      markGroup: markGroupInfo?.markGroup || null,
      groupSelector: markGroupInfo?.groupSelector || null,
      compositeMarkType: composite.compositeMarkType,
      compositeSubPart: composite.compositeSubPart,
      properties: props
    }
  }

  // Default - chart size. Faceted spec keeps the real per-cell size in `spec.spec`.
  const sizeHost = (spec?.facet && spec?.spec) ? spec.spec : spec
  return {
    type: 'chart-size',
    elementPath: 'root',
    element: null,
    selector: null,
    semanticRole: 'other',
    properties: {
      width: sizeHost.width || 400,
      height: sizeHost.height || 250
    }
  }
}

/**
 * Given a selected SVG element, determine which Vega-Lite layer index it belongs to.
 * Walk up the DOM from the selected element to find an ancestor <g> whose parent
 * contains multiple sibling <g> groups with mark-* descendants (one per layer).
 * The index among those siblings is the layer index.
 *
 * @param {SVGElement} element - The selected SVG element
 * @param {SVGElement} svgRoot - The root <svg> of the Vega chart
 * @returns {number|null} - The layer index (0-based), or null if undetermined
 */
export function getLayerIndex(element, svgRoot) {
  if (!element || !svgRoot) return null

  // Vega generates group class names like:
  //   Simple:  "layer_0_marks", "layer_1_marks"
  //   Nested:  "layer_0_layer_0_marks"
  //   Faceted: "child_layer_0_marks" (a facet wraps the unit spec in a "child")
  // We need to extract the FIRST layer index from all patterns. Anchor on start OR an
  // underscore so the "child_" facet prefix (word chars, no \b boundary) still matches.
  const layerPattern = /(?:^|_)layer_(\d+)[\w]*_marks\b/

  // Strategy 1: Walk up from element, look for ancestor <g> with Vega's layer class pattern
  let el = element
  const ancestorClasses = []
  while (el && el !== svgRoot) {
    const cls = el.className?.baseVal || ''
    if (cls) ancestorClasses.push(cls)
    const layerMatch = cls.match(layerPattern)
    if (layerMatch) {
      const idx = parseInt(layerMatch[1], 10)
      return idx
    }
    el = el.parentElement
  }

  // Strategy 2 (fallback): Count sibling <g> groups that have layer class
  el = element
  while (el && el !== svgRoot) {
    const parent = el.parentElement
    if (!parent || parent === svgRoot) break

    if (el.tagName === 'g' && parent.tagName === 'g') {
      const gChildren = Array.from(parent.children).filter(c => c.tagName === 'g')
      const layerGroups = gChildren.filter(g => {
        const gCls = g.className?.baseVal || ''
        return layerPattern.test(gCls)
      })
      if (layerGroups.length > 1 && layerGroups.includes(el)) {
        const idx = layerGroups.indexOf(el)
        return idx
      }
    }

    el = parent
  }
  return null
}

/**
 * Extract datum from a Vega scenegraph element's __data__ property.
 */
export function extractDatum(element) {
  const vegaItem = element?.__data__
  let datum = vegaItem?.datum || null
  if (datum && typeof datum === 'object' && datum.datum && !datum._id) {
    datum = datum.datum
  }
  return datum
}
