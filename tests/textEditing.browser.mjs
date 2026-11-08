import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { chromium } from 'playwright'

test('editing actual facet labels keeps whitespace and isolates selection changes', async () => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } })
    const logs = []
    page.on('console', msg => { if (msg.text().startsWith('[MOD]')) logs.push(msg.text()) })
    const values = ['Element Select', 'NL Prompt', 'Scope Confirm', 'Dynamic Widget', 'Property Widget'].flatMap((method, i) =>
      Array.from({ length: 8 }, (_, j) => ({ method, panel: i < 3 ? 'Input Modality' : 'Modification Strategy', value: j * 2 + i * 12 })))
    const spec = { data: { values }, facet: { column: { field: 'panel', type: 'nominal' } }, spec: {
      width: 270, height: 300, mark: 'boxplot', encoding: {
        x: { field: 'method', type: 'nominal', sort: null, axis: { labelAngle: 0 } },
        y: { field: 'value', type: 'quantitative' },
      },
    }, resolve: { scale: { x: 'independent' } } }
    await page.addInitScript(state => localStorage.setItem('chart-authoring-state', JSON.stringify(state)), {
      _storageVersion: 10, chartObjects: [{ id: 64, x: 30, y: 30, width: 650, height: 450, spec }],
      nextChartId: 65, currentData: values,
    })
    await page.goto(server.resolvedUrls.local[0] + '?system')
    const chart = page.locator('#vega-chart-64')
    await chart.locator('.role-axis-label text').first().waitFor()
    const label = name => chart.locator('.role-axis-label text').filter({ hasText: new RegExp(`^${name}$`) })
    // Native text selection must clear before D3/panel handlers consume a click.
    const selectChartText = () => chart.evaluate(container => {
      const range = document.createRange()
      range.selectNodeContents(container)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      return selection.toString()
    })
    assert.ok((await selectChartText()).includes('Element Select'))
    await page.getByRole('button', { name: 'Properties', exact: true }).click()
    assert.equal(await page.evaluate(() => window.getSelection().toString()), '')
    assert.ok((await selectChartText()).includes('Element Select'))
    await label('Element Select').click()
    assert.equal(await page.evaluate(() => window.getSelection().toString()), '')
    const editor = page.locator('.property-row textarea').first()
    await editor.waitFor()
    assert.ok((await selectChartText()).includes('Element Select'))
    await editor.click()
    assert.equal(await page.evaluate(() => window.getSelection().toString()), '')
    assert.equal(await editor.inputValue(), 'Element Select')
    await editor.focus()
    await editor.press('ControlOrMeta+A')
    assert.deepEqual(await editor.evaluate(el => [el.selectionStart, el.selectionEnd]), [0, 14])
    await editor.press('ArrowRight')
    await editor.press('Home')
    await editor.press('ArrowRight')
    await editor.press('Space')
    await editor.press('Enter')
    await editor.pressSequentially('Test ', { delay: 60 })
    await page.waitForTimeout(500)
    let typed = 'E \nTest lement Select'
    assert.equal(await editor.inputValue(), typed, JSON.stringify(logs))
    assert.equal(await chart.locator('.role-axis-label text').filter({ hasText: 'Test' }).count(), 1)
    await editor.press('End')
    await editor.press('Space')
    typed += ' '
    await page.waitForTimeout(200)
    assert.equal(await editor.inputValue(), typed)
    await editor.press('Enter')
    typed += '\n'
    await page.waitForTimeout(200)
    assert.equal(await editor.inputValue(), typed)
    await editor.press('Enter')
    typed += '\n'
    await page.waitForTimeout(200)
    assert.equal(await editor.inputValue(), typed)
    await label('Scope Confirm').click()
    assert.equal(await editor.inputValue(), 'Scope Confirm')
    await page.waitForTimeout(300)
    await editor.fill('Scope\nConfirm')
    await page.waitForTimeout(500)
    assert.equal(await editor.inputValue(), 'Scope\nConfirm')
    const rendered = await chart.locator('.role-axis-label text').evaluateAll(els => els.map(el =>
      el.children.length ? [...el.children].map(t => t.textContent === '\u200b' ? '' : t.textContent).join('\n') : el.textContent))
    assert.ok(rendered.includes(typed), JSON.stringify({ rendered, logs }))
    assert.ok(rendered.includes('Scope\nConfirm'), JSON.stringify({ rendered, logs }))
    // A reselection must read the edited text, and typing must update the same mod.
    await chart.locator('.role-axis-label text').filter({ hasText: 'Test' }).locator('tspan').first().click()
    assert.equal(await editor.inputValue(), typed)
    await editor.press('End')
    await editor.pressSequentially('Again', { delay: 0 })
    typed += 'Again'
    await page.waitForTimeout(300)
    assert.equal(await editor.inputValue(), typed)
    // Direct guide deletion must survive modification replay on a faceted spec.
    const methodTitles = () => chart.locator('.role-axis-title text').filter({ hasText: /^method$/ })
    assert.equal(await methodTitles().count(), 2)
    await methodTitles().first().click()
    await page.getByRole('button', { name: 'Delete Axis Title', exact: true }).click()
    await page.waitForTimeout(300)
    assert.equal(await methodTitles().count(), 0, 'axis titles disappear immediately')
    await chart.locator('.role-axis-label text').filter({ hasText: 'Test' }).locator('tspan').first().click()
    await editor.fill('Element\nSelect')
    await page.waitForTimeout(400)
    assert.equal(await methodTitles().count(), 0, 'label editing must not restore deleted titles')
    assert.equal(await chart.locator('.role-axis-title text').filter({ hasText: /^value$/ }).count(), 1)
    await page.waitForTimeout(700)
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('chart-authoring-state')))
    const mods = saved.chartObjects[0].modifications.filter(m => m.property === 'text')
    assert.equal(mods.length, 2, JSON.stringify(mods))
    assert.notEqual(mods[0].selector, mods[1].selector)
    assert.equal(saved.chartObjects[0].spec.spec.encoding.x.axis.title, null)
    assert.equal(saved.chartObjects[0].baseSpec.spec.encoding.x.axis.title, null)
  } finally {
    await browser?.close()
    await server.close()
  }
})
