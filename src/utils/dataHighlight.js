import { timeFloor, utcFloor, timeUnits } from 'vega'

// Vega aggregates group by the time-unit result, not the original date field.
// Keep the grouping descriptor so the data table can match the source rows.
export function timeUnitMatch(encoding, datum, axisValue) {
  const config = encoding?.timeUnit
  if (!config || !encoding.field || (typeof config === 'object' && config.binned)) return null
  const unit = typeof config === 'string' ? config : config.unit
  if (typeof unit !== 'string') return null
  const utc = unit.startsWith('utc') || config.utc === true
  const localUnit = unit.replace(/^utc/, '')
  const parts = localUnit.match(/milliseconds|seconds|minutes|hours|dayofyear|year|quarter|month|week|date|day/g)
  if (!parts || parts.join('') !== localUnit) return null
  const units = timeUnits(parts)
  const prefix = `${utc ? 'utc' : ''}${units.join('')}`
  const key = Object.keys(datum || {}).find(key => key.startsWith(`${prefix}_`) && key.endsWith(`_${encoding.field}`))
  const value = axisValue ?? (key ? datum[key] : null)
  const timestamp = value == null ? NaN : +new Date(value)
  if (!Number.isFinite(timestamp)) return null
  return { field: encoding.field, units, utc, step: config.step || 1, value: timestamp }
}

export function matchesTimeUnit(row, match) {
  if (row[match.field] == null) return false
  const value = +new Date(row[match.field])
  if (!Number.isFinite(value)) return false
  const floor = (match.utc ? utcFloor : timeFloor)(match.units, match.step)
  return +floor(value) === match.value
}
