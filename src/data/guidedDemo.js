import initialSpec from './guidedInteractions.json'

export const DEMO_STORAGE_KEY = 'tailvis-guided-demo-v1'
export const DEMO_REQUESTS = [
  { id: 'colors', label: 'Change the colors by interaction type.', hint: 'Create color controls for the two interaction types.' },
  { id: 'facets', label: 'Split the chart into two panels.', hint: 'Separate Input Modality and Modification Strategy.' },
  { id: 'medians', label: 'Show the median values.', hint: 'Add data-bound labels and adjust their appearance.' },
]

export function createDemoState() {
  const spec = structuredClone(initialSpec)
  return {
    _storageVersion: 10,
    chartObjects: [{ id: 1, x: 50, y: 60, width: 560, height: 460, spec, dataSourceId: 'demo-interactions' }],
    nextChartId: 2, lastSelectedChartId: 1,
    currentData: spec.data.values, dataSourceName: 'interaction_patterns_demo.csv',
    activeDataSourceId: 'demo-interactions',
    dataSources: { 'demo-interactions': { id: 'demo-interactions', name: 'interaction_patterns_demo.csv', values: spec.data.values } },
  }
}

// Presets interpret the three guided requests; rendering, preview, widgets and
// applying/branching stay in the real editor. Every operation starts at the
// current spec, so earlier changes survive different request orders.
export function buildDemoResponse(chartSpec, requestId) {
  const request = DEMO_REQUESTS.find(item => item.id === requestId)
  if (!request) throw new Error('Choose one of the three guided requests.')
  const spec = structuredClone(chartSpec)
  let unit = spec.facet ? spec.spec : spec
  let prefix = spec.facet ? 'spec.' : ''
  if (unit?.encoding?.x?.field !== 'method' || unit?.encoding?.y?.field !== 'percentage') {
    throw new Error('These requests use the Interaction Patterns example. Reset the demo to try them again.')
  }
  let widgets = []
  if (requestId === 'colors') {
    unit.encoding.color = { field: 'panel', type: 'nominal', legend: null,
      scale: { domain: ['Input Modality', 'Modification Strategy'], range: ['#88b4b9', '#e89379'] } }
    widgets = ['Input Modality', 'Modification Strategy'].map((label, index) => ({
      id: `panel-color-${index}`, label, type: 'color',
      path: `${prefix}encoding.color.scale.range[${index}]`, value: unit.encoding.color.scale.range[index],
    }))
  }
  if (requestId === 'facets') {
    if (!spec.facet) {
      // Facet is a composition, so keep data/config/title at the outer level.
      const { data, config, title, $schema, ...inner } = spec
      Object.keys(spec).forEach(key => delete spec[key])
      Object.assign(spec, { $schema, data, config, title, spec: inner })
    }
    spec.facet = { column: { field: 'panel', type: 'nominal', sort: ['Input Modality', 'Modification Strategy'],
      header: { title: null, labelFont: 'Avenir', labelFontSize: 13, labelFontWeight: 'bold', labelColor: '#25343c', labelPadding: 14 } } }
    spec.spec.width = 218
    spec.resolve = { ...spec.resolve, scale: { ...spec.resolve?.scale, x: 'independent' } }
    widgets = [
      { id: 'facet-x-scale', label: 'X-axis scale across facets', type: 'select', path: 'resolve.scale.x', value: 'independent', options: ['independent', 'shared'] },
      { id: 'facet-title-size', label: 'Facet title size', type: 'number', path: 'facet.column.header.labelFontSize', value: 13, min: 6, max: 48, step: 1 },
      { id: 'facet-spacing', label: 'Panel spacing', type: 'number', path: 'spacing', value: spec.spacing ?? 24, min: 0, max: 50, step: 1 },
    ]
    spec.spacing ??= 24
  }
  if (requestId === 'medians') {
    if (!unit.layer) {
      unit.layer = [{ mark: unit.mark }]
      delete unit.mark
    }
    let index = unit.layer.findIndex(layer => layer.name === 'median-labels')
    if (index < 0) {
      index = unit.layer.length
      unit.layer.push({ name: 'median-labels',
        mark: { type: 'text', align: 'left', dx: 23, font: 'Avenir', fontSize: 12, color: '#304a4e' },
        encoding: {
          y: { field: 'percentage', type: 'quantitative', aggregate: 'median' },
          text: { field: 'percentage', type: 'quantitative', aggregate: 'median', format: '.1f' },
          color: { value: '#304a4e' },
        },
      })
    }
    widgets = [
      { id: 'median-font-size', label: 'Label font size', type: 'number', path: `${prefix}layer[${index}].mark.fontSize`, value: unit.layer[index].mark.fontSize, min: 6, max: 48, step: 1 },
      { id: 'median-offset', label: 'Label offset', type: 'number', path: `${prefix}layer[${index}].mark.dx`, value: unit.layer[index].mark.dx, min: 0, max: 60, step: 1 },
    ]
  }
  return { message: `${request.hint} Adjust the widget preview, then apply to keep this version.`,
    new_spec: spec, widget_preview: widgets,
    clarification: { change_type: 'visual_refinement' },
    actions: [{ type: 'apply', label: 'Apply', primary: true }, { type: 'cancel', label: 'Cancel' }],
  }
}

export async function requestDemoResponse({ chartSpec, requestId }) {
  await new Promise(resolve => setTimeout(resolve, 550))
  return buildDemoResponse(chartSpec, requestId)
}
