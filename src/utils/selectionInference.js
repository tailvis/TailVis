import { detectElementType, extractDatum } from './elementUtils'

/**
 * Infer possible selection expansion intents from currently selected elements.
 * Returns an array of suggestions, ranked by specificity (most specific first).
 */
export function inferSelectionIntent(selectedElements, spec) {
  if (!selectedElements || selectedElements.length < 2) return []

  const suggestions = []
  const roles = [...new Set(selectedElements.map(e => e.semanticRole))]
  const singleRole = roles.length === 1 ? roles[0] : null

  if (singleRole === 'data-mark') {
    suggestions.push(...inferDataMarkIntent(selectedElements, spec))
  } else if (singleRole === 'axis') {
    suggestions.push(...inferAxisIntent(selectedElements))
  } else if (singleRole === 'legend') {
    suggestions.push(...inferLegendIntent(selectedElements))
  } else if (singleRole === 'text') {
    suggestions.push(...inferTextIntent(selectedElements))
  } else {
    suggestions.push(...inferCrossRoleIntent(selectedElements, spec))
  }

  suggestions.sort((a, b) => a.priority - b.priority)
  return suggestions
}

function inferDataMarkIntent(elements, spec) {
  const suggestions = []
  const datums = elements.map(e => e.datum).filter(Boolean)
  if (datums.length < 2) return suggestions

  // Check each categorical field for shared values
  const categoricalFields = []
  const encoding = spec?.encoding || {}
  for (const [channel, enc] of Object.entries(encoding)) {
    if (enc?.field && ['nominal', 'ordinal'].includes(enc.type)) {
      categoricalFields.push({ channel, field: enc.field })
    }
  }
  if (spec?.layer) {
    for (const layer of spec.layer) {
      for (const [channel, enc] of Object.entries(layer.encoding || {})) {
        if (enc?.field && ['nominal', 'ordinal'].includes(enc.type)) {
          if (!categoricalFields.find(f => f.field === enc.field)) {
            categoricalFields.push({ channel, field: enc.field })
          }
        }
      }
    }
  }

  for (const { field } of categoricalFields) {
    const values = datums.map(d => d[field]).filter(v => v != null)
    const unique = [...new Set(values)]
    if (unique.length === 1 && values.length === datums.length) {
      suggestions.push({
        type: 'by-field',
        field,
        value: unique[0],
        label: `All ${field} = "${unique[0]}"`,
        matchFn: (elInfo, datum) => {
          return elInfo.semanticRole === 'data-mark' && datum && datum[field] === unique[0]
        },
        priority: 10
      })
    }
  }

  // Check shared markGroup
  const markGroups = [...new Set(elements.map(e => e.markGroup).filter(Boolean))]
  if (markGroups.length === 1) {
    const markLabels = {
      'mark-rect': 'All Bars', 'mark-arc': 'All Slices', 'mark-line': 'All Lines',
      'mark-symbol': 'All Points', 'mark-area': 'All Areas', 'mark-text': 'All Text Marks'
    }
    suggestions.push({
      type: 'all-marks',
      markGroup: markGroups[0],
      label: markLabels[markGroups[0]] || 'All Same Type',
      matchFn: (elInfo) => elInfo.semanticRole === 'data-mark' && elInfo.markGroup === markGroups[0],
      priority: 30
    })
  }

  // Check composite sub-parts
  const subParts = [...new Set(elements.map(e => e.compositeSubPart).filter(Boolean))]
  if (subParts.length === 1) {
    const subLabels = { box: 'All Boxes', median: 'All Medians', rule: 'All Whiskers', outliers: 'All Outliers' }
    suggestions.push({
      type: 'composite-sub',
      compositeSubPart: subParts[0],
      label: subLabels[subParts[0]] || `All ${subParts[0]}`,
      matchFn: (elInfo) => elInfo.compositeSubPart === subParts[0],
      priority: 15
    })
  }

  return suggestions
}

function inferAxisIntent(elements) {
  const suggestions = []
  const channels = [...new Set(elements.map(e => e.axisChannel).filter(Boolean))]
  const subTypes = [...new Set(elements.map(e => e.axisSubType).filter(Boolean))]

  if (channels.length === 1 && subTypes.length === 1) {
    const subLabels = { label: 'Labels', tick: 'Ticks', domain: 'Axis Line', grid: 'Gridlines', title: 'Title' }
    suggestions.push({
      type: 'same-axis-subtype',
      axisChannel: channels[0],
      axisSubType: subTypes[0],
      label: `All ${channels[0].toUpperCase()}-Axis ${subLabels[subTypes[0]] || subTypes[0]}`,
      matchFn: (elInfo) => elInfo.semanticRole === 'axis' && elInfo.axisChannel === channels[0] && elInfo.axisSubType === subTypes[0],
      priority: 10
    })
  }

  if (channels.length === 1 && subTypes.length > 1) {
    suggestions.push({
      type: 'same-axis-all',
      axisChannel: channels[0],
      label: `All ${channels[0].toUpperCase()}-Axis Elements`,
      matchFn: (elInfo) => elInfo.semanticRole === 'axis' && elInfo.axisChannel === channels[0],
      priority: 20
    })
  }

  if (channels.length > 1 && subTypes.length === 1) {
    const subLabels = { label: 'Labels', tick: 'Ticks', domain: 'Axis Line', grid: 'Gridlines' }
    suggestions.push({
      type: 'all-axes-subtype',
      axisSubType: subTypes[0],
      label: `All Axes ${subLabels[subTypes[0]] || subTypes[0]}`,
      matchFn: (elInfo) => elInfo.semanticRole === 'axis' && elInfo.axisSubType === subTypes[0],
      priority: 15
    })
  }

  suggestions.push({
    type: 'all-axes',
    label: 'All Axis Elements',
    matchFn: (elInfo) => elInfo.semanticRole === 'axis',
    priority: 30
  })

  return suggestions
}

function inferLegendIntent(elements) {
  return [{
    type: 'all-legend',
    label: 'All Legend Items',
    matchFn: (elInfo) => elInfo.semanticRole === 'legend',
    priority: 20
  }]
}

function inferTextIntent(elements) {
  return [{
    type: 'all-text',
    label: 'All Text',
    matchFn: (elInfo) => elInfo.semanticRole === 'text' || elInfo.type === 'text',
    priority: 20
  }]
}

function inferCrossRoleIntent(elements, spec) {
  const suggestions = []
  const legendEls = elements.filter(e => e.semanticRole === 'legend')
  const markEls = elements.filter(e => e.semanticRole === 'data-mark')

  if (legendEls.length > 0 && markEls.length > 0) {
    const legendField = legendEls[0].legendField
    const legendValue = legendEls[0].legendValue
    if (legendField && legendValue) {
      suggestions.push({
        type: 'legend-with-data',
        field: legendField,
        value: legendValue,
        label: `${legendField} = "${legendValue}" (Data + Legend)`,
        matchFn: (elInfo, datum) => {
          if (elInfo.semanticRole === 'legend' && elInfo.legendValue === legendValue) return true
          if (elInfo.semanticRole === 'data-mark' && datum && datum[legendField] === legendValue) return true
          return false
        },
        priority: 10
      })
    }
  }

  return suggestions
}

/**
 * Find all SVG elements in a chart that match a selection predicate.
 */
export function findMatchingElements(svgEl, spec, matchFn) {
  const results = []
  const visualTags = ['rect', 'circle', 'ellipse', 'line', 'path', 'polyline', 'polygon', 'text']

  const allElements = svgEl.querySelectorAll(visualTags.join(','))

  for (const el of allElements) {
    // Skip background/foreground
    const cls = (typeof el.className === 'string' ? el.className : el.className?.baseVal) || ''
    if (cls === 'background' || cls === 'foreground') continue

    // Skip large background rects
    if (el.tagName.toLowerCase() === 'rect') {
      const w = parseFloat(el.getAttribute('width') || 0)
      const h = parseFloat(el.getAttribute('height') || 0)
      if (w > 350 && h > 200) continue
    }

    const elementInfo = detectElementType(el, spec, svgEl)
    if (!elementInfo) continue

    const datum = extractDatum(el)

    if (matchFn(elementInfo, datum)) {
      results.push({ element: el, elementInfo, datum })
    }

    // Early termination for performance. Keep high enough that large datasets
    // (e.g. 342-row penguins) don't drop the last facet/series' marks.
    if (results.length >= 5000) break
  }

  return results
}
