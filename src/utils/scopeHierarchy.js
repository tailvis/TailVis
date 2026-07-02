/**
 * Scope Hierarchy Generator.
 * Given selected SVG elements on a Vega chart, generates an ordered array of
 * scope candidates from narrowest to broadest, for Tab-cycling.
 */

import { detectElementType, extractDatum } from './elementUtils'
import { evaluateTestExpression, formatTestLabel } from './scopeUtils'

// ─── Helpers ─────────────────────────────────────────────

/**
 * Get all categorical encoding fields from a Vega-Lite spec.
 * Returns [{ channel, field, type }]
 */
function getCategoricalFields(spec) {
  const fields = []
  const add = (channel, enc) => {
    if (enc?.field && ['nominal', 'ordinal'].includes(enc.type) && !fields.find(f => f.field === enc.field)) {
      fields.push({ channel, field: enc.field, type: enc.type })
    }
  }
  // Faceted spec ({facet, spec}): the facet column/row field (e.g. Species) defines
  // the columns — surface it first so "All Species=X" (this facet) precedes "All points".
  if (spec?.facet) {
    for (const ch of ['column', 'row']) add(ch, spec.facet[ch])
    if (spec.facet.field) add('facet', spec.facet)
  }
  const inner = (spec?.facet && spec?.spec) ? spec.spec : spec
  const encoding = inner?.encoding || {}
  for (const [channel, enc] of Object.entries(encoding)) add(channel, enc)
  if (inner?.layer) {
    for (const layer of inner.layer) {
      for (const [channel, enc] of Object.entries(layer.encoding || {})) add(channel, enc)
    }
  }
  return fields
}

/**
 * Resolve which encoding field an axis channel encodes.
 * Returns { field, type } or null.
 */
function getAxisEncodingField(spec, axisChannel) {
  const enc = spec?.encoding?.[axisChannel]
  if (enc?.field) return { field: enc.field, type: enc.type }
  // Check layers
  if (spec?.layer) {
    for (const layer of spec.layer) {
      const lEnc = layer.encoding?.[axisChannel]
      if (lEnc?.field) return { field: lEnc.field, type: lEnc.type }
    }
  }
  return null
}

/**
 * Resolve which encoding field a legend encodes (color/fill/stroke/shape/size).
 */
function getLegendEncodingField(spec) {
  const encoding = spec?.encoding || {}
  for (const ch of ['color', 'fill', 'stroke', 'shape', 'size']) {
    if (encoding[ch]?.field) return { channel: ch, field: encoding[ch].field }
  }
  if (spec?.layer) {
    for (const layer of spec.layer) {
      for (const ch of ['color', 'fill', 'stroke', 'shape', 'size']) {
        if (layer.encoding?.[ch]?.field) return { channel: ch, field: layer.encoding[ch].field }
      }
    }
  }
  return null
}

/**
 * Find all SVG data mark elements in the chart.
 */
function findAllDataMarks(svgRoot, spec) {
  const tags = ['rect', 'circle', 'ellipse', 'line', 'path', 'polyline', 'polygon']
  const results = []
  const all = svgRoot.querySelectorAll(tags.join(','))
  for (const el of all) {
    const cls = (typeof el.className === 'string' ? el.className : el.className?.baseVal) || ''
    if (cls === 'background' || cls === 'foreground') continue
    // Skip large background rects
    if (el.tagName.toLowerCase() === 'rect') {
      const w = parseFloat(el.getAttribute('width') || 0)
      const h = parseFloat(el.getAttribute('height') || 0)
      if (w > 350 && h > 200) continue
    }
    const info = detectElementType(el, spec, svgRoot)
    if (info?.semanticRole === 'data-mark') {
      const datum = extractDatum(el)
      results.push({ element: el, elementInfo: info, datum })
    }
    // Safety cap. Must exceed typical row counts (e.g. 342-row penguins) or the last
    // facet's marks get dropped — "All Marks" would then miss whole facet columns.
    if (results.length >= 5000) break
  }
  return results
}

/**
 * Find all elements within an axis group.
 */
function findAxisElements(svgRoot, axisChannel, subType) {
  const results = []

  // Helper: detect axis channel from lines in a group
  function detectChannelFromLines(group) {
    const lines = group.querySelectorAll('line')
    if (lines.length === 0) return null
    let vCount = 0, hCount = 0
    const n = Math.min(lines.length, 5)
    for (let i = 0; i < n; i++) {
      const dx = Math.abs(parseFloat(lines[i].getAttribute('x2') || 0) - parseFloat(lines[i].getAttribute('x1') || 0))
      const dy = Math.abs(parseFloat(lines[i].getAttribute('y2') || 0) - parseFloat(lines[i].getAttribute('y1') || 0))
      if (dy > dx) vCount++; else hCount++
    }
    return vCount > hCount ? 'x' : 'y'
  }

  // 1. Search inside axis <g> groups (standard Vega structure)
  const axisGroups = svgRoot.querySelectorAll('[aria-roledescription="axis"]')
  for (const axisG of axisGroups) {
    if (axisChannel) {
      const domainGroup = axisG.querySelector('.role-axis-domain')
      const domainLine = domainGroup?.querySelector('line')
      if (domainLine) {
        const x1 = parseFloat(domainLine.getAttribute('x1') || 0)
        const y1 = parseFloat(domainLine.getAttribute('y1') || 0)
        const x2 = parseFloat(domainLine.getAttribute('x2') || 0)
        const y2 = parseFloat(domainLine.getAttribute('y2') || 0)
        const ch = Math.abs(x2 - x1) >= Math.abs(y2 - y1) ? 'x' : 'y'
        if (ch !== axisChannel) continue
      }
    }
    if (subType) {
      const classMap = { label: 'role-axis-label', tick: 'role-axis-tick', grid: 'role-axis-grid', domain: 'role-axis-domain', title: 'role-axis-title' }
      const className = classMap[subType]
      if (className) {
        const group = axisG.querySelector(`.${className}`)
        if (group) {
          const children = group.querySelectorAll('text, line, path, rect')
          for (const child of children) results.push(child)
        }
      }
    } else {
      const children = axisG.querySelectorAll('text, line, path, rect')
      for (const child of children) results.push(child)
    }
  }

  // 2. Search for axis sub-groups rendered OUTSIDE axis <g> (Vega rendering optimization)
  if (subType) {
    const classMap = { label: 'role-axis-label', tick: 'role-axis-tick', grid: 'role-axis-grid', domain: 'role-axis-domain', title: 'role-axis-title' }
    const className = classMap[subType]
    if (className) {
      const allSubGroups = svgRoot.querySelectorAll(`.${className}`)
      for (const group of allSubGroups) {
        // Skip groups already inside an axis <g> (handled above)
        if (group.closest('[aria-roledescription="axis"]')) continue
        // Filter by axis channel using line orientation
        if (axisChannel) {
          const ch = detectChannelFromLines(group)
          if (ch && ch !== axisChannel) continue
        }
        const children = group.querySelectorAll('text, line, path, rect')
        for (const child of children) {
          if (!results.includes(child)) results.push(child)
        }
      }
    }
  }

  return results
}

/**
 * Find all elements within legend groups.
 */
function findLegendElements(svgRoot, subType) {
  const results = []
  const legendGroups = svgRoot.querySelectorAll('[aria-roledescription="legend"]')
  for (const legendG of legendGroups) {
    if (subType === 'symbol') {
      // Get non-text visual elements (the colored symbols)
      const children = legendG.querySelectorAll('rect, circle, path, ellipse, polygon')
      for (const child of children) {
        const cls = child.className?.baseVal || ''
        if (cls === 'background' || cls === 'foreground') continue
        const w = parseFloat(child.getAttribute('width') || 0)
        const h = parseFloat(child.getAttribute('height') || 0)
        if (w > 100 && h > 50) continue // skip large background rects
        results.push(child)
      }
    } else if (subType === 'label') {
      // Get text elements that are labels (not title)
      // Use Vega role classes to distinguish: role-legend-label vs role-legend-title
      const textEls = legendG.querySelectorAll('text')
      for (const t of textEls) {
        // Walk up to check for Vega role classes
        let isTitle = false
        let cur = t
        for (let i = 0; i < 6 && cur && cur !== legendG; i++) {
          const classes = cur.classList ? Array.from(cur.classList) : []
          if (classes.some(c => c.includes('role-legend-title'))) { isTitle = true; break }
          if (classes.some(c => c.includes('role-legend-label'))) break // confirmed label
          cur = cur.parentElement
        }
        if (isTitle) continue
        // Fallback: if parent is the legend group directly, likely title
        if (t.parentElement === legendG) continue
        if (t.parentElement?.parentElement === legendG) {
          const siblings = Array.from(t.parentElement.children)
          if (siblings.every(s => s.tagName?.toLowerCase() === 'text') && siblings.length === 1) continue
        }
        results.push(t)
      }
    } else {
      // All legend elements
      const children = legendG.querySelectorAll('text, rect, circle, path, ellipse, polygon, line')
      for (const child of children) {
        const cls = child.className?.baseVal || ''
        if (cls === 'background' || cls === 'foreground') continue
        results.push(child)
      }
    }
  }
  return results
}

/**
 * Reverse-map axis label text to data field value.
 * Handles temporal formatting differences.
 */
function reverseMapAxisValue(labelText, field, spec, data) {
  if (!labelText || !field) return labelText
  // If we have data, try to find matching value
  if (data && Array.isArray(data)) {
    // Direct match first
    const directMatch = data.find(row => String(row[field]) === labelText)
    if (directMatch) return directMatch[field]
    // Partial match for temporal (label might be abbreviated)
    const partialMatch = data.find(row => {
      const val = String(row[field])
      return val.startsWith(labelText) || labelText.startsWith(val)
    })
    if (partialMatch) return partialMatch[field]
  }
  return labelText
}

// ─── Semantic role classification ────────────────────────

/**
 * Classify element into semantic role for hierarchy generation.
 */
function classifyElement(elementInfo) {
  const { semanticRole, axisSubType } = elementInfo
  if (semanticRole === 'data-mark') return 'data-mark'
  if (semanticRole === 'axis') {
    if (axisSubType === 'label') return 'axis-label'
    if (axisSubType === 'title') return 'axis-title'
    if (axisSubType === 'tick') return 'axis-tick'
    if (axisSubType === 'domain') return 'axis-domain'
    if (axisSubType === 'grid') return 'grid-line'
    return 'axis-other'
  }
  if (semanticRole === 'legend') {
    // Determine if symbol or label based on element tag
    const tag = elementInfo.element?.tagName?.toLowerCase()
    if (tag === 'text') return 'legend-label'
    if (['rect', 'circle', 'path', 'ellipse', 'polygon'].includes(tag)) return 'legend-symbol'
    return 'legend-other'
  }
  if (semanticRole === 'text') return 'text'
  return 'other'
}

// ─── Hierarchy generators per element type ──────────────


/**
 * Cache for getMarkGroup DOM traversal results.
 */
const markGroupCache = new WeakMap()

/**
 * Find the Vega mark group <g> that this data mark element belongs to.
 * Vega renders each mark type into a separate <g> group.
 * The line <path> and point <path>s live in different mark groups
 * even though they share the same SVG tag name.
 */
function getMarkGroup(element) {
  if (markGroupCache.has(element)) return markGroupCache.get(element)
  let parent = element.parentElement
  while (parent && parent.tagName?.toLowerCase() !== "svg") {
    if (parent.tagName?.toLowerCase() === "g") {
      const role = parent.getAttribute("role") || parent.getAttribute("aria-roledescription") || ""
      const cls = (typeof parent.className === 'string' ? parent.className : parent.className?.baseVal) || ""
      // Vega mark group indicators: class like "mark-point", "mark-line", etc.
      if (role.includes("mark") || cls.includes("mark-") || cls.includes("role-mark")) {
        markGroupCache.set(element, parent)
        return parent
      }
      // Fallback: count direct shape children
      const shapes = Array.from(parent.children).filter(c => {
        const tag = c.tagName?.toLowerCase()
        return ["rect", "circle", "ellipse", "line", "path", "polygon", "polyline"].includes(tag)
      })
      if (shapes.length >= 2) {
        markGroupCache.set(element, parent)
        return parent
      }
    }
    parent = parent.parentElement
  }
  markGroupCache.set(element, null)
  return null
}

/**
 * Infer a human-readable label for the mark group containing this element.
 */
function inferMarkGroupLabel(element, markGroup, siblings) {
  const cls = (typeof markGroup?.className === 'string' ? markGroup.className : markGroup?.className?.baseVal) || ""
  if (cls.includes("mark-point") || cls.includes("symbol")) return "point"
  if (cls.includes("mark-line")) return "line"
  if (cls.includes("mark-bar") || cls.includes("mark-rect")) return "bar"
  if (cls.includes("mark-area")) return "area"
  if (cls.includes("mark-circle")) return "point"

  // Heuristic: many siblings of same tag => likely point symbols
  if (siblings.length > 3) {
    const tag = element.tagName?.toLowerCase()
    if (tag === "circle") return "point"
    if (tag === "rect") return "bar"
    return "point"
  }
  if (siblings.length === 1) return "line"

  const typeLabels = { circle: "point", rect: "bar", path: "mark" }
  return typeLabels[element.tagName?.toLowerCase()] || "mark"
}

/**
 * Build scope levels based on conditional encodings (color/fill conditions).
 * Returns the scope matching the clicked datum's condition.
 */
function buildConditionScopes(spec, datum, allMarks, svgRoot) {
  if (!datum || allMarks.length <= 1) return []

  const scopes = []
  const checkedChannels = new Set()

  const encodingSources = []
  if (spec?.encoding) encodingSources.push(spec.encoding)
  if (spec?.layer) {
    for (const layer of spec.layer) {
      if (layer.encoding) encodingSources.push(layer.encoding)
    }
  }

  for (const encoding of encodingSources) {
    for (const channel of ['color', 'fill']) {
      if (checkedChannels.has(channel)) continue
      const enc = encoding[channel]
      if (!enc?.condition) continue
      checkedChannels.add(channel)

      const conditions = Array.isArray(enc.condition) ? enc.condition : [enc.condition]
      const predicates = conditions.filter(c => c.test != null)
      if (predicates.length === 0) continue

      let matchedConditionIndex = -1
      for (let i = 0; i < predicates.length; i++) {
        if (evaluateTestExpression(predicates[i].test, datum) === true) {
          matchedConditionIndex = i
          break
        }
      }

      if (matchedConditionIndex >= 0) {
        const cond = predicates[matchedConditionIndex]
        const matchingElements = allMarks.filter(m =>
          m.datum && evaluateTestExpression(cond.test, m.datum) === true
        )
        if (matchingElements.length > 1 && matchingElements.length < allMarks.length) {
          const readableLabel = formatTestLabel(cond.test)
          scopes.push({
            label: `Condition: ${readableLabel}`,
            labelEn: `Condition: ${readableLabel}`,
            elements: matchingElements.map(m => m.element),
            scopeType: 'condition-match',
            scopeData: { channel, conditionIndex: matchedConditionIndex, test: cond.test }
          })
        }
      } else {
        const defaultElements = allMarks.filter(m => {
          if (!m.datum) return false
          return predicates.every(c => evaluateTestExpression(c.test, m.datum) !== true)
        })
        if (defaultElements.length > 1 && defaultElements.length < allMarks.length) {
          scopes.push({
            label: 'Condition: Default',
            labelEn: 'Condition: default',
            elements: defaultElements.map(m => m.element),
            scopeType: 'condition-default',
            scopeData: { channel }
          })
        }
      }
    }
  }

  return scopes
}

// Human-readable singular noun for each composite sub-part.
const SUBPART_NOUN = {
  box: 'box', median: 'median line', rule: 'whisker',
  outliers: 'outlier', ticks: 'end cap',
  band: 'band', borders: 'border line',
}

/**
 * Collect all sibling composite sub-parts of the same kind (e.g. every median
 * line across all boxplots / facets). Vega renders each sub-part into its own
 * mark group class (median → mark-tick, whisker → mark-rule, box → mark-rect),
 * so we match the clicked element's group class across the whole SVG.
 */
function findCompositeSubPartSiblings(element, svgRoot) {
  const group = getMarkGroup(element)
  const cls = (typeof group?.className === 'string' ? group.className : group?.className?.baseVal) || ''
  const m = cls.match(/mark-(\w+)/)
  if (!m) return [element]
  const key = m[1] // e.g. "tick", "rule", "rect"
  const shapeTags = new Set(['rect', 'circle', 'ellipse', 'line', 'path', 'polygon', 'polyline'])
  // Axis gridlines/ticks are ALSO rendered as mark-rule/mark-tick groups, so a naive
  // class match would sweep them in. Skip any group that lives inside an axis/legend.
  const isChrome = (g) => {
    const gcls = (typeof g.className === 'string' ? g.className : g.className?.baseVal) || ''
    if (/role-(axis|legend|grid|title)/.test(gcls)) return true
    let p = g.parentElement
    while (p && p.tagName?.toLowerCase() !== 'svg') {
      const role = p.getAttribute?.('role') || p.getAttribute?.('aria-roledescription') || ''
      const pcls = (typeof p.className === 'string' ? p.className : p.className?.baseVal) || ''
      if (/axis|legend/.test(role) || /role-(axis|legend)/.test(pcls)) return true
      p = p.parentElement
    }
    return false
  }
  const result = []
  svgRoot.querySelectorAll(`g[class*="mark-${key}"]`).forEach(g => {
    if (isChrome(g)) return
    Array.from(g.children).forEach(c => {
      if (shapeTags.has(c.tagName?.toLowerCase())) result.push(c)
    })
  })
  return result.length ? result : [element]
}

function buildDataMarkHierarchy(elementInfo, datum, spec, svgRoot) {
  const hierarchy = []
  const element = elementInfo.element
  // Composite sub-part (boxplot median/whisker/box, errorbar caps, …): keep the
  // sub-part semantics — a median line labeled "This median line" / "All median
  // lines" — while still offering the field groups (e.g. "By Island") below.
  const subPart = elementInfo.compositeSubPart
  const compositeMarkType = elementInfo.compositeMarkType
  const subPartNoun = subPart ? (SUBPART_NOUN[subPart] || subPart) : null

  // Level 0: This specific mark
  const datumLabel = datum
    ? Object.entries(datum)
        .filter(([k, v]) => !k.startsWith('_') && v != null && (typeof v === 'string' || typeof v === 'number'))
        .filter(([k]) => !/^bin_/.test(k) && !k.endsWith('_end'))
        .filter(([, v]) => !(typeof v === 'number' && Math.abs(v) > 1e9))
        .map(([k, v]) => `${k}=${v}`)
        .slice(0, 2)
        .join(', ')
    : ''
  hierarchy.push({
    level: 0,
    label: subPartNoun ? `This ${subPartNoun}` : (datumLabel ? `This Mark (${datumLabel})` : 'This Mark'),
    labelEn: subPartNoun ? `This ${subPartNoun}` : (datumLabel ? `This mark (${datumLabel})` : 'This mark'),
    elements: [element],
    scopeType: 'individual',
    scopeData: { selector: elementInfo.selector, datum, compositeMarkType, compositeSubPart: subPart }
  })

  // Compute allMarks once (used by condition scopes, field groups, and later levels)
  const allMarks = findAllDataMarks(svgRoot, spec)

  // Condition-based scope levels: group marks by which encoding condition they match
  const conditionScopes = buildConditionScopes(spec, datum, allMarks, svgRoot)
  for (const condScope of conditionScopes) {
    hierarchy.push({
      level: hierarchy.length,
      ...condScope
    })
  }

  // Levels: categorical field groups (skip fields already covered by condition scopes)
  const conditionFields = new Set(
    conditionScopes.map(cs => {
      // Extract field name from test expression like "datum['Species'] === 'Adelie'" or "datum.Species === 'Adelie'"
      const m = cs.scopeData?.test?.match(/datum(?:\['([^']+)'\]|\.(\w+))/)
      return m ? (m[1] || m[2]) : null
    }).filter(Boolean)
  )
  const catFields = getCategoricalFields(spec)
  if (datum) {
    for (const { field } of catFields) {
      if (conditionFields.has(field)) continue // already covered by condition scope
      const value = datum[field]
      if (value == null) continue
      const matching = allMarks.filter(m => m.datum && m.datum[field] === value)
      if (matching.length <= 1) continue // skip if only this element matches
      hierarchy.push({
        level: hierarchy.length,
        label: `All ${field}=${value}`,
        labelEn: `All ${field}=${value}`,
        elements: matching.map(m => m.element),
        scopeType: 'field-value',
        scopeData: { field, value }
      })
    }
  }

  // Same mark type level - use mark-group-based filtering to distinguish
  // point <path>s from line <path>s even when they share the same SVG tag name.
  // Compare by the mark-type CLASS (e.g. "mark-symbol"), NOT the group element:
  // a faceted chart renders one group per facet column, so element identity would
  // limit "all points" to the clicked facet only.
  const markGroup = getMarkGroup(element)
  const markGroupTypeKey = (groupEl) => {
    if (!groupEl) return null
    const cls = (typeof groupEl.className === 'string' ? groupEl.className : groupEl.className?.baseVal) || ''
    const m = cls.match(/mark-(\w+)/)
    return m ? m[1] : null
  }
  // Composite sub-part: offer "All median lines" / "All whiskers" etc. (config-based),
  // NOT a mislabeled "All points". Sub-parts share one mark group per kind.
  if (subPart) {
    const siblings = findCompositeSubPartSiblings(element, svgRoot)
    if (siblings.length > 1) {
      hierarchy.push({
        level: hierarchy.length,
        label: `All ${subPartNoun}s`,
        labelEn: `All ${subPartNoun}s`,
        elements: siblings,
        scopeType: 'composite-sub-all',
        scopeData: { compositeMarkType, compositeSubPart: subPart }
      })
    }
  } else {
    const markKey = markGroupTypeKey(markGroup)
    if (markKey && allMarks.length > 1) {
      const siblingsInGroup = allMarks.filter(m => markGroupTypeKey(getMarkGroup(m.element)) === markKey)
      if (siblingsInGroup.length > 1 && siblingsInGroup.length < allMarks.length) {
        const typeName = inferMarkGroupLabel(element, markGroup, siblingsInGroup)
        hierarchy.push({
          level: hierarchy.length,
          label: `All ${typeName}s`,
          labelEn: `All ${typeName}s`,
          elements: siblingsInGroup.map(m => m.element),
          scopeType: 'same-mark-type',
          scopeData: { markType: typeName }
        })
      }
    }
  }

  // FALLBACK: if mark group detection fails, try tag-based (original logic)
  if (!subPart && !markGroup && allMarks.length > 1) {
    const selectedTag = element.tagName?.toLowerCase()
    const sameType = allMarks.filter(m => m.element.tagName?.toLowerCase() === selectedTag)
    if (sameType.length > 1 && sameType.length < allMarks.length) {
      const typeLabels = { circle: 'point', rect: 'bar', path: 'line', line: 'line' }
      const typeName = typeLabels[selectedTag] || selectedTag
      hierarchy.push({
        level: hierarchy.length,
        label: `All ${typeName}s`,
        labelEn: `All ${typeName}s`,
        elements: sameType.map(m => m.element),
        scopeType: 'same-mark-type',
        scopeData: { markType: selectedTag }
      })
    }
  }

  // Last level: All marks
  if (allMarks.length > 1) {
    hierarchy.push({
      level: hierarchy.length,
      label: 'All Marks',
      labelEn: 'All marks',
      elements: allMarks.map(m => m.element),
      scopeType: 'all-marks',
      scopeData: {}
    })
  }

  return hierarchy
}

function buildAxisLabelHierarchy(elementInfo, spec, svgRoot) {
  const hierarchy = []
  const element = elementInfo.element
  const channel = elementInfo.axisChannel
  const labelText = element?.textContent?.trim() || ''

  // Level 0: This label only
  hierarchy.push({
    level: 0,
    label: labelText ? `"${labelText}" Label` : 'This Label',
    labelEn: labelText ? `"${labelText}" label` : 'This label',
    elements: [element],
    scopeType: 'individual',
    scopeData: { selector: elementInfo.selector }
  })

  // Level 1: Data marks matching this axis value (include original element)
  const fieldInfo = getAxisEncodingField(spec, channel)
  if (fieldInfo && labelText) {
    const data = spec?.data?.values
    const mappedValue = reverseMapAxisValue(labelText, fieldInfo.field, spec, data)
    const allMarks = findAllDataMarks(svgRoot, spec)
    const matching = allMarks.filter(m => {
      if (!m.datum) return false
      const val = m.datum[fieldInfo.field]
      return String(val) === String(mappedValue) || String(val) === labelText
    })
    if (matching.length > 0) {
      hierarchy.push({
        level: hierarchy.length,
        label: `${fieldInfo.field}=${mappedValue} Data`,
        labelEn: `${fieldInfo.field}=${mappedValue} data marks`,
        elements: [element, ...matching.map(m => m.element)],
        scopeType: 'field-value',
        scopeData: { field: fieldInfo.field, value: mappedValue }
      })
    }
  }

  // Level 2: All labels on this axis (include original element)
  const axisLabels = findAxisElements(svgRoot, channel, 'label')
  if (axisLabels.length > 1) {
    const chLabel = channel === 'x' ? 'X' : 'Y'
    const labelSet = new Set(axisLabels)
    const elements = labelSet.has(element) ? axisLabels : [element, ...axisLabels]
    hierarchy.push({
      level: hierarchy.length,
      label: `All ${chLabel}-Axis Labels`,
      labelEn: `All ${chLabel}-axis labels`,
      elements,
      scopeType: 'axis-labels',
      scopeData: { axis: channel }
    })
  }

  // Level 3: Entire axis (include original element)
  const allAxisEls = findAxisElements(svgRoot, channel, null)
  if (allAxisEls.length > 0) {
    const chLabel = channel === 'x' ? 'X' : 'Y'
    const axisSet = new Set(allAxisEls)
    const elements = axisSet.has(element) ? allAxisEls : [element, ...allAxisEls]
    hierarchy.push({
      level: hierarchy.length,
      label: `Entire ${chLabel}-Axis`,
      labelEn: `Entire ${chLabel}-axis`,
      elements,
      scopeType: 'entire-axis',
      scopeData: { axis: channel }
    })
  }

  return hierarchy
}

function buildAxisTitleHierarchy(elementInfo, spec, svgRoot) {
  const hierarchy = []
  const element = elementInfo.element
  const titleText = element?.textContent?.trim() || ''

  // Level 0: This title only
  hierarchy.push({
    level: 0,
    label: titleText ? `"${titleText}" Title` : 'This Axis Title',
    labelEn: titleText ? `"${titleText}" title` : 'This axis title',
    elements: [element],
    scopeType: 'individual',
    scopeData: { selector: elementInfo.selector }
  })

  // Level 1: All axis titles (include original element)
  const allTitles = [
    ...findAxisElements(svgRoot, 'x', 'title'),
    ...findAxisElements(svgRoot, 'y', 'title')
  ]
  if (allTitles.length > 1) {
    const titleSet = new Set(allTitles)
    const elements = titleSet.has(element) ? allTitles : [element, ...allTitles]
    hierarchy.push({
      level: hierarchy.length,
      label: 'All Axis Titles',
      labelEn: 'All axis titles',
      elements,
      scopeType: 'all-axis-titles',
      scopeData: {}
    })
  }

  return hierarchy
}

function buildAxisTickHierarchy(elementInfo, spec, svgRoot) {
  const hierarchy = []
  const element = elementInfo.element
  const channel = elementInfo.axisChannel
  const subType = elementInfo.axisSubType // 'tick', 'domain', or 'grid'

  // Level 0: This element
  const subLabels = { tick: 'Tick', domain: 'Axis Line', grid: 'Gridline' }
  const subLabelsEn = { tick: 'tick', domain: 'domain line', grid: 'grid line' }
  hierarchy.push({
    level: 0,
    label: `This ${subLabels[subType] || 'Element'}`,
    labelEn: `This ${subLabelsEn[subType] || 'element'}`,
    elements: [element],
    scopeType: 'individual',
    scopeData: { selector: elementInfo.selector }
  })

  // Level 1: All same sub-type on this axis (e.g., all Y-axis grid lines)
  if (channel && subType) {
    const sameSubType = findAxisElements(svgRoot, channel, subType)
    if (sameSubType.length > 1) {
      const chLabel = channel === 'x' ? 'X' : 'Y'
      const subSet = new Set(sameSubType)
      const elements = subSet.has(element) ? sameSubType : [element, ...sameSubType]
      hierarchy.push({
        level: hierarchy.length,
        label: `All ${chLabel}-Axis ${subLabels[subType] || subType}s`,
        labelEn: `All ${chLabel}-axis ${subLabelsEn[subType] || subType}s`,
        elements,
        scopeType: `axis-${subType}`,
        scopeData: { axis: channel, subType }
      })
    }
  }

  // Level 2: All same sub-type across all axes (e.g., all grid lines)
  if (subType) {
    const allSubType = [
      ...findAxisElements(svgRoot, 'x', subType),
      ...findAxisElements(svgRoot, 'y', subType)
    ]
    const seen = new Set()
    const deduped = allSubType.filter(el => {
      if (seen.has(el)) return false
      seen.add(el)
      return true
    })
    if (deduped.length > 1 && (hierarchy.length < 2 || deduped.length > hierarchy[hierarchy.length - 1].elements.length)) {
      const subSet = new Set(deduped)
      const elements = subSet.has(element) ? deduped : [element, ...deduped]
      hierarchy.push({
        level: hierarchy.length,
        label: `All ${subLabels[subType] || subType}s`,
        labelEn: `All ${subLabelsEn[subType] || subType}s`,
        elements,
        scopeType: `all-${subType}`,
        scopeData: { subType }
      })
    }
  }

  return hierarchy
}

function buildLegendSymbolHierarchy(elementInfo, spec, svgRoot) {
  const hierarchy = []
  const element = elementInfo.element

  // Level 0: This symbol only
  const legendInfo = getLegendEncodingField(spec)
  const legendValue = elementInfo.legendValue
  const symbolLabel = legendValue ? `"${legendValue}" Symbol` : 'This Symbol'

  hierarchy.push({
    level: 0,
    label: symbolLabel,
    labelEn: legendValue ? `"${legendValue}" symbol` : 'This symbol',
    elements: [element],
    scopeType: 'individual',
    scopeData: { selector: elementInfo.selector, legendValue }
  })

  // Level 1: Data marks matching this legend value (include original element)
  if (legendInfo && legendValue != null) {
    const allMarks = findAllDataMarks(svgRoot, spec)
    const matching = allMarks.filter(m => m.datum && m.datum[legendInfo.field] === legendValue)
    if (matching.length > 0) {
      hierarchy.push({
        level: hierarchy.length,
        label: `${legendInfo.field}=${legendValue} Data`,
        labelEn: `${legendInfo.field}=${legendValue} data marks`,
        elements: [element, ...matching.map(m => m.element)],
        scopeType: 'field-value',
        scopeData: { field: legendInfo.field, value: legendValue }
      })
    }
  }

  // Level 2: All legend symbols (include original element)
  const allSymbols = findLegendElements(svgRoot, 'symbol')
  if (allSymbols.length > 1) {
    const symbolSet = new Set(allSymbols)
    const elements = symbolSet.has(element) ? allSymbols : [element, ...allSymbols]
    hierarchy.push({
      level: hierarchy.length,
      label: 'All Legend Symbols',
      labelEn: 'All legend symbols',
      elements,
      scopeType: 'all-legend-symbols',
      scopeData: {}
    })
  }

  // Level 3: Entire legend (include original element)
  const allLegend = findLegendElements(svgRoot, null)
  if (allLegend.length > 0) {
    const legendSet = new Set(allLegend)
    const elements = legendSet.has(element) ? allLegend : [element, ...allLegend]
    hierarchy.push({
      level: hierarchy.length,
      label: 'Entire Legend',
      labelEn: 'Entire legend',
      elements,
      scopeType: 'entire-legend',
      scopeData: {}
    })
  }

  return hierarchy
}

function buildLegendLabelHierarchy(elementInfo, spec, svgRoot) {
  const hierarchy = []
  const element = elementInfo.element
  const legendInfo = getLegendEncodingField(spec)
  const legendValue = elementInfo.legendValue
  const labelText = element?.textContent?.trim() || ''

  // Level 0: This label only
  hierarchy.push({
    level: 0,
    label: labelText ? `"${labelText}" Label` : 'This Legend Label',
    labelEn: labelText ? `"${labelText}" label` : 'This legend label',
    elements: [element],
    scopeType: 'individual',
    scopeData: { selector: elementInfo.selector, legendValue }
  })

  // Level 1: Data marks matching this legend value (include original element)
  const effectiveValue = legendValue ?? labelText
  if (legendInfo && effectiveValue != null) {
    const allMarks = findAllDataMarks(svgRoot, spec)
    const matching = allMarks.filter(m => {
      if (!m.datum) return false
      return m.datum[legendInfo.field] === effectiveValue || String(m.datum[legendInfo.field]) === String(effectiveValue)
    })
    if (matching.length > 0) {
      hierarchy.push({
        level: hierarchy.length,
        label: `${legendInfo.field}=${effectiveValue} Data`,
        labelEn: `${legendInfo.field}=${effectiveValue} data marks`,
        elements: [element, ...matching.map(m => m.element)],
        scopeType: 'field-value',
        scopeData: { field: legendInfo.field, value: effectiveValue }
      })
    }
  }

  // Level 2: All legend labels (include original element)
  const allLabels = findLegendElements(svgRoot, 'label')
  if (allLabels.length > 1) {
    const labelSet = new Set(allLabels)
    const elements = labelSet.has(element) ? allLabels : [element, ...allLabels]
    hierarchy.push({
      level: hierarchy.length,
      label: 'All Legend Labels',
      labelEn: 'All legend labels',
      elements,
      scopeType: 'all-legend-labels',
      scopeData: {}
    })
  }

  // Level 3: Entire legend (include original element)
  const allLegend = findLegendElements(svgRoot, null)
  if (allLegend.length > 0) {
    const legendSet = new Set(allLegend)
    const elements = legendSet.has(element) ? allLegend : [element, ...allLegend]
    hierarchy.push({
      level: hierarchy.length,
      label: 'Entire Legend',
      labelEn: 'Entire legend',
      elements,
      scopeType: 'entire-legend',
      scopeData: {}
    })
  }

  return hierarchy
}

function buildLegendTitleHierarchy(elementInfo, spec, svgRoot) {
  const hierarchy = []
  const element = elementInfo.element

  hierarchy.push({
    level: 0,
    label: 'This Legend Title',
    labelEn: 'This legend title',
    elements: [element],
    scopeType: 'individual',
    scopeData: { selector: elementInfo.selector }
  })

  const allLegend = findLegendElements(svgRoot, null)
  if (allLegend.length > 0) {
    const legendSet = new Set(allLegend)
    const elements = legendSet.has(element) ? allLegend : [element, ...allLegend]
    hierarchy.push({
      level: hierarchy.length,
      label: 'Entire Legend',
      labelEn: 'Entire legend',
      elements,
      scopeType: 'entire-legend',
      scopeData: {}
    })
  }

  return hierarchy
}

function buildFallbackHierarchy(elementInfo) {
  return [{
    level: 0,
    label: 'This Element',
    labelEn: 'This element',
    elements: [elementInfo.element],
    scopeType: 'individual',
    scopeData: { selector: elementInfo.selector }
  }]
}

// ─── Main function ──────────────────────────────────────

/**
 * Generate scope hierarchy for selected elements.
 *
 * @param {Array} selectedElements - Array of element info objects (from detectElementType),
 *   each should have at minimum: { element, semanticRole, ... }
 * @param {Object} spec - The Vega-Lite spec
 * @param {SVGElement} svgRoot - The chart's SVG root element
 * @returns {Array} Ordered scope candidates from narrowest to broadest
 */
export function generateScopeHierarchy(selectedElements, spec, svgRoot) {
  if (!selectedElements || selectedElements.length === 0 || !spec || !svgRoot) return []

  // Single element
  if (selectedElements.length === 1) {
    const elInfo = selectedElements[0]
    if (!elInfo?.element) return []

    const datum = extractDatum(elInfo.element)
    const role = classifyElement(elInfo)

    switch (role) {
      case 'data-mark':
        return buildDataMarkHierarchy(elInfo, datum, spec, svgRoot)
      case 'axis-label':
        return buildAxisLabelHierarchy(elInfo, spec, svgRoot)
      case 'axis-title':
        return buildAxisTitleHierarchy(elInfo, spec, svgRoot)
      case 'axis-tick':
      case 'axis-domain':
      case 'grid-line':
        return buildAxisTickHierarchy(elInfo, spec, svgRoot)
      case 'legend-symbol':
        return buildLegendSymbolHierarchy(elInfo, spec, svgRoot)
      case 'legend-label':
        return buildLegendLabelHierarchy(elInfo, spec, svgRoot)
      case 'legend-other':
        return buildLegendTitleHierarchy(elInfo, spec, svgRoot)
      default:
        return buildFallbackHierarchy(elInfo)
    }
  }

  // Multi-selection — handled in Prompt C extension
  return buildMultiSelectionHierarchy(selectedElements, spec, svgRoot)
}

/**
 * Multi-selection hierarchy.
 * Finds shared semantic context among selected elements.
 */
function buildMultiSelectionHierarchy(selectedElements, spec, svgRoot) {
  const hierarchy = []
  const count = selectedElements.length
  const elements = selectedElements.map(e => e.element).filter(Boolean)
  const originalSet = new Set(elements)

  // Helper: merge original elements into a scope's elements array
  const withOriginals = (scopeElements) => {
    const merged = [...scopeElements]
    for (const el of elements) {
      if (!scopeElements.includes(el)) merged.unshift(el)
    }
    return merged
  }

  // Level 0: Explicit multi-selection
  hierarchy.push({
    level: 0,
    label: `${count} Selected Elements`,
    labelEn: `${count} selected elements`,
    elements,
    scopeType: 'explicit',
    scopeData: { count }
  })

  // Classify all elements
  const roles = selectedElements.map(e => classifyElement(e))
  const uniqueRoles = [...new Set(roles)]

  if (uniqueRoles.length === 1) {
    // All same type — generate type-specific intermediate scopes
    const role = uniqueRoles[0]

    if (role === 'data-mark') {
      // Find shared categorical field values
      const datums = selectedElements.map(e => extractDatum(e.element)).filter(Boolean)
      const catFields = getCategoricalFields(spec)

      // For each categorical field, check if all datums share the same value
      const sharedScopes = []
      for (const { field } of catFields) {
        const values = datums.map(d => d[field]).filter(v => v != null)
        const unique = [...new Set(values)]
        if (unique.length === 1 && values.length === datums.length) {
          // Shared value — find all marks with this value
          const allMarks = findAllDataMarks(svgRoot, spec)
          const matching = allMarks.filter(m => m.datum && m.datum[field] === unique[0])
          sharedScopes.push({
            label: `All ${field}=${unique[0]}`,
            labelEn: `All ${field}=${unique[0]}`,
            elements: withOriginals(matching.map(m => m.element)),
            scopeType: 'field-value',
            scopeData: { field, value: unique[0] },
            matchCount: matching.length
          })
        }
      }

      // Sort by specificity: fewer matches first
      sharedScopes.sort((a, b) => a.matchCount - b.matchCount)
      for (const scope of sharedScopes) {
        hierarchy.push({ ...scope, level: hierarchy.length })
      }

      // Same mark type level — port from single-selection buildDataMarkHierarchy
      const allMarks = findAllDataMarks(svgRoot, spec)
      const markGroups = selectedElements.map(e => getMarkGroup(e.element))
      const uniqueMarkGroups = [...new Set(markGroups.filter(Boolean))]
      if (uniqueMarkGroups.length === 1) {
        const markGroup = uniqueMarkGroups[0]
        const siblingsInGroup = allMarks.filter(m => getMarkGroup(m.element) === markGroup)
        if (siblingsInGroup.length > count && siblingsInGroup.length < allMarks.length) {
          const typeName = inferMarkGroupLabel(selectedElements[0].element, markGroup, siblingsInGroup)
          hierarchy.push({
            level: hierarchy.length,
            label: `All ${typeName}s`,
            labelEn: `All ${typeName}s`,
            elements: withOriginals(siblingsInGroup.map(m => m.element)),
            scopeType: 'same-mark-type',
            scopeData: { markType: typeName }
          })
        }
      } else if (uniqueMarkGroups.length === 0 && allMarks.length > 1) {
        // Fallback: tag-based when mark group detection fails
        const selectedTags = selectedElements.map(e => e.element.tagName?.toLowerCase())
        const uniqueTags = [...new Set(selectedTags.filter(Boolean))]
        if (uniqueTags.length === 1) {
          const selectedTag = uniqueTags[0]
          const sameType = allMarks.filter(m => m.element.tagName?.toLowerCase() === selectedTag)
          if (sameType.length > count && sameType.length < allMarks.length) {
            const typeLabels = { circle: 'point', rect: 'bar', path: 'line', line: 'line' }
            const typeName = typeLabels[selectedTag] || selectedTag
            hierarchy.push({
              level: hierarchy.length,
              label: `All ${typeName}s`,
              labelEn: `All ${typeName}s`,
              elements: withOriginals(sameType.map(m => m.element)),
              scopeType: 'same-mark-type',
              scopeData: { markType: selectedTag }
            })
          }
        }
      }

      // All marks
      if (allMarks.length > count) {
        hierarchy.push({
          level: hierarchy.length,
          label: 'All Marks',
          labelEn: 'All marks',
          elements: withOriginals(allMarks.map(m => m.element)),
          scopeType: 'all-marks',
          scopeData: {}
        })
      }
    } else if (role === 'legend-symbol' || role === 'legend-label') {
      // Union of data marks for selected legend values
      const legendInfo = getLegendEncodingField(spec)
      if (legendInfo) {
        const values = selectedElements
          .map(e => e.legendValue ?? e.element?.textContent?.trim())
          .filter(v => v != null)
        const uniqueValues = [...new Set(values)]

        if (uniqueValues.length > 0) {
          const allMarks = findAllDataMarks(svgRoot, spec)
          const matching = allMarks.filter(m =>
            m.datum && uniqueValues.includes(m.datum[legendInfo.field])
          )
          if (matching.length > 0) {
            const valuesStr = uniqueValues.join(', ')
            hierarchy.push({
              level: hierarchy.length,
              label: `${legendInfo.field} in {${valuesStr}} Data`,
              labelEn: `${legendInfo.field} in {${valuesStr}} data marks`,
              elements: withOriginals(matching.map(m => m.element)),
              scopeType: 'field-values',
              scopeData: { field: legendInfo.field, values: uniqueValues }
            })
          }
        }
      }

      // All legend symbols/labels
      const subType = role === 'legend-symbol' ? 'symbol' : 'label'
      const allOfType = findLegendElements(svgRoot, subType)
      if (allOfType.length > count) {
        hierarchy.push({
          level: hierarchy.length,
          label: role === 'legend-symbol' ? 'All Legend Symbols' : 'All Legend Labels',
          labelEn: role === 'legend-symbol' ? 'All legend symbols' : 'All legend labels',
          elements: withOriginals(allOfType),
          scopeType: role === 'legend-symbol' ? 'all-legend-symbols' : 'all-legend-labels',
          scopeData: {}
        })
      }

      // Entire legend
      const allLegend = findLegendElements(svgRoot, null)
      if (allLegend.length > 0) {
        hierarchy.push({
          level: hierarchy.length,
          label: 'Entire Legend',
          labelEn: 'Entire legend',
          elements: withOriginals(allLegend),
          scopeType: 'entire-legend',
          scopeData: {}
        })
      }
    } else if (role === 'axis-label') {
      // Union of data marks for selected axis label values
      const channels = [...new Set(selectedElements.map(e => e.axisChannel).filter(Boolean))]
      if (channels.length === 1) {
        const channel = channels[0]
        const fieldInfo = getAxisEncodingField(spec, channel)
        if (fieldInfo) {
          const labelTexts = selectedElements
            .map(e => e.element?.textContent?.trim())
            .filter(Boolean)
          const data = spec?.data?.values
          const mappedValues = labelTexts.map(t => reverseMapAxisValue(t, fieldInfo.field, spec, data))

          const allMarks = findAllDataMarks(svgRoot, spec)
          const matching = allMarks.filter(m => {
            if (!m.datum) return false
            return mappedValues.some(v =>
              String(m.datum[fieldInfo.field]) === String(v)
            )
          })
          if (matching.length > 0) {
            const valuesStr = mappedValues.join(', ')
            hierarchy.push({
              level: hierarchy.length,
              label: `${fieldInfo.field} in {${valuesStr}} Data`,
              labelEn: `${fieldInfo.field} in {${valuesStr}} data marks`,
              elements: withOriginals(matching.map(m => m.element)),
              scopeType: 'field-values',
              scopeData: { field: fieldInfo.field, values: mappedValues }
            })
          }
        }

        // All labels on this axis
        const axisLabels = findAxisElements(svgRoot, channel, 'label')
        if (axisLabels.length > count) {
          const chLabel = channel === 'x' ? 'X' : 'Y'
          hierarchy.push({
            level: hierarchy.length,
            label: `All ${chLabel}-Axis Labels`,
            labelEn: `All ${chLabel}-axis labels`,
            elements: withOriginals(axisLabels),
            scopeType: 'axis-labels',
            scopeData: { axis: channel }
          })
        }

        // Entire axis
        const allAxisEls = findAxisElements(svgRoot, channel, null)
        if (allAxisEls.length > 0) {
          const chLabel = channel === 'x' ? 'X' : 'Y'
          hierarchy.push({
            level: hierarchy.length,
            label: `Entire ${chLabel}-Axis`,
            labelEn: `Entire ${chLabel}-axis`,
            elements: withOriginals(allAxisEls),
            scopeType: 'entire-axis',
            scopeData: { axis: channel }
          })
        }
      }
    } else if (role === 'axis-tick' || role === 'grid-line') {
      // Non-label axis elements: tick, grid, domain
      const subTypeMap = { 'axis-tick': 'tick', 'grid-line': 'grid', 'axis-domain': 'domain' }
      const subType = subTypeMap[role] || 'tick'
      const subLabels = { tick: 'Tick', grid: 'Gridline', domain: 'Axis Line' }
      const subLabelsEn = { tick: 'tick', grid: 'grid line', domain: 'domain line' }
      const channels = [...new Set(selectedElements.map(e => e.axisChannel).filter(Boolean))]

      if (channels.length === 1) {
        const channel = channels[0]
        const chLabel = channel === 'x' ? 'X' : 'Y'

        // All same sub-type on this axis
        const sameSubType = findAxisElements(svgRoot, channel, subType)
        if (sameSubType.length > count) {
          hierarchy.push({
            level: hierarchy.length,
            label: `All ${chLabel}-Axis ${subLabels[subType]}s`,
            labelEn: `All ${chLabel}-axis ${subLabelsEn[subType]}s`,
            elements: withOriginals(sameSubType),
            scopeType: `axis-${subType}`,
            scopeData: { axis: channel, subType }
          })
        }

        // Entire axis
        const allAxisEls = findAxisElements(svgRoot, channel, null)
        if (allAxisEls.length > 0) {
          hierarchy.push({
            level: hierarchy.length,
            label: `Entire ${chLabel}-Axis`,
            labelEn: `Entire ${chLabel}-axis`,
            elements: withOriginals(allAxisEls),
            scopeType: 'entire-axis',
            scopeData: { axis: channel }
          })
        }
      }

      // All same sub-type across all axes
      const allSubType = [
        ...findAxisElements(svgRoot, 'x', subType),
        ...findAxisElements(svgRoot, 'y', subType)
      ]
      const seen = new Set()
      const deduped = allSubType.filter(el => {
        if (seen.has(el)) return false
        seen.add(el)
        return true
      })
      if (deduped.length > count) {
        hierarchy.push({
          level: hierarchy.length,
          label: `All ${subLabels[subType]}s`,
          labelEn: `All ${subLabelsEn[subType]}s`,
          elements: withOriginals(deduped),
          scopeType: `all-${subType}`,
          scopeData: { subType }
        })
      }
    }
  } else {
    // Mixed types — find nearest common semantic container
    const hasLegend = roles.some(r => r.startsWith('legend-'))
    const hasAxis = roles.some(r => r.startsWith('axis-'))

    if (hasLegend && !hasAxis) {
      const allLegend = findLegendElements(svgRoot, null)
      if (allLegend.length > 0) {
        hierarchy.push({
          level: hierarchy.length,
          label: 'Entire Legend',
          labelEn: 'Entire legend',
          elements: withOriginals(allLegend),
          scopeType: 'entire-legend',
          scopeData: {}
        })
      }
    } else if (hasAxis && !hasLegend) {
      const channels = [...new Set(selectedElements.map(e => e.axisChannel).filter(Boolean))]
      if (channels.length === 1) {
        const allAxisEls = findAxisElements(svgRoot, channels[0], null)
        if (allAxisEls.length > 0) {
          const chLabel = channels[0] === 'x' ? 'X' : 'Y'
          hierarchy.push({
            level: hierarchy.length,
            label: `Entire ${chLabel}-Axis`,
            labelEn: `Entire ${chLabel}-axis`,
            elements: withOriginals(allAxisEls),
            scopeType: 'entire-axis',
            scopeData: { axis: channels[0] }
          })
        }
      }
    }

    // Broadest: all marks
    const allMarks = findAllDataMarks(svgRoot, spec)
    if (allMarks.length > 0) {
      hierarchy.push({
        level: hierarchy.length,
        label: 'All Chart Elements',
        labelEn: 'All chart elements',
        elements: withOriginals(allMarks.map(m => m.element)),
        scopeType: 'all-marks',
        scopeData: {}
      })
    }
  }

  return hierarchy
}
