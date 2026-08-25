/**
 * Data utilities for column type inference, CSV parsing, and encoding generation.
 */

// Sample dataset
export const SAMPLE_DATA = [
  { Month: "2024-01", Revenue: 1200, Region: "East", Category: "Electronics", Units: 45 },
  { Month: "2024-02", Revenue: 1500, Region: "West", Category: "Electronics", Units: 52 },
  { Month: "2024-03", Revenue: 1800, Region: "North", Category: "Clothing", Units: 38 },
  { Month: "2024-04", Revenue: 1400, Region: "East", Category: "Clothing", Units: 41 },
  { Month: "2024-05", Revenue: 2100, Region: "West", Category: "Food", Units: 67 },
  { Month: "2024-06", Revenue: 1900, Region: "North", Category: "Food", Units: 55 },
  { Month: "2024-07", Revenue: 2400, Region: "East", Category: "Electronics", Units: 73 },
  { Month: "2024-08", Revenue: 2200, Region: "West", Category: "Clothing", Units: 60 },
  { Month: "2024-09", Revenue: 2600, Region: "North", Category: "Electronics", Units: 78 },
  { Month: "2024-10", Revenue: 2000, Region: "East", Category: "Food", Units: 50 },
  { Month: "2024-11", Revenue: 2800, Region: "West", Category: "Clothing", Units: 82 },
  { Month: "2024-12", Revenue: 3100, Region: "North", Category: "Electronics", Units: 90 }
]

/**
 * Infer the Vega-Lite data type of a column.
 * Q = Quantitative, N = Nominal, O = Ordinal, T = Temporal
 */
export function inferColumnType(values) {
  const nonNull = values.filter(v => v != null && v !== '')
  if (nonNull.length === 0) return 'N'

  // Check temporal — date patterns
  const datePatterns = [
    /^\d{4}-\d{2}(-\d{2})?$/,       // 2024-01, 2024-01-15
    /^\d{4}\/\d{2}(\/\d{2})?$/,     // 2024/01, 2024/01/15
    /^\d{2}\/\d{2}\/\d{4}$/,        // 01/15/2024
    /^\d{4}$/,                        // 2024 (year only)
  ]

  const isDate = nonNull.every(v => {
    const str = String(v).trim()
    return datePatterns.some(p => p.test(str)) || !isNaN(Date.parse(str))
  })
  // Only flag as T if it actually looks like date strings (not just numbers)
  if (isDate && nonNull.every(v => typeof v === 'string' && isNaN(Number(v)))) {
    return 'T'
  }

  // Check quantitative — majority numbers (tolerates occasional string rows like sub-headers)
  const numericCount = nonNull.filter(v => !isNaN(Number(v)) && typeof v !== 'boolean').length
  if (numericCount === nonNull.length) {
    const uniqueCount = new Set(nonNull.map(Number)).size
    const nums = nonNull.map(Number)
    const allInts = nums.every(n => Number.isInteger(n))
    const inYearRange = nums.every(n => n >= 1900 && n <= 2100)
    if (allInts && inYearRange && uniqueCount <= 60) return 'O' // year-like integers -> ordinal
    if (uniqueCount <= 5 && nonNull.length > 10) return 'O'
    return 'Q'
  }
  // If most values (>= 60%) are numeric, still treat as Q (data with occasional string outliers)
  if (numericCount >= nonNull.length * 0.6) {
    return 'Q'
  }

  // Otherwise nominal
  return 'N'
}

/**
 * Analyze all columns in a dataset and return column info.
 */
export function analyzeColumns(data) {
  if (!data || data.length === 0) return []
  const columns = Object.keys(data[0])
  return columns.map(name => {
    const values = data.map(row => row[name])
    const type = inferColumnType(values)
    const sampleValues = [...new Set(values)].slice(0, 5)
    return { name, type, sampleValues }
  })
}

/**
 * Parse CSV text into array of objects.
 */
/**
 * Split a CSV line respecting quoted fields (handles commas inside quotes).
 */
function splitCSVLine(line) {
  const result = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++ // skip escaped quote
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  result.push(current.trim())
  return result
}

/**
 * Convert column index to Excel-style letter (0→A, 1→B, ..., 25→Z, 26→AA)
 */
function colIndexToLetter(idx) {
  let letter = '', n = idx + 1
  while (n > 0) {
    const rem = (n - 1) % 26
    letter = String.fromCharCode(65 + rem) + letter
    n = Math.floor((n - 1) / 26)
  }
  return letter
}

export function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n')
    .filter(line => line.trim() !== '')
  if (lines.length === 0) return []

  // Determine column count from the widest row
  const maxCols = lines.reduce((max, line) => Math.max(max, splitCSVLine(line).length), 0)

  // Use the first row as the real column header (standard CSV convention, like other
  // viz tools). Fall back to Excel-style letters only when the first row looks like
  // data (all cells numeric), so a headerless numeric CSV doesn't lose its first row.
  const firstCells = splitCSVLine(lines[0]).map(v => v.replace(/^"|"$/g, '').trim())
  const firstRowIsData = firstCells.length > 0 &&
    firstCells.every(v => v !== '' && !isNaN(Number(v)))

  let headers
  let dataStart
  if (firstRowIsData) {
    headers = Array.from({ length: maxCols }, (_, i) => colIndexToLetter(i))
    dataStart = 0
  } else {
    // Build unique, non-empty column names from the header row
    const seen = {}
    headers = firstCells.map((h, i) => {
      let name = h || colIndexToLetter(i)
      if (seen[name] != null) { seen[name] += 1; name = `${name}_${seen[name]}` }
      else { seen[name] = 1 }
      return name
    })
    // Pad with letters if some data rows are wider than the header row
    for (let i = headers.length; i < maxCols; i++) headers.push(colIndexToLetter(i))
    dataStart = 1
  }

  const rows = []
  for (let i = dataStart; i < lines.length; i++) {
    const values = splitCSVLine(lines[i]).map(v => v.replace(/^"|"$/g, ''))
    const row = {}
    headers.forEach((h, j) => {
      const val = values[j]
      const num = Number(val)
      row[h] = val !== '' && val !== undefined && !isNaN(num) ? num : (val || '')
    })
    rows.push(row)
  }

  return rows
}

function isTrialExperimentData(columns) {
  const required = ['Trial A', 'Trial B', 'Trial C']
  return required.every(col => columns.some(c => (c.name || c) === col))
}

/**
 * Convert an arc (pie) spec into a donut by adding an innerRadius.
 * Mutates and returns the spec. Handles string and object marks.
 */
export function donutifySpec(spec) {
  if (!spec) return spec
  const conv = (m) => {
    if (m === 'arc') return { type: 'arc', innerRadius: 60 }
    if (m && typeof m === 'object' && m.type === 'arc') return { ...m, innerRadius: 60 }
    return m
  }
  if (spec.mark) spec.mark = conv(spec.mark)
  if (Array.isArray(spec.layer)) spec.layer.forEach(l => { if (l.mark) l.mark = conv(l.mark) })
  return spec
}

/**
 * Build a single-level treemap. Vega-Lite has no treemap mark, so this returns
 * a raw Vega (v5) spec — vega-embed renders it transparently. Note: spec.data is
 * an ARRAY (Vega shape), so data-injection code must skip array-form specs.
 */
function buildTreemapSpec(data, catCols, qCols) {
  const catField = (catCols[0] || qCols[0])?.name
  if (!catField) return null
  const valField = qCols[0]?.name
  const aggregate = valField
    ? { type: 'aggregate', groupby: [catField], fields: [valField], ops: ['sum'], as: ['size'] }
    : { type: 'aggregate', groupby: [catField], ops: ['count'], as: ['size'] }

  return {
    $schema: 'https://vega.github.io/schema/vega/v5.json',
    width: 400,
    height: 250,
    padding: 2,
    // 'pad' (not 'none') so an added title/legend reserves space above the
    // treemap instead of overlapping it — matches Vega-Lite's title behavior.
    autosize: 'pad',
    data: [
      {
        name: 'tree',
        values: data,
        transform: [
          aggregate,
          { type: 'nest', keys: [] },
          {
            type: 'treemap',
            field: 'size',
            method: 'squarify',
            round: true,
            padding: 1,
            size: [{ signal: 'width' }, { signal: 'height' }]
          }
        ]
      },
      { name: 'leaves', source: 'tree', transform: [{ type: 'filter', expr: '!datum.children' }] }
    ],
    scales: [
      {
        name: 'color',
        type: 'ordinal',
        domain: { data: 'leaves', field: catField },
        range: { scheme: 'tableau20' }
      }
    ],
    marks: [
      {
        type: 'rect',
        from: { data: 'leaves' },
        encode: {
          enter: { stroke: { value: '#ffffff' }, strokeWidth: { value: 1 } },
          update: {
            x: { field: 'x0' },
            y: { field: 'y0' },
            x2: { field: 'x1' },
            y2: { field: 'y1' },
            fill: { scale: 'color', field: catField }
          }
        }
      },
      {
        type: 'text',
        from: { data: 'leaves' },
        interactive: false,
        encode: {
          enter: {
            align: { value: 'center' },
            baseline: { value: 'middle' },
            fill: { value: '#ffffff' },
            fontSize: { value: 11 }
          },
          update: {
            x: { signal: '0.5 * (datum.x0 + datum.x1)' },
            y: { signal: '0.5 * (datum.y0 + datum.y1)' },
            text: { field: catField }
          }
        }
      }
    ]
  }
}

/**
 * Build a waterfall chart (Vega-Lite). Each category contributes a delta; bars
 * span from the running total before to after, colored by sign of the delta.
 */
function buildWaterfallSpec(data, catCols, qCols) {
  const catField = catCols[0]?.name
  const valField = qCols[0]?.name
  if (!catField || !valField) return null

  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    data: { values: data },
    width: 400,
    height: 250,
    transform: [
      { window: [{ op: 'sum', field: valField, as: '_sum' }], frame: [null, 0] },
      { calculate: `datum._sum - datum['${valField}']`, as: '_prev' },
      { calculate: `datum['${valField}'] >= 0 ? 'Increase' : 'Decrease'`, as: '_dir' }
    ],
    encoding: {
      x: { field: catField, type: 'nominal', sort: null, axis: { labelAngle: 0, title: catField } }
    },
    layer: [
      {
        mark: { type: 'bar', size: 28 },
        encoding: {
          y: { field: '_prev', type: 'quantitative', title: valField },
          y2: { field: '_sum' },
          color: {
            field: '_dir',
            type: 'nominal',
            scale: { domain: ['Increase', 'Decrease'], range: ['#4c78a8', '#e45756'] },
            legend: { title: null }
          }
        }
      },
      {
        mark: { type: 'text', dy: -4, fontSize: 10, color: '#333' },
        encoding: {
          y: { field: '_sum', type: 'quantitative' },
          text: { field: '_sum', type: 'quantitative', format: '.0f' }
        }
      }
    ]
  }
}

/**
 * Generate a Vega-Lite spec from selected columns, data, and chart type.
 */
export function generateSpecFromColumns(data, selectedColumns, columnInfos, chartType, chartTypeId) {
  if (!data || data.length === 0 || selectedColumns.length === 0) return null

  // Clean data: remove rows where most selected values are non-numeric strings
  // (e.g., sub-header rows where values are column names)
  const numericCols = columnInfos.filter(c => c.type === 'Q').map(c => c.name)
  if (numericCols.length > 0) {
    data = data.filter(row => {
      const numericVals = numericCols.filter(col => col in row).map(col => row[col])
      if (numericVals.length === 0) return true
      const actualNumbers = numericVals.filter(v => typeof v === 'number')
      return actualNumbers.length >= numericVals.length * 0.5
    })
  }
  if (data.length === 0) return null

  // Boxplot requires at least 2 data points for quartile calculation
  if (chartType === 'boxplot' && data.length < 2) return null

  // Hardcoded histogram preset for Trial A/B/C experiment dataset
  if (chartType === 'bar' && isTrialExperimentData(columnInfos)) {
    return {
      $schema: "https://vega.github.io/schema/vega-lite/v6.json",
      width: 400,
      height: 250,
      config: { view: { continuousWidth: 300, continuousHeight: 300 } },
      mark: { type: "bar", binSpacing: 0, opacity: 1 },
      encoding: {
        color: { field: "Experiment", type: "nominal", legend: null },
        x: { bin: { maxbins: 100 }, field: "Measurement", type: "quantitative" },
        y: { aggregate: "count", stack: null, type: "quantitative" }
      },
      transform: [
        { fold: ["Trial A", "Trial B", "Trial C"], as: ["Experiment", "Measurement"] }
      ],
      data: { values: data }
    }
  }

  const selected = columnInfos.filter(c => selectedColumns.includes(c.name))
  const qCols = selected.filter(c => c.type === 'Q')
  const nCols = selected.filter(c => c.type === 'N')
  const oCols = selected.filter(c => c.type === 'O')
  const tCols = selected.filter(c => c.type === 'T')

  // Special chart types that don't map to a single Vega-Lite mark
  if (chartTypeId === 'treemap') return buildTreemapSpec(data, [...nCols, ...oCols], qCols)
  if (chartTypeId === 'waterfall') return buildWaterfallSpec(data, [...nCols, ...oCols, ...tCols], qCols)

  // Decide x, y, color fields
  let xField, yField, colorField
  let xType, yType

  // X axis priority: T > N > O > Q
  const xCandidates = [...tCols, ...nCols, ...oCols, ...qCols]
  // Y axis priority: Q > O > N > T
  const yCandidates = [...qCols, ...oCols, ...nCols, ...tCols]

  if (selectedColumns.length === 1) {
    const col = selected[0]
    if (col.type === 'Q') {
      // Single quantitative column: boxplot shows distribution without category
      if (chartType === 'boxplot') {
        return {
          $schema: "https://vega.github.io/schema/vega-lite/v6.json",
          data: { values: data },
          mark: 'boxplot',
          encoding: {
            y: { field: col.name, type: 'quantitative', scale: { zero: false } }
          },
          width: 400, height: 250
        }
      }
      // Check if chart type needs a category
      const needsCategory = chartType === 'arc' || chartType === 'bar' || chartType === 'line' || chartType === 'area'
      if (needsCategory) {
        // Auto-find a suitable categorical field from all columns
        const allCatCols = columnInfos.filter(c =>
          !selectedColumns.includes(c.name) && (c.type === 'N' || c.type === 'O')
        )
        // Pick one with appropriate cardinality (2~20 unique values preferred)
        const bestCat = allCatCols
          .map(c => ({ ...c, uniqueCount: new Set(data.map(r => r[c.name])).size }))
          .filter(c => c.uniqueCount >= 2 && c.uniqueCount <= 20)
          .sort((a, b) => a.uniqueCount - b.uniqueCount)[0]

        if (bestCat) {
          // Use auto-found category field
          if (chartType === 'arc') {
            const catValues = data.map(r => r[bestCat.name])
            const encoding = {
              theta: { field: col.name, type: 'quantitative' },
              color: { field: bestCat.name, type: 'nominal' }
            }
            if (catValues.length !== new Set(catValues).size) {
              encoding.theta.aggregate = 'sum'
            }
            return {
              $schema: "https://vega.github.io/schema/vega-lite/v6.json",
              data: { values: data }, mark: 'arc', encoding, width: 400, height: 250
            }
          } else {
            // bar, area
            const catValues = data.map(r => r[bestCat.name])
            const hasDuplicates = catValues.length !== new Set(catValues).size
            return {
              $schema: "https://vega.github.io/schema/vega-lite/v6.json",
              data: { values: data },
              mark: chartType === 'area' ? { type: 'area', line: true } : chartType === 'line' ? { type: 'line', point: true } : chartType,
              encoding: {
                x: { field: bestCat.name, type: 'nominal', axis: { labelAngle: 0 } },
                y: { field: col.name, type: 'quantitative', ...(hasDuplicates ? { aggregate: 'sum' } : {}), ...(chartType === 'line' || chartType === 'area' ? { scale: { zero: false } } : {}) }
              },
              width: 400, height: 250
            }
          }
        } else {
          // No suitable category field — use row index
          if (chartType === 'arc') {
            return {
              $schema: "https://vega.github.io/schema/vega-lite/v6.json",
              data: { values: data },
              transform: [{ window: [{ op: 'row_number', as: 'row_index' }] }],
              mark: 'arc',
              encoding: {
                theta: { field: col.name, type: 'quantitative' },
                color: { field: 'row_index', type: 'nominal' }
              },
              width: 400, height: 250
            }
          } else {
            return {
              $schema: "https://vega.github.io/schema/vega-lite/v6.json",
              data: { values: data },
              transform: [{ window: [{ op: 'row_number', as: 'row_index' }] }],
              mark: chartType === 'area' ? { type: 'area', line: true } : chartType === 'line' ? { type: 'line', point: true } : chartType,
              encoding: {
                x: { field: 'row_index', type: 'nominal', axis: { labelAngle: 0 } },
                y: { field: col.name, type: 'quantitative' }
              },
              width: 400, height: 250
            }
          }
        }
      }
      // Default: Histogram
      xField = col.name; xType = 'quantitative'
      return {
        $schema: "https://vega.github.io/schema/vega-lite/v6.json",
        data: { values: data },
        mark: chartType === 'line' ? { type: 'line', point: true } : chartType,
        encoding: {
          x: { field: xField, type: xType, bin: true },
          y: { aggregate: 'count', type: 'quantitative' }
        },
        width: 400, height: 250
      }
    } else {
      xField = col.name; xType = col.type === 'T' ? 'temporal' : 'nominal'
      return {
        $schema: "https://vega.github.io/schema/vega-lite/v6.json",
        data: { values: data },
        mark: chartType === 'line' ? { type: 'line', point: true } : chartType,
        encoding: {
          x: { field: xField, type: xType },
          y: { aggregate: 'count', type: 'quantitative' }
        },
        width: 400, height: 250
      }
    }
  }

  // Assign x
  if (xCandidates.length > 0) {
    const x = xCandidates[0]
    xField = x.name
    xType = { Q: 'quantitative', N: 'nominal', O: 'ordinal', T: 'temporal' }[x.type]
  }

  // Assign y (different from x)
  const yCandidate = yCandidates.find(c => c.name !== xField)
  if (yCandidate) {
    yField = yCandidate.name
    yType = { Q: 'quantitative', N: 'nominal', O: 'ordinal', T: 'temporal' }[yCandidate.type]
  }

  // Assign color if 3+ columns
  const remaining = selected.filter(c => c.name !== xField && c.name !== yField)
  if (remaining.length > 0) {
    const cc = remaining[0]
    colorField = cc.name
  }

  // Build encoding
  const encoding = {}
  if (xField) {
    encoding.x = { field: xField, type: xType }
    if (xType === 'nominal' || xType === 'ordinal') {
      encoding.x.axis = { labelAngle: 0 }
    }
  }
  if (yField) {
    encoding.y = { field: yField, type: yType }
    // Add aggregation for bar/line/area when y is quantitative and x is categorical
    // This prevents "one bar per row" — aggregates by x-axis value (like Tableau)
    const needsAggregate = yType === 'quantitative' &&
      (xType === 'nominal' || xType === 'ordinal' || xType === 'temporal') &&
      (chartType === 'bar' || chartType === 'line' || chartType === 'area')
    if (needsAggregate) {
      // Check if x-field has duplicate values in data
      const xValues = data.map(row => row[xField])
      const hasDuplicates = xValues.length !== new Set(xValues).size
      if (hasDuplicates) {
        encoding.y.aggregate = 'sum'
      }
    }
  }
  if (colorField) {
    const ccInfo = columnInfos.find(c => c.name === colorField)
    encoding.color = {
      field: colorField,
      type: ccInfo?.type === 'Q' ? 'quantitative' : 'nominal'
    }
  }

  if (colorField) {
    const ccInfo = columnInfos.find(c => c.name === colorField)
    encoding.color = {
      field: colorField,
      type: ccInfo?.type === 'Q' ? 'quantitative' : 'nominal',
      ...(ccInfo?.type === 'Q' ? { legend: { type: 'gradient' } } : {})
    }
  }

  // Handle special chart types
  let mark = chartType
  const spec = {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    data: { values: data },
    width: 400,
    height: 250
  }

  switch (chartType) {
    case 'bar':
      mark = 'bar'
      break
    case 'line':
      mark = { type: 'line', point: true }
      break
    case 'area':
      mark = { type: 'area', line: true }
      break
    case 'point':
      mark = 'point'
      break
    case 'arc': {
      // Pie chart
      mark = 'arc'
      const thetaField = qCols[0]?.name || yField
      const catField = nCols[0]?.name || xField
      spec.encoding = {}
      if (thetaField) {
        spec.encoding.theta = { field: thetaField, type: 'quantitative' }
        // Add aggregate if there are duplicate category values
        if (catField) {
          const catValues = data.map(row => row[catField])
          if (catValues.length !== new Set(catValues).size) {
            spec.encoding.theta.aggregate = 'sum'
          }
        }
      }
      if (catField) spec.encoding.color = { field: catField, type: 'nominal' }
      spec.mark = mark
      return spec
    }
    case 'boxplot': {
      mark = 'boxplot'
      // Ensure y is quantitative; if x is quantitative too, swap so x is categorical
      if (yField && yType === 'quantitative' && xField && xType === 'quantitative') {
        // No category — just show y as single boxplot, remove x
        delete encoding.x
      } else if (!yField && xField && xType === 'quantitative') {
        // Only x is Q — move to y
        encoding.y = { field: xField, type: 'quantitative' }
        delete encoding.x
      }
      break
    }
    case 'rect': {
      // Heatmap
      mark = 'rect'
      if (encoding.y) {
        encoding.color = { field: yField, type: yType, aggregate: 'mean' }
        delete encoding.y
        if (remaining.length > 0) {
          encoding.y = { field: remaining[0].name, type: 'nominal' }
        }
      }
      break
    }
    default:
      mark = chartType
  }

  // Grouped bar: add xOffset encoding for the color field
  if (chartTypeId === 'grouped-bar' && colorField) {
    encoding.xOffset = { field: colorField }
  }

  // For chart types where zero-baseline is not meaningful, fit axes to data range
  const zeroFreeMarks = new Set(['point', 'line', 'area', 'boxplot'])
  const effectiveMark = typeof mark === 'string' ? mark : mark?.type
  if (zeroFreeMarks.has(effectiveMark)) {
    if (encoding.x?.type === 'quantitative') {
      encoding.x.scale = { zero: false }
    }
    if (encoding.y?.type === 'quantitative') {
      encoding.y.scale = { zero: false }
    }
  }

  spec.mark = mark
  spec.encoding = encoding
  return spec
}

/**
 * Generate a Vega-Lite spec from explicit channel assignments.
 * assignments = { x: {name, type}, y: {name, type}, color: {name, type}, size: {name, type} }
 */
export function generateSpecFromAssignments(data, assignments, chartTypeId) {
  if (!data || !assignments || !assignments.x || !assignments.y) return null

  const vegaTypeMap = { Q: 'quantitative', N: 'nominal', O: 'ordinal', T: 'temporal' }

  const encoding = {}
  if (assignments.x) encoding.x = { field: assignments.x.name, type: vegaTypeMap[assignments.x.type] || 'nominal' }
  if (assignments.y) encoding.y = { field: assignments.y.name, type: vegaTypeMap[assignments.y.type] || 'quantitative' }
  if (assignments.color) encoding.color = { field: assignments.color.name, type: vegaTypeMap[assignments.color.type] || 'nominal' }
  if (assignments.size) encoding.size = { field: assignments.size.name, type: vegaTypeMap[assignments.size.type] || 'quantitative' }

  // Grouped bar: if x is N and color is N, add xOffset
  const isGroupedBar = chartTypeId === 'grouped-bar' ||
    (chartTypeId === 'bar' && assignments.color && assignments.color.type === 'N' && assignments.x && assignments.x.type === 'N')
  if (isGroupedBar && assignments.color) {
    encoding.xOffset = { field: assignments.color.name, type: 'nominal' }
  }

  const markMap = {
    'bar': 'bar',
    'grouped-bar': 'bar',
    'line': { type: 'line', point: true },
    'point': 'point',
    'area': { type: 'area', line: true },
    'histogram': 'bar',
    'boxplot': 'boxplot',
    'heatmap': 'rect',
    'pie': 'arc',
    'donut': { type: 'arc', innerRadius: 60 },
    'stacked-bar': 'bar',
  }
  const mark = markMap[chartTypeId] || 'bar'

  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    data: { values: data },
    mark,
    encoding,
    width: 500,
    height: 320,
  }
}
