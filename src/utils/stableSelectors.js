import { generateSelector } from './elementUtils.js'

// Upgrade saved targets while the old DOM still exists, before a spec edit can
// change an axis/legend's accessibility description. Never broaden a selector.
export function stabilizeChartSelectors(chart, svg) {
  if (!svg) return chart
  const cache = new Map()
  const selectorFor = selector => {
    if (!selector) return selector
    if (cache.has(selector)) return cache.get(selector)
    let next = selector
    try {
      const elements = svg.querySelectorAll(selector)
      if (elements.length === 1) next = generateSelector(elements[0], svg) || selector
    } catch { /* Keep unresolved saved targets intact. */ }
    cache.set(selector, next)
    return next
  }
  const targetFor = target => ({
    ...target,
    ...(target.selector ? { selector: selectorFor(target.selector) } : {}),
    ...(target.scope?.selector ? { scope: { ...target.scope, selector: selectorFor(target.scope.selector) } } : {}),
    ...(target.group ? { group: target.group.map(targetFor) } : {}),
  })
  const overridesFor = overrides => overrides && Object.entries(overrides).reduce((result, [selector, props]) => {
    const next = selectorFor(selector)
    result[next] = { ...result[next], ...props }
    return result
  }, {})
  return {
    ...chart,
    modifications: chart.modifications?.map(targetFor),
    svgOverrides: overridesFor(chart.svgOverrides),
    baseSvgOverrides: overridesFor(chart.baseSvgOverrides),
  }
}
