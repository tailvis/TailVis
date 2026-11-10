import interactionSpec from './guidedInteractions.json'
import payrollSpec from './bar.json'
import populationSpec from './line.json'

export const DEMO_STORAGE_KEY = 'tailvis-guided-demo-v1'
export const DEMO_EXAMPLES = [
  { id: 'demo-interactions', label: 'Interaction patterns' },
  { id: 'demo-employment', label: 'Employment change' },
  { id: 'demo-population', label: 'Population over time' },
]
const REQUESTS = {
  colors: 'Change the colors by interaction type.',
  facets: 'Split the chart into two panels.',
  medians: 'Show the median values.',
  'soft-colors': 'Use a softer color palette.',
  'median-size': 'Make the median labels larger.',
  'panel-borders': 'Add panel borders.',
  'bar-colors': 'Color increases and decreases differently.',
  'bar-labels': 'Show the values.',
  'bar-horizontal': 'Make the bars horizontal.',
  'bar-label-size': 'Make the value labels larger.',
  'bar-grid': 'Remove the gridlines.',
  'line-points': 'Show the data points.',
  'line-smooth': 'Smooth the line.',
  'line-label': 'Label the latest value.',
  'line-width': 'Make the line thicker.',
  'line-grid': 'Remove the gridlines.',
  'line-label-size': 'Make the value label larger.',
}
const clone = value => structuredClone(value)
const unitOf = spec => spec?.facet ? spec.spec : spec
const markOf = unit => unit?.layer?.[0]?.mark ?? unit?.mark
const markType = mark => typeof mark === 'string' ? mark : mark?.type
const namedLayer = (unit, name) => unit?.layer?.find(layer => layer.name === name)
const softColors = ['#b3d5d8', '#f2b6a5']

function exampleKind(spec) {
  const enc = unitOf(spec)?.encoding
  const fields = [enc?.x?.field, enc?.y?.field]
  if (fields.includes('method') && fields.includes('percentage')) return 'box'
  if (fields.includes('month') && fields.includes('nonfarm_change')) return 'bar'
  if (fields.includes('year') && fields.includes('population')) return 'line'
  return null
}

// Derive choices from the current spec, not a global list of completed clicks.
// Backtracking to a different branch restores that branch's valid requests.
export function getDemoRequests(spec) {
  const unit = unitOf(spec)
  if (!unit) return []
  const mark = markOf(unit)
  const ids = []
  if (exampleKind(spec) === 'box') {
    if (unit.encoding.color?.field !== 'panel') ids.push('colors')
    if (!spec.facet) ids.push('facets')
    const median = namedLayer(unit, 'median-labels')
    if (!median) ids.push('medians')
    if (unit.encoding.color?.field === 'panel' && JSON.stringify(unit.encoding.color.scale?.range) !== JSON.stringify(softColors)) ids.push('soft-colors')
    if (median && (median.mark.fontSize ?? 12) < 16) ids.push('median-size')
    if (spec.facet && (!unit.view?.stroke || ['transparent', 'none'].includes(unit.view.stroke))) ids.push('panel-borders')
  }
  if (exampleKind(spec) === 'bar' && markType(mark) === 'bar') {
    if (!unit.encoding.color?.condition) ids.push('bar-colors')
    const labels = namedLayer(unit, 'value-labels')
    if (!labels) ids.push('bar-labels')
    if (unit.encoding.x.field !== 'nonfarm_change') ids.push('bar-horizontal')
    if (labels && (labels.mark.fontSize ?? 12) < 16) ids.push('bar-label-size')
    const channel = unit.encoding.x.field === 'nonfarm_change' ? 'x' : 'y'
    if (unit.encoding[channel].axis?.grid !== false) ids.push('bar-grid')
  }
  if (exampleKind(spec) === 'line' && markType(mark) === 'line') {
    if (!mark.point) ids.push('line-points')
    if (mark.interpolate !== 'monotone') ids.push('line-smooth')
    const label = namedLayer(unit, 'latest-label')
    if (!label) ids.push('line-label')
    if ((mark.strokeWidth ?? 2) < 4) ids.push('line-width')
    if (unit.encoding.y.axis?.grid !== false) ids.push('line-grid')
    if (label && (label.mark.fontSize ?? 12) < 16) ids.push('line-label-size')
  }
  return ids.slice(0, 3).map(id => ({ id, label: REQUESTS[id] }))
}

function exampleSpec(id) {
  if (id === 'demo-interactions') return clone(interactionSpec)
  const spec = clone(id === 'demo-employment' ? payrollSpec : populationSpec)
  spec.width = 445
  spec.height = 300
  spec.config = { ...clone(interactionSpec.config),
    axis: { labelColor: '#71818a', titleColor: '#556b73', labelFontSize: 11, titleFontSize: 12,
      gridColor: '#e8edef', domain: false, ticks: false, labelPadding: 8 }, view: { stroke: null } }
  if (id === 'demo-employment') {
    spec.title = { text: 'Annual Employment Change', anchor: 'start', fontSize: 21, color: '#253f48', offset: 20 }
    spec.mark = { type: 'bar', color: '#6e96bd', size: 22 }
    spec.encoding = {
      x: { field: 'month', type: 'ordinal', timeUnit: 'utcyear', axis: { title: null, format: '%Y', labelAngle: 0 } },
      y: { field: 'nonfarm_change', aggregate: 'sum', type: 'quantitative', axis: { title: 'Employment change (thousands)' } },
    }
  } else {
    spec.title = { text: 'Population over Time', anchor: 'start', fontSize: 21, color: '#253f48', offset: 20 }
    spec.mark = { type: 'line', color: '#6e96bd', strokeWidth: 2 }
    spec.encoding.x.axis = { ...spec.encoding.x.axis, grid: false }
    spec.encoding.y.axis = { title: 'Population' }
  }
  return spec
}

export function createDemoState() {
  const chartObjects = DEMO_EXAMPLES.map((example, i) => ({ id: i + 1, x: 50, y: 60 + i * 740, width: 560, height: 460, spec: exampleSpec(example.id), dataSourceId: example.id }))
  const dataSources = Object.fromEntries(chartObjects.map((chart, i) => [chart.dataSourceId, {
    id: chart.dataSourceId, name: ['interaction_patterns_demo.csv', 'employment_change.csv', 'population.csv'][i], values: chart.spec.data.values,
  }]))
  return { _storageVersion: 10, chartObjects, nextChartId: 4, lastSelectedChartId: 1,
    currentData: chartObjects[0].spec.data.values, dataSourceName: dataSources['demo-interactions'].name,
    activeDataSourceId: 'demo-interactions', dataSources }
}

// Add the new roots to existing saved demos without discarding prior work or IDs.
export function restoreDemoState(saved) {
  const state = clone(saved)
  const defaults = createDemoState()
  state.chartObjects ||= []
  state.dataSources = { ...defaults.dataSources, ...state.dataSources }
  let next = Math.max(state.nextChartId || 1, ...state.chartObjects.map(chart => chart.id + 1))
  for (const root of defaults.chartObjects) {
    if (!state.chartObjects.some(chart => !chart.parentId && chart.dataSourceId === root.dataSourceId)) state.chartObjects.push({ ...root, id: next++ })
  }
  state.nextChartId = next
  // Update saved preset defaults too, while keeping explicit font selections.
  const isFont = key => /font(?:family)?$/i.test(key)
  const updateDefaults = object => {
    if (!object || typeof object !== 'object') return
    for (const [key, value] of Object.entries(object)) {
      if (isFont(key) && value === 'Avenir') object[key] = 'sans-serif'
      else if (value && typeof value === 'object') updateDefaults(value)
    }
  }
  for (const chart of state.chartObjects) {
    const explicitFont = chart.modifications?.some(mod => isFont(mod.property || '') && mod.value === 'Avenir')
      || [chart.svgOverrides, chart.baseSvgOverrides].some(overrides => Object.values(overrides || {})
        .some(props => Object.entries(props || {}).some(([key, value]) => isFont(key) && value === 'Avenir')))
    if (!explicitFont) {
      updateDefaults(chart.spec)
      updateDefaults(chart.baseSpec)
    }
  }
  return state
}

function ensureLayers(unit) {
  if (!unit.layer) { unit.layer = [{ mark: unit.mark }]; delete unit.mark }
}
function labelWidgets(unit, prefix, name, offsetProperty) {
  const index = unit.layer.findIndex(layer => layer.name === name)
  const mark = unit.layer[index].mark
  return [
    { id: `${name}-font-size`, label: 'Label font size', type: 'number', path: `${prefix}layer[${index}].mark.fontSize`, value: mark.fontSize, min: 6, max: 48, step: 1 },
    ...(offsetProperty ? [{ id: `${name}-offset`, label: 'Label offset', type: 'number', path: `${prefix}layer[${index}].mark.${offsetProperty}`, value: mark[offsetProperty], min: 0, max: 60, step: 1 }] : []),
  ]
}

export function buildDemoResponse(chartSpec, requestId) {
  if (!getDemoRequests(chartSpec).some(request => request.id === requestId)) throw new Error('This request is not available for the current chart.')
  const spec = clone(chartSpec)
  const unit = unitOf(spec)
  const prefix = spec.facet ? 'spec.' : ''
  let widgets = []
  if (['colors', 'soft-colors'].includes(requestId)) {
    unit.encoding.color = { field: 'panel', type: 'nominal', legend: null,
      scale: { domain: ['Input Modality', 'Modification Strategy'], range: requestId === 'colors' ? ['#88b4b9', '#e89379'] : clone(softColors) } }
    widgets = unit.encoding.color.scale.domain.map((label, index) => ({ id: `panel-color-${index}`, label, type: 'color', path: `${prefix}encoding.color.scale.range[${index}]`, value: unit.encoding.color.scale.range[index] }))
  }
  if (requestId === 'facets') {
    const { data, config, title, $schema, ...inner } = spec
    Object.keys(spec).forEach(key => delete spec[key])
    Object.assign(spec, { $schema, data, config, title, spec: inner })
    spec.facet = { column: { field: 'panel', type: 'nominal', sort: ['Input Modality', 'Modification Strategy'],
      header: { title: null, labelFont: 'sans-serif', labelFontSize: 13, labelFontWeight: 'bold', labelColor: '#25343c', labelPadding: 14 } } }
    spec.spec.width = 218
    spec.resolve = { scale: { x: 'independent' } }
    spec.spacing = 24
    widgets = [
      { id: 'facet-x-scale', label: 'X-axis scale across facets', type: 'select', path: 'resolve.scale.x', value: 'independent', options: ['independent', 'shared'] },
      { id: 'facet-title-size', label: 'Facet title size', type: 'number', path: 'facet.column.header.labelFontSize', value: 13, min: 6, max: 48, step: 1 },
      { id: 'facet-spacing', label: 'Panel spacing', type: 'number', path: 'spacing', value: 24, min: 0, max: 50, step: 1 },
    ]
  }
  if (requestId === 'medians') {
    ensureLayers(unit)
    unit.layer.push({ name: 'median-labels', mark: { type: 'text', align: 'left', dx: 23, font: 'sans-serif', fontSize: 12, color: '#304a4e' },
      encoding: { y: { field: 'percentage', type: 'quantitative', aggregate: 'median' }, text: { field: 'percentage', type: 'quantitative', aggregate: 'median', format: '.1f' }, color: { value: '#304a4e' } } })
    widgets = labelWidgets(unit, prefix, 'median-labels', 'dx')
  }
  if (requestId === 'panel-borders') {
    unit.view = { ...unit.view, stroke: '#b9c9d5', strokeWidth: 1 }
    widgets = [
      { id: 'panel-border-color', label: 'Panel border color', type: 'color', path: `${prefix}view.stroke`, value: '#b9c9d5' },
      { id: 'panel-border-width', label: 'Panel border width', type: 'number', path: `${prefix}view.strokeWidth`, value: 1, min: 0, max: 10, step: 0.5 },
    ]
  }
  if (requestId === 'bar-colors') {
    unit.encoding.color = { condition: { test: 'datum.sum_nonfarm_change < 0', value: '#e89379' }, value: '#88b4b9' }
    widgets = [
      { id: 'bar-negative', label: 'Decrease color', type: 'color', path: `${prefix}encoding.color.condition.value`, value: '#e89379' },
      { id: 'bar-positive', label: 'Increase color', type: 'color', path: `${prefix}encoding.color.value`, value: '#88b4b9' },
    ]
  }
  if (requestId === 'bar-labels') {
    ensureLayers(unit)
    const horizontal = unit.encoding.x.field === 'nonfarm_change'
    unit.layer.push({ name: 'value-labels', mark: { type: 'text', fontSize: 12, color: '#304a4e',
      ...(horizontal ? { align: { expr: "datum.sum_nonfarm_change < 0 ? 'right' : 'left'" }, baseline: 'middle', dx: { expr: 'datum.sum_nonfarm_change < 0 ? -7 : 7' } }
        : { baseline: { expr: "datum.sum_nonfarm_change < 0 ? 'top' : 'bottom'" }, dy: { expr: 'datum.sum_nonfarm_change < 0 ? 5 : -5' } }) },
      encoding: { text: { field: 'nonfarm_change', aggregate: 'sum', type: 'quantitative', format: ',.0f' }, color: { value: '#304a4e' } } })
    widgets = labelWidgets(unit, prefix, 'value-labels')
  }
  if (requestId === 'bar-horizontal') {
    ;[unit.encoding.x, unit.encoding.y] = [unit.encoding.y, unit.encoding.x]
    unit.encoding.y.axis = { ...unit.encoding.y.axis, format: '%Y' }
    const label = namedLayer(unit, 'value-labels')
    if (label) {
      Object.assign(label.mark, { align: { expr: "datum.sum_nonfarm_change < 0 ? 'right' : 'left'" }, baseline: 'middle', dx: { expr: 'datum.sum_nonfarm_change < 0 ? -7 : 7' } })
      delete label.mark.dy
    }
    const markPath = unit.layer ? 'layer[0].mark' : 'mark'
    widgets = [{ id: 'bar-size', label: 'Bar thickness', type: 'number', path: `${prefix}${markPath}.size`, value: markOf(unit).size, min: 5, max: 50, step: 1 }]
  }
  if (requestId === 'line-points' || requestId === 'line-smooth' || requestId === 'line-width') {
    const mark = markOf(unit)
    const path = `${prefix}${unit.layer ? 'layer[0].mark' : 'mark'}`
    if (requestId === 'line-points') {
      mark.point = { filled: true, size: 35 }
      widgets = [{ id: 'line-point-size', label: 'Point size', type: 'number', path: `${path}.point.size`, value: 35, min: 5, max: 150, step: 5 }]
    }
    if (requestId === 'line-smooth') {
      mark.interpolate = 'monotone'
      widgets = [{ id: 'line-interpolate', label: 'Curve', type: 'select', path: `${path}.interpolate`, value: 'monotone', options: ['linear', 'monotone', 'step'] }]
    }
    if (requestId === 'line-width') {
      mark.strokeWidth = 4
      widgets = [{ id: 'line-width', label: 'Line width', type: 'number', path: `${path}.strokeWidth`, value: 4, min: 1, max: 10, step: 0.5 }]
    }
  }
  if (requestId === 'line-label') {
    ensureLayers(unit)
    unit.layer.push({ name: 'latest-label', transform: [{ window: [{ op: 'rank', as: 'latest_rank' }], sort: [{ field: 'year', order: 'descending' }] }, { filter: 'datum.latest_rank === 1' }],
      mark: { type: 'text', align: 'left', dx: 9, fontSize: 12, color: '#304a4e' },
      encoding: { text: { field: 'population', type: 'quantitative', format: ',.0f' }, color: { value: '#304a4e' } } })
    widgets = labelWidgets(unit, prefix, 'latest-label', 'dx')
  }
  if (['median-size', 'bar-label-size', 'line-label-size'].includes(requestId)) {
    const name = { 'median-size': 'median-labels', 'bar-label-size': 'value-labels', 'line-label-size': 'latest-label' }[requestId]
    namedLayer(unit, name).mark.fontSize = 16
    widgets = labelWidgets(unit, prefix, name)
  }
  if (requestId.endsWith('-grid')) {
    const channel = unit.encoding.x.field === 'nonfarm_change' ? 'x' : 'y'
    unit.encoding[channel].axis = { ...unit.encoding[channel].axis, grid: false }
    widgets = [{ id: `${channel}-grid`, label: 'Gridlines', type: 'boolean', path: `${prefix}encoding.${channel}.axis.grid`, value: false }]
  }
  return { message: { colors: 'Colors updated.', facets: 'Chart split into two panels.', medians: 'Median values added.', 'soft-colors': 'Color palette updated.', 'median-size': 'Median labels enlarged.', 'panel-borders': 'Panel borders added.', 'bar-colors': 'Increases and decreases now use different colors.', 'bar-labels': 'Value labels added.', 'bar-horizontal': 'Bars changed to horizontal.', 'bar-label-size': 'Value labels enlarged.', 'bar-grid': 'Gridlines removed.', 'line-points': 'Data points added.', 'line-smooth': 'Line smoothed.', 'line-label': 'Latest value labeled.', 'line-width': 'Line width increased.', 'line-grid': 'Gridlines removed.', 'line-label-size': 'Value label enlarged.' }[requestId], new_spec: spec, widget_preview: widgets,
    clarification: { change_type: 'visual_refinement' }, actions: [{ type: 'apply', label: 'Apply', primary: true }, { type: 'cancel', label: 'Cancel' }] }
}

export async function requestDemoResponse({ chartSpec, requestId }) {
  await new Promise(resolve => setTimeout(resolve, 550))
  return buildDemoResponse(chartSpec, requestId)
}
