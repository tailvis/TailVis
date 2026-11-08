import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { chromium } from 'playwright'

test('system and demo share typed category scopes; intersection edits stay on selected boxes', async () => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } })
    const values = ['Element Select', 'Scope Confirm', 'NL Prompt', 'Dynamic Widget', 'Property Widget'].flatMap((method, i) =>
      Array.from({ length: 8 }, (_, j) => ({ method, percentage: i * 12 + j * 2, panel: i < 3 ? 'Input Modality' : 'Modification Strategy' })))
    const spec = { data: { values }, width: 520, height: 350,
      mark: { type: 'boxplot', size: 40, median: { color: 'white', thickness: 2 } }, encoding: {
        x: { field: 'method', type: 'nominal', sort: ['Element Select', 'Scope Confirm', 'NL Prompt', 'Dynamic Widget', 'Property Widget'] },
        y: { field: 'percentage', type: 'quantitative' },
        color: { field: 'panel', type: 'nominal', scale: { range: ['#88b4b9', '#e89379'] } },
      } }
    await page.addInitScript(state => localStorage.setItem('chart-authoring-state', JSON.stringify(state)), {
      _storageVersion: 10, chartObjects: [{ id: 1, x: 260, y: 80, width: 750, height: 500, spec }], nextChartId: 2, currentData: values,
    })
    await page.goto(server.resolvedUrls.local[0] + '?system')
    const boxes = page.locator('#vega-chart-1 .role-mark path[aria-roledescription="box"]')
    await boxes.first().waitFor()
    const bounds = await boxes.first().boundingBox()
    await page.mouse.click(bounds.x + 4, bounds.y + bounds.height - 4)
    const candidate = page.locator('.scope-candidate-item').filter({ hasText: /^Rect: Input Modality$/ })
    await candidate.waitFor()
    assert.equal(await candidate.count(), 1)
    assert.equal(await page.locator('.scope-candidate-item').filter({ hasText: /^All panel: Input Modality$/ }).count(), 1)
    // Check target semantics directly on real Vega nodes, including multi-selection.
    const scopes = await page.evaluate(async () => {
      const { generateScopeHierarchy } = await import('/src/utils/scopeHierarchy.js')
      const { detectElementType } = await import('/src/utils/elementUtils.js')
      const svg = document.querySelector('#vega-chart-1 svg')
      const spec = JSON.parse(localStorage.getItem('chart-authoring-state')).chartObjects[0].spec
      const boxes = [...svg.querySelectorAll('.role-mark path[aria-roledescription="box"]')]
      const infos = boxes.map(node => detectElementType(node, spec, svg))
      const summarize = selection => generateScopeHierarchy(selection, spec, svg).filter(entry => entry.scopeType === 'field-value-kind')
        .map(entry => ({ label: entry.label, count: entry.elements.length, boxesOnly: entry.elements.every(node => node.getAttribute('aria-roledescription') === 'box') }))
      return { single: summarize([infos[0]]), multiple: summarize(infos.slice(0, 2)), complete: summarize(infos.slice(0, 3)) }
    })
    assert.deepEqual(scopes.single, [{ label: 'Rect: Input Modality', count: 3, boxesOnly: true }])
    assert.deepEqual(scopes.multiple, scopes.single)
    assert.deepEqual(scopes.complete, [], 'already selected intersections are omitted')
    await candidate.click()
    await page.locator('.property-panel .element-type').filter({ hasText: /3/ }).waitFor()
    const fill = page.locator('.property-row').filter({ has: page.getByText('Fill', { exact: true }) }).locator('.hex-input')
    await fill.fill('#2255aa')
    await fill.press('Tab')
    await page.waitForFunction(() => [...document.querySelectorAll('#vega-chart-1 .role-mark path[aria-roledescription="box"]')].filter(node => node.getAttribute('fill') === '#2255aa').length === 3)
    assert.deepEqual(await boxes.evaluateAll(nodes => nodes.map(node => node.getAttribute('fill'))), ['#2255aa', '#2255aa', '#2255aa', '#e89379', '#e89379'])
    assert.ok(await page.locator('#vega-chart-1 .role-mark [data-editor-line-path]').evaluateAll(nodes => nodes.length === 5 && nodes.every(node => node.getAttribute('stroke') === 'white')))
    assert.equal(await page.locator('#vega-chart-1 .role-mark.mark-rule line[stroke="#2255aa"]').count(), 0)
    // Unrelated UI selection/re-render must retain the exact edited targets.
    await page.mouse.click(1400, 850)
    assert.equal(await page.locator('#vega-chart-1 .role-mark path[aria-roledescription="box"][fill="#2255aa"]').count(), 3)
  } finally { await browser?.close(); await server.close() }
})
