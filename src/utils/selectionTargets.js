// Selection identity must describe targets, never a display label or element count.
function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().filter(k => !k.startsWith('_')).map(k => [k, stable(value[k])])
  )
  return value
}

export function selectionKey(elements) {
  return JSON.stringify(elements.map(el => JSON.stringify(stable({
    selector: el.selector, datum: el.datum, layerIndex: el.layerIndex ?? null,
    role: el.semanticRole, markGroup: el.markGroup,
    axisChannel: el.axisChannel, axisSubType: el.axisSubType,
    legendField: el.legendField, legendValue: el.legendValue,
    compositeSubPart: el.compositeSubPart,
    scopeType: el._scopeType, scopeData: el._scopeData,
  }))).sort())
}

export function buildSelectionTargets(elements, property) {
  const first = elements[0]
  const scopeType = first?._scopeType
  const sharedScope = scopeType && !['individual', 'explicit'].includes(scopeType)
    && elements.every(el => el._scopeType === scopeType
      && JSON.stringify(stable(el._scopeData)) === JSON.stringify(stable(first._scopeData)))
  const targets = []
  const seen = new Set()
  for (const el of elements) {
    let scope = { type: 'this-only' }
    // Only collapse scopes whose semantics we can represent exactly. In particular,
    // condition indexes and unknown scope types must never fall back to all-marks.
    const canCollapse = sharedScope && el.semanticRole === 'data-mark'
      && !el.compositeMarkType
      && ['all-marks', 'same-mark-type', 'field-value'].includes(scopeType)
      && (scopeType !== 'field-value' || (el._scopeData?.field != null && el._scopeData?.value != null))
    if (canCollapse) {
      scope = scopeType === 'field-value'
        ? { type: 'by-field', field: el._scopeData.field, fieldValue: el._scopeData.value }
        : { type: 'all-marks' }
    } else if (['axis', 'legend', 'text'].includes(el.semanticRole) || el.compositeMarkType) {
      // An explicit selection must not expand to every axis label, legend, or
      // composite sub-part merely because those elements share a role.
      scope = { type: 'selected-element' }
    }
    const item = {
      selector: el.selector || null, datum: el.datum || null, scope,
      originalValue: el.properties?.[property] ?? null,
      semanticRole: el.semanticRole || 'data-mark', markGroup: el.markGroup || null,
      axisChannel: el.axisChannel ?? null, axisSubType: el.axisSubType ?? null,
      legendField: el.legendField ?? null, legendValue: el.legendValue ?? null,
      legendSubType: el.legendSubType ?? null,
      compositeMarkType: el.compositeMarkType ?? null,
      compositeSubPart: el.compositeSubPart ?? null, layerIndex: el.layerIndex ?? null,
    }
    const key = canCollapse
      ? JSON.stringify([scope, item.layerIndex, item.markGroup])
      : JSON.stringify([item.selector, item.datum, item.layerIndex])
    if (!seen.has(key)) { seen.add(key); targets.push(item) }
  }
  return targets
}
