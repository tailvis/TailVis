import test from 'node:test'
import assert from 'node:assert/strict'
import { compile } from 'vega-lite'
import { View, parse } from 'vega'
import { timeUnitMatch, matchesTimeUnit } from '../src/utils/dataHighlight.js'

async function grouped(unit, dates) {
  const encoding = { field: 'when', type: 'ordinal', timeUnit: unit }
  const values = dates.map(when => ({ when, amount: 1 }))
  const view = new View(parse(compile({ data: { values }, mark: 'bar', encoding: { x: encoding, y: { field: 'amount', aggregate: 'sum', type: 'quantitative' } } }).spec), { renderer: 'none' })
  try { await view.runAsync(); return { encoding, values, datum: view.data('data_0')[0] } }
  finally { view.finalize() }
}

test('a UTC annual aggregate maps back to every contributing monthly row', async () => {
  const { encoding, values, datum } = await grouped('utcyear', ['2009-01-01', '2009-06-01', '2009-12-31T23:59:59Z', '2010-01-01'])
  const match = timeUnitMatch(encoding, datum)
  assert.ok(match)
  assert.equal(values.filter(row => matchesTimeUnit(row, match)).length, 3)
  assert.equal(matchesTimeUnit({ when: null }, match), false)
  assert.equal(matchesTimeUnit({ when: 'invalid' }, match), false)
})

test('composite UTC month groups and axis labels use the same source-row matching', async () => {
  const { encoding, values, datum } = await grouped('utcyearmonth', ['2009-06-01', '2009-06-30', '2009-07-01', '2010-06-01'])
  const match = timeUnitMatch(encoding, datum)
  assert.equal(values.filter(row => matchesTimeUnit(row, match)).length, 2)
  assert.deepEqual(timeUnitMatch(encoding, null, match.value), match)
})

test('local calendar groups and stepped time-unit objects match Vega grouping', async () => {
  for (const unit of ['yearmonth', { unit: 'year', utc: true, step: 5 }]) {
    const { encoding, values, datum } = await grouped(unit, ['2006-06-01', '2007-06-01', '2011-06-01'])
    const match = timeUnitMatch(encoding, datum)
    assert.ok(match)
    assert.equal(values.filter(row => matchesTimeUnit(row, match)).length, datum.sum_amount)
  }
})

test('ordinary fields and unsupported or absent grouping values stay on the existing match path', () => {
  assert.equal(timeUnitMatch({ field: 'category' }, { category: 'A' }), null)
  assert.equal(timeUnitMatch({ field: 'when', timeUnit: 'utcyear' }, { unrelated: 2009 }), null)
  assert.equal(timeUnitMatch({ field: 'when', timeUnit: 'invalidyear' }, {}), null)
})
