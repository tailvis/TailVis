import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { chromium } from 'playwright'

test('text edits retain saved element fonts on column-faceted charts', async () => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } })
    const values = ['Element Select', 'Scope Confirm', 'NL Prompt', 'Dynamic Widget', 'Property Widget'].flatMap((method, i) =>
      Array.from({ length: 8 }, (_, j) => ({ method, panel: i < 3 ? 'Input Modality' : 'Modification Strategy', percentage: j * 2 + i * 12 })))
    const spec = { data: { values }, width: 190, height: 299, mark: { type: 'boxplot', size: 50 }, encoding: {
      column: { field: 'panel', type: 'nominal', header: { title: null, labelFontSize: 13, labelFontWeight: 'bold' } },
      x: { field: 'method', type: 'nominal', axis: { labelAngle: 0, title: null } },
      y: { field: 'percentage', type: 'quantitative', scale: { zero: false }, axis: { title: 'percentage (%)' } },
    }, resolve: { scale: { x: 'independent' } }, config: { view: { stroke: 'transparent' } } }
    await page.addInitScript(state => {
      if (!localStorage.getItem('chart-authoring-state')) localStorage.setItem('chart-authoring-state', JSON.stringify(state))
    }, { _storageVersion: 10, chartObjects: [{ id: 64, x: 30, y: 30, width: 650, height: 450, spec }], nextChartId: 65, currentData: values })
    await page.goto(server.resolvedUrls.local[0] + '?system')
    const chart = page.locator('#vega-chart-64')
    const first = chart.locator('.role-axis-label text').filter({ hasText: /^Element Select$/ })
    await first.waitFor()
    const selector = await first.evaluate(async el => {
      const { generateSelector } = await import('/src/utils/elementUtils.js')
      const selector = generateSelector(el, el.closest('svg'))
      const state = JSON.parse(localStorage.getItem('chart-authoring-state'))
      state.chartObjects[0].svgOverrides = { [selector]: { font: 'Avenir', fontWeight: 'bold', color: '#123456' } }
      localStorage.setItem('chart-authoring-state', JSON.stringify(state))
      return selector
    })
    await page.addInitScript(selector => {
      const state = JSON.parse(localStorage.getItem('chart-authoring-state'))
      state.chartObjects[0].svgOverrides = { [selector]: { font: 'Avenir', fontWeight: 'bold', color: '#123456' } }
      localStorage.setItem('chart-authoring-state', JSON.stringify(state))
    }, selector)
    await page.reload()
    const label = chart.locator(selector)
    await label.waitFor()
    assert.equal(await label.getAttribute('font-family'), 'Avenir')
    await label.click()
    const editor = page.locator('.property-row textarea').first()
    await editor.fill('Element\nSelect')
    await page.waitForTimeout(400)
    assert.equal(await label.getAttribute('font-family'), 'Avenir', 'text edits must preserve saved font')
    assert.equal(await label.getAttribute('font-weight'), 'bold')
    assert.equal(await label.getAttribute('fill'), '#123456')
    assert.equal(await page.getByRole('combobox', { name: 'Font family', exact: true }).inputValue(), 'Avenir')
    await page.getByRole('combobox', { name: 'Font family', exact: true }).selectOption('Georgia')
    await editor.fill('Element Select edited')
    await page.waitForTimeout(400)
    assert.equal(await label.getAttribute('font-family'), 'Georgia')
    await page.getByRole('combobox', { name: 'Font family', exact: true }).selectOption('Avenir')
    await editor.fill('Element\nSelect again')
    await page.waitForTimeout(400)
    assert.equal(await label.getAttribute('font-family'), 'Avenir')
  } finally {
    await browser?.close()
    await server.close()
  }
})
