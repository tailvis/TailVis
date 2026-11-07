import test from 'node:test'
import assert from 'node:assert/strict'
import { compile } from 'vega-lite'
import { View, parse } from 'vega'
import { applyModificationsToSpec } from '../src/utils/scopeUtils.js'
import { buildSelectionTargets } from '../src/utils/selectionTargets.js'

const base = {
  data: { values: [{ category: 'A', value: 1 }, { category: 'B', value: 2 }] },
  mark: 'text',
  encoding: {
    x: { field: 'category', type: 'nominal' },
    y: { field: 'value', type: 'quantitative' },
    text: { field: 'category' },
    color: { field: 'category', type: 'nominal' },
  },
}

async function render(spec) {
  const view = new View(parse(compile(spec).spec), { renderer: 'none' })
  try { await view.runAsync(); return await view.toSVG() }
  finally { view.finalize() }
}

test('font edits to an explicit legend label remain isolated SVG overrides', () => {
  const group = buildSelectionTargets([{
    selector: '.role-legend-label text:first-child', semanticRole: 'legend',
    legendSubType: 'label', legendField: 'category', legendValue: 'A',
  }], 'font')
  const result = applyModificationsToSpec(base, [{ property: 'font', value: 'Georgia', group }])
  assert.deepEqual(result.svgOverrides, { '.role-legend-label text:first-child': { font: 'Georgia' } })
  assert.equal(result.spec.config?.legend?.labelFont, undefined)
})

test('axis and legend scope font edits map to their own Vega-Lite properties', async () => {
  const result = applyModificationsToSpec(base, [
    { property: 'font', value: 'Georgia', semanticRole: 'axis', axisChannel: 'x', axisSubType: 'label', scope: { type: 'this-only' } },
    { property: 'font', value: 'Courier New', semanticRole: 'legend', scope: { type: 'legend-title' } },
    { property: 'font', value: 'Times New Roman', semanticRole: 'legend', scope: { type: 'all-legend-labels' } },
  ])
  assert.equal(result.spec.encoding.x.axis.labelFont, 'Georgia')
  assert.equal(result.spec.config.legend.titleFont, 'Courier New')
  assert.equal(result.spec.config.legend.labelFont, 'Times New Roman')
  const svg = await render(result.spec)
  for (const font of ['Georgia', 'Courier New', 'Times New Roman']) assert.ok(svg.includes(`font-family="${font}"`))
})

test('whole-legend font controls preserve symbol styling', async () => {
  const result = applyModificationsToSpec(base, [
    { property: 'labelFont', value: 'Georgia', semanticRole: 'legend', scope: { type: 'all-in-legend' } },
    { property: 'titleFont', value: 'Courier New', semanticRole: 'legend', scope: { type: 'all-in-legend' } },
  ])
  assert.equal(result.spec.encoding.color.legend.labelFont, 'Georgia')
  assert.equal(result.spec.encoding.color.legend.titleFont, 'Courier New')
  assert.equal(result.spec.encoding.color.legend.symbolFillColor, undefined)
  await render(result.spec)
})
