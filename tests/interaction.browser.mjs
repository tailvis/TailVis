import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { compile } from 'vega-lite'
import { View, parse } from 'vega'

test('real Vega SVG sub-part selection and multiline text editing', async () => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.goto(server.resolvedUrls.local[0])
    const data = Array.from({ length: 32 }, (_, i) => ({
      panel: i < 16 ? 'First' : 'Second', category: i % 16 < 8 ? 'A' : 'B', value: i % 8,
    }))
    const unit = { mark: { type: 'boxplot', median: { thickness: 14 } }, encoding: {
      x: { field: 'category', type: 'nominal' }, y: { field: 'value', type: 'quantitative' },
    } }
    const specs = [
      { data: { values: data }, ...unit },
      { data: { values: data }, mark: unit.mark, encoding: { x: unit.encoding.y, y: unit.encoding.x } },
      { data: { values: data }, facet: { column: { field: 'panel', type: 'nominal' } }, spec: unit },
      { data: { values: data }, layer: [unit, { ...unit, mark: 'bar' }] },
    ]
    for (const spec of specs) {
      const compiled = compile(spec).spec
      const view = new View(parse(compiled), { renderer: 'none' })
      await view.runAsync()
      const svg = await view.toSVG()
      view.finalize()
      const result = await page.evaluate(async ({ spec, svg, compiled }) => {
        const { detectElementType } = await import('/src/utils/elementUtils.js')
        const { generateScopeHierarchy } = await import('/src/utils/scopeHierarchy.js')
        const { buildSelectionTargets } = await import('/src/utils/selectionTargets.js')
        const { applyModificationsToSpec } = await import('/src/utils/scopeUtils.js')
        document.body.innerHTML = svg
        const root = document.querySelector('svg')
        const names = new Set()
        const walk = marks => marks?.forEach(m => {
          if (m.style?.includes('boxplot-median')) names.add(m.name)
          walk(m.marks)
        })
        walk(compiled.marks)
        const medians = [...root.querySelectorAll('g.role-mark')]
          .filter(g => [...g.classList].some(c => names.has(c))).flatMap(g => [...g.children])
        const infos = medians.map(el => detectElementType(el, spec, root))
        const scope = generateScopeHierarchy([infos[0]], spec, root).find(s => s.scopeType === 'composite-sub-all')
        const boxes = [...root.querySelectorAll('[aria-roledescription="box"]')]
        const selectedInfos = scope.elements.map(el => detectElementType(el, spec, root))
        const edited = applyModificationsToSpec(spec, [{
          property: 'fill', value: '#ff0000', group: buildSelectionTargets(selectedInfos, 'fill'),
        }])
        const targets = Object.keys(edited.svgOverrides).flatMap(selector => [...root.querySelectorAll(selector)])
        return {
          expected: medians.length, selected: scope?.elements.length,
          exact: scope?.elements.every(el => medians.includes(el)),
          editExact: targets.length === medians.length && targets.every(el => medians.includes(el)),
          medianParts: infos.map(i => i.compositeSubPart),
          boxParts: boxes.map(el => detectElementType(el, spec, root).compositeSubPart),
        }
      }, { spec, svg, compiled })
      assert.ok(result.expected > 1)
      assert.equal(result.selected, result.expected)
      assert.equal(result.exact, true)
      assert.equal(result.editExact, true)
      assert.ok(result.medianParts.every(p => p === 'median'))
      assert.ok(result.boxParts.every(p => p === 'box'))
    }
    const text = await page.evaluate(async () => {
      const { setSvgText, readSvgText } = await import('/src/utils/svgText.js')
      document.body.innerHTML = '<svg><text x="25" y="20" text-anchor="middle" font-size="12">Before</text></svg>'
      const el = document.querySelector('text')
      setSvgText(el, 'First\n\nThird')
      const value = readSvgText(el)
      const ys = [...el.children].map(c => c.getBoundingClientRect().y)
      setSvgText(el, 'One line')
      return { value, ys, single: readSvgText(el), spans: el.children.length }
    })
    assert.equal(text.value, 'First\n\nThird')
    assert.ok(text.ys[2] > text.ys[0] + 20)
    assert.equal(text.single, 'One line')
    assert.equal(text.spans, 0)

    const upgraded = await page.evaluate(async () => {
      const { stabilizeChartSelectors } = await import('/src/utils/stableSelectors.js')
      document.body.innerHTML = '<svg><g class="role-axis" aria-label="X-axis titled method"><g class="role-axis-label"><text>Edited</text><text>Other</text></g></g></svg>'
      const svg = document.querySelector('svg')
      const legacy = 'g[aria-label="X-axis titled method"] > g > text:nth-of-type(1)'
      const updated = stabilizeChartSelectors({
        modifications: [{ selector: legacy, scope: { type: 'this-only', selector: legacy }, group: [{ selector: legacy }] }],
        svgOverrides: { [legacy]: { text: 'Edited' } },
        baseSvgOverrides: { [legacy]: { fontSize: 13 } },
      }, svg)
      svg.querySelector('.role-axis').setAttribute('aria-label', 'X-axis')
      const selector = updated.modifications[0].selector
      return {
        text: svg.querySelector(selector)?.textContent,
        scope: updated.modifications[0].scope.selector === selector,
        group: updated.modifications[0].group[0].selector === selector,
        overrides: updated.svgOverrides[selector]?.text,
        baseline: updated.baseSvgOverrides[selector]?.fontSize,
      }
    })
    assert.deepEqual(upgraded, { text: 'Edited', scope: true, group: true, overrides: 'Edited', baseline: 13 })

    await page.evaluate(async () => {
      const { default: React } = await import('/node_modules/.vite/deps/react.js')
      const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js')
      const { default: PropertyPanel } = await import('/src/components/PropertyPanel.jsx')
      document.body.innerHTML = '<div id="test-panel"></div>'
      const selectedElement = { type: 'text', elementPath: 'text', semanticRole: 'text', properties: { text: 'First' } }
      function Editor() {
        const [selected, setSelected] = React.useState(selectedElement)
        return React.createElement(PropertyPanel, {
          selectedElement: selected,
          onPropertyChange: (_path, property, value) => setSelected(s => ({ ...s, properties: { ...s.properties, [property]: value } })),
        })
      }
      ReactDOM.createRoot(document.getElementById('test-panel')).render(React.createElement(Editor))
    })
    const editor = page.locator('.property-row textarea').first()
    await editor.fill('First')
    await editor.press('End')
    await editor.press('Enter')
    await editor.pressSequentially('Second')
    assert.equal(await editor.inputValue(), 'First\nSecond')
  } finally {
    await browser?.close()
    await server.close()
  }
})
