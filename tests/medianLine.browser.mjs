import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { chromium } from 'playwright'

test('boxplot medians open Line controls and edits remain isolated after rerender', async () => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } })
    const values = ['A', 'B', 'C'].flatMap((category, i) => Array.from({ length: 8 }, (_, j) => ({ category, value: i * 10 + j * 2 })))
    const spec = { data: { values }, width: 420, height: 300, mark: { type: 'boxplot', median: { thickness: 2 } }, encoding: {
      x: { field: 'category', type: 'nominal' }, y: { field: 'value', type: 'quantitative' },
    } }
    await page.addInitScript(state => localStorage.setItem('chart-authoring-state', JSON.stringify(state)), {
      _storageVersion: 10, chartObjects: [{ id: 1, x: 30, y: 30, width: 600, height: 450, spec }], nextChartId: 2, currentData: values,
    })
    await page.goto(server.resolvedUrls.local[0] + '?system')
    const medians = page.locator('#vega-chart-1 .role-mark.mark-rect[aria-hidden="true"] path')
    await medians.first().waitFor({ state: 'attached' })
    const box = await medians.first().boundingBox()
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.locator('.property-panel .element-type').filter({ hasText: /^Line$/ }).waitFor()
    assert.equal(await page.locator('.property-row > label').filter({ hasText: /^Fill$/ }).count(), 0)
    const row = name => page.locator('.property-row').filter({ has: page.getByText(name, { exact: true }) })
    await row('Stroke').locator('.hex-input').fill('#cc2233')
    await row('Stroke Width').locator('input[type="number"]').fill('4')
    await row('Line Style').locator('select').selectOption('4,4')
    await page.waitForTimeout(300)
    assert.equal(await medians.first().getAttribute('fill'), 'none')
    assert.equal(await medians.first().getAttribute('stroke'), '#cc2233')
    assert.equal(await medians.first().getAttribute('stroke-width'), '4')
    assert.equal(await medians.first().getAttribute('stroke-dasharray'), '4,4')
    assert.equal(await medians.nth(1).getAttribute('stroke'), 'white')
    assert.equal(await medians.nth(1).getAttribute('stroke-width'), '2')
    assert.equal(await page.locator('#vega-chart-1 path[aria-roledescription="box"]').first().getAttribute('fill'), '#4c78a8')
    // Reselecting the same line must read its line style, not its old rectangle fill.
    await page.mouse.click(1000, 850)
    const updated = await medians.first().boundingBox()
    await page.mouse.click(updated.x + 2, updated.y + updated.height / 2)
    await page.locator('.property-panel .element-type').filter({ hasText: /^Line$/ }).waitFor()
    assert.equal(await row('Stroke').locator('.hex-input').inputValue(), '#cc2233')
    assert.equal(await row('Stroke Width').locator('input[type="number"]').inputValue(), '4')
    assert.equal(await row('Line Style').locator('select').inputValue(), '4,4')
  } finally {
    await browser?.close()
    await server.close()
  }
})
