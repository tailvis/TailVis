import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const server = await createServer({ server: { host: '127.0.0.1', port: 0 } })
await server.listen()
let browser
try {
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  await page.goto(`${server.resolvedUrls.local[0]}?gallery&example=ex_1782928410103`)
  const selector = '#vega-chart-49 svg .mark-text.role-mark text'
  await page.locator(selector).first().waitFor()
  const input = page.locator('.widget-position').filter({ hasText: 'Label Font Size' }).first()
    .locator('.option-control').filter({ hasText: 'Label Font Size' }).locator('input[type=number]')
  const readLabels = () => page.locator(selector).evaluateAll(elements => elements
    .filter(el => el.textContent.trim()).map(el => ({ text: el.textContent, size: el.getAttribute('font-size') })))
  const original = await readLabels()
  const storage = await page.evaluate(() => JSON.stringify(localStorage))
  const waitForSize = size => page.waitForFunction(({ selector, size }) => {
    const labels = [...document.querySelectorAll(selector)].filter(el => el.textContent.trim())
    return labels.length > 0 && labels.every(el => parseFloat(el.getAttribute('font-size')) === size)
  }, { selector, size })

  await input.fill('32')
  await waitForSize(32)
  const layers = await page.locator(selector).evaluateAll(elements => [...new Set(elements
    .filter(el => el.textContent.trim()).map(el => el.parentElement.getAttribute('class')))])
  assert.equal(layers.length, 3, 'increase, decrease, and in-bar labels all change')
  const undoKey = process.platform === 'darwin' ? 'Meta+z' : 'Control+z'
  const redoKey = process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z'
  await page.keyboard.press(undoKey)
  await page.waitForFunction(({ selector, original }) => JSON.stringify([...document.querySelectorAll(selector)]
    .filter(el => el.textContent.trim()).map(el => ({ text: el.textContent, size: el.getAttribute('font-size') }))) === JSON.stringify(original), { selector, original })
  assert.equal(await input.inputValue(), '9')
  await page.keyboard.press(redoKey)
  await waitForSize(32)
  assert.equal(await input.inputValue(), '32')

  const descendantSelector = '#vega-chart-52 svg .mark-text.role-mark text'
  await page.waitForFunction(selector => {
    const labels = [...document.querySelectorAll(selector)].filter(el => el.textContent.trim())
    return labels.length > 0 && labels.every(el => parseFloat(el.getAttribute('font-size')) === 32)
  }, descendantSelector)
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage)), storage, 'gallery edits never persist')

  // A fresh edit after undo must discard the old redo branch.
  await page.keyboard.press(undoKey)
  await input.fill('24')
  await waitForSize(24)
  await page.keyboard.press(redoKey)
  assert.equal(await input.inputValue(), '24')
  await page.reload()
  await page.locator(selector).first().waitFor()
  assert.deepEqual(await readLabels(), original, 'reload restores the saved example')
  console.log('Gallery widget undo/redo, label layers, descendants, and reload checks passed')
} finally {
  await browser?.close()
  await server.close()
}
