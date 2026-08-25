/**
 * Scope utilities for binding-aware modification system.
 * Generates semantic scope options based on element role (data-mark, axis, legend, text),
 * and applies modifications to specs based on scope selection.
 */

/**
 * Determine whether a layer in a Vega-Lite spec is an annotation (non-data) layer.
 * Annotation layers use only datum/value in encoding, never referencing the main dataset fields.
 */
/**
 * Parse a simple Vega expression filter into field/op/value.
 * Returns null for complex expressions.
 */
function parseFilterExpression(expr) {
  if (typeof expr !== 'string') return null
  const match = expr.match(
    /datum(?:\.(\w+)|\['([^']+)'\]|\["([^"]+)"\])\s*(===?|!==?|>=?|<=?)\s*(?:'([^']*)'|"([^"]*)"|(\d+(?:\.\d+)?))/
  )
  if (!match) return null
  const field = match[1] || match[2] || match[3]
  const op = match[4]
  const value = match[5] ?? match[6] ?? (match[7] !== undefined ? Number(match[7]) : undefined)
  return { field, op, value }
}

/**
 * Analyze a layer to determine its role and meaningful scope fields.
 */
export function analyzeLayerContext(layerSpec, fullSpec, mainData) {
  if (!layerSpec) return { layerType: 'data-mark', encodedFields: [], filterFields: [], effectiveData: mainData || [], meaningfulScopeFields: [] }

  const encoding = layerSpec.encoding || {}
  const transforms = layerSpec.transform || []

  // 1. Collect fields this layer actually encodes
  const encodedFields = []
  for (const [, enc] of Object.entries(encoding)) {
    if (enc?.field) encodedFields.push(enc.field)
  }

  // 2. Identify filter constraints
  const filterFields = []
  for (const t of transforms) {
    if (t.filter) {
      const parsed = parseFilterExpression(t.filter)
      if (parsed) filterFields.push(parsed)
    }
  }

  // 3. Compute effective data (main data after filters)
  const safeMainData = Array.isArray(mainData) && mainData.length > 0 ? mainData : []
  let effectiveData = safeMainData
  for (const ff of filterFields) {
    if (ff.op === '==' || ff.op === '===') {
      effectiveData = effectiveData.filter(d => String(d[ff.field]) == String(ff.value))
    }
  }

  // 4. Determine layer type
  const mainDataFields = safeMainData[0] ? Object.keys(safeMainData[0]) : []
  const usesMainDataFields = encodedFields.some(f => mainDataFields.includes(f))
  const hasOwnData = !!layerSpec.data
  const markType = typeof layerSpec.mark === 'string' ? layerSpec.mark : layerSpec.mark?.type
  const isDecorationMark = ['rect', 'rule', 'text'].includes(markType)

  let layerType
  if (!usesMainDataFields && (hasOwnData || encodedFields.length === 0) && isDecorationMark) {
    layerType = 'pure-annotation'
  } else if (isDecorationMark && filterFields.length > 0) {
    layerType = 'highlight-mark'
  } else {
    layerType = 'data-mark'
  }

  // 5. Determine meaningful scope fields
  const meaningfulScopeFields = encodedFields.filter(field => {
    const uniqueValues = [...new Set(effectiveData.map(d => d[field]))]
    return uniqueValues.length > 1
  })

  return { layerType, encodedFields, filterFields, effectiveData, meaningfulScopeFields }
}

/**
 * Generate scope options based on layer context for annotation/highlight layers.
 * Now also accepts classification from classifyLayer() for unified handling.
 */
function generateLayerAwareScopes(layerContext, clickedDatum, layerIndex, classification) {
  const scopes = []

  // If unified classification is provided, use it
  if (classification && classification.type.startsWith('annotation-')) {
    if (!classification.hasMultipleElements) {
      // Single element: only "This element"
      scopes.push({
        label: 'This element',
        value: { type: 'annotation-direct', layerIndex, modStrategy: classification.modStrategy },
        description: 'Direct modification of this element'
      })
      return scopes
    }

    // Multiple elements: "All elements" + "This element"
    scopes.push({
      label: 'All elements',
      value: { type: 'all-in-layer', layerIndex, modStrategy: classification.modStrategy },
      description: 'Apply to all elements in this layer'
    })

    scopes.push({
      label: 'This element',
      value: { type: 'this-element', layerIndex, datum: clickedDatum, modStrategy: classification.modStrategy },
      description: 'Apply to this specific element only'
    })

    return scopes
  }

  // Legacy path: use layerContext
  if (layerContext.layerType === 'pure-annotation') {
    scopes.push({
      label: 'This element',
      value: { type: 'annotation-direct', layerIndex },
      description: 'Direct modification of this element'
    })
    return scopes
  }

  if (layerContext.layerType === 'highlight-mark') {
    if (layerContext.meaningfulScopeFields.length === 0) {
      scopes.push({
        label: 'This element',
        value: { type: 'annotation-direct', layerIndex },
        description: 'Direct modification of this element'
      })
    } else {
      scopes.push({
        label: 'All elements',
        value: { type: 'all-in-layer', layerIndex },
        description: 'Apply to all elements in this layer'
      })

      for (const field of layerContext.meaningfulScopeFields) {
        const value = clickedDatum?.[field]
        scopes.push({
          label: value != null ? `${field} = ${value}` : `By ${field}`,
          value: { type: 'by-field', field, fieldValue: value, layerIndex },
          description: `condition on ${field}`
        })
      }

      scopes.push({
        label: 'This element',
        value: { type: 'this-element', layerIndex },
        description: 'Apply to this specific element only'
      })
    }
    return scopes
  }

  // data-mark: shouldn't reach here, but fallback
  return scopes
}

export function isAnnotationLayer(layerSpec, mainDataFields) {
  if (!layerSpec || !mainDataFields || mainDataFields.length === 0) return false
  const encoding = layerSpec.encoding || {}

  const referencedFields = []
  for (const channel of Object.keys(encoding)) {
    const enc = encoding[channel]
    if (enc.field) referencedFields.push(enc.field)
    if (enc.condition) {
      const conditions = Array.isArray(enc.condition) ? enc.condition : [enc.condition]
      for (const cond of conditions) {
        if (cond.field) referencedFields.push(cond.field)
      }
    }
  }

  // No field references at all (only datum/value) → annotation
  if (referencedFields.length === 0) return true

  // If layer has its own inline data, check if fields belong to inline vs main dataset
  if (layerSpec.data && layerSpec.data.values && layerSpec.data.values.length > 0) {
    const inlineFields = Object.keys(layerSpec.data.values[0])
    const refsMainData = referencedFields.some(f =>
      mainDataFields.includes(f) && !inlineFields.includes(f)
    )
    return !refsMainData
  }

  // Layer inherits main data — check if it references main dataset fields
  const refsMainData = referencedFields.some(f => mainDataFields.includes(f))
  return !refsMainData
}

/**
 * Get the field names available to a specific layer.
 * Used for layer data isolation — prevents cross-layer field leakage in scope options.
 *
 * @param {Object} layerSpec - spec.layer[N]
 * @param {Object} fullSpec - full Vega-Lite spec
 * @returns {string[]} field names available to this layer
 */
function getLayerDataFields(layerSpec, fullSpec) {
  // Layer has its own inline data → use only those fields
  if (layerSpec.data && layerSpec.data.values && layerSpec.data.values.length > 0) {
    return Object.keys(layerSpec.data.values[0])
  }

  // Layer inherits top-level data → use top-level fields
  if (fullSpec.data && fullSpec.data.values && fullSpec.data.values.length > 0) {
    return Object.keys(fullSpec.data.values[0])
  }

  return []
}

/**
 * Classify a layer and determine its modification strategy.
 * Returns a LayerClassification object with type, modStrategy, and metadata.
 *
 * @param {Object} layerSpec - spec.layer[N]
 * @param {string[]} mainDataFields - column names of the main dataset
 * @param {Array} mainData - the main dataset rows
 * @returns {Object} LayerClassification
 */
export function classifyLayer(layerSpec, mainDataFields, mainData) {
  const encoding = layerSpec.encoding || {}
  const transforms = layerSpec.transform || []
  const hasOwnData = !!(layerSpec.data && layerSpec.data.values)
  const markType = typeof layerSpec.mark === 'string' ? layerSpec.mark : layerSpec.mark?.type

  // Collect field references in encoding (not datum — datum is a literal)
  const encodedFields = []
  for (const [channel, enc] of Object.entries(encoding)) {
    if (enc && enc.field) encodedFields.push({ channel, field: enc.field })
  }

  // Determine which dataset this layer operates on
  let layerDataFields = []
  let layerData = []

  if (hasOwnData) {
    layerDataFields = Object.keys(layerSpec.data.values[0] || {})
    layerData = layerSpec.data.values
  } else {
    layerDataFields = mainDataFields || []
    layerData = mainData || []
  }

  // Check if encoded fields reference the main dataset
  const referencesMainData = !hasOwnData && encodedFields.some(
    ef => mainDataFields.includes(ef.field)
  )

  // Parse filter constraints (for pattern A detection)
  const filterConstraints = []
  for (const t of transforms) {
    if (t.filter && typeof t.filter === 'string') {
      const parsed = parseFilterExpression(t.filter)
      if (parsed) filterConstraints.push(parsed)
    }
  }

  // Detect visibility conditions (for pattern B detection)
  const visibilityConditions = []
  for (const [channel, enc] of Object.entries(encoding)) {
    if (enc && enc.condition && enc.value !== undefined) {
      const fallback = enc.value
      const isVisibilityControl = (
        fallback === 'transparent' ||
        fallback === 'none' ||
        fallback === 'rgba(0,0,0,0)' ||
        fallback === null ||
        (channel === 'opacity' && (fallback === 0 || fallback === '0'))
      )
      if (isVisibilityControl) {
        const cond = enc.condition
        const conditions = Array.isArray(cond) ? cond : [cond]
        for (const c of conditions) {
          if (c.test) {
            const parsed = parseFilterExpression(c.test)
            if (parsed) visibilityConditions.push({ channel, ...parsed, value: c.value })
          }
        }
      }
    }
  }

  // === Classification logic ===
  const isDecorationMark = ['rect', 'rule', 'text'].includes(markType)

  // Pattern C/D: Has own inline data, does not reference main dataset
  if (hasOwnData && !referencesMainData && isDecorationMark) {
    const hasMultipleRows = layerSpec.data.values.length > 1
    return {
      type: 'annotation-inline',
      hasMultipleElements: hasMultipleRows,
      inlineData: layerSpec.data.values,
      inlineDataFields: layerDataFields,
      modStrategy: 'inline-data-edit',
      encodedFields
    }
  }

  // Pattern A: Decoration mark + filter + references main data for position
  if (isDecorationMark && referencesMainData && filterConstraints.length > 0) {
    let filtered = mainData || []
    for (const fc of filterConstraints) {
      filtered = filtered.filter(d => String(d[fc.field]) == String(fc.value))
    }
    return {
      type: 'annotation-filtered',
      hasMultipleElements: filtered.length > 1,
      filterConstraints,
      effectiveData: filtered,
      modStrategy: 'direct-mark-edit',
      encodedFields
    }
  }

  // Pattern B: Decoration mark + visibility condition + references main data
  if (isDecorationMark && referencesMainData && visibilityConditions.length > 0) {
    return {
      type: 'annotation-conditional',
      hasMultipleElements: visibilityConditions.length > 1,
      visibilityConditions,
      modStrategy: 'condition-value-edit',
      encodedFields
    }
  }

  // Decoration mark with no data field references at all (pure datum/value)
  if (isDecorationMark && encodedFields.length === 0) {
    return {
      type: 'annotation-pure',
      hasMultipleElements: false,
      modStrategy: 'direct-mark-edit',
      encodedFields
    }
  }

  // Default: data mark — existing scope system handles this
  return {
    type: 'data-mark',
    modStrategy: 'scope-based',
    encodedFields
  }
}

/**
 * Find the index in inline data.values that matches the clicked element's datum.
 * Vega attaches the source datum to rendered marks — match on the original inline data fields.
 *
 * @param {Object} clickedDatum - datum from the clicked SVG element
 * @param {Array} inlineDataValues - the layer's data.values array
 * @returns {number} row index, or -1 if not found
 */
function findInlineDataRowIndex(clickedDatum, inlineDataValues) {
  if (!clickedDatum || !inlineDataValues || inlineDataValues.length === 0) return -1
  const fields = Object.keys(inlineDataValues[0] || {})

  return inlineDataValues.findIndex(row =>
    fields.every(f => String(row[f]) === String(clickedDatum[f]))
  )
}

/**
 * Modify a value in a layer's inline data.
 * SAFETY: Only allowed for layers classified as annotation-inline.
 * Never modify main dataset or top-level data through this path.
 */

/**
 * SPEC_PATH_MAP: Two-dimensional routing table for (element-type, property) → spec property name.
 * Used by axis and legend modification handlers to determine the exact Vega-Lite spec path.
 */
const SPEC_PATH_MAP = {
  'axis-grid': {
    color: 'gridColor', fill: 'gridColor', stroke: 'gridColor',
    strokeWidth: 'gridWidth', opacity: 'gridOpacity', strokeDasharray: 'gridDash',
    width: 'gridWidth',
  },
  'axis-label': {
    color: 'labelColor', fill: 'labelColor', stroke: 'labelColor',
    fontSize: 'labelFontSize', fontWeight: 'labelFontWeight', opacity: 'labelOpacity',
    angle: 'labelAngle', fontStyle: 'labelFontStyle',
  },
  'axis-title': {
    color: 'titleColor', fill: 'titleColor', stroke: 'titleColor',
    fontSize: 'titleFontSize', fontWeight: 'titleFontWeight', opacity: 'titleOpacity',
    text: 'title', angle: 'titleAngle', fontStyle: 'titleFontStyle',
  },
  'axis-tick': {
    color: 'tickColor', fill: 'tickColor', stroke: 'tickColor',
    strokeWidth: 'tickWidth', opacity: 'tickOpacity', strokeDasharray: 'tickDash',
    size: 'tickSize', width: 'tickWidth',
  },
  'axis-domain': {
    color: 'domainColor', fill: 'domainColor', stroke: 'domainColor',
    strokeWidth: 'domainWidth', opacity: 'domainOpacity', strokeDasharray: 'domainDash',
    width: 'domainWidth',
  },
  'legend-symbol': {
    color: 'symbolFillColor', fill: 'symbolFillColor',
    stroke: 'symbolStrokeColor',
    strokeWidth: 'symbolStrokeWidth', opacity: 'symbolOpacity',
    size: 'symbolSize',
  },
  'legend-label': {
    color: 'labelColor', fill: 'labelColor',
    fontSize: 'labelFontSize', fontWeight: 'labelFontWeight',
    opacity: 'labelOpacity', fontStyle: 'labelFontStyle',
  },
  'legend-title': {
    color: 'titleColor', fill: 'titleColor',
    fontSize: 'titleFontSize', fontWeight: 'titleFontWeight',
    opacity: 'titleOpacity', fontStyle: 'titleFontStyle',
  },
}

/**
 * Map property names to the encoding channels they correspond to.
 * Used to determine which encoding channel is relevant for a given CSS/SVG property.
 */
const propToChannels = {
  fill: ['color', 'fill'],
  color: ['color', 'fill'],
  stroke: ['stroke', 'color'],
  opacity: ['opacity'],
  size: ['size'],
  shape: ['shape'],
  strokeWidth: ['strokeWidth'],
  fontSize: [],
  fontWeight: [],
  text: [],
}

/**
 * Analyze all encoding bindings for a selected element, determining what data
 * mappings exist and how they relate to the property being modified.
 *
 * @param {object} spec - Vega-Lite spec
 * @param {object|null} datum - The datum of the selected element
 * @param {string} property - The property being modified (e.g., 'fill', 'opacity')
 * @returns {Array<EncodingBinding>} Sorted by relevance (property-specific first)
 *
 * Each EncodingBinding: {
 *   channel: string,           // e.g., 'color', 'fill', 'size'
 *   field: string,             // e.g., 'Category', 'Revenue'
 *   fieldValue: any,           // datum value for this field
 *   encodingType: string,      // 'nominal', 'ordinal', 'quantitative', 'temporal'
 *   bindingKind: 'categorical' | 'continuous' | 'none',
 *   scale: object|null,        // existing scale config
 *   isPropertyRelevant: bool,  // true if this channel directly maps to the property
 * }
 */
export function analyzeEncodingBindings(spec, datum, property, layerIndex) {
  const bindings = []
  const relevantChannels = propToChannels[property] || []
  const seenFields = new Set()

  // Collect encodings from top-level and relevant layer only
  const encodingSources = []
  if (spec?.encoding) encodingSources.push(spec.encoding)
  if (spec?.layer) {
    if (layerIndex != null && layerIndex < spec.layer.length) {
      // Only scan the specific layer's encoding
      if (spec.layer[layerIndex].encoding) encodingSources.push(spec.layer[layerIndex].encoding)
    } else {
      for (const layer of spec.layer) {
        if (layer.encoding) encodingSources.push(layer.encoding)
      }
    }
  }

  const categoricalTypes = ['nominal', 'ordinal']
  const continuousTypes = ['quantitative', 'temporal']

  for (const encoding of encodingSources) {
    for (const [channel, enc] of Object.entries(encoding)) {
      if (!enc?.field) continue
      const field = enc.field
      if (seenFields.has(`${channel}:${field}`)) continue
      seenFields.add(`${channel}:${field}`)

      let encodingType = enc.type || ''
      let bindingKind = 'none'
      if (categoricalTypes.includes(encodingType)) bindingKind = 'categorical'
      else if (continuousTypes.includes(encodingType)) bindingKind = 'continuous'
      else if (!encodingType && (channel === 'color' || channel === 'fill')) {
        // No type specified on color/fill channel — infer from data
        // If the field has a small number of unique values, treat as categorical
        bindingKind = 'categorical'
        encodingType = 'nominal'
      }

      const isPropertyRelevant = relevantChannels.includes(channel)

      bindings.push({
        channel,
        field,
        fieldValue: datum ? datum[field] ?? null : null,
        encodingType,
        bindingKind,
        scale: enc.scale || null,
        isBinned: !!enc.bin,
        isPropertyRelevant,
      })
    }
  }

  // Sort: property-relevant channels first, then categorical before continuous
  bindings.sort((a, b) => {
    if (a.isPropertyRelevant !== b.isPropertyRelevant) return a.isPropertyRelevant ? -1 : 1
    const kindOrder = { categorical: 0, continuous: 1, none: 2 }
    return (kindOrder[a.bindingKind] || 2) - (kindOrder[b.bindingKind] || 2)
  })

  return bindings
}

/**
 * Try to evaluate a simple Vega test expression against a datum.
 * Returns true/false if evaluable, null if too complex to parse.
 */
export function evaluateTestExpression(test, datum) {
  if (!test || !datum) return null
  try {
    // Handle compound && expressions by splitting and evaluating each part
    if (test.includes('&&')) {
      const parts = test.split('&&').map(p => p.trim())
      for (const part of parts) {
        const result = evaluateTestExpression(part, datum)
        if (result === false) return false
        if (result === null) return null // can't evaluate → unknown
      }
      return true
    }

    // Normalize datum references: datum['field'] → datum.field
    let expr = test
      .replace(/datum\['([^']+)'\]/g, (_, f) => `datum_${f}`)
      .replace(/datum\["([^"]+)"\]/g, (_, f) => `datum_${f}`)
      .replace(/datum\.(\w+)/g, (_, f) => `datum_${f}`)

    // Build a local scope from datum
    const vars = {}
    for (const [k, v] of Object.entries(datum)) {
      vars[`datum_${k}`] = v
    }

    // Support simple binary comparisons only (safe evaluation)
    const simpleBinary = /^([\w_]+)\s*(>=|<=|===|!==|==|!=|>|<)\s*(.+)$/
    const m = expr.match(simpleBinary)
    if (!m) return null
    const [, lhs, op, rhs] = m
    const lVal = vars[lhs]
    if (lVal === undefined) return null
    // Parse rhs: number or quoted string
    let rVal
    const numMatch = rhs.match(/^-?\d+(\.\d+)?$/)
    const strMatch = rhs.match(/^['"](.*)['"]$/)
    if (numMatch) rVal = parseFloat(rhs)
    else if (strMatch) rVal = strMatch[1]
    else return null

    switch (op) {
      case '>': return lVal > rVal
      case '<': return lVal < rVal
      case '>=': return lVal >= rVal
      case '<=': return lVal <= rVal
      case '==': case '===': return lVal == rVal // eslint-disable-line eqeqeq
      case '!=': case '!==': return lVal != rVal // eslint-disable-line eqeqeq
      default: return null
    }
  } catch {
    return null
  }
}

/**
 * Convert a Vega test expression to a short human-readable label.
 * e.g. "datum.sum_Revenue >= 8000" → "sum_Revenue ≥ 8000"
 */
export function formatTestLabel(test) {
  if (!test) return test
  return test
    .replace(/datum\['([^']+)'\]/g, '$1')
    .replace(/datum\["([^"]+)"\]/g, '$1')
    .replace(/datum\.(\w+)/g, '$1')
    .replace(/\s*===\s*/g, ' = ')
    .replace(/\s*!==\s*/g, ' ≠ ')
    .replace(/\s*==\s*/g, ' = ')
    .replace(/\s*!=\s*/g, ' ≠ ')
    .replace(/\s*>=\s*/g, ' ≥ ')
    .replace(/\s*<=\s*/g, ' ≤ ')
    .trim()
    .slice(0, 40)
}

/**
 * Generate scope options based on the semantic role of the clicked element.
 *
 * @param {object} spec - Vega-Lite spec
 * @param {object|null} datum - The datum of the currently selected element
 * @param {object|null} elementInfo - Element info from detectElementType (semanticRole, axisChannel, etc.)
 * @param {string|null} property - The property being modified (optional, for encoding-aware options)
 * @returns {Array<{label: string, value: object, description: string}>}
 */
export function generateScopeOptions(spec, datum, elementInfo, property) {
  const semanticRole = elementInfo?.semanticRole || 'data-mark'

  // --- A. Data mark ---
  if (semanticRole === 'data-mark') {
    // Unified classification-based scope for annotation layers
    if (elementInfo?.layerClassification && elementInfo.layerClassification.type !== 'data-mark') {
      return generateLayerAwareScopes(elementInfo.layerContext, datum, elementInfo.layerIndex, elementInfo.layerClassification)
    }
    // Legacy layer-aware scope (fallback)
    if (elementInfo?.layerContext && elementInfo.layerContext.layerType !== 'data-mark') {
      return generateLayerAwareScopes(elementInfo.layerContext, datum, elementInfo.layerIndex)
    }
    return generateDataMarkScopeOptions(spec, datum, elementInfo, property)
  }

  // --- B. Axis ---
  if (semanticRole === 'axis') {
    return generateAxisScopeOptions(elementInfo)
  }

  // --- C. Legend ---
  if (semanticRole === 'legend') {
    return generateLegendScopeOptions(elementInfo)
  }

  // --- D. Text (standalone) ---
  if (semanticRole === 'text') {
    return [
      { label: 'All Text', value: { type: 'all-text' }, description: 'Apply to all text elements' },
      { label: 'This Element Only', value: { type: 'this-only' }, description: 'SVG override only' }
    ]
  }

  // --- E. Other ---
  return [
    { label: 'This Element Only', value: { type: 'this-only' }, description: 'SVG override only' }
  ]
}

function generateDataMarkScopeOptions(spec, datum, elementInfo, property) {
  // Composite mark → different options
  const compositeType = elementInfo?.compositeMarkType
  const subPart = elementInfo?.compositeSubPart
  if (compositeType && subPart) {
    return generateCompositeScopeOptions(spec, datum, elementInfo)
  }

  const options = []

  // Mark type label from markGroup
  const markGroupLabels = {
    'mark-rect': 'All Bars', 'mark-line': 'All Lines', 'mark-symbol': 'All Points',
    'mark-area': 'All Areas', 'mark-arc': 'All Arcs', 'mark-text': 'All Text Marks',
    'mark-rule': 'All Rules'
  }
  const markGroup = elementInfo?.markGroup
  const allLabel = markGroupLabels[markGroup] || 'All Marks'
  options.push({
    label: allLabel,
    value: { type: 'all-marks' },
    description: 'Apply to all marks of this type'
  })

  // Layer data isolation: only use fields available to THIS layer's data context
  const layerIdx = elementInfo?.layerIndex
  const allowedFields = (layerIdx != null && spec?.layer?.[layerIdx])
    ? getLayerDataFields(spec.layer[layerIdx], spec)
    : null // null = no restriction (non-layer spec)

  // By-field options from encoding (dedup across channels)
  const encoding = spec?.encoding || {}
  const categoricalTypes = ['nominal', 'ordinal']
  const seenByFields = new Set()
  for (const [, enc] of Object.entries(encoding)) {
    if (!enc || !enc.field) continue
    if (!categoricalTypes.includes(enc.type || '')) continue
    const field = enc.field
    if (seenByFields.has(field)) continue
    if (allowedFields && !allowedFields.includes(field)) continue
    seenByFields.add(field)
    const datumValue = datum ? datum[field] : null
    const label = datumValue != null ? `By ${field} (= "${datumValue}")` : `By ${field}`
    options.push({
      label,
      value: { type: 'by-field', field, fieldValue: datumValue },
      description: `condition on ${field}`
    })
  }

  // Check layer encodings — only from the SELECTED layer (if known) or shared-data layers
  if (spec?.layer) {
    for (let li = 0; li < spec.layer.length; li++) {
      // If layer index is known, only scan that specific layer's encoding
      if (layerIdx != null && li !== layerIdx) continue
      const layer = spec.layer[li]
      // Skip layers with their own inline data (different data context) unless it's the selected layer
      if (layerIdx == null && layer.data?.values) continue
      for (const [, enc] of Object.entries(layer.encoding || {})) {
        if (!enc?.field || seenByFields.has(enc.field)) continue
        if (!categoricalTypes.includes(enc.type || '')) continue
        const field = enc.field
        if (allowedFields && !allowedFields.includes(field)) continue
        seenByFields.add(field)
        const datumValue = datum ? datum[field] : null
        options.push({
          label: datumValue != null ? `By ${field} (= "${datumValue}")` : `By ${field}`,
          value: { type: 'by-field', field, fieldValue: datumValue },
          description: `condition on ${field}`
        })
      }
    }
  }

  // Continuous scale options (quantitative/temporal encodings)
  if (property) {
    const bindings = analyzeEncodingBindings(spec, datum, property, elementInfo?.layerIndex)
    const continuousBindings = bindings.filter(b => b.bindingKind === 'continuous' && b.isPropertyRelevant)
    for (const binding of continuousBindings) {
      const schemeLabel = binding.scale?.scheme
        ? `Change color scheme (${binding.scale.scheme})`
        : `Change ${binding.channel} scale`
      options.push({
        label: schemeLabel,
        value: { type: 'scale-modify', channel: binding.channel, field: binding.field },
        description: `Modify the ${binding.channel} scale range/scheme`
      })
    }
  }

  // Condition-match options: predicate-based color mappings in encoding.color/fill.condition
  // Only relevant when modifying color/fill/stroke properties
  const isColorProperty = !property || ['fill', 'color', 'stroke'].includes(property)
  if (isColorProperty) {
    const allEncodings = []
    for (const ch of ['color', 'fill']) {
      const enc = spec?.encoding?.[ch]
      if (enc?.condition) allEncodings.push({ channel: ch, enc })
    }
    // Also check layers
    if (spec?.layer) {
      for (const layer of spec.layer) {
        for (const ch of ['color', 'fill']) {
          const enc = layer.encoding?.[ch]
          if (enc?.condition) allEncodings.push({ channel: ch, enc })
        }
      }
    }

    for (const { channel, enc } of allEncodings) {
      const conditions = Array.isArray(enc.condition) ? enc.condition : [enc.condition]
      const predicates = conditions.filter(c => c.test != null)
      if (predicates.length === 0) continue

      // Show only the condition that matches the clicked datum (or all if no datum)
      for (let i = 0; i < predicates.length; i++) {
        const cond = predicates[i]
        const matchesDatum = datum ? evaluateTestExpression(cond.test, datum) : null
        if (matchesDatum === false) continue // skip non-matching conditions
        const readableLabel = formatTestLabel(cond.test)
        options.push({
          label: `Condition: ${readableLabel}`,
          value: { type: 'condition-match', channel, conditionIndex: i },
          description: `Update color for condition: ${cond.test}`
        })
      }

      // Show default scope only if the clicked datum falls through to default
      const anyConditionMatched = datum
        ? predicates.some(c => evaluateTestExpression(c.test, datum) === true)
        : false
      if (enc.value != null && (!datum || !anyConditionMatched)) {
        options.push({
          label: 'Default',
          value: { type: 'condition-default', channel },
          description: 'Update the default color (when no condition matches)'
        })
      }
    }
  }

  // Facet
  if (spec?.facet) {
    const facetField = typeof spec.facet === 'string'
      ? spec.facet
      : spec.facet?.field || spec.facet?.row?.field || spec.facet?.column?.field
    if (facetField) {
      const datumValue = datum ? datum[facetField] : null
      options.push({
        label: datumValue != null ? `By ${facetField} (= "${datumValue}")` : `By ${facetField}`,
        value: { type: 'by-field', field: facetField, fieldValue: datumValue },
        description: `facet condition on ${facetField}`
      })
    }
  }

  options.push({
    label: 'This Element Only',
    value: { type: 'this-only' },
    description: 'Conditional encoding on this datum'
  })

  return options
}

function generateCompositeScopeOptions(spec, datum, elementInfo) {
  const { compositeMarkType, compositeSubPart } = elementInfo
  const options = []

  // Sub-part labels
  const subPartLabels = {
    box: 'All boxes', median: 'All median lines', rule: 'All whiskers',
    outliers: 'All outliers', ticks: 'All end caps',
    band: 'All bands', borders: 'All border lines',
  }
  const allLabel = subPartLabels[compositeSubPart] || `All ${compositeSubPart}`

  // Option 1: All same sub-parts via config
  options.push({
    label: allLabel,
    value: {
      type: 'composite-sub-all',
      compositeMarkType,
      compositeSubPart
    },
    description: `Apply to all ${compositeSubPart} via config.${compositeMarkType}.${compositeSubPart}`
  })

  // Option 2: By field (will use SVG override for composite)
  const encoding = spec?.encoding || {}
  const categoricalTypes = ['nominal', 'ordinal']
  for (const [, enc] of Object.entries(encoding)) {
    if (!enc?.field) continue
    if (!categoricalTypes.includes(enc.type || '')) continue
    const field = enc.field
    const datumValue = datum ? datum[field] : null
    const label = datumValue != null
      ? `By ${field} (= "${datumValue}")`
      : `By ${field}`
    options.push({
      label,
      value: { type: 'by-field', field, fieldValue: datumValue },
      description: `condition on ${field} (SVG override for composite)`
    })
  }

  // Option 3: This only
  options.push({
    label: 'This Element Only',
    value: { type: 'this-only' },
    description: 'SVG override only'
  })

  return options
}

function generateAxisScopeOptions(elementInfo) {
  const channel = elementInfo?.axisChannel || 'x'
  const subType = elementInfo?.axisSubType
  const options = []

  if (subType) {
    // Clicked a specific sub-element
    const subLabels = { domain: 'Domain Line', tick: 'Ticks', label: 'Labels', title: 'Title', grid: 'Gridlines' }
    options.push({
      label: `All ${channel.toUpperCase()}-Axis ${subLabels[subType] || subType}`,
      value: { type: 'same-type-in-axis', axisChannel: channel, axisSubType: subType },
      description: `Apply to all ${subType} elements in ${channel}-axis`
    })
    const allAxesSubLabels = { domain: 'Domain Line', tick: 'Ticks', label: 'Labels', title: 'Title', grid: 'Gridlines' }
    options.push({
      label: `All Axes ${allAxesSubLabels[subType] || subType}`,
      value: { type: 'same-type-all-axes', axisSubType: subType },
      description: `Apply to all ${subType} elements across all axes`
    })
  }

  options.push({
    label: `Entire ${channel.toUpperCase()}-Axis`,
    value: { type: 'all-in-axis', axisChannel: channel },
    description: `Apply to entire ${channel}-axis`
  })
  options.push({
    label: 'All Axes',
    value: { type: 'all-axes' },
    description: 'Apply to all axes'
  })
  options.push({
    label: 'This Element Only',
    value: { type: 'this-only' },
    description: 'SVG override only'
  })

  return options
}

function generateLegendScopeOptions(elementInfo) {
  const legendField = elementInfo?.legendField
  const legendValue = elementInfo?.legendValue
  const legendSubType = elementInfo?.legendSubType
  const options = []

  if (legendSubType === 'symbol') {
    // Symbol: affect data marks + legend
    if (legendField && legendValue != null) {
      options.push({
        label: `Legend + Data (${legendField}="${legendValue}")`,
        value: { type: 'legend-with-data', legendField, legendValue },
        description: 'Change legend item and linked data series together'
      })
    }
    options.push({
      label: 'All Legend Symbols',
      value: { type: 'all-legend-symbols' },
      description: 'Apply to all legend symbols'
    })
  } else if (legendSubType === 'label') {
    options.push({
      label: 'All Legend Labels',
      value: { type: 'all-legend-labels' },
      description: 'Apply to all legend label text'
    })
  } else if (legendSubType === 'title') {
    options.push({
      label: 'Legend Title',
      value: { type: 'legend-title' },
      description: 'Apply to legend title text'
    })
  } else {
    // legendSubType unknown (e.g., unified scope mods) — include all sub-type options
    if (legendField && legendValue != null) {
      options.push({
        label: `Legend + Data (${legendField}="${legendValue}")`,
        value: { type: 'legend-with-data', legendField, legendValue },
        description: 'Change legend item and linked data series together'
      })
    }
    options.push({
      label: 'All Legend Symbols',
      value: { type: 'all-legend-symbols' },
      description: 'Apply to all legend symbols'
    })
    options.push({
      label: 'All Legend Labels',
      value: { type: 'all-legend-labels' },
      description: 'Apply to all legend label text'
    })
    options.push({
      label: 'This Legend Item Only',
      value: { type: 'legend-item-only' },
      description: 'Change only this legend swatch/label'
    })
  }

  options.push({
    label: 'All Legend Items',
    value: { type: 'all-in-legend' },
    description: 'Apply to entire legend'
  })
  options.push({
    label: 'This Element Only',
    value: { type: 'this-only' },
    description: 'SVG override only'
  })

  return options
}

// Map property names to Vega-Lite encoding channel names
// Map property names to Vega-Lite encoding channel names.
// For fill/color, the channel is resolved dynamically in applyByFieldScope
// to avoid conflicts between 'color' and 'fill' encodings.
const propToChannel = {
  fill: 'fill',
  color: 'fill',
  stroke: 'stroke',
  strokeWidth: 'strokeWidth',
  opacity: 'opacity',
  size: 'size',
  shape: 'shape'
}

// Map Vega mark group class to Vega-Lite mark type
const markGroupToMarkType = {
  'mark-area': 'area',
  'mark-line': 'line',
  'mark-rect': 'bar',
  'mark-symbol': 'point',
  'mark-text': 'text',
  'mark-arc': 'arc',
  'mark-rule': 'rule',
}

// Properties that can be expressed as Vega-Lite conditional encodings
const ENCODABLE_PROPERTIES = new Set(['fill', 'color', 'stroke', 'opacity', 'size', 'strokeWidth', 'shape'])

/**
 * Extract categorical fields from the spec's encoding (used to build datum test expressions).
 */
function getCategoricalFields(spec) {
  const fields = []
  const categoricalTypes = ['nominal', 'ordinal']
  const encodingSources = []
  if (spec?.encoding) encodingSources.push(spec.encoding)
  if (spec?.layer) {
    for (const layer of spec.layer) {
      if (layer.encoding) encodingSources.push(layer.encoding)
    }
  }
  const seen = new Set()
  for (const encoding of encodingSources) {
    for (const [, enc] of Object.entries(encoding)) {
      if (!enc?.field || seen.has(enc.field)) continue
      if (!categoricalTypes.includes(enc.type || '')) continue
      seen.add(enc.field)
      fields.push({ field: enc.field, type: enc.type })
    }
  }
  return fields
}

/**
 * Build a Vega expression test string that uniquely identifies a datum.
 * Uses ALL non-internal datum fields to ensure unique element identification.
 * (Categorical-only was insufficient — e.g., Island=Dream matches multiple rows.)
 */
function buildDatumTest(datum, spec) {
  if (!datum) return null
  const conditions = []
  const skippedKeys = []
  for (const [key, val] of Object.entries(datum)) {
    if (key.startsWith('_') || val == null) continue
    // Skip Vega runtime aggregate fields (but keep bin_ fields for unique bin identification)
    if (/^(count|sum|mean|median|min|max|stdev|q1|q3|distinct|missing|valid)_/.test(key)) {
      skippedKeys.push(key)
      continue
    }
    // Skip very large numbers (likely computed aggregates)
    if (typeof val === 'number' && Math.abs(val) > 1e12) {
      skippedKeys.push(`${key}(large:${val})`)
      continue
    }
    if (typeof val === 'number') {
      conditions.push(`datum['${key}'] === ${val}`)
    } else if (typeof val === 'string') {
      const escaped = String(val).replace(/'/g, "\\'")
      conditions.push(`datum['${key}'] === '${escaped}'`)
    }
  }
  const result = conditions.length > 0 ? conditions.join(' && ') : null
  return result
}

/**
 * Apply a conditional encoding for an individual element modification.
 * This replaces SVG direct overrides — the modification lives in the spec.
 */
// Pull the field name a datum-test references, e.g. datum['bg'] / datum.bg / datum["bg"].
function fieldFromTest(testExpr) {
  if (!testExpr || typeof testExpr !== 'string') return null
  const m = testExpr.match(/datum(?:\[\s*['"]([^'"]+)['"]\s*\]|\.([A-Za-z_$][\w$]*))/)
  return m ? (m[1] || m[2]) : null
}
// A layer's effective first data row (own inline data, else inherited top-level data).
function layerEffectiveDataRow(spec, layerIdx) {
  const data = spec.layer?.[layerIdx]?.data || spec.data
  return data?.values?.[0] || null
}
const rowHasField = (row, field) => !!row && Object.prototype.hasOwnProperty.call(row, field)

function applyIndividualConditionalEncoding(spec, property, testExpr, value, markGroup, layerIndex) {
  const condition = { test: testExpr, value }
  const targetMarkType = markGroup ? markGroupToMarkType[markGroup] : null

  // Layer guard: a field-based condition must live on a layer whose data actually carries
  // that field. Detection can capture the wrong layerIndex (e.g. a background rect whose
  // color field `bg` exists only in layer[0], but the mod lands on the primary bar layer).
  // There the test never matches and the change silently does nothing — so if the resolved
  // layer lacks the field, redirect to the layer whose OWN data owns it.
  if (spec.layer) {
    const field = fieldFromTest(testExpr)
    if (field && (layerIndex == null || !rowHasField(layerEffectiveDataRow(spec, layerIndex), field))) {
      const better = spec.layer.findIndex((ls) => rowHasField(ls?.data?.values?.[0], field))
      if (better >= 0) layerIndex = better
    }
  }

  // Point overlay on line/area: encoding changes affect both the line and points.
  // For most properties, use SVG override. For 'size', SVG override can't work
  // (no direct SVG attribute), so split into explicit layers and apply to point layer only.
  if (targetMarkType === 'point') {
    let isPointOverlay = false
    if (spec.layer && layerIndex != null) {
      const layerMark = spec.layer[layerIndex]?.mark
      const layerMarkType = typeof layerMark === 'string' ? layerMark : layerMark?.type
      if (layerMarkType && ['line', 'area'].includes(layerMarkType)) {
        isPointOverlay = true
      }
    } else if (!spec.layer) {
      const specMarkType = typeof spec.mark === 'string' ? spec.mark : spec.mark?.type
      if (specMarkType && ['line', 'area'].includes(specMarkType)) {
        isPointOverlay = true
      }
    }
    if (isPointOverlay) {
      if (property === 'size') {
        // Size: split into layers so encoding only affects the point layer
        if (!spec.layer) ensureLayerForPointOverlay(spec)
        // After split, find the point layer and apply there
        if (spec.layer) {
          const pointLayerIdx = spec.layer.findIndex(ls => {
            const mt = typeof ls.mark === 'string' ? ls.mark : ls.mark?.type
            return mt === 'point'
          })
          if (pointLayerIdx >= 0) {
            if (!spec.layer[pointLayerIdx].encoding) spec.layer[pointLayerIdx].encoding = {}
            const pointEnc = spec.layer[pointLayerIdx].encoding
            const pointMark = spec.layer[pointLayerIdx].mark
            const defaultSize = (typeof pointMark === 'object' ? pointMark.size : null) ?? 30
            if (!pointEnc.size) {
              pointEnc.size = { condition, value: defaultSize }
            } else if (pointEnc.size.condition) {
              const existing = Array.isArray(pointEnc.size.condition) ? pointEnc.size.condition : [pointEnc.size.condition]
              const idx = existing.findIndex(c => c.test === testExpr)
              if (idx >= 0) existing[idx].value = value
              else existing.unshift(condition)
              pointEnc.size.condition = existing
            } else {
              pointEnc.size = { ...pointEnc.size, condition }
            }
          }
          return // Applied directly, skip normal flow
        }
      }
      return false // Other properties: use SVG override
    }
  }

  // Find target encoding (top-level or matching layer)
  let targetEncoding = spec.encoding
  let targetLocation = 'top-level'
  if (spec.layer && layerIndex != null && layerIndex < spec.layer.length) {
    // Layer index known — target the specific layer directly
    if (!spec.layer[layerIndex].encoding) spec.layer[layerIndex].encoding = {}
    targetEncoding = spec.layer[layerIndex].encoding
    targetLocation = `layer[${layerIndex}]`
  } else if (spec.layer && targetMarkType) {
    const layerIdx = spec.layer.findIndex(ls => {
      const mt = typeof ls.mark === 'string' ? ls.mark : ls.mark?.type
      return mt === targetMarkType
    })
    if (layerIdx >= 0) {
      if (!spec.layer[layerIdx].encoding) spec.layer[layerIdx].encoding = {}
      targetEncoding = spec.layer[layerIdx].encoding
      targetLocation = `layer[${layerIdx}](by markType ${targetMarkType})`
    }
  }
  if (!targetEncoding) {
    if (!spec.encoding) spec.encoding = {}
    targetEncoding = spec.encoding
    targetLocation = 'top-level(fallback)'
  }
  // Resolve channel: avoid color/fill conflict
  // Determine if the mark renders as filled or stroked
  let resolvedMarkSpec = spec.mark
  if (spec.layer && layerIndex != null) resolvedMarkSpec = spec.layer[layerIndex]?.mark || spec.mark
  const resolvedMarkType = typeof resolvedMarkSpec === 'string' ? resolvedMarkSpec : resolvedMarkSpec?.type
  const isFilledMark = resolvedMarkSpec?.filled === true
    || !['point', 'line', 'rule'].includes(resolvedMarkType) // bars, areas, arcs are filled by default

  // Redirect to the field-bound color channel only when the property matches
  // what the color channel actually controls for this mark type:
  //   - Unfilled point/line: color → stroke. Only redirect stroke→color.
  //   - Filled point/bar/area: color → fill. Only redirect fill→color.
  //   - 'color' property always redirects to 'color' channel.
  let channel = propToChannel[property] || property
  if (targetEncoding.color?.field) {
    if (property === 'color') {
      channel = 'color'
    } else if (property === 'stroke' && !isFilledMark) {
      channel = 'color'
    } else if (property === 'fill' && isFilledMark) {
      channel = 'color'
    }
  } else if (targetEncoding.fill?.field && (property === 'fill' || property === 'color')) {
    channel = 'fill'
  }

  // If the resolved channel has no conditions, check the related channel (color↔fill).
  // Prefer the channel that already has conditions to avoid creating a parallel encoding.
  if (property === 'fill' || property === 'color') {
    const related = channel === 'color' ? 'fill' : channel === 'fill' ? 'color' : null
    if (related && !targetEncoding[channel]?.condition && targetEncoding[related]?.condition) {
      channel = related
    }
  }

  const existingEnc = targetEncoding[channel]

  if (!existingEnc) {
    // No encoding for this channel — create condition-only encoding
    const defaultValue = getOriginalMarkValue(property, spec, markGroup, layerIndex)
    targetEncoding[channel] = { condition, value: defaultValue }
  } else if (existingEnc.condition) {
    // Already has conditions — prepend new condition (highest priority = first)
    const existing = Array.isArray(existingEnc.condition) ? existingEnc.condition : [existingEnc.condition]
    const idx = existing.findIndex(c => c.test === testExpr)
    if (idx >= 0) {
      existing[idx].value = value
    } else {
      existing.unshift(condition)
    }
    existingEnc.condition = existing
    // Preserve existing default value (do NOT overwrite)
  } else if (existingEnc.field) {
    // Field-based encoding — add condition alongside
    targetEncoding[channel] = { ...existingEnc, condition }
  } else {
    // Value-only encoding — add condition, preserve existing default value
    targetEncoding[channel] = { ...existingEnc, condition }
  }

}

/**
 * Apply a property change to a single mark spec (non-layer).
 */
function applyToMarkSpec(spec, property, value) {
  if (typeof spec.mark === 'string') {
    spec.mark = { type: spec.mark }
  }
  
  if (property === 'fill' || property === 'color') {
    if (spec.mark.color !== undefined && property === 'fill') {
      spec.mark.color = value
    } else if (spec.mark.fill !== undefined && property === 'color') {
      spec.mark.fill = value
    } else {
      spec.mark[property] = value
    }
  } else {
    spec.mark[property] = value
  }
  
  if ((property === 'fill' || property === 'color') && spec.mark.type === 'point') {
    spec.mark.filled = true
  }
}

/**
 * Convert SVG stroke-dasharray string to Vega-Lite dash array.
 * e.g. "4,2" → [4,2], "solid" or "" → []
 */
function parseDashValue(value) {
  if (!value || value === 'solid' || value === 'none') return []
  if (Array.isArray(value)) return value
  return String(value).split(/[\s,]+/).map(Number).filter(n => !isNaN(n) && n > 0)
}

/**
 * Apply a direct mark/encoding edit in place on a layer spec.
 * Used for annotation-direct, annotation-layer, all-in-layer scopes.
 */
function applyDirectMarkEditInPlace(layer, property, value) {
  const COLOR_PROPS = new Set(['fill', 'color'])
  const MARK_PROPS = new Set(['opacity', 'strokeWidth', 'stroke', 'strokeDash', 'cornerRadius', 'size'])

  if (property === 'text') {
    // Text content: encoding.text overrides mark.text, so handle encoding first
    if (layer.encoding?.text) {
      // Remove field-based encoding and set static value
      layer.encoding.text = { value }
    }
    // Also set mark.text for marks that use it directly
    if (typeof layer.mark === 'string') layer.mark = { type: layer.mark }
    layer.mark.text = value
  } else if (COLOR_PROPS.has(property)) {
    if (layer.mark && typeof layer.mark === 'object' && layer.mark.color !== undefined) {
      layer.mark.color = value
    } else if (layer.encoding?.color?.value !== undefined) {
      layer.encoding.color.value = value
    } else if (layer.encoding?.fill?.value !== undefined) {
      layer.encoding.fill.value = value
    } else {
      // Set color on the mark object to avoid destroying field-based encodings
      if (typeof layer.mark === 'string') {
        layer.mark = { type: layer.mark, color: value }
      } else {
        layer.mark = { ...layer.mark, color: value }
      }
    }
  } else if (MARK_PROPS.has(property)) {
    if (typeof layer.mark === 'string') layer.mark = { type: layer.mark }
    layer.mark[property] = value
  } else {
    if (typeof layer.mark === 'string') layer.mark = { type: layer.mark }
    layer.mark[property] = value
  }
}

/**
 * Resolve which inline data field corresponds to the given visual property.
 * Only returns fields that are actually used in the layer's encoding.
 */
function resolveInlineDataField(layer, property) {
  const encoding = layer.encoding || {}
  const COLOR_PROPS = ['fill', 'color', 'stroke']
  const POSITION_X_PROPS = ['x']
  const POSITION_X2_PROPS = ['x2']
  const POSITION_Y_PROPS = ['y']
  const POSITION_Y2_PROPS = ['y2']

  // For color properties: check if color/fill encoding uses a field from inline data
  if (COLOR_PROPS.includes(property)) {
    for (const ch of ['color', 'fill']) {
      if (encoding[ch]?.field && layer.data?.values) {
        const inlineFields = Object.keys(layer.data.values[0] || {})
        if (inlineFields.includes(encoding[ch].field)) return encoding[ch].field
      }
    }
  }

  // For position properties: check x/x2/y/y2 encoding fields
  if (POSITION_X_PROPS.includes(property) && encoding.x?.field) {
    const inlineFields = Object.keys(layer.data?.values?.[0] || {})
    if (inlineFields.includes(encoding.x.field)) return encoding.x.field
  }
  if (POSITION_X2_PROPS.includes(property) && encoding.x2?.field) {
    const inlineFields = Object.keys(layer.data?.values?.[0] || {})
    if (inlineFields.includes(encoding.x2.field)) return encoding.x2.field
  }
  if (POSITION_Y_PROPS.includes(property) && encoding.y?.field) {
    const inlineFields = Object.keys(layer.data?.values?.[0] || {})
    if (inlineFields.includes(encoding.y.field)) return encoding.y.field
  }
  if (POSITION_Y2_PROPS.includes(property) && encoding.y2?.field) {
    const inlineFields = Object.keys(layer.data?.values?.[0] || {})
    if (inlineFields.includes(encoding.y2.field)) return encoding.y2.field
  }

  return null
}

/**
 * Apply a color modification to an inline-data layer, handling scale domain/range correctly.
 *
 * If the color encoding uses an explicit scale (domain+range), update the scale range entries
 * instead of the data values — otherwise Vega-Lite can't map the new color.
 * If scale is null or absent, modify data values directly (they ARE the raw colors).
 *
 * @param {Object} layer - the layer spec (mutated in place)
 * @param {string} colorField - the field name used in color encoding
 * @param {string} colorChannel - 'color' or 'fill'
 * @param {any} newValue - new color value
 * @param {number|null} rowIndex - specific row to change (null = all rows)
 * @param {Object|null} datum - clicked datum (for matching domain entry in this-element scope)
 */
function applyInlineColorEdit(layer, colorField, colorChannel, newValue, rowIndex, datum) {
  const enc = layer.encoding?.[colorChannel]
  const scale = enc?.scale

  // Case 1: explicit scale with domain/range — update range
  if (scale && scale !== null && scale.domain && scale.range) {
    if (rowIndex === null) {
      // All elements: set all range entries to the new color
      for (let i = 0; i < scale.range.length; i++) {
        scale.range[i] = newValue
      }
    } else {
      // This element: find which domain value the clicked datum has, update that range entry
      const datumColorValue = datum ? datum[colorField] : (layer.data.values[rowIndex]?.[colorField])
      const domainIdx = scale.domain.indexOf(datumColorValue)
      if (domainIdx >= 0 && domainIdx < scale.range.length) {
        scale.range[domainIdx] = newValue
      } else {
        // Domain value not found — add it
        scale.domain.push(datumColorValue)
        scale.range.push(newValue)
      }
    }
    return
  }

  // Case 2: scale: null or no scale — modify data values directly (they are raw colors)
  if (rowIndex === null) {
    for (const row of layer.data.values) {
      row[colorField] = newValue
    }
  } else {
    if (layer.data.values[rowIndex]) {
      layer.data.values[rowIndex][colorField] = newValue
    }
  }
}

/**
 * Find the encoding channel that uses a visibility condition pattern
 * (condition with transparent/none fallback).
 */
function findVisibilityConditionChannel(layer) {
  const encoding = layer.encoding || {}
  for (const [channel, enc] of Object.entries(encoding)) {
    if (enc?.condition && enc.value !== undefined) {
      const fallback = enc.value
      if (
        fallback === 'transparent' ||
        fallback === 'none' ||
        fallback === 'rgba(0,0,0,0)' ||
        fallback === null ||
        (channel === 'opacity' && (fallback === 0 || fallback === '0'))
      ) {
        return channel
      }
    }
  }
  return null
}

// --- Delete (filter-out) support ----------------------------------------
// Format a JS value as a Vega expression literal for equality comparison.
function vegaDeleteLiteral(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(String(v))
}

// Dimension fields (nominal/ordinal/temporal, non-aggregated) of an encoding —
// these identify *which* mark a datum belongs to. Quantitative measures are
// skipped because they're usually aggregated and won't match a raw datum value.
function getDeleteDimensionFields(spec, layerIndex) {
  const enc = (spec.layer && layerIndex != null && spec.layer[layerIndex]?.encoding) || spec.encoding || {}
  const fields = []
  for (const ch of Object.keys(enc)) {
    const e = enc[ch]
    if (!e || !e.field || e.aggregate) continue
    if (e.type === 'quantitative') continue
    fields.push(e.field)
  }
  return [...new Set(fields)]
}

// Build a Vega predicate that is TRUE for rows to KEEP (i.e. everything EXCEPT
// the element targeted by `mod`). Returns null when no reliable predicate can be
// derived (in which case nothing is filtered — safe, no accidental data loss).
function buildDeleteKeepPredicate(spec, mod) {
  const scope = mod.scope || {}
  const datum = mod.datum || {}

  // Delete a whole category/series selected by field=value.
  if (scope.type === 'by-field' && scope.field != null) {
    return `!(datum[${JSON.stringify(scope.field)}] === ${vegaDeleteLiteral(scope.fieldValue)})`
  }
  // Delete a whole series selected via its legend item.
  if (scope.type === 'legend-with-data' && scope.legendField != null) {
    return `!(datum[${JSON.stringify(scope.legendField)}] === ${vegaDeleteLiteral(scope.legendValue)})`
  }

  // Delete a single mark: match its datum across the dimension fields.
  let fields = getDeleteDimensionFields(spec, mod.layerIndex).filter(f => f in datum)
  if (fields.length === 0) {
    // Fallback: pin the exact row using every non-internal datum key.
    fields = Object.keys(datum).filter(k => k && !k.startsWith('__'))
  }
  if (fields.length === 0) return null
  const conds = fields.map(f => `datum[${JSON.stringify(f)}] === ${vegaDeleteLiteral(datum[f])}`)
  return `!(${conds.join(' && ')})`
}

// Legend-level config properties (as opposed to symbol visual props like fill/color/opacity).
// These are written to encoding[channel].legend[prop].
const LEGEND_CONFIG_PROPS = new Set([
  'orient', 'direction', 'title', 'padding', 'offset',
  'labelFontSize', 'symbolSize', 'fillColor', 'strokeColor',
])

// Write a legend config prop onto every field-bound legend channel in the spec
// (handles top-level encoding, layers, and a faceted inner spec).
function applyLegendConfig(spec, prop, value) {
  const hosts = []
  const collect = (s) => {
    if (s?.encoding) hosts.push(s.encoding)
    if (Array.isArray(s?.layer)) s.layer.forEach(l => l.encoding && hosts.push(l.encoding))
  }
  collect(spec)
  if (spec?.facet && spec?.spec) collect(spec.spec)
  for (const enc of hosts) {
    for (const ch of ['color', 'fill', 'stroke', 'shape', 'size', 'opacity']) {
      if (enc[ch]?.field && enc[ch].legend !== null) {
        if (!enc[ch].legend || typeof enc[ch].legend !== 'object') enc[ch].legend = {}
        if (value === '' || value == null) delete enc[ch].legend[prop]
        else enc[ch].legend[prop] = value
      }
    }
  }
}

export function applyModificationsToSpec(baseSpec, modifications) {
  const fullSpec = JSON.parse(JSON.stringify(baseSpec))
  // A faceted spec ({facet, spec}) keeps its real marks/encodings inside `.spec`.
  // Operate on that inner unit spec so element edits (color, mark opts, axes) land
  // in the right place, then return the outer wrapper. The inner spec has no data of
  // its own (the facet owns it) — lend it the outer data so data-dependent color
  // logic (alphaSorted scale ranges) still works, then remove it before returning.
  const isFacet = !!(fullSpec.facet && fullSpec.spec)
  const spec = isFacet ? fullSpec.spec : fullSpec
  const borrowedData = isFacet && !spec.data && fullSpec.data ? (spec.data = fullSpec.data, true) : false
  const svgOverrides = {}

  // A top-level mark is ignored by Vega-Lite when the spec is layered. Strip any
  // leftover (e.g. from an earlier non-layered state or a mis-targeted edit) so it
  // can't shadow the per-layer marks or fool the composite-mark detection below.
  if (Array.isArray(spec.layer) && spec.mark) delete spec.mark

  // Ensure mark is an object (for non-layer specs)
  if (spec.mark && typeof spec.mark === 'string') {
    spec.mark = { type: spec.mark }
  }

  // Detect if spec uses a composite mark type
  const COMPOSITE_MARK_TYPES = { boxplot: true, errorbar: true, errorband: true }
  const topMarkType = typeof spec.mark === 'string' ? spec.mark : spec.mark?.type
  const isCompositeSpec = !!(topMarkType && COMPOSITE_MARK_TYPES[topMarkType])

  // Expand grouped modifications into individual sub-modifications
  const expandedMods = []
  for (const mod of modifications) {
    if (mod.group && Array.isArray(mod.group)) {
      // Expand group into individual mods sharing the same property/value
      for (const item of mod.group) {
        expandedMods.push({
          ...item,
          property: mod.property,
          value: mod.value,
        })
      }
    } else {
      expandedMods.push(mod)
    }
  }

  for (const mod of expandedMods) {
    const { property, value, scope, selector, markGroup, layerIndex } = mod

    // Legend CONFIG props (orient/direction/offset/padding/title/box colors/…) are written
    // to the field-bound legend channel's `legend` object, so legend edits appear as normal
    // modifications in the stack instead of a silent direct-spec edit. (Symbol color edits
    // use property 'fill'/'color' → NOT in LEGEND_CONFIG_PROPS → normal legend handling.)
    if (mod.semanticRole === 'legend' && LEGEND_CONFIG_PROPS.has(property)) {
      applyLegendConfig(spec, property, value)
      continue
    }

    // dx/dy are always applied as SVG overrides (position offsets for non-data elements)
    if ((property === 'dx' || property === 'dy') && selector) {
      if (!svgOverrides[selector]) svgOverrides[selector] = {}
      svgOverrides[selector][property] = value
      continue
    }

    // Delete: filter the targeted data out of the spec. Fully reversible — removing
    // this modification restores the data. Targets the owning layer when known,
    // otherwise the top-level spec (shared data).
    if (property === '__delete__') {
      const keep = buildDeleteKeepPredicate(spec, mod)
      if (keep) {
        const target = (spec.layer && layerIndex != null && spec.layer[layerIndex])
          ? spec.layer[layerIndex]
          : spec
        if (!Array.isArray(target.transform)) target.transform = []
        if (!target.transform.some(t => t && t.filter === keep)) {
          target.transform.push({ filter: keep })
        }
      }
      continue
    }

    // --- Data mark scopes ---
    if (scope.type === 'all' || scope.type === 'all-marks') {
      // For composite marks, route through config instead of spec.mark
      // Setting spec.mark[property] on composite marks cascades to ALL sub-marks
      if (isCompositeSpec && mod.compositeSubPart) {
        // Use config path for the specific sub-part
        const compositeType = mod.compositeMarkType || topMarkType
        const subPart = mod.compositeSubPart
        if (!spec.config) spec.config = {}
        if (!spec.config[compositeType]) spec.config[compositeType] = {}
        if (!spec.config[compositeType][subPart]) spec.config[compositeType][subPart] = {}
        spec.config[compositeType][subPart][property] = value
      } else if (isCompositeSpec) {
        // Composite mark, no sub-part → apply to mark level directly
        // e.g., boxplot fill color set via spec.mark.fill
        if (typeof spec.mark === 'string') {
          spec.mark = { type: spec.mark, [property]: value }
        } else {
          spec.mark = { ...spec.mark, [property]: value }
        }
      } else if (spec.layer && layerIndex != null && layerIndex < spec.layer.length) {
        // Layer index known — apply directly to the specific layer
        const cloned = JSON.parse(JSON.stringify(spec.layer[layerIndex]))
        const targetMarkType = markGroup ? markGroupToMarkType[markGroup] : null
        const layerMarkType = typeof cloned.mark === 'string' ? cloned.mark : cloned.mark?.type

        // Handle point overlay in line/area layers
        if (targetMarkType === 'point' && ['line', 'area'].includes(layerMarkType)) {
          const markObj = typeof cloned.mark === 'string' ? { type: cloned.mark } : cloned.mark
          if (markObj.point === true) {
            markObj.point = { [property]: value }
          } else if (markObj.point && typeof markObj.point === 'object') {
            markObj.point[property] = value
          }
          if ((property === 'fill' || property === 'color') && markObj.point && typeof markObj.point === 'object') {
            markObj.point.filled = true
          }
          cloned.mark = markObj
        } else {
          applyToMarkSpec(cloned, property, value)
        }
        spec.layer[layerIndex] = cloned
      } else if (spec.layer && markGroup) {
        const targetMarkType = markGroupToMarkType[markGroup]
        if (targetMarkType) {
          spec.layer = spec.layer.map(layerSpec => {
            const layerMarkType = typeof layerSpec.mark === 'string' ? layerSpec.mark : layerSpec.mark?.type
            if (layerMarkType === targetMarkType) {
              const cloned = JSON.parse(JSON.stringify(layerSpec))
              applyToMarkSpec(cloned, property, value)
              return cloned
            }
            return layerSpec
          })
        } else if (spec.mark) {
          spec.mark[property] = value
        }
      } else if (spec.mark) {
        // Non-layer: if markGroup is set, only apply if it matches the spec mark type
        if (markGroup) {
          const targetMarkType = markGroupToMarkType[markGroup]
          const specMarkType = typeof spec.mark === 'string' ? spec.mark : spec.mark?.type
          if (!targetMarkType || targetMarkType === specMarkType) {
            applyToMarkSpec(spec, property, value)
          } else if (targetMarkType === 'point' && ['line', 'area'].includes(specMarkType)) {
            // Line/area chart with overlay points (mark.point: true)
            // Apply to the point overlay config
            const markObj = typeof spec.mark === 'string' ? { type: spec.mark } : spec.mark
            if (markObj.point === true) {
              markObj.point = { [property]: value }
            } else if (markObj.point && typeof markObj.point === 'object') {
              markObj.point[property] = value
            }
            // Also set filled: true for fill property on point overlay
            if ((property === 'fill' || property === 'color') && markObj.point && typeof markObj.point === 'object') {
              markObj.point.filled = true
            }
            spec.mark = markObj
          }
          // else: markGroup doesn't match spec mark → skip
        } else {
          spec.mark[property] = value
        }
      }

    } else if (scope.type === 'by-field') {
      // Composite marks don't support encoding conditions — fall back to SVG override
      if ((mod.compositeMarkType || isCompositeSpec) && selector) {
        if (!svgOverrides[selector]) svgOverrides[selector] = {}
        svgOverrides[selector][property] = value
      } else {
        applyByFieldScope(spec, mod)
      }

    } else if (scope.type === 'composite-sub-all') {
      // Apply to specific sub-part of composite mark via Vega-Lite config
      const compositeType = scope.compositeMarkType || mod.compositeMarkType
      const subPart = scope.compositeSubPart || mod.compositeSubPart
      if (compositeType && subPart) {
        // Line sub-parts (median/whisker/tick/borders) are strokes → use `color`, not fill/stroke.
        const lineSubParts = new Set(['median', 'rule', 'ticks', 'borders'])
        const subProp = (lineSubParts.has(subPart) && (property === 'fill' || property === 'color' || property === 'stroke'))
          ? 'color' : property
        // Vega-Lite honors `config` only at the root spec — on a faceted chart
        // that's the outer wrapper, not the inner unit spec.
        const configHost = isFacet ? fullSpec : spec
        if (!configHost.config) configHost.config = {}
        if (!configHost.config[compositeType]) configHost.config[compositeType] = {}
        if (!configHost.config[compositeType][subPart]) configHost.config[compositeType][subPart] = {}
        configHost.config[compositeType][subPart][subProp] = value
      }

    } else if (scope.type === 'scale-modify') {
      // Modify continuous scale (range endpoints or scheme)
      const channel = scope.channel
      applyScaleModifyScope(spec, channel, property, value)

    } else if (scope.type === 'this-only') {
      // Composite marks (boxplot/errorbar/errorband): a single box's sub-part (box, median,
      // whisker=rule, outliers, ticks) CANNOT be isolated per-datum. Route the edit to the
      // mark's sub-part config so it lands correctly, e.g. mark.median.color for a boxplot
      // median. Line sub-parts (median/whisker/tick/borders) use `color` for their line.
      if (mod.compositeMarkType && mod.compositeSubPart) {
        const subPart = mod.compositeSubPart
        const lineSubParts = new Set(['median', 'rule', 'ticks', 'borders'])
        const subProp = (lineSubParts.has(subPart) && (property === 'fill' || property === 'color' || property === 'stroke'))
          ? 'color' : property
        const applyToCompositeMark = (host) => {
          if (!host) return
          const m = typeof host.mark === 'string' ? { type: host.mark } : { ...(host.mark || {}) }
          m[subPart] = { ...(typeof m[subPart] === 'object' ? m[subPart] : {}), [subProp]: value }
          host.mark = m
        }
        if (spec.layer && layerIndex != null && layerIndex < spec.layer.length) {
          applyToCompositeMark(spec.layer[layerIndex])
        } else if (spec.layer) {
          const idx = spec.layer.findIndex(l => (typeof l.mark === 'string' ? l.mark : l.mark?.type) === mod.compositeMarkType)
          applyToCompositeMark(spec.layer[idx >= 0 ? idx : 0])
        } else {
          applyToCompositeMark(spec)
        }
      // Text marks in layers: apply directly to spec instead of SVG override
      } else if (mod.semanticRole === 'text' && layerIndex != null && spec.layer && layerIndex < spec.layer.length) {
        applyDirectMarkEditInPlace(spec.layer[layerIndex], property, value)
      // Continuous marks (area, line): one connected path spans ALL data points,
      // so there is no per-datum part to isolate. A datum-conditional encoding
      // would split & corrupt the mark (broken area wedge / segmented line).
      // For a single series, set the mark-level color directly — clean, in-spec,
      // and (for area+line) colors only the area, never the line:true overlay.
      // For multi-series (color field), isolate the clicked path via SVG override.
      } else if (mod.markGroup === 'mark-area' || mod.targetType === 'AREA' || mod.markGroup === 'mark-line' || mod.targetType === 'LINE') {
        // Resolve the target layer. NEVER fall back to the top-level spec when the
        // spec is layered: Vega-Lite ignores spec.mark while spec.layer exists, so
        // the edit would silently not render. When layerIndex is missing (e.g. a
        // line layer with no own encoding fails SVG layer detection), locate the
        // matching line/area layer by mark type, defaulting to the first layer.
        let target
        if (spec.layer && layerIndex != null && layerIndex < spec.layer.length) {
          target = spec.layer[layerIndex]
        } else if (spec.layer && spec.layer.length > 0) {
          const wantType = (mod.markGroup === 'mark-area' || mod.targetType === 'AREA') ? 'area' : 'line'
          const li = spec.layer.findIndex(l => {
            const mt = typeof l.mark === 'string' ? l.mark : l.mark?.type
            return mt === wantType
          })
          target = spec.layer[li >= 0 ? li : 0]
        } else {
          target = spec
        }
        const hasColorField = !!(target.encoding?.color?.field || target.encoding?.fill?.field || target.encoding?.stroke?.field)
        const targetMarkType = typeof target.mark === 'string' ? target.mark : target.mark?.type
        // The line:true overlay of an AREA is styled via mark.line, NOT mark.stroke
        // (mark.stroke colors the area's own border, leaving the overlay unchanged).
        const isAreaLineOverlay = targetMarkType === 'area' && (mod.markGroup === 'mark-line' || mod.targetType === 'LINE')
        if (ENCODABLE_PROPERTIES.has(property) && !hasColorField) {
          if (isAreaLineOverlay) {
            if (typeof target.mark === 'string') target.mark = { type: target.mark }
            if (!target.mark.line || target.mark.line === true) target.mark.line = {}
            const lineProp = (property === 'stroke' || property === 'color') ? 'color' : property
            target.mark.line[lineProp] = value
          } else {
            applyDirectMarkEditInPlace(target, property, value)
          }
        } else if (selector) {
          // Multi-series, or a non-encodable property (e.g. strokeDash) → SVG override
          if (!svgOverrides[selector]) svgOverrides[selector] = {}
          svgOverrides[selector][property] = value
        }
      // For data marks with datum, use conditional encoding instead of SVG override
      } else if (mod.semanticRole === 'data-mark' && mod.datum && ENCODABLE_PROPERTIES.has(property)) {
        const testExpr = buildDatumTest(mod.datum, spec)
        if (testExpr) {
          const applied = applyIndividualConditionalEncoding(spec, property, testExpr, value, mod.markGroup, layerIndex)
          // If returned false (e.g., point overlay on line layer), fall back to SVG override
          if (applied === false && selector) {
            if (!svgOverrides[selector]) svgOverrides[selector] = {}
            svgOverrides[selector][property] = value
          }
        } else if (selector) {
          // Fallback: can't build test — use SVG override
          if (!svgOverrides[selector]) svgOverrides[selector] = {}
          svgOverrides[selector][property] = value
        }
      // Axis elements (title/label/tick/grid/domain): there is only ONE axis per channel,
      // so "this element" can't be isolated. Route the edit to the axis config IN-SPEC so it
      // persists across re-renders. A selector-based SVG override is fragile here — the axis
      // title's aria-label selector depends on its text, so changing the text (or the font
      // size, which re-renders it) breaks the override and the edit reverts.
      } else if (mod.semanticRole === 'axis' && mod.axisSubType && (mod.axisChannel || scope.axisChannel)) {
        const axCh = mod.axisChannel || scope.axisChannel
        const axisPropName = buildAxisPropName(mod.axisSubType, property)
        // Write to the encoding object that ACTUALLY owns this channel — top-level for a
        // simple spec, or the matching layer for a layered one. Never fabricate a top-level
        // encoding on a layered spec (a field-less `encoding.y` breaks the whole chart).
        let encHost = spec.encoding?.[axCh] ? spec.encoding : null
        if (!encHost && Array.isArray(spec.layer)) {
          for (const l of spec.layer) { if (l.encoding?.[axCh]) { encHost = l.encoding; break } }
        }
        if (axisPropName && encHost) {
          if (!encHost[axCh].axis) encHost[axCh].axis = {}
          encHost[axCh].axis[axisPropName] = axisPropName.endsWith('Dash') ? parseDashValue(value) : value
        } else if (selector) {
          if (!svgOverrides[selector]) svgOverrides[selector] = {}
          svgOverrides[selector][property] = value
        }
      } else if (selector) {
        // Non-data-mark or non-encodable property — SVG override
        if (!svgOverrides[selector]) svgOverrides[selector] = {}
        svgOverrides[selector][property] = value
      }

    // --- Axis scopes ---
    } else if (scope.type === 'same-type-in-axis') {
      const ch = scope.axisChannel || mod.axisChannel
      const subType = scope.axisSubType || mod.axisSubType
      if (ch && subType) {
        ensureAxisConfig(spec, ch)
        const axisPropName = buildAxisPropName(subType, property)
        if (axisPropName) {
          // strokeDasharray → Dash: convert string "4,2" to array [4,2], "solid" to []
          const axisValue = axisPropName.endsWith('Dash') ? parseDashValue(value) : value
          spec.encoding[ch].axis[axisPropName] = axisValue
        }
      }

    } else if (scope.type === 'all-in-axis') {
      const ch = scope.axisChannel || mod.axisChannel
      if (ch) {
        ensureAxisConfig(spec, ch)
        // Apply to all sub-types in this axis
        for (const sub of ['domain', 'tick', 'label', 'title', 'grid']) {
          const axisPropName = buildAxisPropName(sub, property)
          if (axisPropName) {
            const axisValue = axisPropName.endsWith('Dash') ? parseDashValue(value) : value
            spec.encoding[ch].axis[axisPropName] = axisValue
          }
        }
      }

    } else if (scope.type === 'same-type-all-axes') {
      // Same sub-type across ALL axes (e.g., "All axes titles")
      const subType = scope.axisSubType || mod.axisSubType
      if (subType) {
        const axisPropName = buildAxisPropName(subType, property)
        if (axisPropName) {
          const axisValue = axisPropName.endsWith('Dash') ? parseDashValue(value) : value
          for (const ch of ['x', 'y']) {
            if (hasChannelEncoding(spec, ch)) {
              ensureAxisConfig(spec, ch)
              spec.encoding[ch].axis[axisPropName] = axisValue
            }
          }
        }
      }

    } else if (scope.type === 'all-axes') {
      // Apply to ALL sub-types across ALL axes
      for (const ch of ['x', 'y']) {
        if (hasChannelEncoding(spec, ch)) {
          ensureAxisConfig(spec, ch)
          for (const sub of ['domain', 'tick', 'label', 'title', 'grid']) {
            const axisPropName = buildAxisPropName(sub, property)
            if (axisPropName) {
              const axisValue = axisPropName.endsWith('Dash') ? parseDashValue(value) : value
              spec.encoding[ch].axis[axisPropName] = axisValue
            }
          }
        }
      }

    // --- Legend scopes ---
    } else if (scope.type === 'legend-with-data') {
      // Change both legend and linked data series via encoding scale
      const field = scope.legendField || mod.legendField
      const fieldValue = scope.legendValue || mod.legendValue
      if (field && fieldValue != null) {
        // Apply as by-field condition on the data marks
        const byFieldMod = { ...mod, scope: { type: 'by-field', field, fieldValue } }
        applyByFieldScope(spec, byFieldMod)
      } else {
        console.warn('[applyMod] legend-with-data SKIPPED — missing field or fieldValue')
      }

    } else if (scope.type === 'legend-item-only') {
      // SVG override for legend swatch only
      if (selector) {
        if (!svgOverrides[selector]) svgOverrides[selector] = {}
        svgOverrides[selector][property] = value
      }

    } else if (scope.type === 'all-legend-symbols') {
      // Apply to legend symbols via config + encoding-level legend
      if (!spec.config) spec.config = {}
      if (!spec.config.legend) spec.config.legend = {}
      const symbolProp = buildLegendPropName('symbol', property)
      if (symbolProp) {
        spec.config.legend[symbolProp] = value
        applyToEncodingLevelLegend(spec, symbolProp, value)
      }

    } else if (scope.type === 'all-legend-labels') {
      // Apply to legend label text via config + encoding-level legend
      if (!spec.config) spec.config = {}
      if (!spec.config.legend) spec.config.legend = {}
      const labelProp = buildLegendPropName('label', property)
      if (labelProp) {
        spec.config.legend[labelProp] = value
        applyToEncodingLevelLegend(spec, labelProp, value)
      }

    } else if (scope.type === 'legend-title') {
      // Apply to legend title text via config + encoding-level legend
      if (!spec.config) spec.config = {}
      if (!spec.config.legend) spec.config.legend = {}
      const titleProp = buildLegendPropName('title', property)
      if (titleProp) {
        spec.config.legend[titleProp] = value
        applyToEncodingLevelLegend(spec, titleProp, value)
      }

    } else if (scope.type === 'all-in-legend') {
      // Apply to ALL legend elements via config + encoding-level legend (symbols + labels + title)
      if (!spec.config) spec.config = {}
      if (!spec.config.legend) spec.config.legend = {}
      for (const sub of ['symbol', 'label', 'title']) {
        const legendProp = buildLegendPropName(sub, property)
        if (legendProp) {
          spec.config.legend[legendProp] = value
          applyToEncodingLevelLegend(spec, legendProp, value)
        }
      }

    // --- Text scope ---
    } else if (scope.type === 'all-text') {
      if (!spec.config) spec.config = {}
      if (!spec.config.text) spec.config.text = {}
      const textProp = property === 'color' || property === 'fill' ? 'color' : property
      spec.config.text[textProp] = value

    // --- Condition-match: update a specific predicate condition's value ---
    } else if (scope.type === 'condition-match') {
      const { channel, conditionIndex } = scope
      // Find the encoding and its owning layer (top-level or in layers)
      let targetEnc = spec.encoding?.[channel]
      let targetLayerEncoding = spec.encoding
      if (!targetEnc && spec.layer) {
        for (const layer of spec.layer) {
          if (layer.encoding?.[channel]?.condition) {
            targetEnc = layer.encoding[channel]
            targetLayerEncoding = layer.encoding
            break
          }
        }
      }
      // Map the edited property to the channel it belongs to. The scope's condition lives
      // on `channel` (e.g. color). If the property targets a DIFFERENT channel (e.g. opacity),
      // mirror the SAME test onto that channel — do NOT clobber the color condition's value
      // (that's what turned color.condition.value into an opacity number).
      const PROP_CHANNEL = { fill: 'color', color: 'color', stroke: 'stroke', opacity: 'opacity', fillOpacity: 'fillOpacity', size: 'size', strokeWidth: 'strokeWidth' }
      const isColorCh = (c) => c === 'color' || c === 'fill'
      const propChannel = PROP_CHANNEL[property] || property
      const sameChannel = (propChannel === channel) || (isColorCh(propChannel) && isColorCh(channel))
      // Sensible "otherwise" default for the new encoding's fallback value.
      const CHANNEL_DEFAULT = { opacity: 1, fillOpacity: 1, size: undefined, strokeWidth: undefined }
      if (!sameChannel && targetEnc?.condition) {
        // Property belongs to another channel — create/patch a condition there
        // using the SAME test expression from the matched condition.
        const conditions = Array.isArray(targetEnc.condition) ? targetEnc.condition : [targetEnc.condition]
        const matchedCondition = conditions[conditionIndex]
        if (matchedCondition?.test) {
          const dest = targetLayerEncoding[propChannel]
          if (!dest) {
            targetLayerEncoding[propChannel] = { condition: { test: matchedCondition.test, value }, value: CHANNEL_DEFAULT[property] ?? null }
          } else if (dest.condition) {
            const existingConds = Array.isArray(dest.condition) ? dest.condition : [dest.condition]
            const existingIdx = existingConds.findIndex(c => c.test === matchedCondition.test)
            if (existingIdx >= 0) existingConds[existingIdx] = { ...existingConds[existingIdx], value }
            else existingConds.push({ test: matchedCondition.test, value })
            dest.condition = existingConds.length === 1 ? existingConds[0] : existingConds
          } else {
            // channel exists as a plain value/field — attach a condition, keep its value as fallback
            targetLayerEncoding[propChannel] = { ...dest, condition: { test: matchedCondition.test, value } }
          }
        }
      } else if (targetEnc?.condition) {
        if (Array.isArray(targetEnc.condition)) {
          if (targetEnc.condition[conditionIndex]) {
            targetEnc.condition[conditionIndex] = { ...targetEnc.condition[conditionIndex], value }
          }
        } else if (conditionIndex === 0) {
          targetEnc.condition = { ...targetEnc.condition, value }
        }
      }

    // --- Condition-default: update the fallback value of a predicate condition encoding ---
    } else if (scope.type === 'condition-default') {
      const { channel } = scope
      // Check if the property matches what the channel controls (fill/color → color channel)
      const channelMatchesProperty = (property === 'fill' || property === 'color')
        || (property === 'stroke' && channel === 'stroke')
        || (property === 'opacity' && channel === 'opacity')
        || (property === 'strokeWidth' && channel === 'strokeWidth')

      if (channelMatchesProperty) {
        // Direct channel update: property matches the scope's channel
        let targetEnc = spec.encoding?.[channel]
        if (!targetEnc && spec.layer) {
          for (const layer of spec.layer) {
            if (layer.encoding?.[channel]?.condition) {
              targetEnc = layer.encoding[channel]
              break
            }
          }
        }
        if (targetEnc) {
          targetEnc.value = value
        }
      } else {
        // Property doesn't match the channel (e.g., stroke on a color condition-default scope).
        // Build a negated test from the condition to target "default" bars,
        // then create a separate encoding for the actual property.
        let targetEnc = spec.encoding?.[channel]
        let targetEncoding = spec.encoding
        if (!targetEnc && spec.layer) {
          for (const layer of spec.layer) {
            if (layer.encoding?.[channel]?.condition) {
              targetEnc = layer.encoding[channel]
              targetEncoding = layer.encoding
              break
            }
          }
        }
        if (targetEnc && targetEnc.condition) {
          // Build negated test: "default" = when none of the conditions match
          const conditions = Array.isArray(targetEnc.condition)
            ? targetEnc.condition
            : [targetEnc.condition]
          const negatedParts = conditions.map(c => `!(${c.test})`).filter(Boolean)
          const negatedTest = negatedParts.length > 1
            ? negatedParts.join(' && ')
            : negatedParts[0]
          if (negatedTest && targetEncoding) {
            const propChannel = propToChannel[property] || property
            const condition = { test: negatedTest, value }
            const existingPropEnc = targetEncoding[propChannel]
            if (!existingPropEnc) {
              const defaultValue = getOriginalMarkValue(property, spec, mod.markGroup, layerIndex)
              targetEncoding[propChannel] = { condition, value: defaultValue }
            } else if (existingPropEnc.condition) {
              const existing = Array.isArray(existingPropEnc.condition) ? existingPropEnc.condition : [existingPropEnc.condition]
              const idx = existing.findIndex(c => c.test === negatedTest)
              if (idx >= 0) existing[idx].value = value
              else existing.push(condition)
              existingPropEnc.condition = existing
            } else {
              targetEncoding[propChannel] = { ...existingPropEnc, condition }
            }
          }
        }
      }

    // --- Annotation layer scope ---
    } else if (scope.type === 'annotation-layer' || scope.type === 'annotation-direct' || scope.type === 'all-in-layer') {
      const li = layerIndex ?? scope.layerIndex
      const modStrategy = scope.modStrategy || mod.modStrategy
      if (spec.layer && li != null && li < spec.layer.length) {
        // Route by modification strategy if available
        if (modStrategy === 'inline-data-edit') {
          // Pattern C/D: modify inline data values or scale range
          const layer = spec.layer[li]
          if (layer.data?.values) {
            const fieldToEdit = resolveInlineDataField(layer, property)
            const isColorProp = ['fill', 'color', 'stroke'].includes(property)
            if (isColorProp && fieldToEdit) {
              // Color field: handle scale domain/range properly
              const colorChannel = layer.encoding?.fill?.field === fieldToEdit ? 'fill' : 'color'
              applyInlineColorEdit(layer, fieldToEdit, colorChannel, value, null, null)
            } else if (fieldToEdit) {
              // Non-color field: modify data values directly
              for (const row of layer.data.values) {
                const orig = row[fieldToEdit]
                row[fieldToEdit] = typeof orig === 'number' ? Number(value) : value
              }
            } else {
              // No matching inline data field — fall back to direct mark edit
              applyDirectMarkEditInPlace(spec.layer[li], property, value)
            }
          }
        } else if (modStrategy === 'condition-value-edit') {
          // Pattern B: modify existing visibility condition value
          const visChannel = findVisibilityConditionChannel(spec.layer[li])
          if (visChannel) {
            const enc = spec.layer[li].encoding[visChannel]
            if (Array.isArray(enc.condition)) {
              // Modify all visible conditions for all-in-layer scope
              for (const c of enc.condition) {
                if (c.value && c.value !== 'transparent' && c.value !== 'none') {
                  c.value = value
                }
              }
            } else if (enc.condition) {
              enc.condition.value = value
            }
          } else {
            applyDirectMarkEditInPlace(spec.layer[li], property, value)
          }
        } else {
          // Default: direct mark/encoding edit (Pattern A, pure annotation, legacy)
          applyDirectMarkEditInPlace(spec.layer[li], property, value)
        }
      }

    // --- this-element scope (individual element within a highlight/annotation layer) ---
    } else if (scope.type === 'this-element') {
      const li = layerIndex ?? scope.layerIndex
      const modStrategy = scope.modStrategy || mod.modStrategy

      if (modStrategy === 'inline-data-edit' && spec.layer?.[li]?.data?.values && mod.datum) {
        // Pattern D: modify specific row in inline data or scale range
        const layer = spec.layer[li]
        const inlineData = layer.data.values
        const rowIdx = findInlineDataRowIndex(mod.datum, inlineData)
        if (rowIdx >= 0) {
          const fieldToEdit = resolveInlineDataField(layer, property)
          const isColorProp = ['fill', 'color', 'stroke'].includes(property)
          if (isColorProp && fieldToEdit) {
            // Color field: handle scale domain/range properly
            const colorChannel = layer.encoding?.fill?.field === fieldToEdit ? 'fill' : 'color'
            applyInlineColorEdit(layer, fieldToEdit, colorChannel, value, rowIdx, mod.datum)
          } else if (fieldToEdit) {
            const orig = inlineData[rowIdx][fieldToEdit]
            inlineData[rowIdx][fieldToEdit] = typeof orig === 'number' ? Number(value) : value
          } else {
            // Fallback to conditional encoding
            const testExpr = buildDatumTest(mod.datum, spec)
            if (testExpr) applyIndividualConditionalEncoding(spec, property, testExpr, value, mod.markGroup, li)
          }
        }
      } else if (modStrategy === 'condition-value-edit' && spec.layer?.[li] && mod.datum) {
        // Pattern B: modify the specific condition that matches the clicked datum
        const visChannel = findVisibilityConditionChannel(spec.layer[li])
        if (visChannel) {
          const enc = spec.layer[li].encoding[visChannel]
          const conditions = Array.isArray(enc.condition) ? enc.condition : [enc.condition]
          // Find the condition whose test matches the clicked datum
          for (const c of conditions) {
            if (c.test) {
              const matched = evaluateTestExpression(c.test, mod.datum)
              if (matched) {
                c.value = value
                break
              }
            }
          }
        }
      } else if (mod.datum && ENCODABLE_PROPERTIES.has(property)) {
        // Default: conditional encoding (legacy path)
        const testExpr = buildDatumTest(mod.datum, spec)
        if (testExpr) {
          applyIndividualConditionalEncoding(spec, property, testExpr, value, mod.markGroup, li)
        }
      }
    }

    // Log which layers were affected after each modification
    if (spec.layer) {
      const layerSummary = spec.layer.map((l, i) => {
        const markType = typeof l.mark === 'string' ? l.mark : l.mark?.type
        const encKeys = l.encoding ? Object.keys(l.encoding) : []
        return `L${i}(${markType}|enc:${encKeys.join(',')})`
      }).join(' ')
    }
  }

  if (borrowedData) delete spec.data   // don't leave duplicate data on the facet child
  return { spec: isFacet ? fullSpec : spec, svgOverrides }
}

/**
 * Convert a line/area chart with point overlay (mark.point) into an explicit
 * two-layer spec, so that point-specific encodings don't bleed into the line/area.
 */
function ensureLayerForPointOverlay(spec) {
  const markObj = typeof spec.mark === 'string' ? { type: spec.mark } : spec.mark
  if (!markObj || !markObj.point) return false
  const markType = markObj.type
  if (!['line', 'area'].includes(markType)) return false
  if (spec.layer) return false // already has layers

  // Extract point config
  const pointConfig = typeof markObj.point === 'object' ? { ...markObj.point } : {}

  // Main mark without point overlay
  const mainMark = { ...markObj }
  delete mainMark.point

  // Point mark — preserve filled behavior from line/area overlay
  // Vega-Lite line+point overlay renders filled points by default,
  // so we must set filled: true to keep the same appearance after splitting.
  const pointMark = { type: 'point', filled: true, ...pointConfig }

  // Deep clone encoding for both layers
  const encoding = spec.encoding ? JSON.parse(JSON.stringify(spec.encoding)) : {}

  spec.layer = [
    { mark: mainMark, encoding: JSON.parse(JSON.stringify(encoding)) },
    { mark: pointMark, encoding: JSON.parse(JSON.stringify(encoding)) }
  ]
  delete spec.mark
  delete spec.encoding
  return true
}

/**
 * Resolve a Vega color scheme name into an array of hex colors.
 * Supports common categorical schemes. Falls back to Vega-Lite's default (tableau10).
 */
const KNOWN_SCHEMES = {
  // Vox theme's default categorical colors (used in our app via theme: 'vox')
  vox: ['#3e5c69', '#6793a6', '#182429', '#0570b0', '#3690c0', '#74a9cf', '#a6bddb', '#e2ddf2'],
  tableau10: ['#4c78a8', '#f58518', '#e45756', '#72b7b2', '#54a24b', '#eeca3b', '#b279a2', '#ff9da6', '#9d755d', '#bab0ac'],
  category10: ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'],
  category20: ['#1f77b4', '#aec7e8', '#ff7f0e', '#ffbb78', '#2ca02c', '#98df8a', '#d62728', '#ff9896', '#9467bd', '#c5b0d5',
               '#8c564b', '#c49c94', '#e377c2', '#f7b6d2', '#7f7f7f', '#c7c7c7', '#bcbd22', '#dbdb8d', '#17becf', '#9edae5'],
  set1: ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00', '#ffff33', '#a65628', '#f781bf', '#999999'],
  set2: ['#66c2a5', '#fc8d62', '#8da0cb', '#e78ac3', '#a6d854', '#ffd92f', '#e5c494', '#b3b3b3'],
  set3: ['#8dd3c7', '#ffffb3', '#bebada', '#fb8072', '#80b1d3', '#fdb462', '#b3de69', '#fccde5', '#d9d9d9', '#bc80bd', '#ccebc5', '#ffed6f'],
  pastel1: ['#fbb4ae', '#b3cde3', '#ccebc5', '#decbe4', '#fed9a6', '#ffffcc', '#e5d8bd', '#fddaec', '#f2f2f2'],
  dark2: ['#1b9e77', '#d95f02', '#7570b3', '#e7298a', '#66a61e', '#e6ab02', '#a6761d', '#666666'],
  accent: ['#7fc97f', '#beaed4', '#fdc086', '#ffff99', '#386cb0', '#f0027f', '#bf5b17', '#666666'],
}

// Sequential/diverging continuous color scheme endpoints [low, high]
const CONTINUOUS_SCHEME_ENDPOINTS = {
  blues: ['#f7fbff', '#08306b'],
  greens: ['#f7fcf5', '#00441b'],
  greys: ['#ffffff', '#252525'],
  oranges: ['#fff5eb', '#7f2704'],
  purples: ['#fcfbfd', '#3f007d'],
  reds: ['#fff5f0', '#67000d'],
  viridis: ['#440154', '#fde725'],
  inferno: ['#000004', '#fcffa4'],
  magma: ['#000004', '#fcfdbf'],
  plasma: ['#0d0887', '#f0f921'],
  cividis: ['#00204c', '#ffea46'],
  turbo: ['#23171b', '#900c00'],
  sinebow: ['#ff4040', '#ff4040'],
  rainbow: ['#6e40aa', '#6e40aa'],
  warm: ['#6e40aa', '#ff1925'],
  cool: ['#6e40aa', '#aff05b'],
  cubehelix: ['#000000', '#ffffff'],
  bugn: ['#f7fcfd', '#00441b'],
  bupu: ['#f7fcfd', '#4d004b'],
  gnbu: ['#f7fcf0', '#084081'],
  orrd: ['#fff7ec', '#7f0000'],
  pubu: ['#fff7fb', '#023858'],
  pubugn: ['#fff7fb', '#014636'],
  purd: ['#f7f4f9', '#67001f'],
  rdpu: ['#fff7f3', '#49006a'],
  ylgn: ['#ffffe5', '#004529'],
  ylgnbu: ['#ffffd9', '#081d58'],
  ylorbr: ['#ffffe5', '#662506'],
  ylorrd: ['#ffffcc', '#800026'],
  brownbluegreen: ['#543005', '#003c30'],
  purpleorange: ['#7f3b08', '#2d004b'],
  pinkyellowgreen: ['#8e0152', '#276419'],
  purplegreen: ['#40004b', '#00441b'],
  redblue: ['#67001f', '#053061'],
  redgrey: ['#67001f', '#1a1a1a'],
  redyellowblue: ['#a50026', '#313695'],
  redyellowgreen: ['#a50026', '#006837'],
  spectral: ['#9e0142', '#5e4fa2'],
}

// Default scheme to use when no scheme is specified.
// Our app uses theme: 'vox', which overrides the default categorical colors.
const DEFAULT_SCHEME = 'vox'

function resolveSchemeColors(scheme, count) {
  // scheme can be a string name or { name: '...', count: N }
  const schemeName = typeof scheme === 'string' ? scheme : scheme?.name || DEFAULT_SCHEME
  const colors = KNOWN_SCHEMES[schemeName] || KNOWN_SCHEMES[DEFAULT_SCHEME]
  return Array.from({ length: count }, (_, i) => colors[i % colors.length])
}

/**
 * Extract the current color mapping from a spec for a given encoding channel.
 * Returns array of { fieldValue, color } entries if a categorical color encoding exists.
 * Used by the Selection Colors panel.
 */
export function extractColorMapping(spec, channel, chartId) {
  const encoding = spec?.encoding || {}
  // Resolve channel: try 'color', 'fill'
  const channels = channel ? [channel] : ['color', 'fill']
  let enc = null
  let resolvedChannel = null
  for (const ch of channels) {
    if (encoding[ch]?.field) {
      enc = encoding[ch]
      resolvedChannel = ch
      break
    }
  }
  // Also check layers
  if (!enc && spec?.layer) {
    for (const layer of spec.layer) {
      for (const ch of channels) {
        if (layer.encoding?.[ch]?.field) {
          enc = layer.encoding[ch]
          resolvedChannel = ch
          break
        }
      }
      if (enc) break
    }
  }
  if (!enc) {
    // Check for predicate-based conditional encoding (no field, but has condition.test)
    for (const ch of channels) {
      const condEnc = encoding[ch]
      if (condEnc?.condition) {
        const conditions = Array.isArray(condEnc.condition) ? condEnc.condition : [condEnc.condition]
        const hasPredicateCondition = conditions.some(c => c.test != null)
        if (hasPredicateCondition) {
          const entries = conditions
            .filter(c => c.test != null && c.value != null)
            .map((cond, i) => ({
              test: cond.test,
              value: cond.value,
              index: i,
            }))
          return {
            type: 'conditional',
            channel: ch,
            conditions: entries,
            defaultValue: condEnc.value ?? null,
          }
        }
      }
    }
    // Also check layers for conditional encoding
    if (spec?.layer) {
      for (const layer of spec.layer) {
        for (const ch of channels) {
          const condEnc = layer.encoding?.[ch]
          if (condEnc?.condition) {
            const conditions = Array.isArray(condEnc.condition) ? condEnc.condition : [condEnc.condition]
            const hasPredicateCondition = conditions.some(c => c.test != null)
            if (hasPredicateCondition) {
              const entries = conditions
                .filter(c => c.test != null && c.value != null)
                .map((cond, i) => ({ test: cond.test, value: cond.value, index: i }))
              return {
                type: 'conditional',
                channel: ch,
                conditions: entries,
                defaultValue: condEnc.value ?? null,
              }
            }
          }
        }
      }
    }
    const staticResult = extractStaticColors(spec)
    return staticResult
  }

  const field = enc.field
  const type = enc.type || ''
  const scale = enc.scale || {}
  const isCategorical = ['nominal', 'ordinal'].includes(type)

  if (!isCategorical) {
    // Continuous: resolve actual gradient endpoints from scheme or range
    let lowColor = null
    let highColor = null
    if (scale.range && Array.isArray(scale.range) && scale.range.length >= 2) {
      lowColor = scale.range[0]
      highColor = scale.range[scale.range.length - 1]
    } else if (scale.scheme) {
      const schemeName = typeof scale.scheme === 'string' ? scale.scheme.toLowerCase() : scale.scheme?.name?.toLowerCase()
      const endpoints = CONTINUOUS_SCHEME_ENDPOINTS[schemeName]
      if (endpoints) {
        lowColor = endpoints[0]
        highColor = endpoints[1]
      }
    } else {
      // No explicit scheme or range — Vega-Lite defaults to 'blues' for continuous color
      const defaultEndpoints = CONTINUOUS_SCHEME_ENDPOINTS['blues']
      if (defaultEndpoints) {
        lowColor = defaultEndpoints[0]
        highColor = defaultEndpoints[1]
      }
    }
    return { type: 'continuous', field, channel: resolvedChannel, scale, lowColor, highColor }
  }

  // Categorical: build field→color mapping
  // Use scale.domain/range directly if available (works even without inline data)
  let uniqueVals
  if (scale.domain && Array.isArray(scale.domain)) {
    uniqueVals = scale.domain
  } else {
    const dataValues = spec.data?.values
    if (dataValues) {
      uniqueVals = [...new Set(dataValues.map(d => d[field]).filter(v => v != null))]
      // Vega-Lite nominal color domain defaults to data occurrence order (NOT alphabetical).
      // Only sort if explicitly requested via enc.sort.
      const encSort = enc.sort
      if (encSort === 'ascending') {
        uniqueVals.sort()
      } else if (encSort === 'descending') {
        uniqueVals.sort().reverse()
      }
    }
    // If uniqueVals is empty or undefined (transform-generated field like row_index),
    // try reading from the rendered Vega view's scale
    if (!uniqueVals || uniqueVals.length === 0) {
      // Find the specific chart container's Vega view
      const containers = chartId
        ? [document.getElementById(`vega-chart-${chartId}`)].filter(Boolean)
        : document.querySelectorAll('[id^="vega-chart-"]')
      for (const container of containers) {
        const view = container._vegaView
        if (!view) continue
        try {
          const scaleFn = view.scale('color') || view.scale('fill')
          if (scaleFn && scaleFn.domain) {
            const domain = scaleFn.domain()
            if (domain && domain.length > 0) {
              uniqueVals = [...domain]
              // Use scaleFn(value) to get the actual mapped color for each domain value
              // (scaleFn.range() only returns base scheme colors, not cycled ones)
              const mapping = uniqueVals.map((val) => ({
                fieldValue: val,
                color: scaleFn(val) || '#888888',
                field,
                channel: resolvedChannel,
              }))
              return { type: 'categorical', mapping, field, channel: resolvedChannel, scale }
            }
          }
        } catch { /* ignore */ }
      }
      // Still nothing — give up
      if (!uniqueVals || uniqueVals.length === 0) return null
    }
  }

  let colors
  if (scale.range && Array.isArray(scale.range)) {
    colors = scale.range
  } else {
    // Prefer the ACTUAL colors from the live Vega view — they match what the user
    // sees regardless of the active theme / default scheme (our scheme constants may
    // not mirror Vega-Lite's real default, e.g. tableau10). Fall back to the scheme
    // palette only when no rendered view is available.
    let rendered = null
    const containers = chartId
      ? [document.getElementById(`vega-chart-${chartId}`)].filter(Boolean)
      : Array.from(document.querySelectorAll('[id^="vega-chart-"]'))
    for (const container of containers) {
      const view = container?._vegaView
      if (!view) continue
      try {
        const scaleFn = view.scale(resolvedChannel) || view.scale('color') || view.scale('fill')
        if (scaleFn) {
          const mapped = uniqueVals.map(v => scaleFn(v) || null)
          if (mapped.every(c => c)) { rendered = mapped; break }
        }
      } catch { /* ignore */ }
    }
    if (rendered) {
      colors = rendered
    } else {
      // Arc marks (pie charts) with no explicit sort assign colors alphabetically.
      const markType = typeof spec.mark === 'string' ? spec.mark : spec.mark?.type
      const isArcMark = markType === 'arc'
      const encSort = enc.sort
      if (isArcMark && !encSort) {
        const alphaSorted = [...uniqueVals].sort((a, b) => String(a).localeCompare(String(b)))
        const alphaColors = resolveSchemeColors(scale.scheme, alphaSorted.length)
        const colorByValue = Object.fromEntries(alphaSorted.map((v, i) => [String(v), alphaColors[i]]))
        colors = uniqueVals.map(v => colorByValue[String(v)])
      } else {
        colors = resolveSchemeColors(scale.scheme, uniqueVals.length)
      }
    }
  }

  const mapping = uniqueVals.map((val, i) => ({
    fieldValue: val,
    color: colors[i] || '#888888',
    field,
    channel: resolvedChannel,
  }))

  return { type: 'categorical', field, channel: resolvedChannel, mapping }
}

/**
 * Apply by-field scope (encoding condition) — extracted for reuse
 */
function applyByFieldScope(spec, mod) {
  const { property, value, scope, datum, markGroup } = mod
  let layerIndex = mod.layerIndex
  const field = scope.field

  const resolvedFieldValue = scope.fieldValue ?? scope.value ?? (datum ? datum[field] : null)
  if (resolvedFieldValue == null) return

  // Layer guard: the condition tests `datum[field]`, so it MUST live on a layer whose data
  // actually carries `field`. Detection can give a null layerIndex (→ falls through to
  // markType resolution, e.g. a background rect misread as a bar lands the condition on the
  // primary bar layer) or a wrong layerIndex. In either case the test never matches and the
  // change silently does nothing. Resolve the field-owning layer up front and prefer it.
  if (spec.layer && field
      && (layerIndex == null || !rowHasField(layerEffectiveDataRow(spec, layerIndex), field))) {
    const better = spec.layer.findIndex(ls => rowHasField(ls?.data?.values?.[0], field))
    if (better >= 0) layerIndex = better
  }

  const testExpr = typeof resolvedFieldValue === 'number'
    ? `datum['${field}'] === ${resolvedFieldValue}`
    : `datum['${field}'] === '${resolvedFieldValue}'`
  const condition = { test: testExpr, value }

  const targetMarkType = markGroup ? markGroupToMarkType[markGroup] : null

  // For line/area with point overlay: convert to explicit layers so that
  // fill/color encoding only applies to the point layer, not the line/area.
  if (targetMarkType === 'point' && (property === 'fill' || property === 'color') && !spec.layer) {
    const specMarkType = typeof spec.mark === 'string' ? spec.mark : spec.mark?.type
    if (specMarkType && ['line', 'area'].includes(specMarkType)) {
      ensureLayerForPointOverlay(spec)
    }
  }

  let targetEncoding = spec.encoding
  if (spec.layer && layerIndex != null && layerIndex < spec.layer.length) {
    // Layer index known — target the specific layer directly
    if (!spec.layer[layerIndex].encoding) spec.layer[layerIndex].encoding = {}
    targetEncoding = spec.layer[layerIndex].encoding
  } else if (spec.layer && targetMarkType) {
    const layerIdx = spec.layer.findIndex(ls => {
      const mt = typeof ls.mark === 'string' ? ls.mark : ls.mark?.type
      return mt === targetMarkType
    })
    if (layerIdx >= 0) {
      if (!spec.layer[layerIdx].encoding) spec.layer[layerIdx].encoding = {}
      targetEncoding = spec.layer[layerIdx].encoding
    }
  }
  // Field-based fallback: no layerIndex, markType miss, or no top-level encoding
  if (spec.layer && !targetEncoding) {
    // No layerIndex and no top-level encoding — find the layer that encodes this field
    for (let i = 0; i < spec.layer.length; i++) {
      const layer = spec.layer[i]
      if (layer.encoding) {
        const hasField = Object.values(layer.encoding).some(enc => enc?.field === field)
        if (hasField) {
          targetEncoding = layer.encoding
          break
        }
      }
    }
  }
  if (!targetEncoding) {
    if (!spec.encoding) spec.encoding = {}
    targetEncoding = spec.encoding
  }

  // Determine if the mark renders as filled or stroked
  // Find the mark from the layer that owns targetEncoding (handles layerIndex=null from legend clicks)
  let resolvedMark = spec.mark
  if (spec.layer && layerIndex != null) {
    resolvedMark = spec.layer[layerIndex]?.mark || spec.mark
  } else if (spec.layer && targetEncoding !== spec.encoding) {
    // targetEncoding was found in a layer — use that layer's mark
    for (const layer of spec.layer) {
      if (layer.encoding === targetEncoding) {
        resolvedMark = layer.mark || spec.mark
        break
      }
    }
  }
  const resolvedMT = typeof resolvedMark === 'string' ? resolvedMark : resolvedMark?.type
  const isFilled = resolvedMark?.filled === true
    || !['point', 'line', 'rule'].includes(resolvedMT)

  // Redirect to the field-bound color channel only when the property matches
  // what the color channel actually controls for this mark type.
  let channel = propToChannel[property] || property
  if (targetEncoding.color?.field) {
    if (property === 'color') {
      channel = 'color'
    } else if (property === 'stroke' && !isFilled) {
      channel = 'color'
    } else if (property === 'fill' && isFilled) {
      channel = 'color'
    }
  } else if (targetEncoding.fill?.field && (property === 'fill' || property === 'color')) {
    channel = 'fill'
  }

  const existingEnc = targetEncoding[channel]

  // Special case: if the encoding has a field-based color/fill and the by-field targets
  // the SAME field, use scale.domain/range instead of condition.
  // This ensures the legend updates together with the marks.

  if (existingEnc && existingEnc.field && (property === 'fill' || property === 'color' || property === 'stroke')
      && existingEnc.field === field) {
    // Same-field color change: range-only approach for all mark types.
    // Never set scale.domain — Vega-Lite determines nominal domain in alphabetical order
    // internally. We build range aligned to that alphabetical order.
    if (!targetEncoding[channel].scale) {
      targetEncoding[channel] = { ...targetEncoding[channel], scale: {} }
    }
    const scale = targetEncoding[channel].scale

    // Build alphabetically sorted category list (Vega-Lite's internal domain order)
    // Find data values: check top-level first, then layer-level
    let dataValues = spec.data?.values
    if ((!dataValues || dataValues.length === 0) && spec.layer) {
      for (let li = 0; li < spec.layer.length; li++) {
        const layer = spec.layer[li]
        if (layer.data?.values && layer.data.values.length > 0) {
          dataValues = layer.data.values
          break
        }
      }
    }
    let alphaSorted = null
    if (dataValues && Array.isArray(dataValues)) {
      const rawOrder = dataValues.map(d => d[field]).filter(v => v != null)
      const uniqueVals = [...new Set(rawOrder)]
      alphaSorted = uniqueVals.length > 0
        ? [...uniqueVals].sort((a, b) => String(a).localeCompare(String(b)))
        : null
    }

    // Fallback: if alphaSorted is empty (field created by transform, e.g. row_index),
    // give up range-only approach and use condition instead.
    if (!alphaSorted || alphaSorted.length === 0) {
      // alphaSorted empty — fall back to condition approach
      // Remove the empty scale we just created
      if (scale && Object.keys(scale).length === 0) {
        delete targetEncoding[channel].scale
      }
      // Apply condition on the existing field encoding
      if (!targetEncoding[channel].condition) {
        targetEncoding[channel] = { ...targetEncoding[channel], condition }
      } else {
        const existing = Array.isArray(targetEncoding[channel].condition)
          ? targetEncoding[channel].condition
          : [targetEncoding[channel].condition]
        const idx = existing.findIndex(c => c.test === testExpr)
        if (idx >= 0) existing[idx] = condition
        else existing.push(condition)
        targetEncoding[channel].condition = existing
      }
    } else {
      // Normal range-only approach
      if (!scale.range) {
        scale.range = resolveSchemeColors(scale.scheme, alphaSorted.length)
        if (scale.scheme) delete scale.scheme
      }

      if (scale.range) {
        const idx = alphaSorted.findIndex(v => String(v) === String(resolvedFieldValue))
        if (idx >= 0) {
          scale.range[idx] = value
        }
      }

      // Never set domain — it can override ordering and cause layout issues
      if (scale.domain) delete scale.domain
    }

  } else if (existingEnc && existingEnc.field) {
    // Case A: Field-based encoding exists (different field, or arc mark with same field)
    if (!targetEncoding[channel].condition) {
      targetEncoding[channel] = { ...existingEnc, condition }
    } else {
      const existing = Array.isArray(targetEncoding[channel].condition)
        ? targetEncoding[channel].condition
        : [targetEncoding[channel].condition]
      const idx = existing.findIndex(c => c.test === testExpr)
      if (idx >= 0) existing[idx] = condition
      else existing.push(condition)
      targetEncoding[channel].condition = existing
    }

  } else if (existingEnc && existingEnc.condition) {
    // Case B: Condition-based encoding already exists (from a previous by-field mod)
    // Merge the new condition into the existing condition array
    const existing = Array.isArray(existingEnc.condition)
      ? existingEnc.condition
      : [existingEnc.condition]
    const idx = existing.findIndex(c => c.test === testExpr)
    if (idx >= 0) {
      existing[idx] = condition
    } else {
      existing.push(condition)
    }
    targetEncoding[channel] = {
      ...existingEnc,
      condition: existing
    }

  } else {
    // Case C: No encoding exists for this channel
    const defaultValue = getOriginalMarkValue(property, spec, markGroup, layerIndex)
    targetEncoding[channel] = { condition, value: defaultValue }
  }

  // Clean up conflicting mark-level property to avoid double-specification
  if (layerIndex != null && spec.layer?.[layerIndex]?.mark && typeof spec.layer[layerIndex].mark === 'object' && spec.layer[layerIndex].mark[property] !== undefined) {
    delete spec.layer[layerIndex].mark[property]
  } else if (spec.mark && typeof spec.mark === 'object' && spec.mark[property] !== undefined) {
    delete spec.mark[property]
  }
  if (spec.layer) {
    spec.layer.forEach(layerSpec => {
      const lm = typeof layerSpec.mark === 'object' ? layerSpec.mark : null
      if (lm && lm[property] !== undefined) {
        delete lm[property]
      }
    })
  }

  // For line/area charts with point overlay, ensure points are filled when setting fill
  if ((property === 'fill' || property === 'color') && spec.mark && typeof spec.mark === 'object') {
    const specMarkType = spec.mark.type
    if (['line', 'area'].includes(specMarkType) && spec.mark.point) {
      if (spec.mark.point === true) {
        spec.mark.point = { filled: true }
      } else if (typeof spec.mark.point === 'object') {
        spec.mark.point.filled = true
      }
    }
  }
}

/**
 * Apply scale-modify scope: modify the scale of a continuous encoding channel.
 * For color: modifies scale.range endpoints or replaces scale.scheme.
 * For size/opacity: modifies scale.range endpoints.
 */
function applyScaleModifyScope(spec, channel, property, value) {
  // Find the target encoding (top-level or in layers)
  let targetEncoding = null
  if (spec.encoding?.[channel]?.field) {
    targetEncoding = spec.encoding
  } else if (spec.layer) {
    for (const layer of spec.layer) {
      if (layer.encoding?.[channel]?.field) {
        targetEncoding = layer.encoding
        break
      }
    }
  }
  // Also try resolved channel names (color ↔ fill)
  if (!targetEncoding && (property === 'fill' || property === 'color')) {
    const altChannel = channel === 'color' ? 'fill' : 'color'
    if (spec.encoding?.[altChannel]?.field) {
      targetEncoding = spec.encoding
      // Use the resolved channel
      channel = altChannel
    } else if (spec.layer) {
      for (const layer of spec.layer) {
        if (layer.encoding?.[altChannel]?.field) {
          targetEncoding = layer.encoding
          channel = altChannel
          break
        }
      }
    }
  }

  if (!targetEncoding?.[channel]) return

  const enc = targetEncoding[channel]
  if (!enc.scale) {
    targetEncoding[channel] = { ...enc, scale: {} }
  }
  const scale = targetEncoding[channel].scale

  if (property === 'fill' || property === 'color') {
    // Color property: modify scale range or replace scheme
    if (scale.scheme) {
      // Replace scheme with explicit range using the user's chosen color
      // Keep the scheme's feel but make the high end the user's color
      delete scale.scheme
      scale.range = ['#f0f0f0', value]
    } else if (scale.range && Array.isArray(scale.range)) {
      // Modify the high end of the existing range
      scale.range[scale.range.length - 1] = value
    } else {
      // No scale config yet: create a range from light to user's color
      scale.range = ['#f0f0f0', value]
    }
  } else if (property === 'opacity') {
    if (scale.range && Array.isArray(scale.range)) {
      scale.range[scale.range.length - 1] = value
    } else {
      scale.range = [0.1, value]
    }
  } else if (property === 'size') {
    if (scale.range && Array.isArray(scale.range)) {
      scale.range[scale.range.length - 1] = value
    } else {
      scale.range = [0, value]
    }
  } else if (property === 'strokeWidth') {
    if (scale.range && Array.isArray(scale.range)) {
      scale.range[scale.range.length - 1] = value
    } else {
      scale.range = [0, value]
    }
  }
}

/**
 * Ensure spec.encoding[channel].axis exists
 */
function ensureAxisConfig(spec, channel) {
  if (!spec.encoding) spec.encoding = {}
  if (!spec.encoding[channel]) spec.encoding[channel] = {}
  if (!spec.encoding[channel].axis) spec.encoding[channel].axis = {}
}

/**
 * Check if a channel has encoding definition anywhere in the spec (top-level or layers).
 * Used by multi-axis handlers to determine which channels actually have axes.
 */
function hasChannelEncoding(spec, channel) {
  if (spec.encoding?.[channel]) return true
  if (spec.layer) {
    for (const layer of spec.layer) {
      if (layer.encoding?.[channel]) return true
    }
  }
  return false
}

/**
 * Build axis-specific property name using SPEC_PATH_MAP.
 * e.g. ('grid', 'stroke') → 'gridColor', ('title', 'fontSize') → 'titleFontSize'
 */
function buildAxisPropName(subType, property) {
  return SPEC_PATH_MAP[`axis-${subType}`]?.[property] || null
}

/**
 * Build legend-specific config property name using SPEC_PATH_MAP.
 * e.g. ('label', 'color') → 'labelColor', ('title', 'fontSize') → 'titleFontSize'
 */
function buildLegendPropName(subType, property) {
  return SPEC_PATH_MAP[`legend-${subType}`]?.[property] || null
}

/**
 * Apply a legend property to encoding-level legend configs.
 * Vega-Lite: encoding.[ch].legend has higher priority than config.legend,
 * so we must also update encoding-level legend when it exists.
 * Handles both top-level spec.encoding and spec.layer[i].encoding.
 */
function applyToEncodingLevelLegend(spec, legendPropName, value) {
  const LEGEND_CHANNELS = ['color', 'fill', 'stroke', 'shape', 'size', 'opacity', 'strokeWidth']

  function applyToEncoding(encoding) {
    if (!encoding) return
    for (const ch of LEGEND_CHANNELS) {
      if (encoding[ch]?.legend && typeof encoding[ch].legend === 'object') {
        // Only overwrite if the encoding-level legend already has this property
        // (to avoid injecting properties the user never set at encoding level)
        if (legendPropName in encoding[ch].legend) {
          encoding[ch].legend[legendPropName] = value
        }
      }
    }
  }

  // Top-level encoding
  applyToEncoding(spec.encoding)

  // Layer encodings
  if (spec.layer) {
    for (const layer of spec.layer) {
      applyToEncoding(layer.encoding)
    }
  }
}

// buildGenericAxisProp removed — all-axes now loops over all sub-types per channel

/**
 * Get the original visual value for a property from the spec.
 * For the "fallback" in conditional encodings — what non-matching elements should look like.
 * @param {string} markGroup - optional markGroup (e.g., 'mark-symbol') to determine actual target mark
 */
function getOriginalMarkValue(property, spec, markGroup, layerIndex) {
  // For layered specs, use the target layer's mark
  let markSpec, specMarkType
  if (spec.layer && layerIndex != null && layerIndex < spec.layer.length) {
    const layerMark = spec.layer[layerIndex].mark
    markSpec = typeof layerMark === 'string' ? {} : layerMark || {}
    specMarkType = typeof layerMark === 'string' ? layerMark : layerMark?.type
  } else {
    markSpec = typeof spec.mark === 'string' ? {} : spec.mark || {}
    specMarkType = typeof spec.mark === 'string' ? spec.mark : spec.mark?.type
  }

  // Determine the actual target mark type
  // For line+point charts, the target might be 'point' even though spec mark is 'line'
  const targetMarkType = markGroup ? (markGroupToMarkType[markGroup] || specMarkType) : specMarkType

  switch (property) {
    case 'fill':
    case 'color': {
      // Check point overlay properties for line/area + point charts
      if (targetMarkType === 'point' && specMarkType !== 'point' && markSpec.point && typeof markSpec.point === 'object') {
        if (markSpec.point.fill) return markSpec.point.fill
        if (markSpec.point.color) return markSpec.point.color
      }
      if (markSpec.fill) return markSpec.fill
      if (markSpec.color) return markSpec.color
      // Standalone point marks with filled: false → hollow, fill = transparent
      if (targetMarkType === 'point' && specMarkType === 'point' && markSpec.filled !== true) return 'transparent'
      // Overlay points on line/area charts are filled by default → use default color
      if (targetMarkType === 'point' && specMarkType !== 'point') return '#4c78a8'
      // Line/rule marks themselves are typically unfilled
      if (targetMarkType === 'line' || targetMarkType === 'rule') return 'transparent'
      // Default for filled marks (bar, area, arc, etc.)
      return '#4c78a8'
    }
    case 'stroke': {
      if (markSpec.stroke) return markSpec.stroke
      if (targetMarkType === 'point') return markSpec.color || '#4c78a8'
      return null
    }
    case 'strokeWidth':
      return markSpec.strokeWidth ?? (targetMarkType === 'point' ? 1 : 0)
    case 'opacity':
      return markSpec.opacity ?? 1
    case 'size': {
      if (markSpec.size) return markSpec.size
      // For point overlays on line/area, check mark.point config
      if (targetMarkType === 'point' && markSpec.point && typeof markSpec.point === 'object') {
        if (markSpec.point.size) return markSpec.point.size
      }
      // Vega-Lite default point size is ~30 (area in sq pixels)
      return targetMarkType === 'point' ? 30 : null
    }
    default:
      return null
  }
}

/**
 * Get the encoding object for a specific channel, respecting layer structure.
 */
function getChannelEncoding(spec, channel, layerIndex) {
  if (layerIndex !== null && layerIndex !== undefined && spec.layer) {
    return spec.layer[layerIndex]?.encoding?.[channel] || spec.encoding?.[channel];
  }
  return spec.encoding?.[channel];
}

/**
 * Determine the data binding integrity state of a modification.
 * @param {Object} spec - The Vega-Lite spec BEFORE this modification is applied
 * @param {Object} modification - { channel, layerIndex, scope: { type, field, values, value } }
 * @param {Array} data - The dataset rows
 * @returns {'binding-preserved' | 'binding-overridden' | 'new-annotation'}
 */
export function detectBindingIntegrity(spec, modification, data) {
  if (!modification.channel) return 'new-annotation';
  if (!spec?.encoding && !spec?.layer) return 'new-annotation';

  const encoding = getChannelEncoding(spec, modification.channel, modification.layerIndex);
  const boundField = encoding?.field || encoding?.condition?.field || null;

  if (!boundField) return 'new-annotation';

  const scope = modification.scope;
  if (!scope || scope.type === 'all' || scope.type === 'all-marks' || !scope.field) return 'binding-preserved';

  if (scope.field === boundField) {
    const uniqueValues = [...new Set((data || []).map(d => d[boundField]))];
    const scopeValues = scope.values || (scope.value !== undefined ? [scope.value] : []);
    const coversAll = uniqueValues.length > 0 && uniqueValues.every(v => scopeValues.includes(v));
    if (coversAll) return 'binding-preserved';
  }

  return 'binding-overridden';
}

/**
 * Get a binding level tag for a scope type.
 */
export function getScopeBindingTag(scope) {
  switch (scope.type) {
    case 'all':
    case 'all-marks':
    case 'by-field':
    case 'scale-modify':
    case 'condition-match':
    case 'condition-default':
      return { label: 'data-bound', className: 'tag-bound' }
    case 'legend-with-data':
      return { label: 'data-bound', className: 'tag-bound' }
    case 'composite-sub-all':
      return { label: 'config-level', className: 'tag-aware' }
    case 'all-in-axis':
    case 'same-type-in-axis':
    case 'same-type-all-axes':
    case 'all-axes':
      return { label: 'spec-level', className: 'tag-aware' }
    case 'all-in-legend':
    case 'legend-item-only':
    case 'all-legend-symbols':
    case 'all-legend-labels':
    case 'legend-title':
      return { label: 'config-level', className: 'tag-aware' }
    case 'all-text':
      return { label: 'config-level', className: 'tag-aware' }
    case 'this-only':
    case 'this-element':
      return { label: 'conditional', className: 'tag-bound' }
    case 'annotation-direct':
    case 'annotation-layer':
      return { label: 'annotation', className: 'tag-aware' }
    case 'all-in-layer':
      return { label: 'layer-level', className: 'tag-aware' }
    default:
      return { label: 'unknown', className: '' }
  }
}

/**
 * Extract static (non-data-mapped) colors from the spec.
 * Handles single marks, layered marks, and default colors.
 */
function extractStaticColors(spec) {
  const colors = []

  if (spec.layer) {
    for (const layer of spec.layer) {
      const markSpec = typeof layer.mark === 'string' ? {} : layer.mark || {}
      const markType = typeof layer.mark === 'string' ? layer.mark : layer.mark?.type
      const color = markSpec.fill || markSpec.color || getDefaultMarkColor(markType)
      if (color && color !== 'transparent') {
        colors.push({
          label: markType || 'mark',
          color,
          source: 'mark',
          layerIndex: spec.layer.indexOf(layer),
        })
      }
    }
  } else {
    const markSpec = typeof spec.mark === 'string' ? {} : spec.mark || {}
    const markType = typeof spec.mark === 'string' ? spec.mark : spec.mark?.type
    // Priority: mark.fill > mark.color > config[markType].color > config.mark.color > default
    const configMarkColor = (markType && spec.config?.[markType]?.color)
      || (markType && spec.config?.[markType]?.fill)
      || spec.config?.mark?.color
      || spec.config?.mark?.fill
    const color = markSpec.fill || markSpec.color || configMarkColor || getDefaultMarkColor(markType)
    if (color && color !== 'transparent') {
      colors.push({
        label: markType || 'mark',
        color,
        source: markSpec.fill || markSpec.color ? 'mark' : 'config',
        layerIndex: null,
      })
    }
  }

  // Deduplicate by color value
  const unique = []
  const seen = new Set()
  for (const c of colors) {
    if (!seen.has(c.color)) {
      seen.add(c.color)
      unique.push(c)
    }
  }

  if (unique.length === 0) return null

  return { type: 'static', colors: unique }
}

/**
 * Get the default color for a mark type (what Vega-Lite renders when no color is specified).
 */
function getDefaultMarkColor(markType) {
  // Vega-Lite default fill for most marks is #4c78a8 (from tableau10 scheme)
  if (['line', 'rule'].includes(markType)) return '#4c78a8'
  return '#4c78a8'
}

// ============================================================
// CONDITION INSPECTOR UTILITIES
// ============================================================

/**
 * Parse a simple datum test expression into structured parts.
 * Returns null for expressions that are too complex.
 */
export function parseTestExpression(test) {
  if (!test || typeof test !== 'string') return null;
  const trimmed = test.trim();
  const re = /^datum(?:\.(\w+)|\['([^']+)'\])\s*(===|!==|==|!=|>=|<=|>|<)\s*(?:'([^']*)'|(-?\d+(?:\.\d+)?))$/;
  const m = trimmed.match(re);
  if (!m) return null;
  const field = m[1] || m[2];
  const op = m[3];
  const strVal = m[4];
  const numVal = m[5];
  if (strVal !== undefined) {
    return { field, op, value: strVal, valueType: 'string' };
  }
  if (numVal !== undefined) {
    return { field, op, value: parseFloat(numVal), valueType: 'number' };
  }
  return null;
}

/**
 * Reconstruct a test expression from structured parts.
 */
export function buildTestExpression({ field, op, value }) {
  if (typeof value === 'string') {
    return 'datum.' + field + ' ' + op + ' \'' + value + '\'';
  }
  return 'datum.' + field + ' ' + op + ' ' + value;
}

/**
 * Infer value type from channel name and value.
 */
function inferConditionValueType(channel, value) {
  const colorChannels = ['color', 'fill', 'stroke', 'background'];
  const numberChannels = ['opacity', 'size', 'strokeWidth', 'strokeDash', 'angle', 'radius', 'theta'];
  if (colorChannels.some(c => channel.toLowerCase().includes(c))) return 'color';
  if (numberChannels.includes(channel)) return 'number';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string' && /^#[0-9a-fA-F]{3,6}$/.test(value)) return 'color';
  if (typeof value === 'string' && /^rgb/.test(value)) return 'color';
  return 'string';
}

/**
 * Extract all conditions from a Vega-Lite spec.
 * @param {Object} spec
 * @param {number|null} layerIndex - If non-null, only extract from spec.layer[layerIndex]
 * @returns {Array<ConditionInfo>}
 */
export function extractConditions(spec, layerIndex = null) {
  if (!spec) return [];
  const results = [];

  const processEncoding = (encoding, layerIdx) => {
    if (!encoding) return;
    for (const channel of Object.keys(encoding)) {
      const enc = encoding[channel];
      if (!enc || typeof enc !== 'object') continue;
      if (!enc.condition) continue;
      const defaultValue = enc.value !== undefined ? enc.value : (enc.field ? ('field:' + enc.field) : null);
      const conditions = Array.isArray(enc.condition) ? enc.condition : [enc.condition];
      conditions.forEach((cond, condIdx) => {
        if (!cond || typeof cond !== 'object') return;
        const test = cond.test || cond.param || cond.selection || '';
        const value = cond.value !== undefined ? cond.value : (cond.field ? ('field:' + cond.field) : null);
        const valueType = cond.field ? 'field' : inferConditionValueType(channel, value);
        const pathBase = layerIdx !== null ? ('layer[' + layerIdx + '].encoding.' + channel) : ('encoding.' + channel);
        const path = conditions.length > 1
          ? (pathBase + '.condition[' + condIdx + ']')
          : (pathBase + '.condition');
        results.push({
          path,
          channel,
          layerIndex: layerIdx,
          conditionIndex: conditions.length > 1 ? condIdx : null,
          test,
          value,
          valueType,
          defaultValue,
          fieldEncoding: cond.field ? { field: cond.field, type: cond.type } : null,
        });
      });
    }
  };

  if (layerIndex !== null && spec.layer) {
    const layer = spec.layer[layerIndex];
    if (layer) processEncoding(layer.encoding, layerIndex);
    processEncoding(spec.encoding, null);
  } else if (spec.layer) {
    processEncoding(spec.encoding, null);
    spec.layer.forEach((layer, idx) => processEncoding(layer.encoding, idx));
  } else {
    processEncoding(spec.encoding, null);
  }

  return results;
}

/**
 * Get the encoding object for a condition's scope in a spec.
 */
function getEncodingForCondition(spec, condInfo) {
  if (condInfo.layerIndex !== null && condInfo.layerIndex !== undefined && spec.layer) {
    return spec.layer[condInfo.layerIndex]?.encoding;
  }
  return spec.encoding;
}

/**
 * Delete a condition from spec. Returns new spec (immutable).
 */
export function deleteCondition(spec, conditionInfo) {
  const newSpec = JSON.parse(JSON.stringify(spec));
  const enc = getEncodingForCondition(newSpec, conditionInfo);
  if (!enc || !enc[conditionInfo.channel]) return newSpec;
  const chEnc = enc[conditionInfo.channel];
  if (!chEnc.condition) return newSpec;

  if (Array.isArray(chEnc.condition)) {
    if (conditionInfo.conditionIndex !== null) {
      chEnc.condition.splice(conditionInfo.conditionIndex, 1);
      if (chEnc.condition.length === 1) {
        chEnc.condition = chEnc.condition[0];
      } else if (chEnc.condition.length === 0) {
        if (chEnc.value !== undefined) {
          enc[conditionInfo.channel] = { value: chEnc.value };
        } else {
          delete enc[conditionInfo.channel];
        }
      }
    }
  } else {
    if (chEnc.value !== undefined) {
      enc[conditionInfo.channel] = { value: chEnc.value };
    } else {
      delete enc[conditionInfo.channel];
    }
  }
  return newSpec;
}

/**
 * Update a condition's value. Returns new spec (immutable).
 */
export function updateConditionValue(spec, conditionInfo, newValue) {
  const newSpec = JSON.parse(JSON.stringify(spec));
  const enc = getEncodingForCondition(newSpec, conditionInfo);
  if (!enc || !enc[conditionInfo.channel]) return newSpec;
  const chEnc = enc[conditionInfo.channel];
  if (!chEnc.condition) return newSpec;

  if (Array.isArray(chEnc.condition) && conditionInfo.conditionIndex !== null) {
    chEnc.condition[conditionInfo.conditionIndex].value = newValue;
    delete chEnc.condition[conditionInfo.conditionIndex].field;
    delete chEnc.condition[conditionInfo.conditionIndex].type;
  } else if (!Array.isArray(chEnc.condition)) {
    chEnc.condition.value = newValue;
    delete chEnc.condition.field;
    delete chEnc.condition.type;
  }
  return newSpec;
}

/**
 * Update a condition's test expression. Returns new spec (immutable).
 */
export function updateConditionTest(spec, conditionInfo, newTest) {
  const newSpec = JSON.parse(JSON.stringify(spec));
  const enc = getEncodingForCondition(newSpec, conditionInfo);
  if (!enc || !enc[conditionInfo.channel]) return newSpec;
  const chEnc = enc[conditionInfo.channel];
  if (!chEnc.condition) return newSpec;

  if (Array.isArray(chEnc.condition) && conditionInfo.conditionIndex !== null) {
    chEnc.condition[conditionInfo.conditionIndex].test = newTest;
  } else if (!Array.isArray(chEnc.condition)) {
    chEnc.condition.test = newTest;
  }
  return newSpec;
}
