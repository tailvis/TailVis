import { useState, useRef, useCallback, useEffect, useMemo, lazy, Suspense } from 'react'
// Lazy: pulls the vega/vega-embed/d3 stack into a separate chunk, off the initial bundle.
const Canvas = lazy(() => import('./components/Canvas'))
import SpecCodeEditor, { SpecView } from './components/SpecCodeEditor'
import PropertyPanel from './components/PropertyPanel'
import AncestorWidgetPanel from './components/AncestorWidgetPanel'
import LayerPanel from './components/LayerPanel'
import ChatAgent from './components/ChatAgent'
import DataTable from './components/DataTable'
import EncodingBar from './components/EncodingBar'
import { CHART_TYPES } from './components/EncodingBar'
import { applyModificationsToSpec, analyzeEncodingBindings, extractColorMapping, evaluateTestExpression, detectBindingIntegrity, classifyLayer, analyzeLayerContext } from './utils/scopeUtils'
import { detectElementType, extractDatum, getLayerIndex } from './utils/elementUtils'
import { SAMPLE_DATA, analyzeColumns, generateSpecFromColumns, generateSpecFromAssignments, donutifySpec } from './utils/dataUtils'
import { renderChartPng } from './utils/chartThumbnail'
import { withApiKey, IS_STATIC_DEMO, hasApiBase, apiUrl } from './utils/apiKey'
import ApiKeyModal from './components/ApiKeyModal'
import { SAMPLE_DATASETS } from './data/sampleDatasets'
import barSpec from './data/bar.json'
import lineSpec from './data/line.json'
import scatterSpec from './data/scatter.json'
import histogramSpec from './data/histogram.json'
import './App.css'

// Default Vega-Lite specs


// localStorage helpers
const STORAGE_KEY = 'chart-authoring-state'
const STORAGE_VERSION = 10  // v10: +seattle-weather, waterfall, movies, cars, stocks, sine datasets

// Sanitize widgetOptions from LLM responses: fix missing/empty select options
// Property-aware range definitions for number widgets
const NUMBER_RANGE_RULES = [
  { test: /angle|rotate|rotation|labelangle|각도|회전/i, min: 0, max: 360, step: 1 },
  { test: /opacity|fillopacity|strokeopacity|투명|불투명/i, min: 0, max: 1, step: 0.05 },
  { test: /fontsize|titlefontsize|labelfontsize|글꼴.*크기|폰트.*크기|글자.*크기/i, min: 6, max: 48, step: 1 },
  { test: /strokewidth|domainwidth|gridwidth|선.*두께|테두리.*두께/i, min: 0, max: 10, step: 0.5 },
  { test: /cornerradius|모서리.*반경|둥글기/i, min: 0, max: 20, step: 1 },
  { test: /\bsize\b|크기/i, min: 0, max: 500, step: 10 },
  { test: /paddinginner|paddingouter|bandpadding/i, min: 0, max: 1, step: 0.05 },
  { test: /offset|오프셋/i, min: -200, max: 200, step: 1 },
  { test: /padding|spacing|간격|패딩|여백/i, min: 0, max: 50, step: 1 },
  { test: /ticksize|tickwidth|눈금.*크기/i, min: 0, max: 20, step: 1 },
  { test: /\bwidth\b|\bheight\b|너비|높이/i, min: 50, max: 1200, step: 10 },
]

function sanitizeWidgetOptions(options) {
  if (!Array.isArray(options)) return []
  return options.map(opt => {
    if (opt.type === 'select') {
      const hasValidOptions = Array.isArray(opt.options) && opt.options.length > 0
      if (!hasValidOptions) {
        console.warn('[sanitizeWidgetOptions] select missing options, converting to text:', opt.label)
        return { ...opt, type: 'text' }
      }
    }
    // A number widget whose value isn't actually a number (e.g. the LLM pointed it at
    // an expression string like "(random() - 0.5) * 22" without a valueTemplate) would
    // drive a broken slider. Fall back to a text input so the user edits the raw value.
    if (opt.type === 'number' && !opt.valueTemplate) {
      const n = typeof opt.value === 'number' ? opt.value : parseFloat(opt.value)
      const looksNumeric = typeof opt.value === 'number' ||
        (typeof opt.value === 'string' && opt.value.trim() !== '' && Number.isFinite(n) && String(n) === opt.value.trim())
      if (!looksNumeric) {
        console.warn('[sanitizeWidgetOptions] number widget has non-numeric value, converting to text:', opt.label, opt.value)
        return { ...opt, type: 'text' }
      }
    }
    // Enforce property-aware ranges for number widgets
    if (opt.type === 'number') {
      const hint = [opt.id, opt.label, opt.path].join(' ')
      const rule = NUMBER_RANGE_RULES.find(r => r.test.test(hint))
      if (rule) {
        const fixed = { ...opt }
        fixed.min = rule.min
        fixed.max = rule.max
        fixed.step = fixed.step ?? rule.step
        // Clamp value to valid range
        if (fixed.value != null) {
          fixed.value = Math.max(rule.min, Math.min(rule.max, fixed.value))
        }
        return fixed
      }
    }
    return opt
  })
}

// Inject chartData into a spec whose data.values is empty (LLM responses strip data
// to save tokens). Skips raw-Vega array-form data, specs that already carry data, and
// specs whose fields don't match the data (so the wrong dataset is never clobbered on).
function injectDataIntoSpec(spec, chartData) {
  if (!spec) return spec
  if (Array.isArray(spec.data)) return spec               // raw Vega (e.g. treemap)
  if (spec.data?.values?.length > 0) return spec          // already has its own data
  if (!chartData || chartData.length === 0) return spec
  const enc = spec.encoding || {}
  const usedFields = Object.values(enc).map(e => e?.field).filter(Boolean)
  if (spec.layer) {
    spec.layer.forEach(l => {
      Object.values(l.encoding || {}).forEach(e => { if (e?.field) usedFields.push(e.field) })
    })
  }
  // Fields produced by transforms (fold/calculate `as`) don't exist in the raw data;
  // exclude them and validate the transform INPUT fields instead.
  const transformOutputs = new Set()
  const transformInputs = []
  const collect = (transforms) => {
    for (const t of (transforms || [])) {
      if (Array.isArray(t.as)) t.as.forEach(a => transformOutputs.add(a))
      else if (typeof t.as === 'string') transformOutputs.add(t.as)
      if (Array.isArray(t.fold)) transformInputs.push(...t.fold)
    }
  }
  collect(spec.transform)
  if (spec.layer) spec.layer.forEach(l => collect(l.transform))
  const fieldsToCheck = usedFields.filter(f => !transformOutputs.has(f)).concat(transformInputs)
  if (fieldsToCheck.length > 0) {
    const dsFields = new Set(Object.keys(chartData[0]))
    const compatible = fieldsToCheck.some(f => dsFields.has(f))
    if (!compatible) return spec                          // fields mismatch → don't inject
  }
  return { ...spec, data: { ...(spec.data || {}), values: chartData } }
}

export function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null

    // Version check: discard only user-uploaded data sources (sample ones get re-merged below)
    if ((parsed._storageVersion || 0) < STORAGE_VERSION) {
      console.warn('[loadFromStorage] storage version mismatch — resetting uploaded data sources')
      delete parsed.dataSources
      // Keep chartObjects — charts with sample dataSourceIds will reconnect after merge below
    }

    // Validate that chartObjects is an array (if present)
    if (parsed.chartObjects && !Array.isArray(parsed.chartObjects)) {
      parsed.chartObjects = []
    }

    // Merge saved dataSources with built-in SAMPLE_DATASETS
    const allDataSources = { ...SAMPLE_DATASETS, ...(parsed.dataSources || {}) }
    parsed.dataSources = allDataSources

    // Re-attach data to chart specs (stripped during save to reduce size)
    const data = parsed.currentData
    if (Array.isArray(parsed.chartObjects)) {
      parsed.chartObjects = parsed.chartObjects.map(c => {
        if (!c || !c.spec) return c
        // Use data source values if chart has a dataSourceId, otherwise fall back to currentData
        const chartData = (c.dataSourceId && allDataSources[c.dataSourceId])
          ? allDataSources[c.dataSourceId].values
          : (data || [])
        return {
          ...c,
          spec: injectDataIntoSpec(c.spec, chartData),
          baseSpec: injectDataIntoSpec(c.baseSpec, chartData),
        }
      })
    }

    return parsed
  } catch (e) {
    console.warn('[loadFromStorage] failed:', e.message)
    // DON'T delete localStorage — user might refresh and retry
    return null
  }
}

function saveToStorage(state) {
  try {
    // Strip inline data from specs to avoid bloating localStorage
    // Only strip if the spec's data fields match the data source fields (safe to restore)
    const canStripData = (spec, dataSourceId) => {
      if (!dataSourceId) return false  // no data source → must keep inline data
      const ds = (state.dataSources || {})[dataSourceId]
      if (!ds?.values?.length) return false  // data source missing → keep
      const specRow = spec?.data?.values?.[0]
      if (!specRow) return true  // no inline data to strip
      const specFields = Object.keys(specRow)
      const dsFields = new Set(Object.keys(ds.values[0]))
      // Only safe to strip if spec uses the same fields as the data source
      return specFields.every(f => dsFields.has(f))
    }

    const stripData = (spec, safeToStrip) => {
      if (!spec) return spec
      if (!safeToStrip) return spec
      const { data, ...rest } = spec
      return rest
    }

    // Only persist serializable fields from chartObjects
    const cleaned = {
      _storageVersion: STORAGE_VERSION,
      chartObjects: (state.chartObjects || []).map(c => {
        if (!c) return null
        const safe = canStripData(c.spec, c.dataSourceId)
        return {
          id: c.id,
          spec: stripData(c.spec, safe),
          baseSpec: stripData(c.baseSpec, safe) || null,
          svgOverrides: c.svgOverrides || {},
          baseSvgOverrides: c.baseSvgOverrides || null,
          modifications: (c.modifications || []).map(({ element, ...rest }) => rest),
          x: c.x,
          y: c.y,
          width: c.width,
          height: c.height,
          parentId: c.parentId || null,
          childIds: c.childIds || [],
          dataSourceId: c.dataSourceId || null,
          widgetOptions: sanitizeWidgetOptions(c.widgetOptions || []),
          command: c.command || null,
          widgetTitle: c.widgetTitle || null,
          intent: c.intent || null,
          changeType: c.changeType || null,
          conversationHistory: c.conversationHistory || [],
        }
      }).filter(Boolean),
      nextChartId: state.nextChartId,
      currentData: state.currentData,
      columnInfos: state.columnInfos,
      selectedColumns: state.selectedColumns,
      dataSourceName: state.dataSourceName,
      selectedChartType: state.selectedChartType,
      lastSelectedChartId: state.lastSelectedChartId ?? null,
      activeDataSourceId: state.activeDataSourceId || null,
      dataSources: (() => {
        // Only save non-sample dataSources (dynamic ones like prebuilt-histogram-xxx)
        const extra = {}
        const ds = state.dataSources || {}
        for (const [id, val] of Object.entries(ds)) {
          if (!SAMPLE_DATASETS[id]) extra[id] = val
        }
        return Object.keys(extra).length > 0 ? extra : undefined
      })(),
    }
    const json = JSON.stringify(cleaned)
    localStorage.setItem(STORAGE_KEY, json)
  } catch (e) {
    console.warn('[saveToStorage] failed:', e.name, e.message)
    // If quota exceeded, try saving without currentData (charts still work with embedded data)
    if (e.name === 'QuotaExceededError') {
      try {
        const { currentData, ...minimal } = JSON.parse(json)
        localStorage.setItem(STORAGE_KEY, JSON.stringify(minimal))
        console.warn('[saveToStorage] saved minimal (no data) due to quota')
      } catch (_) { /* truly cannot save */ }
    }
  }
}

// Latest state ref for beforeunload flush
let _latestStateForSave = null

// ─── Lineage propagation helpers ───
// When a parent chart's spec is edited, the same change flows down to all
// charts derived from it (connected children on the canvas).

// Collect ids of every descendant of rootId (children, grandchildren, …)
function collectDescendantIds(charts, rootId) {
  const result = new Set()
  const stack = [rootId]
  while (stack.length) {
    const pid = stack.pop()
    for (const c of charts) {
      if (c.parentId === pid && !result.has(c.id)) {
        result.add(c.id)
        stack.push(c.id)
      }
    }
  }
  return result
}

// Render a diff-path array as a widget-style path string, e.g.
// ['layer', 0, 'mark', 'point'] -> "layer[0].mark.point"
function pathArrToString(path) {
  return path
    .map((p, i) => (typeof p === 'number' ? `[${p}]` : i === 0 ? p : `.${p}`))
    .join('')
}

// True when `pathStr` equals, or is nested under, any path in `paths`.
function isUnderAnyPath(pathStr, paths) {
  return paths.some(p => pathStr === p || pathStr.startsWith(p + '.') || pathStr.startsWith(p + '['))
}

// Diff two specs into leaf-path operations. The top-level `data` subtree is
// never propagated (each chart keeps its own data). Arrays of equal length are
// diffed element-wise (so a change inside layer[0] propagates without clobbering
// a descendant's extra appended layers); arrays of differing length are atomic.
function diffSpecPaths(oldObj, newObj, base = [], out = []) {
  const keys = new Set([
    ...(oldObj && typeof oldObj === 'object' ? Object.keys(oldObj) : []),
    ...(newObj && typeof newObj === 'object' ? Object.keys(newObj) : []),
  ])
  for (const k of keys) {
    if (base.length === 0 && k === 'data') continue
    const ov = oldObj ? oldObj[k] : undefined
    const nv = newObj ? newObj[k] : undefined
    if (JSON.stringify(ov) === JSON.stringify(nv)) continue
    const path = [...base, k]
    if (nv === undefined) {
      out.push({ path, op: 'delete' })
    } else if (Array.isArray(ov) && Array.isArray(nv) && ov.length === nv.length) {
      // Equal-length arrays: recurse per index so only the changed element/leaf
      // is emitted (keeps a descendant's own appended array tail untouched).
      for (let i = 0; i < nv.length; i++) {
        const oi = ov[i]
        const ni = nv[i]
        if (JSON.stringify(oi) === JSON.stringify(ni)) continue
        const ipath = [...path, i]
        if (oi && ni && typeof oi === 'object' && typeof ni === 'object' && !Array.isArray(oi) && !Array.isArray(ni)) {
          diffSpecPaths(oi, ni, ipath, out)
        } else {
          out.push({ path: ipath, op: 'set', value: ni })
        }
      }
    } else if (
      ov && nv && typeof ov === 'object' && typeof nv === 'object' &&
      !Array.isArray(ov) && !Array.isArray(nv)
    ) {
      diffSpecPaths(ov, nv, path, out)
    } else {
      out.push({ path, op: 'set', value: nv })
    }
  }
  return out
}

// Apply a single diff op to a spec object (mutates), creating intermediate objects as needed
function applyPathOp(root, path, op, value) {
  let obj = root
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i]
    if (obj[k] == null || typeof obj[k] !== 'object') {
      if (op === 'delete') return
      obj[k] = {}
    }
    obj = obj[k]
  }
  const last = path[path.length - 1]
  if (op === 'delete') delete obj[last]
  else obj[last] = JSON.parse(JSON.stringify(value))
}

// Return a clone of a spec with all diff ops applied
function applySpecChanges(spec, changes) {
  const next = JSON.parse(JSON.stringify(spec))
  for (const ch of changes) applyPathOp(next, ch.path, ch.op, ch.value)
  return next
}

const DATA_MARK_TYPES = new Set(['line', 'area', 'bar', 'point', 'circle', 'square', 'rect', 'tick', 'trail'])

// Source and descendant charts can have different structures — most commonly a
// non-layered source (top-level `mark`) and a layered descendant (the same mark
// lives in a data layer). A raw path like `mark.stroke` would land on the
// descendant's top-level mark, which Vega-Lite IGNORES when the spec is layered.
// Remap top-level `mark` ops onto the descendant's primary data layer so they render.
function remapMarkOpsForSpec(ops, targetSpec) {
  if (!Array.isArray(targetSpec?.layer)) return ops
  let dataIdx = -1
  return ops.map(op => {
    if (op.path[0] !== 'mark') return op
    if (dataIdx < 0) {
      dataIdx = targetSpec.layer.findIndex(l => {
        const mt = typeof l.mark === 'string' ? l.mark : l.mark?.type
        return DATA_MARK_TYPES.has(mt)
      })
      if (dataIdx < 0) dataIdx = 0
    }
    return { ...op, path: ['layer', dataIdx, 'mark', ...op.path.slice(1)] }
  })
}

// Apply propagated ops to a descendant spec, remapping top-level mark ops to its
// data layer and dropping any dead top-level mark left over in a layered spec.
function applyPropagatedOps(spec, ops) {
  let next = applySpecChanges(spec, remapMarkOpsForSpec(ops, spec))
  if (Array.isArray(next.layer) && next.mark) delete next.mark
  return next
}

// Propagate a source chart's spec + SVG-override delta to all of its descendants.
// Shared by every modification handler so element edits, scope changes, value
// re-edits, and deletions cascade CONSISTENTLY. Skips spec paths a descendant
// controls via its own widget panel (widgets stay local overrides) and remaps
// top-level mark ops onto a layered child's data layer.
function propagateDeltaToDescendants(result, prev, sourceId, srcOldSpec, srcNewSpec, srcOldSvg, srcNewSvg) {
  if (!srcOldSpec || !srcNewSpec) return result
  const changes = diffSpecPaths(srcOldSpec, srcNewSpec)
  // Per-selector/prop SVG-override delta — includes props REMOVED in the new set.
  const svgDelta = {}
  const allSelectors = new Set([...Object.keys(srcOldSvg || {}), ...Object.keys(srcNewSvg || {})])
  for (const sel of allSelectors) {
    const oldProps = (srcOldSvg && srcOldSvg[sel]) || {}
    const newProps = (srcNewSvg && srcNewSvg[sel]) || {}
    for (const p of new Set([...Object.keys(oldProps), ...Object.keys(newProps)])) {
      if (JSON.stringify(oldProps[p]) !== JSON.stringify(newProps[p])) {
        if (!svgDelta[sel]) svgDelta[sel] = {}
        svgDelta[sel][p] = newProps[p]  // undefined → clears that override on the child
      }
    }
  }
  const svgDeltaSelectors = Object.keys(svgDelta)
  if (changes.length === 0 && svgDeltaSelectors.length === 0) return result
  const descendantIds = collectDescendantIds(prev, sourceId)
  if (descendantIds.size === 0) return result
  return result.map(chart => {
    if (!descendantIds.has(chart.id)) return chart
    const widgetPaths = (chart.widgetOptions || []).map(o => o.path).filter(Boolean)
    const ops = widgetPaths.length
      ? changes.filter(ch => !isUnderAnyPath(pathArrToString(ch.path), widgetPaths))
      : changes
    let nextSvg = chart.svgOverrides
    if (svgDeltaSelectors.length > 0) {
      nextSvg = { ...(chart.svgOverrides || {}) }
      for (const sel of svgDeltaSelectors) {
        nextSvg[sel] = { ...(nextSvg[sel] || {}) }
        for (const [p, v] of Object.entries(svgDelta[sel])) {
          if (v === undefined) delete nextSvg[sel][p]
          else nextSvg[sel][p] = v
        }
      }
    }
    if (ops.length === 0 && nextSvg === chart.svgOverrides) return chart
    const upd = { ...chart, svgOverrides: nextSvg }
    if (ops.length > 0) {
      upd.spec = applyPropagatedOps(chart.spec, ops)
      if (chart.baseSpec) upd.baseSpec = applyPropagatedOps(chart.baseSpec, ops)
    }
    return upd
  })
}

// Prepare a frozen gallery example for read-only display: merge sample data sources and
// re-inject data into each chart's spec (same as loadFromStorage, but from the example).
export function prepareGalleryExample(example) {
  // Gallery shows ONLY the example's own data sources (not the built-in samples), so the
  // read-only data table reflects just the dataset(s) this tree actually uses.
  const dataSources = { ...(example?.dataSources || {}) }
  const charts = (example?.charts || []).map(c => {
    if (!c || !c.spec) return c
    const chartData = (c.dataSourceId && dataSources[c.dataSourceId])
      ? dataSources[c.dataSourceId].values
      : (example?.currentData || [])
    return {
      ...c,
      spec: injectDataIntoSpec(c.spec, chartData),
      baseSpec: injectDataIntoSpec(c.baseSpec, chartData),
    }
  })
  return { chartObjects: charts, dataSources, nextChartId: (example?.nextChartId || charts.length + 1) }
}

function App({ readOnly = false, galleryExample = null } = {}) {
  // Read-only gallery mode seeds from a frozen example and NEVER persists (guarded below).
  const savedState = useRef(readOnly ? null : loadFromStorage()).current
  const galleryInit = useRef(readOnly && galleryExample ? prepareGalleryExample(galleryExample) : null).current

  // Chart objects on canvas
  const [chartObjects, setChartObjects] = useState(
    readOnly ? (galleryInit?.chartObjects || []) : (savedState?.chartObjects || [])
  )
  const [selectedChartIds, setSelectedChartIds] = useState([])
  const [nextChartId, setNextChartId] = useState((readOnly ? galleryInit?.nextChartId : savedState?.nextChartId) || 1)

  // Undo/Redo history
  const historyRef = useRef([])
  const historyIndexRef = useRef(-1)
  const isUndoRedoRef = useRef(false)
  const historyTimerRef = useRef(null)

  const dataSourcesRef = useRef(null)
  const setDataSourcesRef = useRef(null)

  const saveToHistory = useCallback((charts) => {
    if (isUndoRedoRef.current) return

    if (historyTimerRef.current) {
      clearTimeout(historyTimerRef.current)
    }

    historyTimerRef.current = setTimeout(() => {
      const history = historyRef.current
      const index = historyIndexRef.current

      historyRef.current = history.slice(0, index + 1)
      // Snapshot without data.values to reduce memory (data lives in dataSources)
      const lightCharts = charts.map(c => {
        const copy = JSON.parse(JSON.stringify(c))
        if (copy.spec?.data?.values?.length > 0) copy.spec.data.values = []
        if (copy.spec?.layer) copy.spec.layer.forEach(l => { if (l.data?.values?.length > 20 && l.encoding?.x?.field) l.data.values = [] })
        return copy
      })
      historyRef.current.push({
        chartObjects: lightCharts,
        dataSources: dataSourcesRef.current ? JSON.parse(JSON.stringify(dataSourcesRef.current)) : null,
      })
      historyIndexRef.current = historyRef.current.length - 1

      if (historyRef.current.length > 50) {
        historyRef.current = historyRef.current.slice(-50)
        historyIndexRef.current = historyRef.current.length - 1
      }
    }, 500)
  }, [])

  // Restore data.values from dataSources after undo/redo (snapshots strip data to save memory)
  const restoreSnapshotData = useCallback((chartObjs, ds) => {
    return chartObjs.map(c => {
      if (c.dataSourceId && ds?.[c.dataSourceId]?.values) {
        const vals = ds[c.dataSourceId].values
        // Skip raw Vega specs (array-form data) — they embed their own data
        if (c.spec?.data && !Array.isArray(c.spec.data) && (!c.spec.data.values || c.spec.data.values.length === 0)) {
          c.spec.data.values = vals
        }
      }
      return c
    })
  }, [])

  const undo = useCallback(() => {
    if (readOnly) return
    const index = historyIndexRef.current
    if (index > 0) {
      isUndoRedoRef.current = true
      historyIndexRef.current = index - 1
      const snapshot = historyRef.current[index - 1]
      if (Array.isArray(snapshot)) {
        setChartObjects(JSON.parse(JSON.stringify(snapshot)))
      } else {
        const ds = snapshot.dataSources ? JSON.parse(JSON.stringify(snapshot.dataSources)) : dataSourcesRef.current
        if (snapshot.dataSources && setDataSourcesRef.current) setDataSourcesRef.current(ds)
        setChartObjects(restoreSnapshotData(JSON.parse(JSON.stringify(snapshot.chartObjects)), ds))
      }
      setTimeout(() => { isUndoRedoRef.current = false }, 0)
    }
  }, [restoreSnapshotData])

  const redo = useCallback(() => {
    if (readOnly) return
    const index = historyIndexRef.current
    if (index < historyRef.current.length - 1) {
      isUndoRedoRef.current = true
      historyIndexRef.current = index + 1
      const snapshot = historyRef.current[index + 1]
      if (Array.isArray(snapshot)) {
        setChartObjects(JSON.parse(JSON.stringify(snapshot)))
      } else {
        const ds = snapshot.dataSources ? JSON.parse(JSON.stringify(snapshot.dataSources)) : dataSourcesRef.current
        if (snapshot.dataSources && setDataSourcesRef.current) setDataSourcesRef.current(ds)
        setChartObjects(restoreSnapshotData(JSON.parse(JSON.stringify(snapshot.chartObjects)), ds))
      }
      setTimeout(() => { isUndoRedoRef.current = false }, 0)
    }
  }, [restoreSnapshotData])

  useEffect(() => {
    const handleKeyDown = (e) => {
      // Don't intercept Cmd+Z when the spec code editor (CodeMirror) is focused
      if (document.activeElement?.closest?.('.cm-editor')) return
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault()
        if (e.shiftKey) {
          redo()
        } else {
          undo()
        }
      }
      if (e.key === 'Escape') {
        setActiveModificationId(null)
        document.querySelectorAll('.mod-selected').forEach(el => el.classList.remove('mod-selected'))
        document.querySelectorAll('.has-mod-selection').forEach(el => el.classList.remove('has-mod-selection'))
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [undo, redo])

  useEffect(() => {
    if (chartObjects.length > 0 || historyRef.current.length > 0) {
      saveToHistory(chartObjects)
    }
  }, [chartObjects, saveToHistory])

  // NL input state
  const [nlInput, setNlInput] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)

  // Selected element for property panel
  const [selectedElement, setSelectedElement] = useState(null)
  const [selectedElements, setSelectedElements] = useState([])
  const [elementChartId, setElementChartId] = useState(null)

  // Refs for latest values (needed by onOpenChat which is captured in Canvas render effect)
  const selectedElementsRef = useRef(selectedElements)
  selectedElementsRef.current = selectedElements
  const selectedElementRef = useRef(selectedElement)
  selectedElementRef.current = selectedElement
  const elementChartIdRef = useRef(elementChartId)
  elementChartIdRef.current = elementChartId

  // Active modification (for highlight)
  const [activeModificationId, setActiveModificationId] = useState(null)

  // Layer panel state
  const [selectedLayerId, setSelectedLayerId] = useState(null)
  const [selectedSelectors, setSelectedSelectors] = useState([]) // multi-select selectors
  const [splitPosition, setSplitPosition] = useState(50) // percentage for left panel
  const [isDraggingSplit, setIsDraggingSplit] = useState(false)
  const leftPanelRef = useRef(null)

  const [rightPanelTab, setRightPanelTab] = useState('properties') // 'properties' | 'spec'
  const rightPanelRef = useRef(null)

  // Panel width state (horizontal resize)
  const [rightPanelWidth, setRightPanelWidth] = useState(280)
  const [isDraggingRightResize, setIsDraggingRightResize] = useState(false)

  // DataTable collapsible panel state
  const [dataTableOpen, setDataTableOpen] = useState(true)
  const [dataTableWidth, setDataTableWidth] = useState(340)
  const [isDraggingDataTableResize, setIsDraggingDataTableResize] = useState(false)

  // Layer panel collapsible state
  const [layerPanelOpen, setLayerPanelOpen] = useState(false)
  const [layerPanelWidth, setLayerPanelWidth] = useState(260)
  const [isDraggingLayerResize, setIsDraggingLayerResize] = useState(false)

  // Chat agent state
  const [activeChatId, setActiveChatId] = useState(null)
  const [chatCanvasPos, setChatCanvasPos] = useState({ x: 0, y: 0 })
  const [chatInitialMessages, setChatInitialMessages] = useState(null)
  const [chatElementReferences, setChatElementReferences] = useState(null) // snapshot of selected elements at chat open
  const [chatScopeInfo, setChatScopeInfo] = useState(null)
  const [chatReferences, setChatReferences] = useState([]) // Scenario B: numbered click-to-reference during chat
  const [canvasTransform, setCanvasTransform] = useState({ x: 0, y: 0, k: 1 })
  const continueChatOriginalSpec = useRef(null) // { chartId, spec } — saved before preview
  const canvasWrapperRef = useRef(null)
  const canvasPanToRef = useRef(null) // exposed by Canvas for programmatic pan
  const chatAgentFocusRef = useRef(null)

  // Spec edit mode state
  const [specEditMode, setSpecEditMode] = useState(false)
  const [specEditText, setSpecEditText] = useState('')
  const [specEditError, setSpecEditError] = useState(null)

  // Spec import state
  const [showSpecImport, setShowSpecImport] = useState(false)
  const [specImportText, setSpecImportText] = useState('')
  const [specImportError, setSpecImportError] = useState(null)
  const specImportFileRef = useRef(null)

  // Pan canvas to center a chart in the viewport (with smooth animation)
  const panToChart = useCallback((chartX, chartY, chartW, chartH) => {
    const wrapper = canvasWrapperRef.current
    if (!wrapper) return
    const viewW = wrapper.clientWidth
    const viewH = wrapper.clientHeight
    const k = canvasTransform.k || 1
    const newX = viewW / 2 - (chartX + chartW / 2) * k
    const newY = viewH / 2 - (chartY + chartH / 2) * k
    const newTransform = { x: newX, y: newY, k }
    if (canvasPanToRef.current) {
      canvasPanToRef.current(newTransform, { animate: true, duration: 600 })
    } else {
      setCanvasTransform(newTransform)
    }
  }, [canvasTransform.k])

  const [previewChart, setPreviewChart] = useState(null)

  // Reset confirm dialog
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  // API-key dialog (public build). keyVersion bumps to re-render the header key indicator.
  const [apiKeyOpen, setApiKeyOpen] = useState(false)
  const [, setKeyVersion] = useState(0)

  // Toast notification state
  const [toastMessage, setToastMessage] = useState(null)
  const toastTimerRef = useRef(null)
  const showToast = useCallback((message, duration = 3000) => {
    setToastMessage(message)
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToastMessage(null), duration)
  }, [])

  // Data state (for encoding scenario)
  const [currentData, setCurrentData] = useState(savedState?.currentData || SAMPLE_DATA)
  const [columnInfos, setColumnInfos] = useState(() => savedState?.columnInfos || analyzeColumns(SAMPLE_DATA))
  const [selectedColumns, setSelectedColumns] = useState(savedState?.selectedColumns || [])
  const [selectedData, setSelectedData] = useState([])
  const [dataSourceName, setDataSourceName] = useState(savedState?.dataSourceName || 'sample_data')
  const [selectedChartType, setSelectedChartType] = useState(savedState?.selectedChartType || null)

  // DataSource state
  const [dataSources, setDataSources] = useState((readOnly ? galleryInit?.dataSources : savedState?.dataSources) || SAMPLE_DATASETS)
  const [activeDataSourceId, setActiveDataSourceId] = useState(savedState?.activeDataSourceId || null)
  dataSourcesRef.current = dataSources  // keep ref in sync for history snapshots
  setDataSourcesRef.current = setDataSources

  // Helper: update a data source and propagate to all charts referencing it
  const updateDataSource = useCallback((dataSourceId, newValues) => {
    setDataSources(prev => ({
      ...prev,
      [dataSourceId]: { ...prev[dataSourceId], values: newValues }
    }))
    setChartObjects(prev => {
      let result = prev.map(chart => {
        if (chart.dataSourceId !== dataSourceId) return chart
        // Only inject if chart's spec fields are compatible with the data source
        // (charts with transformed/subset data have different fields — don't overwrite)
        const specRow = chart.spec?.data?.values?.[0]
        if (specRow && newValues?.[0]) {
          const specFields = Object.keys(specRow)
          const dsFields = new Set(Object.keys(newValues[0]))
          const compatible = specFields.every(f => dsFields.has(f))
          if (!compatible) return chart  // fields differ → keep chart's own data
        }
        const updated = {
          ...chart,
          spec: { ...chart.spec, data: { values: newValues } }
        }
        // Keep baseSpec.data in sync too. baseSpec is the pre-modification source
        // that applyModificationsToSpec() recomputes spec from; if it kept the old
        // data, a later edit would recompute the spec with stale data and the newly
        // added rows would vanish. Skip raw array-form data (e.g. treemap).
        if (chart.baseSpec && !Array.isArray(chart.baseSpec.data)) {
          updated.baseSpec = { ...chart.baseSpec, data: { ...(chart.baseSpec.data || {}), values: newValues } }
        }
        return updated
      })
      return result
    })
  }, [])

  // Persist state to localStorage (debounced)
  const saveTimerRef = useRef(null)
  useEffect(() => {
    if (readOnly) return   // gallery preview: never write over the user's real charts
    const stateToSave = {
      chartObjects,
      nextChartId,
      currentData,
      columnInfos,
      selectedColumns,
      dataSourceName,
      selectedChartType,
      lastSelectedChartId: selectedChartIds.length === 1 ? selectedChartIds[0] : null,
      dataSources,
      activeDataSourceId,
    }
    _latestStateForSave = stateToSave
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveToStorage(stateToSave)
      _latestStateForSave = null
    }, 300)
  }, [chartObjects, nextChartId, currentData, columnInfos, selectedColumns, dataSourceName, selectedChartType, selectedChartIds, activeDataSourceId])

  // Flush save immediately on page unload (refresh / back / close)
  useEffect(() => {
    const flush = () => {
      if (_latestStateForSave) {
        saveToStorage(_latestStateForSave)
        _latestStateForSave = null
      }
    }
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      // Also flush on unmount
      flush()
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [])

  // Derived: single selection for panels (only when exactly 1 chart selected)
  const selectedChartId = selectedChartIds.length === 1 ? selectedChartIds[0] : null
  const selectedChart = chartObjects.find(c => c.id === selectedChartId)

  // Auto-exit spec edit mode when chart selection changes
  useEffect(() => {
    setSpecEditMode(false)
    setSpecEditError(null)
  }, [selectedChartId])

  // Build ancestor chain for widget panel: [root, ..., grandparent, parent, self]
  const ancestorWidgetChain = useMemo(() => {
    if (!selectedChartId) return []
    const chain = []
    let current = chartObjects.find(c => c.id === selectedChartId)
    while (current) {
      chain.unshift(current)
      current = current.parentId ? chartObjects.find(c => c.id === current.parentId) : null
    }
    return chain
  }, [chartObjects, selectedChartId])

  // On mount: pan to the last selected chart's position
  const didRestoreView = useRef(false)
  useEffect(() => {
    if (didRestoreView.current) return
    didRestoreView.current = true
    // Read-only gallery: fit the whole frozen tree into view.
    if (readOnly) {
      if (!chartObjects.length) return
      const minX = Math.min(...chartObjects.map(c => c.x))
      const minY = Math.min(...chartObjects.map(c => c.y))
      const maxX = Math.max(...chartObjects.map(c => c.x + (c.width || 480)))
      const maxY = Math.max(...chartObjects.map(c => c.y + (c.height || 350)))
      setTimeout(() => panToChart(minX, minY, maxX - minX, maxY - minY), 250)
      return
    }
    const lastId = savedState?.lastSelectedChartId
    if (lastId == null) return
    const chart = chartObjects.find(c => c.id === lastId)
    if (!chart) return
    // Wait for canvas to mount and panToRef to be available
    setTimeout(() => {
      panToChart(chart.x, chart.y, chart.width || 480, chart.height || 350)
    }, 200)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Effective data source: prefer active browsing, then selected chart's, then first available
  const effectiveDataSourceId = activeDataSourceId || selectedChart?.dataSourceId || null

  // Effective data for DataTable (based on selected chart's data source or active browsing data source)
  const tableEffectiveDataSourceId = selectedChart?.dataSourceId || activeDataSourceId
  const tableEffectiveData = useMemo(() => {
    if (tableEffectiveDataSourceId && dataSources[tableEffectiveDataSourceId]) {
      return dataSources[tableEffectiveDataSourceId].values
    }
    // Fallback: if a chart is selected and has inline data, show that
    if (selectedChart?.spec?.data?.values?.length > 0) {
      return selectedChart.spec.data.values
    }
    return currentData
  }, [tableEffectiveDataSourceId, dataSources, currentData, selectedChart])

  const tableEffectiveColumnInfos = useMemo(() => {
    if (tableEffectiveDataSourceId && dataSources[tableEffectiveDataSourceId]) {
      return analyzeColumns(dataSources[tableEffectiveDataSourceId].values)
    }
    if (selectedChart?.spec?.data?.values?.length > 0) {
      return analyzeColumns(selectedChart.spec.data.values)
    }
    return columnInfos
  }, [tableEffectiveDataSourceId, dataSources, columnInfos, selectedChart])

  // Extract encoded fields from selected chart's spec (ordered by encoding channel priority)
  // Resolves fold-generated virtual fields (variable/value) back to original data columns
  const chartEncodedFields = useMemo(() => {
    if (!selectedChart?.spec) return []
    const spec = selectedChart.spec
    const fields = []
    const seen = new Set()
    const channelOrder = ['x', 'y', 'color', 'fill', 'size', 'shape', 'stroke', 'opacity', 'detail', 'text', 'tooltip', 'row', 'column', 'facet', 'theta', 'radius', 'x2', 'y2', 'xOffset']
    const collectFromEncoding = (enc) => {
      if (!enc) return
      for (const ch of channelOrder) {
        const field = enc[ch]?.field
        if (field && !seen.has(field)) {
          seen.add(field)
          fields.push({ field, channel: ch })
        }
      }
    }
    collectFromEncoding(spec.encoding)
    if (spec.layer) {
      for (const layer of spec.layer) {
        collectFromEncoding(layer.encoding)
      }
    }
    return fields
  }, [selectedChart?.spec])

  // Memoized external selection for Canvas sync (prevents useEffect firing on every render)
  const externalSelectedElement = useMemo(() => {
    if (!selectedElement) return null
    return { chartId: elementChartId, selector: selectedElement.selector, selectors: selectedSelectors }
  }, [selectedElement, elementChartId, selectedSelectors])

  // Clear element selection helper
  const clearElementSelection = () => {
    setSelectedElement(null)
    setSelectedElements([])
    setElementChartId(null)
    setSelectedLayerId(null)
    setActiveModificationId(null)
    document.querySelectorAll('.mod-selected').forEach(el => el.classList.remove('mod-selected'))
    document.querySelectorAll('.has-mod-selection').forEach(el => el.classList.remove('has-mod-selection'))
  }

  // Select single chart (normal click)
  const handleSelectChart = useCallback((id) => {
    setSelectedChartIds(prev => {
      // Skip update if already the sole selection — prevents unnecessary Canvas re-render
      // that would destroy element overlays
      if (id && prev.length === 1 && prev[0] === id) return prev
      return id ? [id] : []
    })
    clearElementSelection()
    if (!id) setActiveDataSourceId(null)
  }, [])

  // Toggle chart in/out of selection (shift-click)
  const handleToggleChartSelection = useCallback((id) => {
    setSelectedChartIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    )
    clearElementSelection()
  }, [])

  // Set multiple charts (rubber-band result)
  const handleSelectCharts = useCallback((ids) => {
    setSelectedChartIds(ids)
    clearElementSelection()
  }, [])

  // Find non-overlapping position for a new chart
  const findNonOverlappingPosition = (targetX, targetY, targetW, targetH, existingCharts) => {
    let x = targetX
    let y = targetY
    const PADDING = 40
    const MAX_X = 1800 // max horizontal boundary before wrapping down
    const START_X = targetX // remember starting x for row wrapping
    let overlapping = true
    let maxIter = 100
    while (overlapping && maxIter-- > 0) {
      overlapping = existingCharts.some(chart =>
        !(x > chart.x + chart.width + PADDING ||
          x + targetW + PADDING < chart.x ||
          y > chart.y + chart.height + PADDING ||
          y + targetH + PADDING < chart.y)
      )
      if (overlapping) {
        x += targetW + PADDING
        // If past max boundary, wrap to next row
        if (x + targetW > MAX_X) {
          x = START_X
          y += targetH + PADDING
        }
      }
    }
    return { x, y }
  }

  // Add new chart to canvas
  const handleAddChart = (templateKey = 'bar') => {
    const template = CHART_TEMPLATES[templateKey] || CHART_TEMPLATES.bar
    const newChart = {
      id: nextChartId,
      dataSourceId: effectiveDataSourceId,
      x: 700 + (chartObjects.length * 50),
      y: 150,
      width: 480,
      height: 350,
      spec: JSON.parse(JSON.stringify(template.spec)),
      parentId: null, // For tracking lineage
      command: null,  // NL command that created this
      modifications: [],
      baseSpec: null,
      baseSvgOverrides: null
    }
    setChartObjects(prev => [...prev, newChart])
    setSelectedChartIds([nextChartId])
    setNextChartId(prev => prev + 1)
    setTimeout(() => panToChart(newChart.x, newChart.y, newChart.width, newChart.height), 100)
  }

  // Update chart
  const handleUpdateChart = useCallback((id, updates) => {
    // Read-only gallery: block edits, but ALLOW pure size measurements from the renderer
    // (onSizeReady) so selection boxes, parent-child connectors, and widget overlays match
    // the actually-rendered chart instead of hand-authored estimates.
    if (readOnly) {
      const keys = Object.keys(updates || {})
      const sizeOnly = keys.length > 0 && keys.every(k => k === 'width' || k === 'height')
      if (!sizeOnly) return
    }
    setChartObjects(prev => {
      // When the spec changes, propagate the change down to all derived (child) charts
      let changes = null
      let descendantIds = null
      if (updates.spec) {
        const oldChart = prev.find(c => c.id === id)
        if (oldChart?.spec) {
          changes = diffSpecPaths(oldChart.spec, updates.spec)
          if (changes.length > 0) {
            descendantIds = collectDescendantIds(prev, id)
          }
          console.log('[updateChart propagate] id:', id, '| specChanges:', changes.length, '| descendants:', descendantIds ? Array.from(descendantIds) : [])
        }
      }

      let result = prev.map(chart => {
        if (chart.id === id) {
          const merged = { ...chart, ...updates }
          // Keep baseSpec's SIZE in sync with a spec size change — but operate on the
          // ALREADY-MERGED baseSpec, which honors a caller-provided updates.baseSpec (e.g.
          // handleMarkOption mutates baseSpec to add point/interpolate). Previously this
          // recomputed from the STALE chart.baseSpec and clobbered updates.baseSpec, so mark
          // options never reached baseSpec and got reverted on the next modification replay.
          if (updates.spec && merged.baseSpec) {
            const src = updates.spec.facet && updates.spec.spec ? updates.spec.spec : updates.spec
            const newW = src.width
            const newH = src.height
            const base = JSON.parse(JSON.stringify(merged.baseSpec))
            const dst = base.facet && base.spec ? base.spec : base
            if (newW != null) dst.width = newW
            if (newH != null) dst.height = newH
            if (dst !== base) { delete base.width; delete base.height }
            merged.baseSpec = base
          }
          return merged
        }
        // Propagate the parent's edit to descendants (spec + baseSpec if present),
        // but skip any path the descendant controls via its own widget panel —
        // widget values remain local overrides.
        if (descendantIds?.has(chart.id) && chart.spec) {
          const widgetPaths = (chart.widgetOptions || []).map(o => o.path).filter(Boolean)
          const ops = widgetPaths.length
            ? changes.filter(ch => !isUnderAnyPath(pathArrToString(ch.path), widgetPaths))
            : changes
          if (ops.length === 0) return chart
          const propagated = { ...chart, spec: applyPropagatedOps(chart.spec, ops) }
          if (chart.baseSpec) propagated.baseSpec = applyPropagatedOps(chart.baseSpec, ops)
          return propagated
        }
        return chart
      })
      return result
    })
  }, [])

  // Copy chart (deep clone with new identity)
  const handleCopyChart = useCallback((chartId) => {
    const newId = nextChartId
    setNextChartId(prev => prev + 1)
    setChartObjects(prev => {
      const original = prev.find(c => c.id === chartId)
      if (!original) return prev
      const cloned = JSON.parse(JSON.stringify(original))
      const adjusted = findNonOverlappingPosition(original.x + 40, original.y + 40, original.width, original.height, prev)
      const newChart = {
        ...cloned,
        id: newId,
        x: adjusted.x,
        y: adjusted.y,
        parentId: null,
        command: null,
        conversationHistory: [],
      }
      return [...prev, newChart]
    })
  }, [findNonOverlappingPosition, nextChartId])

  // Duplicate a chart AS A BRANCH: keep it wired to the same parent so the
  // connecting widget + line reproduce, and carry over widgetOptions/changeType.
  // A root chart (no parent) branches OFF itself instead.
  const handleBranchChart = useCallback((chartId) => {
    const newId = nextChartId
    setNextChartId(prev => prev + 1)
    setChartObjects(prev => {
      const original = prev.find(c => c.id === chartId)
      if (!original) return prev
      const cloned = JSON.parse(JSON.stringify(original))
      const adjusted = findNonOverlappingPosition(original.x + 40, original.y + 40, original.width, original.height, prev)
      const newChart = {
        ...cloned,               // keeps widgetOptions, modifications, changeType, spec/baseSpec
        id: newId,
        x: adjusted.x,
        y: adjusted.y,
        parentId: original.parentId ?? original.id,
        command: original.command || null,
        conversationHistory: [],
      }
      return [...prev, newChart]
    })
  }, [findNonOverlappingPosition, nextChartId])

  // Cmd+D: copy selected charts. Shift adds a branch (keeps connection widget + line).
  useEffect(() => {
    const handleCopyKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'd') {
        e.preventDefault()
        const fn = e.shiftKey ? handleBranchChart : handleCopyChart
        selectedChartIds.forEach(id => fn(id))
      }
    }
    window.addEventListener('keydown', handleCopyKeyDown)
    return () => window.removeEventListener('keydown', handleCopyKeyDown)
  }, [selectedChartIds, handleCopyChart, handleBranchChart])

  // Delete chart
  const [deleteConfirm, setDeleteConfirm] = useState(null)

  const handleDeleteChart = useCallback((id) => {
    if (readOnly) return   // read-only gallery: no deletes (incl. keyboard Delete)
    setChartObjects(prev => {
      // Recursively delete target and all descendants
      const toDelete = new Set()
      const collect = (parentId) => {
        toDelete.add(parentId)
        prev.filter(c => c.parentId === parentId).forEach(c => collect(c.id))
      }
      collect(id)
      return prev.filter(c => !toDelete.has(c.id))
    })
    setSelectedChartIds(prev => prev.filter(x => x !== id))
    setDeleteConfirm(null)
  }, [])

  const performDelete = useCallback((id, mode) => {
    setChartObjects(prev => {
      if (mode === 'cascade') {
        // Recursively collect all descendants
        const toDelete = new Set()
        const collect = (parentId) => {
          toDelete.add(parentId)
          prev.filter(c => c.parentId === parentId).forEach(c => collect(c.id))
        }
        collect(id)
        return prev.filter(c => !toDelete.has(c.id))
      }
      // mode === 'detach': keep children, remove parent link
      return prev
        .filter(chart => chart.id !== id)
        .map(chart => chart.parentId === id ? { ...chart, parentId: null } : chart)
    })
    setSelectedChartIds(prev => prev.filter(x => x !== id))
    setDeleteConfirm(null)
  }, [])

  // Delete one or more selected elements by filtering their data out of the spec.
  // Accepts a single element or an array (group/multi-select). Each becomes a
  // reversible '__delete__' modification; a multi-delete shares one batchId so the
  // modification stack collapses them into a single toggle group. The spec delta
  // cascades to descendants.
  const handleDeleteElement = useCallback((elementInfoOrList) => {
    if (readOnly) return
    if (!elementChartId) return
    const list = Array.isArray(elementInfoOrList)
      ? elementInfoOrList
      : [elementInfoOrList || selectedElement]
    const els = list.filter(Boolean)
    if (els.length === 0) return

    const markGroupToLabel = {
      'mark-area': 'AREA', 'mark-line': 'LINE', 'mark-rect': 'BAR',
      'mark-symbol': 'POINT', 'mark-text': 'TEXT', 'mark-arc': 'ARC', 'mark-rule': 'RULE'
    }
    // Multiple deletions share one batchId → grouped under a single toggle in the stack.
    const batchId = els.length > 1 ? `del-batch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` : null

    const buildMod = (el, i) => {
      const targetType = el.markGroup
        ? (markGroupToLabel[el.markGroup] || el.markGroup)
        : ({ rect: 'BAR', path: 'AREA', circle: 'POINT', line: 'LINE', mark: 'MARK' }[el.type] || 'MARK')
      return {
        id: `mod-del-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
        property: '__delete__',
        value: true,
        isDelete: true,
        scope: el.scope || { type: 'this-only' },
        selector: el.selector || null,
        datum: el.datum || null,
        targetType,
        markGroup: el.markGroup || null,
        semanticRole: el.semanticRole || 'data-mark',
        layerIndex: el.layerIndex ?? null,
        batchId,
        timestamp: Date.now(),
      }
    }

    setChartObjects(prev => {
      let srcOldSpec = null
      let srcNewSpec = null
      let result = prev.map(chart => {
        if (chart.id !== elementChartId) return chart
        srcOldSpec = chart.spec
        const baseSpec = chart.baseSpec || JSON.parse(JSON.stringify(chart.spec))
        const baseSvgOverrides = chart.baseSvgOverrides ?? JSON.parse(JSON.stringify(chart.svgOverrides || {}))
        const modifications = [...(chart.modifications || [])]
        els.forEach((el, i) => {
          const mod = buildMod(el, i)
          const sig = JSON.stringify({ s: mod.selector, d: mod.datum, sc: mod.scope, li: mod.layerIndex })
          const dup = modifications.some(m => m.property === '__delete__' &&
            JSON.stringify({ s: m.selector, d: m.datum, sc: m.scope, li: m.layerIndex }) === sig)
          if (!dup) modifications.push(mod)
        })
        const { spec: newSpec, svgOverrides: modOverrides } = applyModificationsToSpec(baseSpec, modifications)
        const finalOverrides = rebuildSvgOverrides(baseSvgOverrides, modOverrides)
        srcNewSpec = newSpec
        return { ...chart, modifications, baseSpec, baseSvgOverrides, spec: newSpec, svgOverrides: finalOverrides }
      })

      // Cascade the deletion's spec delta to descendants (skip their widget paths).
      if (srcOldSpec && srcNewSpec) {
        const changes = diffSpecPaths(srcOldSpec, srcNewSpec)
        if (changes.length > 0) {
          const descendantIds = collectDescendantIds(prev, elementChartId)
          if (descendantIds.size > 0) {
            result = result.map(chart => {
              if (!descendantIds.has(chart.id)) return chart
              const widgetPaths = (chart.widgetOptions || []).map(o => o.path).filter(Boolean)
              const ops = widgetPaths.length
                ? changes.filter(ch => !isUnderAnyPath(pathArrToString(ch.path), widgetPaths))
                : changes
              if (ops.length === 0) return chart
              const upd = { ...chart, spec: applyPropagatedOps(chart.spec, ops) }
              if (chart.baseSpec) upd.baseSpec = applyPropagatedOps(chart.baseSpec, ops)
              return upd
            })
          }
        }
      }

      return result
    })

    // The deleted element no longer exists — clear selection.
    setSelectedElement(null)
    setSelectedElements([])
  }, [elementChartId, selectedElement])

  // generateSelector, detectElementType, extractDatum are imported from ./utils/elementUtils

  // Helper to get value at a dot-bracket path in an object
  const getValueAtPath = (obj, path) => {
    try {
      const parts = path.match(/([^.\[\]]+|\[\d+\])/g)
      if (!parts) return undefined
      let current = obj
      for (const part of parts) {
        if (current == null) return undefined
        if (part.startsWith('[') && part.endsWith(']')) {
          current = current[parseInt(part.slice(1, -1))]
        } else {
          current = current[part]
        }
      }
      return current
    } catch {
      return undefined
    }
  }

  // Helper function to set value at a path in an object (returns unchanged clone if path doesn't exist)
  const setValueAtPath = (obj, path, value) => {
    const newObj = JSON.parse(JSON.stringify(obj)) // Deep clone
    const parts = path.match(/([^.\[\]]+|\[\d+\])/g) // Split path into parts
    if (!parts || parts.length === 0) return newObj

    let current = newObj
    for (let i = 0; i < parts.length - 1; i++) {
      let part = parts[i]
      // Handle array index like [1]
      if (part.startsWith('[') && part.endsWith(']')) {
        part = parseInt(part.slice(1, -1))
      }
      if (current[part] === undefined) return newObj // path doesn't exist, return unchanged
      current = current[part]
    }

    // Set the final value
    let lastPart = parts[parts.length - 1]
    if (lastPart.startsWith('[') && lastPart.endsWith(']')) {
      lastPart = parseInt(lastPart.slice(1, -1))
    }
    current[lastPart] = value

    return newObj
  }

  // Handle widget option change - directly modify spec using path (no API call)
  const handleWidgetOptionChange = useCallback((chartId, optionId, newValue) => {
    if (readOnly) return   // read-only gallery: widgets are display-only
    setChartObjects(prev => {
      const sourceChart = prev.find(c => c.id === chartId)
      const option = sourceChart?.widgetOptions?.find(opt => opt.id === optionId)
      if (!option || !option.path) {
        console.warn('No path found for option:', optionId)
        return prev
      }

      // Determine the actual value to write into the spec
      const computeSpecValue = (currentSpec) => {
        if (option.valueTemplate) {
          return option.valueTemplate.replace(/\{value\}/g, newValue)
        }
        const currentSpecValue = getValueAtPath(currentSpec, option.path)
        if (typeof currentSpecValue === 'string' && option.value != null) {
          const oldStr = String(option.value)
          // Special case: spec has rgba(...) and new value is a hex color → preserve alpha
          const rgbaMatch = currentSpecValue.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/)
          const newIsHex = typeof newValue === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(newValue)
          if (rgbaMatch && newIsHex) {
            const alpha = rgbaMatch[4] !== undefined ? rgbaMatch[4] : '1'
            const hex = newValue.replace('#', '')
            const r = parseInt(hex.length === 3 ? hex[0]+hex[0] : hex.slice(0,2), 16)
            const g = parseInt(hex.length === 3 ? hex[1]+hex[1] : hex.slice(2,4), 16)
            const b = parseInt(hex.length === 3 ? hex[2]+hex[2] : hex.slice(4,6), 16)
            return `rgba(${r},${g},${b},${alpha})`
          } else if (currentSpecValue === oldStr) {
            return newValue
          } else if (currentSpecValue.includes(oldStr)) {
            return currentSpecValue.replace(oldStr, String(newValue))
          }
        }
        return newValue
      }

      // Update source chart
      let updated = prev.map(chart => {
        if (chart.id !== chartId) return chart

        const updatedOptions = chart.widgetOptions.map(opt =>
          opt.id === optionId ? { ...opt, value: newValue } : opt
        )
        const specVal = computeSpecValue(chart.spec)
        const updatedSpec = setValueAtPath(chart.spec, option.path, specVal)
        // Keep baseSpec in sync so a later modification-replay doesn't revert this widget
        // change (baseSpec is what applyModificationsToSpec replays over).
        const updatedBase = chart.baseSpec ? setValueAtPath(chart.baseSpec, option.path, specVal) : chart.baseSpec
        return { ...chart, spec: updatedSpec, baseSpec: updatedBase, widgetOptions: updatedOptions }
      })

      // Propagate to all descendant charts via same path
      const descendantIds = new Set()
      const queue = [chartId]
      while (queue.length > 0) {
        const pid = queue.shift()
        updated.forEach(c => {
          if (c.parentId === pid && !descendantIds.has(c.id)) {
            descendantIds.add(c.id)
            queue.push(c.id)
          }
        })
      }

      if (descendantIds.size > 0) {
        // Value to write into descendants: raw newValue, but honor a valueTemplate so a
        // templated widget doesn't propagate an un-templated value.
        const descValue = option.valueTemplate
          ? option.valueTemplate.replace(/\{value\}/g, newValue)
          : newValue

        updated = updated.map(chart => {
          if (!descendantIds.has(chart.id)) return chart

          // Locate the knob in a possibly-restructured descendant. Try, in order:
          //   1. the source path as-is (same structure — original behavior),
          //   2. the descendant's own inherited widget path,
          //   3. a layer-wrapped source path — a unit ancestor whose descendant wrapped the
          //      same encoding into a layer (e.g. encoding.color… → layer[N].encoding.color…).
          // First path that actually resolves in this spec wins; else fall back to source path
          // (setValueAtPath then no-ops, as before).
          const ownWidget = chart.widgetOptions?.find(w => w.id === optionId)
          const candidates = [option.path]
          if (ownWidget?.path && ownWidget.path !== option.path) candidates.push(ownWidget.path)
          if (/^encoding\./.test(option.path) && Array.isArray(chart.spec.layer)) {
            for (let i = 0; i < chart.spec.layer.length; i++) candidates.push(`layer[${i}].${option.path}`)
          }
          const applyPath = candidates.find(p => getValueAtPath(chart.spec, p) !== undefined) || option.path

          const newSpec = setValueAtPath(chart.spec, applyPath, descValue)
          const newBase = chart.baseSpec ? setValueAtPath(chart.baseSpec, applyPath, descValue) : chart.baseSpec

          // Sync descendant's own widget value (match by id or path)
          const newWidgets = chart.widgetOptions?.map(w =>
            (w.id === optionId || w.path === option.path) ? { ...w, value: newValue } : w
          )

          return { ...chart, spec: newSpec, baseSpec: newBase, widgetOptions: newWidgets || chart.widgetOptions }
        })
      }

      return updated
    })
  }, [])

  // Handle click-to-reference during chat (Scenario B)
  const handleElementReference = useCallback((chartId, elementInfo) => {
    setChatReferences(prev => {
      // Toggle: if already referenced, remove it
      const existing = prev.find(r => r.selector === elementInfo.selector)
      if (existing) {
        const filtered = prev.filter(r => r.selector !== elementInfo.selector)
        return filtered.map((r, i) => ({ ...r, number: i + 1 }))
      }
      // Cap at 9 references
      if (prev.length >= 9) return prev
      // Build label
      const datum = elementInfo.datum
      const labelParts = datum
        ? Object.entries(datum)
            .filter(([k, v]) => !k.startsWith('_') && v != null && (typeof v === 'string' || typeof v === 'number'))
            .filter(([, v]) => !(typeof v === 'number' && v > 1e9))
            .map(([k, v]) => `${k}: ${v}`)
            .slice(0, 2)
        : []
      const newRef = {
        number: prev.length + 1,
        selector: elementInfo.selector,
        elementInfo,
        datum: datum || null,
        label: labelParts.length > 0 ? labelParts.join(' · ') : (elementInfo.type || 'element'),
        markType: elementInfo.type || 'element',
        properties: elementInfo.properties || {}
      }
      return [...prev, newRef]
    })
  }, [])

  // Handle element selection from Canvas (single or multi)
  // skipLog: true when called from scope confirm or Vega re-render recovery (already logged elsewhere)
  const handleElementSelect = useCallback((chartId, elementInfo, allSelectedSelectors, allElementInfos, { skipLog } = {}) => {
    const allInfos = allElementInfos || [elementInfo]
    // console.log('[SELECT]', skipLog ? '(skipLog)' : '', {
    //   chartId,
    //   type: elementInfo.type,
    //   scopeType: elementInfo._scopeType || null,
    //   elementCount: allInfos.length,
    //   selectors: (allSelectedSelectors || []).length,
    //   datum: elementInfo.datum ? Object.keys(elementInfo.datum).filter(k => !k.startsWith('_')) : null,
    //   markGroup: elementInfo.markGroup,
    // })
    // Ensure the chart is selected (without clearing element state)
    setSelectedChartIds(prev => {
      if (prev.length === 1 && prev[0] === chartId) return prev // already selected, skip
      return [chartId]
    })
    setElementChartId(chartId)
    setSelectedElement(elementInfo)
    setSelectedElements(allInfos)
    setSelectedLayerId(null)
    const finalSelectors = allSelectedSelectors || (elementInfo.selector ? [elementInfo.selector] : [])
    setSelectedSelectors(finalSelectors)
    setActiveModificationId(null)
    document.querySelectorAll('.mod-selected').forEach(el => el.classList.remove('mod-selected'))
    document.querySelectorAll('.has-mod-selection').forEach(el => el.classList.remove('has-mod-selection'))

    // Update chat references when element selection changes during active chat
    if (activeChatId && chartId === activeChatId && allInfos.length > 0) {
      const firstWithScope = allInfos.find(el => el._scopeType)
      if (firstWithScope) {
        // Scope confirmed during active chat — show as blue "multi-selected" chip
        const scopeLabel = firstWithScope._scopeLabelEn || `${allInfos.length} elements`
        setChatScopeInfo({
          scopeType: firstWithScope._scopeType,
          scopeData: firstWithScope._scopeData,
          label: firstWithScope._scopeLabel,
          labelEn: firstWithScope._scopeLabelEn,
          elementCount: firstWithScope._scopeElementCount || allInfos.length
        })
        // Replace numbered references with a single scope reference (blue chip)
        setChatReferences([{
          number: 1,
          selector: allInfos[0]?.selector || null,
          elementInfo: allInfos[0] || null,
          datum: allInfos[0]?.datum || null,
          label: scopeLabel,
          markType: allInfos[0]?.type || 'unknown',
          properties: allInfos[0]?.properties || {},
        }])
      }
      // Single clicks during chat: handled by handleElementReference → chatReferences
      // Don't update chatElementReferences here — pre-chat snapshot stays as-is
    }
  }, [activeChatId])

  // Handle layer selection from LayerPanel
  // Uses the SAME detectElementType as Canvas click — one shared function, identical output
  const handleLayerSelect = (layer, isShiftClick = false) => {
    setSelectedLayerId(layer.id)

    const el = layer.element
    if (!el) return

    const spec = selectedChart?.spec || {}

    const svgElement = el.closest?.('svg') || document.getElementById(`vega-chart-${selectedChartId}`)?.querySelector('svg')
    if (!svgElement) return

    const elementInfo = detectElementType(el, spec, svgElement)
    if (!elementInfo) return

    elementInfo.datum = extractDatum(el)
    elementInfo.layerId = layer.id
    elementInfo.element = el
    elementInfo.layerIndex = getLayerIndex(el, svgElement)

    // Set layer classification for annotation detection
    if (elementInfo.layerIndex != null && spec?.layer?.[elementInfo.layerIndex]) {
      const dataValues = selectedChart?.dataSourceId && dataSources?.[selectedChart.dataSourceId]
        ? dataSources[selectedChart.dataSourceId].values
        : spec?.data?.values
      const layerSpec = spec.layer[elementInfo.layerIndex]
      const mainDataFields = dataValues && dataValues.length > 0 ? Object.keys(dataValues[0]) : []
      elementInfo.layerClassification = classifyLayer(layerSpec, mainDataFields, dataValues || [])
      const layerContext = analyzeLayerContext(layerSpec, spec, dataValues || [])
      elementInfo.layerContext = layerContext
      elementInfo.isAnnotation = layerContext.layerType !== 'data-mark' || elementInfo.layerClassification.type !== 'data-mark'
    }

    setElementChartId(selectedChartId)
    setSelectedElement(elementInfo)

    // Multi-select with shift — update both selectedSelectors and selectedElements
    if (isShiftClick && elementInfo.selector) {
      setSelectedSelectors(prev => {
        if (prev.includes(elementInfo.selector)) {
          return prev.filter(s => s !== elementInfo.selector)
        }
        return [...prev, elementInfo.selector]
      })
      setSelectedElements(prev => {
        const exists = prev.find(e => e.selector === elementInfo.selector)
        if (exists) {
          return prev.filter(e => e.selector !== elementInfo.selector)
        }
        return [...prev, elementInfo]
      })
    } else {
      setSelectedSelectors(elementInfo.selector ? [elementInfo.selector] : [])
      setSelectedElements([elementInfo])
    }
  }

  // Extract properties from layer element
  // getPropertiesFromLayer removed — detectElementType now handles property extraction

  // Split resize handlers
  const handleSplitMouseDown = useCallback((e) => {
    e.preventDefault()
    setIsDraggingSplit(true)
  }, [])

  const handleSplitMouseMove = useCallback((e) => {
    if (!isDraggingSplit || !leftPanelRef.current) return

    const panelRect = leftPanelRef.current.getBoundingClientRect()
    const newPosition = ((e.clientY - panelRect.top) / panelRect.height) * 100
    setSplitPosition(Math.max(20, Math.min(80, newPosition)))
  }, [isDraggingSplit])

  const handleSplitMouseUp = useCallback(() => {
    setIsDraggingSplit(false)
  }, [])

  // Right panel split handlers removed — now using tab view

  // Horizontal panel resize handlers
  const ICON_SIDEBAR_WIDTH = 48

  const handleRightResizeMouseDown = useCallback((e) => {
    e.preventDefault()
    setIsDraggingRightResize(true)
  }, [])

  const handlePanelResizeMouseMove = useCallback((e) => {
    if (isDraggingRightResize) {
      const newWidth = Math.max(200, Math.min(400, window.innerWidth - e.clientX))
      setRightPanelWidth(newWidth)
    }
    if (isDraggingLayerResize) {
      const newWidth = Math.max(160, Math.min(500, e.clientX - ICON_SIDEBAR_WIDTH))
      setLayerPanelWidth(newWidth)
    }
    if (isDraggingDataTableResize) {
      const baseLeft = ICON_SIDEBAR_WIDTH + (layerPanelOpen ? layerPanelWidth + 6 : 0)
      const newWidth = Math.max(220, Math.min(700, e.clientX - baseLeft))
      setDataTableWidth(newWidth)
    }
  }, [isDraggingRightResize, isDraggingLayerResize, isDraggingDataTableResize, layerPanelOpen, layerPanelWidth])

  const handlePanelResizeMouseUp = useCallback(() => {
    setIsDraggingRightResize(false)
    setIsDraggingLayerResize(false)
    setIsDraggingDataTableResize(false)
  }, [])

  // Handle property change from PropertyPanel
  // overrides: optional { groupElements, ... } for multi-select batch edits
  const handlePropertyChange = (elementPath, propName, value, overrides) => {
    if (readOnly) return
    if (!elementChartId) return

    const chart = chartObjects.find(c => c.id === elementChartId)
    if (!chart) return

    // Grouped multi-element modification: create a single entry with group field
    if (overrides?.groupElements && overrides.groupElements.length > 1) {
      // dx/dy for group: apply svgOverrides to each element individually
      if (propName === 'dx' || propName === 'dy') {
        setChartObjects(prev => prev.map(c => {
          if (c.id !== elementChartId) return c
          const svgOverrides = { ...(c.svgOverrides || {}) }
          for (const el of overrides.groupElements) {
            const sel = el.selector
            if (!sel) continue
            if (!svgOverrides[sel]) svgOverrides[sel] = {}
            svgOverrides[sel][propName] = value
          }
          return { ...c, svgOverrides }
        }))
        return
      }
      handleGroupedModificationPropertyChange(elementChartId, propName, value, overrides.groupElements)
      return
    }

    // If batch override provided, use its element info instead of selectedElement
    const effectiveElement = overrides ? {
      ...selectedElement,
      selector: overrides.selector || selectedElement?.selector,
      datum: overrides.datum || selectedElement?.datum,
      semanticRole: overrides.semanticRole || selectedElement?.semanticRole,
      markGroup: overrides.markGroup || selectedElement?.markGroup,
      element: overrides.element || selectedElement?.element,
      compositeMarkType: overrides.compositeMarkType || selectedElement?.compositeMarkType,
      compositeSubPart: overrides.compositeSubPart || selectedElement?.compositeSubPart,
      axisChannel: overrides.axisChannel || selectedElement?.axisChannel,
      axisSubType: overrides.axisSubType || selectedElement?.axisSubType,
      legendField: overrides.legendField || selectedElement?.legendField,
      legendValue: overrides.legendValue ?? selectedElement?.legendValue,
      legendSubType: overrides.legendSubType || selectedElement?.legendSubType,
      layerIndex: overrides.layerIndex ?? selectedElement?.layerIndex ?? null,
    } : selectedElement

    // Route elements with semantic roles through modification system
    const semanticRole = effectiveElement?.semanticRole
    const modRouteElements = ['rect', 'path', 'circle', 'line', 'mark', 'legend']
    const isAxisElement = semanticRole === 'axis'
    const isTextElement = semanticRole === 'text' && elementPath === 'text'
    const isLegendElement = semanticRole === 'legend'
    const isDataMark = modRouteElements.includes(elementPath) || semanticRole === 'data-mark'

    // Group property changes (childrenFill, childrenStroke, transform, etc.)
    // always go through svgOverrides, not the modification system
    if (elementPath === 'group') {
      const selector = effectiveElement?.selector
      if (selector) {
        setChartObjects(prev => prev.map(c => {
          if (c.id !== elementChartId) return c
          const svgOverrides = { ...(c.svgOverrides || {}) }
          if (!svgOverrides[selector]) svgOverrides[selector] = {}
          svgOverrides[selector][propName] = value
          return { ...c, svgOverrides }
        }))
      }
      return
    }

    // dx/dy position offsets: apply directly as SVG overrides, not through modification stack
    if ((propName === 'dx' || propName === 'dy') && effectiveElement?.selector) {
      const selector = effectiveElement.selector
      setChartObjects(prev => prev.map(c => {
        if (c.id !== elementChartId) return c
        const svgOverrides = { ...(c.svgOverrides || {}) }
        if (!svgOverrides[selector]) svgOverrides[selector] = {}
        svgOverrides[selector][propName] = value
        return { ...c, svgOverrides }
      }))
      return
    }

    if (isDataMark || isAxisElement || isTextElement || isLegendElement) {
      if (activeModificationId && !overrides) {
        const activeMod = chart.modifications?.find(m => m.id === activeModificationId)
        const isSameProperty = activeMod && activeMod.property === propName
        const isSameElement = activeMod && (
          activeMod.selector === effectiveElement?.selector ||
          activeMod.markGroup === effectiveElement?.markGroup
        )

        if (isSameProperty && isSameElement) {
          handleModificationValueUpdate(elementChartId, activeModificationId, propName, value)
        } else {
          setActiveModificationId(null)
          handleModificationPropertyChange(elementChartId, elementPath, propName, value, overrides)
        }
      } else {
        handleModificationPropertyChange(elementChartId, elementPath, propName, value, overrides)
      }
      if (!overrides) {
        setSelectedElement(prev => ({
          ...prev,
          properties: { ...prev.properties, [propName]: value }
        }))
      }
      return
    }

    let updatedSpec = JSON.parse(JSON.stringify(chart.spec))
    let specUpdated = false

    const updateSvgElement = () => {
      let el = selectedElement?.element

      if (!el || !el.isConnected) {
        const container = document.getElementById(`vega-chart-${elementChartId}`)
        const svg = container?.querySelector('svg')

        if (svg && selectedElement?.selector) {
          try {
            el = svg.querySelector(selectedElement.selector)
          } catch (e) {
            // invalid selector
          }
        }

        if (!el) {
          return false
        }
      }

      const svgAttrMap = {
        fill: 'fill',
        stroke: 'stroke',
        strokeWidth: 'stroke-width',
        opacity: 'opacity',
        strokeDasharray: 'stroke-dasharray',
        fontSize: 'font-size',
        fontWeight: 'font-weight',
        color: 'fill'  // text color
      }

      const attrName = svgAttrMap[propName]
      if (attrName) {
        if (propName === 'strokeDasharray') {
          if (value === 'solid') {
            el.removeAttribute('stroke-dasharray')
          } else {
            el.setAttribute('stroke-dasharray', value)
          }
        } else {
          el.setAttribute(attrName, value)
        }
      }

      if (propName === 'text' && el.tagName.toLowerCase() === 'text') {
        el.textContent = value
      }
    }

    // Apply property change based on element type
    if (elementPath === 'title') {
      // Handle title properties
      if (typeof updatedSpec.title === 'string') {
        updatedSpec.title = { text: updatedSpec.title }
      }
      if (!updatedSpec.title) {
        updatedSpec.title = {}
      }
      if (propName === 'text') {
        updatedSpec.title = typeof updatedSpec.title === 'object'
          ? { ...updatedSpec.title, text: value }
          : value
      } else {
        updatedSpec.title = { ...updatedSpec.title, [propName]: value }
      }
      specUpdated = true
    } else if (elementPath === 'mark') {
      // Handle mark properties
      if (typeof updatedSpec.mark === 'string') {
        updatedSpec.mark = { type: updatedSpec.mark }
      }
      updatedSpec.mark = { ...updatedSpec.mark, [propName]: value }
      specUpdated = true
    } else if (elementPath.startsWith('encoding.')) {
      // Handle axis properties
      const axisKey = elementPath.includes('.x.') ? 'x' : 'y'
      if (!updatedSpec.encoding[axisKey].axis) {
        updatedSpec.encoding[axisKey].axis = {}
      }
      updatedSpec.encoding[axisKey].axis[propName] = value
      specUpdated = true
    } else if (elementPath === 'text' || elementPath === 'line' ||
               elementPath === 'path' || elementPath === 'rect' ||
               elementPath === 'circle') {
      updateSvgElement()

      const selector = selectedElement?.selector
      if (selector) {
        setChartObjects(prev => prev.map(c => {
          if (c.id !== elementChartId) return c

          const svgOverrides = { ...(c.svgOverrides || {}) }
          if (!svgOverrides[selector]) {
            svgOverrides[selector] = {}
          }
          svgOverrides[selector][propName] = value

          return { ...c, svgOverrides }
        }))
      }
    } else if (propName === 'width' || propName === 'height') {
      // Handle chart size. Faceted spec ({facet, spec}) keeps the real per-cell
      // size in the inner unit spec; the outer value is a derived total.
      if (updatedSpec.facet && updatedSpec.spec) {
        updatedSpec.spec[propName] = value
        delete updatedSpec[propName]
      } else {
        updatedSpec[propName] = value
      }
      specUpdated = true
    }

    if (specUpdated) {
      setChartObjects(prev => {
        let result = prev.map(c =>
          c.id === elementChartId
            ? {
                ...c,
                spec: updatedSpec,
                ...(( propName === 'width' || propName === 'height') && (() => {
                  const bs = JSON.parse(JSON.stringify(c.baseSpec || c.spec))
                  if (bs.facet && bs.spec) { bs.spec[propName] = value; delete bs[propName] }
                  else bs[propName] = value
                  return { baseSpec: bs }
                })())
              }
            : c
        )
        return result
      })
    }

    // Update selected element properties to reflect change
    setSelectedElement(prev => {
      return {
        ...prev,
        properties: { ...prev.properties, [propName]: value }
      }
    })
  }

  // Helper: get modification identity key (element + property + scope)
  // Extract stable element identity from selector (aria-label part is stable across re-renders)
  const normalizeSelector = (selector) => {
    if (!selector) return ''
    const ariaMatch = selector.match(/\[aria-label="([^"]+)"\]/)
    return ariaMatch ? ariaMatch[1] : selector
  }

  const getModificationKey = (mod) => {
    // Element identity: which mark group or element type this targets
    const elementId = mod.compositeMarkType && mod.compositeSubPart
      ? `${mod.compositeMarkType}:${mod.compositeSubPart}`
      : mod.markGroup || mod.targetType || 'unknown'

    const normalizedSelector = normalizeSelector(mod.selector)

    const scopeId = (() => {
      const s = mod.scope
      if (!s) return 'all-marks'
      if (s.type === 'this-only') return `this::${normalizedSelector}`
      if (s.type === 'by-field') return `field::${s.field}::${s.fieldValue}`
      if (s.type === 'composite-sub-all') return `composite::${s.compositeMarkType}::${s.compositeSubPart}`
      if (s.type === 'same-type-in-axis') return `axis::${s.axisChannel}::${s.axisSubType}`
      if (s.type === 'same-type-all-axes') return `all-axes::${s.axisSubType}`
      if (s.type === 'all-in-axis') return `axis::${s.axisChannel}`
      if (s.type === 'all-axes') return 'all-axes'
      if (s.type === 'legend-with-data') return `legend::${s.legendField}::${s.legendValue}`
      if (s.type === 'legend-item-only') return 'legend-item'
      if (s.type === 'all-legend-symbols') return 'all-legend-symbols'
      if (s.type === 'all-legend-labels') return 'all-legend-labels'
      if (s.type === 'legend-title') return 'legend-title'
      if (s.type === 'all-in-legend') return 'all-legend'
      if (s.type === 'all-text') return 'all-text'
      if (s.type === 'scale-modify') return `scale::${s.channel}`
      if (s.type === 'condition-match') return `cond-match::${s.channel}::${s.conditionIndex}`
      if (s.type === 'condition-default') return `cond-default::${s.channel}`
      return s.type || 'all-marks'
    })()

    // Use normalized selector so different CSS paths to the same element match
    return `${elementId}::${mod.property}::${scopeId}::${normalizedSelector}`
  }

  // Helper: rebuild svgOverrides cleanly from base + modification output
  const rebuildSvgOverrides = (baseSvgOverrides, modSvgOverrides) => {
    return { ...(baseSvgOverrides || {}), ...modSvgOverrides }
  }

  // Handle grouped multi-element modification: creates a single entry with group[] field
  const handleGroupedModificationPropertyChange = (chartId, propName, value, groupElements) => {
    setChartObjects(prev => {
      let result = prev.map(chart => {
      if (chart.id !== chartId) return chart

      const modifications = [...(chart.modifications || [])]
      let baseSpec = chart.baseSpec || JSON.parse(JSON.stringify(chart.spec))
      if (!chart.baseSpec) {
        const currentSpec = chart.spec
        for (const ch of ['color', 'fill']) {
          const enc = currentSpec?.encoding?.[ch]
          if (enc?.scale?.domain && enc?.scale?.range) {
            if (!baseSpec.encoding) baseSpec.encoding = {}
            if (!baseSpec.encoding[ch]) baseSpec.encoding[ch] = { ...enc }
            else {
              if (!baseSpec.encoding[ch].scale) baseSpec.encoding[ch].scale = {}
              baseSpec.encoding[ch].scale.domain = [...enc.scale.domain]
              baseSpec.encoding[ch].scale.range = [...enc.scale.range]
              if (baseSpec.encoding[ch].scale.scheme) delete baseSpec.encoding[ch].scale.scheme
            }
          }
        }
      }
      const baseSvgOverrides = chart.baseSvgOverrides ?? JSON.parse(JSON.stringify(chart.svgOverrides || {}))

      // Build per-element group items with individual scopes
      const markGroupToLabel = {
        'mark-area': 'AREA', 'mark-line': 'LINE', 'mark-rect': 'BAR',
        'mark-symbol': 'POINT', 'mark-text': 'TEXT', 'mark-arc': 'ARC', 'mark-rule': 'RULE'
      }

      // --- Scope-based optimization ---
      // If all elements share a scope-level type from scopeHierarchy (same-mark-type, all-marks, field-value),
      // create ONE efficient modification instead of N individual this-only modifications.
      const firstEl = groupElements[0]
      const sharedScopeType = firstEl?._scopeType
      const sharedScopeData = firstEl?._scopeData
      const allShareScope = sharedScopeType &&
        sharedScopeType !== 'individual' &&
        sharedScopeType !== 'explicit' &&
        groupElements.every(el => el._scopeType === sharedScopeType)

      // --- Legend scope-based optimization ---
      // Map legend scopeHierarchy types to unified modification scopes
      if (allShareScope && firstEl.semanticRole === 'legend') {
        let unifiedScope
        if (sharedScopeType === 'entire-legend') {
          unifiedScope = { type: 'all-in-legend' }
        } else if (sharedScopeType === 'all-legend-labels') {
          unifiedScope = { type: 'all-legend-labels' }
        } else if (sharedScopeType === 'all-legend-symbols') {
          unifiedScope = { type: 'all-legend-symbols' }
        } else if (sharedScopeType === 'field-value' && sharedScopeData?.field != null) {
          unifiedScope = { type: 'legend-with-data', legendField: sharedScopeData.field, legendValue: sharedScopeData.value }
        } else {
          unifiedScope = null // fall through to grouped modification path
        }

        if (unifiedScope) {
          const representativeEl = firstEl
          const targetType = sharedScopeType === 'entire-legend' ? 'LEGEND (전체)'
            : sharedScopeType === 'all-legend-labels' ? 'LEGEND (라벨)'
            : sharedScopeType === 'all-legend-symbols' ? 'LEGEND (심볼)'
            : sharedScopeType === 'field-value' ? `LEGEND (${sharedScopeData?.field}=${sharedScopeData?.value})`
            : 'LEGEND'

          const existingIdx = modifications.findIndex(m =>
            !m.group && m.property === propName && m.targetType === targetType &&
            m.scope?.type === unifiedScope.type
          )

          if (existingIdx >= 0) {
            modifications[existingIdx] = {
              ...modifications[existingIdx],
              value,
              scope: unifiedScope,
              fromScopeSelection: true,
            }
          } else {
            const newMod = {
              id: `mod-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              property: propName,
              value,
              originalValue: representativeEl.properties?.[propName] ?? null,
              scope: unifiedScope,
              selector: null,
              datum: null,
              targetType,
              markGroup: null,
              semanticRole: 'legend',
              axisChannel: null,
              axisSubType: null,
              legendField: unifiedScope.legendField || representativeEl.legendField || null,
              legendValue: unifiedScope.legendValue ?? representativeEl.legendValue ?? null,
              legendSubType: null,
              compositeMarkType: null,
              compositeSubPart: null,
              layerIndex: null,
              isAnnotation: false,
              layerContext: null,
              layerClassification: null,
              modStrategy: null,
              batchId: null,
              group: null,
              fromScopeSelection: true,
              bindingIntegrity: 'config-level',
              timestamp: Date.now()
            }
            modifications.push(newMod)
          }

          const { spec: newSpec, svgOverrides: modOverrides } = applyModificationsToSpec(baseSpec, modifications)
          const finalOverrides = rebuildSvgOverrides(baseSvgOverrides, modOverrides)
          return { ...chart, modifications, baseSpec, baseSvgOverrides, spec: newSpec, svgOverrides: finalOverrides }
        }
      }
      // --- End legend scope-based optimization ---

      if (allShareScope && firstEl.semanticRole === 'data-mark') {
        // Map scopeHierarchy scopeType → modification scope.type
        let unifiedScope
        if (sharedScopeType === 'composite-sub-all') {
          unifiedScope = {
            type: 'composite-sub-all',
            compositeMarkType: sharedScopeData?.compositeMarkType || firstEl.compositeMarkType,
            compositeSubPart: sharedScopeData?.compositeSubPart || firstEl.compositeSubPart,
          }
        } else if (sharedScopeType === 'same-mark-type' || sharedScopeType === 'all-marks') {
          unifiedScope = { type: 'all-marks' }
        } else if (sharedScopeType === 'field-value' && sharedScopeData?.field != null) {
          unifiedScope = { type: 'by-field', field: sharedScopeData.field, fieldValue: sharedScopeData.value }
        } else if (sharedScopeType === 'condition-match' && sharedScopeData?.channel != null) {
          unifiedScope = { type: 'condition-match', channel: sharedScopeData.channel, conditionIndex: sharedScopeData.conditionIndex }
        } else if (sharedScopeType === 'condition-default' && sharedScopeData?.channel != null) {
          unifiedScope = { type: 'condition-default', channel: sharedScopeData.channel }
        } else {
          unifiedScope = { type: 'all-marks' }
        }

        const representativeEl = firstEl
        const markGroup = representativeEl.markGroup || null
        const layerIndex = representativeEl.layerIndex ?? null
        const semanticRole = representativeEl.semanticRole || 'data-mark'
        const markGroups = [...new Set(groupElements.map(el => el.markGroup).filter(Boolean))]
        const markGroupLabel = markGroups.length === 1 ? (markGroupToLabel[markGroups[0]] || 'MARK') : 'MARK'
        const scopeLabel = sharedScopeType === 'all-marks' ? 'ALL' :
          sharedScopeType === 'composite-sub-all' ? `ALL ${(unifiedScope.compositeSubPart || 'PART').toUpperCase()}` :
          sharedScopeType === 'same-mark-type' ? (sharedScopeData?.markType?.toUpperCase() || 'MARK') :
          sharedScopeType === 'field-value' ? `${sharedScopeData?.field}=${sharedScopeData?.value}` : 'SCOPE'
        const targetType = sharedScopeType === 'composite-sub-all'
          ? `${(unifiedScope.compositeMarkType || 'MARK').toUpperCase()} (${scopeLabel})`
          : `${markGroupLabel} (${scopeLabel})`

        const existingIdx = modifications.findIndex(m =>
          !m.group && m.property === propName && m.targetType === targetType &&
          m.scope?.type === unifiedScope.type
        )

        if (existingIdx >= 0) {
          modifications[existingIdx] = {
            ...modifications[existingIdx],
            value,
            scope: unifiedScope,
            markGroup: sharedScopeType === 'all-marks' ? null : markGroup,
            layerIndex,
            fromScopeSelection: true,
          }
        } else {
          const newMod = {
            id: `mod-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            property: propName,
            value,
            originalValue: representativeEl.properties?.[propName] ?? null,
            scope: unifiedScope,
            selector: null,
            datum: null,
            targetType,
            markGroup: sharedScopeType === 'all-marks' ? null : markGroup,
            semanticRole,
            axisChannel: null,
            axisSubType: null,
            legendField: unifiedScope.type === 'by-field' ? unifiedScope.field : null,
            legendValue: unifiedScope.type === 'by-field' ? unifiedScope.fieldValue : null,
            legendSubType: null,
            compositeMarkType: representativeEl.compositeMarkType || null,
            compositeSubPart: representativeEl.compositeSubPart || null,
            layerIndex,
            isAnnotation: false,
            layerContext: null,
            layerClassification: null,
            modStrategy: null,
            batchId: null,
            group: null,
            fromScopeSelection: true,
            bindingIntegrity: 'binding-overridden',
            timestamp: Date.now()
          }
          modifications.push(newMod)
        }

        const { spec: newSpec, svgOverrides: modOverrides } = applyModificationsToSpec(baseSpec, modifications)
        const finalOverrides = rebuildSvgOverrides(baseSvgOverrides, modOverrides)
        return { ...chart, modifications, baseSpec, baseSvgOverrides, spec: newSpec, svgOverrides: finalOverrides }
      }
      // --- End scope-based optimization ---

      const group = groupElements.map(el => {
        const semanticRole = el.semanticRole || 'data-mark'
        let scope = { type: 'this-only' }
        // For axis elements, use axis-specific scope
        if (semanticRole === 'axis') {
          const axisChannel = el.axisChannel || 'x'
          scope = el.axisSubType
            ? { type: 'same-type-in-axis', axisChannel, axisSubType: el.axisSubType }
            : { type: 'all-in-axis', axisChannel }
        } else if (semanticRole === 'legend') {
          if (el.legendSubType === 'label') scope = { type: 'all-legend-labels' }
          else if (el.legendSubType === 'title') scope = { type: 'legend-title' }
          else if (el.legendField && el.legendValue != null) scope = { type: 'legend-with-data', legendField: el.legendField, legendValue: el.legendValue }
          else scope = { type: 'legend-item-only' }
        }
        return {
          selector: el.selector || null,
          datum: el.datum || null,
          scope,
          originalValue: el.properties?.[propName] ?? null,
          semanticRole,
          markGroup: el.markGroup || null,
          axisChannel: el.axisChannel || null,
          axisSubType: el.axisSubType || null,
          legendField: el.legendField || null,
          legendValue: el.legendValue || null,
          legendSubType: el.legendSubType || null,
          compositeMarkType: el.compositeMarkType || null,
          compositeSubPart: el.compositeSubPart || null,
          layerIndex: el.layerIndex ?? null,
        }
      })

      // Derive summary label
      const roles = [...new Set(group.map(g => g.semanticRole))]
      let targetType
      if (roles.length === 1) {
        const role = roles[0]
        if (role === 'axis') {
          const channels = [...new Set(group.map(g => g.axisChannel).filter(Boolean))]
          targetType = channels.length === 1 ? `${channels[0].toUpperCase()}-AXIS Group` : 'AXIS Group'
        } else if (role === 'legend') {
          targetType = 'LEGEND Group'
        } else {
          // data-mark: use markGroup label
          const markGroups = [...new Set(group.map(g => g.markGroup).filter(Boolean))]
          const label = markGroups.length === 1 ? (markGroupToLabel[markGroups[0]] || 'MARK') : 'MARK'
          targetType = `${label} Group (${group.length})`
        }
      } else {
        targetType = `Mixed Selection (${group.length})`
      }

      // Check if an existing grouped modification with same property+targetType exists
      const existingIdx = modifications.findIndex(m =>
        m.group && m.property === propName && m.targetType === targetType
      )

      if (existingIdx >= 0) {
        modifications[existingIdx] = { ...modifications[existingIdx], value, group }
      } else {
        const newMod = {
          id: `mod-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          property: propName,
          value,
          originalValue: null,
          scope: { type: 'group' },
          selector: null,
          datum: null,
          targetType,
          markGroup: group[0]?.markGroup || null,
          semanticRole: roles.length === 1 ? roles[0] : 'mixed',
          axisChannel: null,
          axisSubType: null,
          legendField: null,
          legendValue: null,
          legendSubType: null,
          compositeMarkType: null,
          compositeSubPart: null,
          layerIndex: null,
          isAnnotation: false,
          layerContext: null,
          layerClassification: null,
          modStrategy: null,
          batchId: null,
          group,
          bindingIntegrity: 'binding-overridden',
          timestamp: Date.now()
        }
        modifications.push(newMod)
      }

      const { spec: newSpec, svgOverrides: modOverrides } = applyModificationsToSpec(baseSpec, modifications)
      const finalOverrides = rebuildSvgOverrides(baseSvgOverrides, modOverrides)

      return { ...chart, modifications, baseSpec, baseSvgOverrides, spec: newSpec, svgOverrides: finalOverrides }
    })
      return result
    })
  }

  // Handle modification-based property change for mark/axis/legend/text elements
  // overrides: optional { batchId, selector, datum, semanticRole, markGroup, ... } for batch multi-select
  const handleModificationPropertyChange = (chartId, elementPath, propName, value, overrides) => {
    const effectiveDbg = overrides || selectedElement || {}
    setChartObjects(prev => {
      // Capture the source chart's before/after spec so the same visual delta can
      // cascade to descendants (same mechanism as encoding / chart-property edits).
      let srcOldSpec = null
      let srcNewSpec = null
      let srcOldSvg = null
      let srcNewSvg = null
      let result = prev.map(chart => {
      if (chart.id !== chartId) return chart
      srcOldSpec = chart.spec
      srcOldSvg = chart.svgOverrides || {}

      const modifications = [...(chart.modifications || [])]
      let baseSpec = chart.baseSpec || JSON.parse(JSON.stringify(chart.spec))
      if (!chart.baseSpec) {
        const currentSpec = chart.spec
        for (const ch of ['color', 'fill']) {
          const enc = currentSpec?.encoding?.[ch]
          if (enc?.scale?.domain && enc?.scale?.range) {
            if (!baseSpec.encoding) baseSpec.encoding = {}
            if (!baseSpec.encoding[ch]) baseSpec.encoding[ch] = { ...enc }
            else {
              if (!baseSpec.encoding[ch].scale) baseSpec.encoding[ch].scale = {}
              baseSpec.encoding[ch].scale.domain = [...enc.scale.domain]
              baseSpec.encoding[ch].scale.range = [...enc.scale.range]
              if (baseSpec.encoding[ch].scale.scheme) delete baseSpec.encoding[ch].scale.scheme
            }
          }
        }
      }
      const baseSvgOverrides = chart.baseSvgOverrides ?? JSON.parse(JSON.stringify(chart.svgOverrides || {}))

      // Use overrides for batch multi-select, or selectedElement for single
      const effectiveEl = overrides || selectedElement || {}
      const semanticRole = effectiveEl.semanticRole || 'data-mark'

      // Determine default scope based on semantic role
      const compositeMarkType = effectiveEl.compositeMarkType || null
      const compositeSubPart = effectiveEl.compositeSubPart || null


      // Default scope: always this-only for individual element edits.
      // Users can expand scope via Tab cycling before editing.
      let defaultScope = { type: 'this-only' }

      // Build element identity fields for key computation
      const markGroup = effectiveEl.markGroup || null
      const markGroupToLabel = {
        'mark-area': 'AREA', 'mark-line': 'LINE', 'mark-rect': 'BAR',
        'mark-symbol': 'POINT', 'mark-text': 'TEXT', 'mark-arc': 'ARC', 'mark-rule': 'RULE'
      }
      let targetType
      if (effectiveEl.isAnnotation) {
        const lc = effectiveEl.layerContext
        const elType = effectiveEl.type || 'mark'
        if (lc?.layerType === 'highlight-mark') {
          const highlightLabels = { rect: 'HIGHLIGHT RECT', rule: 'HIGHLIGHT RULE', text: 'HIGHLIGHT TEXT' }
          targetType = highlightLabels[elType] || `HIGHLIGHT ${elType.toUpperCase()}`
        } else {
          const markTypeLabels = { rect: 'BG RECT', rule: 'REF LINE', text: 'TEXT LABEL' }
          targetType = markTypeLabels[elType] || `ANNOTATION ${elType.toUpperCase()}`
        }
      } else if (compositeMarkType && compositeSubPart) {
        const compositeSubPartLabels = {
          box: 'BOX', median: 'MEDIAN', rule: 'WHISKER',
          outliers: 'OUTLIER', ticks: 'END CAP',
          band: 'BAND', borders: 'BORDER',
        }
        targetType = compositeSubPartLabels[compositeSubPart] || compositeSubPart.toUpperCase()
      } else if (semanticRole === 'axis') {
        const sub = effectiveEl.axisSubType
        targetType = sub ? `${(effectiveEl.axisChannel || 'x').toUpperCase()}-AXIS ${sub.toUpperCase()}` : `${(effectiveEl.axisChannel || 'x').toUpperCase()}-AXIS`
      } else if (semanticRole === 'legend') {
        const legendSubLabels = { symbol: 'LEGEND SYMBOL', label: 'LEGEND LABEL', title: 'LEGEND TITLE' }
        targetType = legendSubLabels[effectiveEl.legendSubType] || 'LEGEND'
      } else if (semanticRole === 'text') {
        targetType = 'TEXT'
      } else {
        targetType = markGroup
          ? (markGroupToLabel[markGroup] || markGroup)
          : ({ rect: 'BAR', path: 'AREA', circle: 'POINT', line: 'LINE', mark: 'MARK' }[effectiveEl.type] || 'MARK')
      }


      // Build a key for the new modification (includes element identity + selector)
      const selector = effectiveEl.selector || null
      const newKey = getModificationKey({
        property: propName,
        scope: defaultScope,
        markGroup,
        targetType,
        compositeMarkType,
        compositeSubPart,
        selector,
      })
      const existingIdx = modifications.findIndex(m => getModificationKey(m) === newKey)
      console.log('[MOD]', existingIdx >= 0 ? 'UPDATE' : 'NEW', newKey, 'total:', modifications.length)

      if (existingIdx >= 0) {
        modifications[existingIdx] = { ...modifications[existingIdx], value }
      } else {
        // Determine encoding channel from property for binding integrity detection
        const propToChannelMap = { fill: 'fill', color: 'color', stroke: 'stroke', opacity: 'opacity', size: 'size', strokeWidth: 'strokeWidth', shape: 'shape' }
        const modChannel = propToChannelMap[propName] || null
        const integrityMod = { channel: modChannel, layerIndex: effectiveEl.layerIndex ?? null, scope: defaultScope }
        const dataForIntegrity = baseSpec?.data?.values || []
        const isAnnotationOrHighlight = effectiveEl.layerContext
          ? effectiveEl.layerContext.layerType !== 'data-mark'
          : effectiveEl.isAnnotation
        const bindingIntegrity = isAnnotationOrHighlight
          ? 'new-annotation'
          : detectBindingIntegrity(baseSpec, integrityMod, dataForIntegrity)

        const newMod = {
          id: `mod-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          property: propName,
          value,
          originalValue: effectiveEl.properties?.[propName] ?? null,
          scope: defaultScope,
          selector: effectiveEl.selector || null,
          datum: effectiveEl.datum || null,
          targetType,
          markGroup,
          semanticRole,
          axisChannel: effectiveEl.axisChannel || null,
          axisSubType: effectiveEl.axisSubType || null,
          legendField: effectiveEl.legendField || null,
          legendValue: effectiveEl.legendValue || null,
          legendSubType: effectiveEl.legendSubType || null,
          compositeMarkType,
          compositeSubPart,
          layerIndex: effectiveEl.layerIndex ?? null,
          isAnnotation: effectiveEl.isAnnotation || false,
          layerContext: effectiveEl.layerContext || null,
          layerClassification: effectiveEl.layerClassification || null,
          modStrategy: effectiveEl.layerClassification?.modStrategy || null,
          batchId: overrides?.batchId || null,
          bindingIntegrity,
          timestamp: Date.now()
        }
        modifications.push(newMod)
      }

      const { spec: newSpec, svgOverrides: modOverrides } = applyModificationsToSpec(baseSpec, modifications)
      const finalOverrides = rebuildSvgOverrides(baseSvgOverrides, modOverrides)
      srcNewSpec = newSpec
      srcNewSvg = finalOverrides

      return { ...chart, modifications, baseSpec, baseSvgOverrides, spec: newSpec, svgOverrides: finalOverrides }
    })

      // ── Propagate this element edit to descendant charts ──
      // An element edit lands either in the spec (mark/encoding/conditional) or as a
      // selector-keyed SVG override. Descendants are derived from this chart, so they
      // share its structure & data — the same spec path and the same selector both
      // target the matching element. Propagate BOTH deltas. Skip spec paths a
      // descendant controls via its own widget panel (widgets stay local overrides).
      if (srcOldSpec && srcNewSpec) {
        const changes = diffSpecPaths(srcOldSpec, srcNewSpec)

        // Shallow per-selector/per-prop delta of the SVG overrides.
        const svgDelta = {}
        for (const sel of Object.keys(srcNewSvg || {})) {
          const oldProps = (srcOldSvg && srcOldSvg[sel]) || {}
          const newProps = srcNewSvg[sel] || {}
          for (const p of Object.keys(newProps)) {
            if (JSON.stringify(oldProps[p]) !== JSON.stringify(newProps[p])) {
              if (!svgDelta[sel]) svgDelta[sel] = {}
              svgDelta[sel][p] = newProps[p]
            }
          }
        }
        const svgDeltaSelectors = Object.keys(svgDelta)

        console.log('[MOD propagate] specChanges:', changes.length, '| svgDelta selectors:', svgDeltaSelectors.length)

        if (changes.length > 0 || svgDeltaSelectors.length > 0) {
          const descendantIds = collectDescendantIds(prev, chartId)
          console.log('[MOD propagate] descendants:', Array.from(descendantIds))
          if (descendantIds.size > 0) {
            result = result.map(chart => {
              if (!descendantIds.has(chart.id)) return chart

              // Spec delta (skip widget-controlled paths)
              const widgetPaths = (chart.widgetOptions || []).map(o => o.path).filter(Boolean)
              const ops = widgetPaths.length
                ? changes.filter(ch => !isUnderAnyPath(pathArrToString(ch.path), widgetPaths))
                : changes

              // SVG-override delta (merge onto the child's own overrides)
              let nextSvg = chart.svgOverrides
              if (svgDeltaSelectors.length > 0) {
                nextSvg = { ...(chart.svgOverrides || {}) }
                for (const sel of svgDeltaSelectors) {
                  nextSvg[sel] = { ...(nextSvg[sel] || {}), ...svgDelta[sel] }
                }
              }

              if (ops.length === 0 && nextSvg === chart.svgOverrides) return chart

              const upd = { ...chart, svgOverrides: nextSvg }
              if (ops.length > 0) {
                upd.spec = applyPropagatedOps(chart.spec, ops)
                if (chart.baseSpec) upd.baseSpec = applyPropagatedOps(chart.baseSpec, ops)
              }
              return upd
            })
          }
        }
      }

      return result
    })
  }

  // Handle updating an existing modification's value (editing mode)
  const handleModificationValueUpdate = (chartId, modId, propName, value) => {
    if (readOnly) return
    setChartObjects(prev => {
      let srcOldSpec = null, srcNewSpec = null, srcOldSvg = null, srcNewSvg = null
      let result = prev.map(chart => {
        if (chart.id !== chartId) return chart
        srcOldSpec = chart.spec
        srcOldSvg = chart.svgOverrides || {}

        const modifications = (chart.modifications || []).map(mod =>
          mod.id === modId ? { ...mod, property: propName, value } : mod
        )
        const baseSpec = chart.baseSpec || JSON.parse(JSON.stringify(chart.spec))
        const baseSvgOverrides = chart.baseSvgOverrides ?? JSON.parse(JSON.stringify(chart.svgOverrides || {}))

        const { spec: newSpec, svgOverrides: modOverrides } = applyModificationsToSpec(baseSpec, modifications)
        const finalOverrides = rebuildSvgOverrides(baseSvgOverrides, modOverrides)
        srcNewSpec = newSpec
        srcNewSvg = finalOverrides

        return { ...chart, modifications, spec: newSpec, svgOverrides: finalOverrides }
      })

      // Re-editing a modification's value must cascade to descendants too (same as
      // the initial edit). Propagate the spec delta + SVG-override delta.
      if (srcOldSpec && srcNewSpec) {
        const changes = diffSpecPaths(srcOldSpec, srcNewSpec)
        const svgDelta = {}
        for (const sel of Object.keys(srcNewSvg || {})) {
          const oldProps = (srcOldSvg && srcOldSvg[sel]) || {}
          const newProps = srcNewSvg[sel] || {}
          for (const p of Object.keys(newProps)) {
            if (JSON.stringify(oldProps[p]) !== JSON.stringify(newProps[p])) {
              if (!svgDelta[sel]) svgDelta[sel] = {}
              svgDelta[sel][p] = newProps[p]
            }
          }
        }
        const svgDeltaSelectors = Object.keys(svgDelta)
        if (changes.length > 0 || svgDeltaSelectors.length > 0) {
          const descendantIds = collectDescendantIds(prev, chartId)
          if (descendantIds.size > 0) {
            result = result.map(chart => {
              if (!descendantIds.has(chart.id)) return chart
              const widgetPaths = (chart.widgetOptions || []).map(o => o.path).filter(Boolean)
              const ops = widgetPaths.length
                ? changes.filter(ch => !isUnderAnyPath(pathArrToString(ch.path), widgetPaths))
                : changes
              let nextSvg = chart.svgOverrides
              if (svgDeltaSelectors.length > 0) {
                nextSvg = { ...(chart.svgOverrides || {}) }
                for (const sel of svgDeltaSelectors) nextSvg[sel] = { ...(nextSvg[sel] || {}), ...svgDelta[sel] }
              }
              if (ops.length === 0 && nextSvg === chart.svgOverrides) return chart
              const upd = { ...chart, svgOverrides: nextSvg }
              if (ops.length > 0) {
                upd.spec = applyPropagatedOps(chart.spec, ops)
                if (chart.baseSpec) upd.baseSpec = applyPropagatedOps(chart.baseSpec, ops)
              }
              return upd
            })
          }
        }
      }

      return result
    })
  }

  // Handle scope change for a modification
  const handleScopeChange = useCallback((chartId, modId, newScope) => {
    if (readOnly) return
    setChartObjects(prev => {
      let srcOldSpec = null, srcNewSpec = null, srcOldSvg = null, srcNewSvg = null
      let result = prev.map(chart => {
        if (chart.id !== chartId) return chart
        srcOldSpec = chart.spec
        srcOldSvg = chart.svgOverrides || {}

        const baseSpec = chart.baseSpec || JSON.parse(JSON.stringify(chart.spec))
        const baseSvgOverrides = chart.baseSvgOverrides ?? JSON.parse(JSON.stringify(chart.svgOverrides || {}))

        const modifications = (chart.modifications || []).map(mod => {
          if (mod.id !== modId) return mod
          const propToChannelMap = { fill: 'fill', color: 'color', stroke: 'stroke', opacity: 'opacity', size: 'size', strokeWidth: 'strokeWidth', shape: 'shape' }
          const modChannel = propToChannelMap[mod.property] || null
          const integrityMod = { channel: modChannel, layerIndex: null, scope: newScope }
          const dataForIntegrity = baseSpec?.data?.values || []
          const bindingIntegrity = detectBindingIntegrity(baseSpec, integrityMod, dataForIntegrity)
          return { ...mod, scope: newScope, bindingIntegrity }
        })

        const { spec: newSpec, svgOverrides: modOverrides } = applyModificationsToSpec(baseSpec, modifications)
        const finalOverrides = rebuildSvgOverrides(baseSvgOverrides, modOverrides)
        srcNewSpec = newSpec
        srcNewSvg = finalOverrides

        return { ...chart, modifications, baseSpec, baseSvgOverrides, spec: newSpec, svgOverrides: finalOverrides }
      })
      result = propagateDeltaToDescendants(result, prev, chartId, srcOldSpec, srcNewSpec, srcOldSvg, srcNewSvg)
      return result
    })
  }, [])

  // Handle deletion of a modification
  const handleDeleteModification = useCallback((chartId, modId) => {
    if (readOnly) return
    setChartObjects(prev => {
      let srcOldSpec = null, srcNewSpec = null, srcOldSvg = null, srcNewSvg = null
      let result = prev.map(chart => {
        if (chart.id !== chartId) return chart
        srcOldSpec = chart.spec
        srcOldSvg = chart.svgOverrides || {}

        const modifications = (chart.modifications || []).filter(m => m.id !== modId)
        const baseSpec = chart.baseSpec || JSON.parse(JSON.stringify(chart.spec))
        const baseSvgOverrides = chart.baseSvgOverrides ?? {}

        if (modifications.length === 0) {
          srcNewSpec = JSON.parse(JSON.stringify(baseSpec))
          srcNewSvg = JSON.parse(JSON.stringify(baseSvgOverrides))
          return {
            ...chart,
            modifications: [],
            spec: srcNewSpec,
            baseSpec: null,
            svgOverrides: srcNewSvg,
            baseSvgOverrides: null
          }
        }

        const { spec: newSpec, svgOverrides: modOverrides } = applyModificationsToSpec(baseSpec, modifications)
        const finalOverrides = rebuildSvgOverrides(baseSvgOverrides, modOverrides)
        srcNewSpec = newSpec
        srcNewSvg = finalOverrides

        return { ...chart, modifications, spec: newSpec, svgOverrides: finalOverrides }
      })

      // Removing a modification must also un-apply it on descendants. Propagate the
      // reverting spec delta + SVG-override delta (additions AND removals).
      if (srcOldSpec && srcNewSpec) {
        const changes = diffSpecPaths(srcOldSpec, srcNewSpec)
        // Per-selector/prop delta, including props removed in the new overrides.
        const svgDelta = {}
        const allSelectors = new Set([...Object.keys(srcOldSvg || {}), ...Object.keys(srcNewSvg || {})])
        for (const sel of allSelectors) {
          const oldProps = (srcOldSvg && srcOldSvg[sel]) || {}
          const newProps = (srcNewSvg && srcNewSvg[sel]) || {}
          for (const p of new Set([...Object.keys(oldProps), ...Object.keys(newProps)])) {
            if (JSON.stringify(oldProps[p]) !== JSON.stringify(newProps[p])) {
              if (!svgDelta[sel]) svgDelta[sel] = {}
              svgDelta[sel][p] = newProps[p]  // may be undefined → clears the override
            }
          }
        }
        const svgDeltaSelectors = Object.keys(svgDelta)
        if (changes.length > 0 || svgDeltaSelectors.length > 0) {
          const descendantIds = collectDescendantIds(prev, chartId)
          if (descendantIds.size > 0) {
            result = result.map(chart => {
              if (!descendantIds.has(chart.id)) return chart
              const widgetPaths = (chart.widgetOptions || []).map(o => o.path).filter(Boolean)
              const ops = widgetPaths.length
                ? changes.filter(ch => !isUnderAnyPath(pathArrToString(ch.path), widgetPaths))
                : changes
              let nextSvg = chart.svgOverrides
              if (svgDeltaSelectors.length > 0) {
                nextSvg = { ...(chart.svgOverrides || {}) }
                for (const sel of svgDeltaSelectors) {
                  nextSvg[sel] = { ...(nextSvg[sel] || {}) }
                  for (const [p, v] of Object.entries(svgDelta[sel])) {
                    if (v === undefined) delete nextSvg[sel][p]
                    else nextSvg[sel][p] = v
                  }
                }
              }
              if (ops.length === 0 && nextSvg === chart.svgOverrides) return chart
              const upd = { ...chart, svgOverrides: nextSvg }
              if (ops.length > 0) {
                upd.spec = applyPropagatedOps(chart.spec, ops)
                if (chart.baseSpec) upd.baseSpec = applyPropagatedOps(chart.baseSpec, ops)
              }
              return upd
            })
          }
        }
      }

      return result
    })
  }, [])

  // Handle modification click — highlight matching elements on canvas
  const handleModificationClick = useCallback((chartId, mod) => {
    setActiveModificationId(mod.id)
    setElementChartId(chartId)

    // Find matching elements on the chart's SVG and highlight them
    const container = document.getElementById(`vega-chart-${chartId}`)
    const svg = container?.querySelector('svg')
    if (!svg) return

    // Get all visual mark elements
    const markElements = svg.querySelectorAll('rect, path, circle, line')

    // Clear previous mod-selected highlights
    markElements.forEach(el => el.classList.remove('mod-selected'))
    svg.classList.remove('has-mod-selection')

    // Apply highlight based on scope
    if (mod.scope.type === 'all') {
      // Highlight all mark elements (skip background rects)
      markElements.forEach(el => {
        const w = parseFloat(el.getAttribute('width') || 0)
        const h = parseFloat(el.getAttribute('height') || 0)
        const elClass = el.className?.baseVal || ''
        if (elClass === 'background' || elClass === 'foreground') return
        if (el.tagName === 'rect' && w > 350 && h > 200) return
        el.classList.add('mod-selected')
      })
      svg.classList.add('has-mod-selection')
    } else if (mod.scope.type === 'by-field' && mod.datum) {
      // Highlight elements matching the field condition
      const field = mod.scope.field
      const fieldValue = mod.scope.fieldValue ?? mod.datum[field]
      markElements.forEach(el => {
        const elDatum = el.__data__?.datum
        if (elDatum && elDatum[field] === fieldValue) {
          el.classList.add('mod-selected')
        }
      })
      svg.classList.add('has-mod-selection')
    } else if (mod.scope.type === 'this-only') {
      // Highlight the specific element — prefer datum matching for data marks,
      // fall back to CSS selector
      if (mod.semanticRole === 'data-mark' && mod.datum) {
        markElements.forEach(el => {
          const elDatum = el.__data__?.datum
          if (!elDatum) return
          // Match all non-internal fields from the stored datum
          const matches = Object.entries(mod.datum).every(([k, v]) => {
            if (k.startsWith('_') || v == null) return true
            return elDatum[k] === v
          })
          if (matches) el.classList.add('mod-selected')
        })
        svg.classList.add('has-mod-selection')
      } else if (mod.selector) {
        try {
          const el = svg.querySelector(mod.selector)
          if (el) el.classList.add('mod-selected')
          svg.classList.add('has-mod-selection')
        } catch (e) { /* invalid selector */ }
      }
    }

    // Restore full selectedElement from modification's stored info
    setSelectedElement({
      type: mod.semanticRole === 'axis' ? `axis-${mod.axisChannel || 'x'}` :
            mod.semanticRole === 'legend' ? 'legend' :
            mod.semanticRole === 'text' ? 'text' :
            (mod.markGroup || 'mark'),
      elementPath: mod.semanticRole === 'axis' ? `encoding.${mod.axisChannel || 'x'}.axis` :
                   mod.markGroup || 'mark',
      datum: mod.datum || null,
      selector: mod.selector || null,
      properties: { [mod.property]: mod.value },
      semanticRole: mod.semanticRole || 'data-mark',
      markGroup: mod.markGroup || null,
      compositeMarkType: mod.compositeMarkType || null,
      compositeSubPart: mod.compositeSubPart || null,
      axisChannel: mod.axisChannel || null,
      axisSubType: mod.axisSubType || null,
      legendField: mod.legendField || null,
      legendValue: mod.legendValue || null,
    })
  }, [])

  // Process NL command with OpenAI
  const handleNLSubmit = async (e) => {
    e.preventDefault()
    if (!nlInput.trim() || !selectedChart || isProcessing) return
    if (IS_STATIC_DEMO && !hasApiBase()) { setApiKeyOpen(true); showToast('Connect a backend (enter its URL) to use AI features'); return }

    setIsProcessing(true)

    try {
      const response = await fetch(apiUrl('/api/modify-chart'), {
        method: 'POST',
        headers: withApiKey({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          currentSpec: selectedChart.spec,
          command: nlInput
        })
      })

      if (response.status === 401) { setIsProcessing(false); setApiKeyOpen(true); showToast('Invalid or missing API key'); return }

      const text = await response.text()
      if (!text) {
        throw new Error('Received empty response from server')
      }

      let data
      try {
        data = JSON.parse(text)
      } catch (parseError) {
        console.error('Server response:', text)
        throw new Error(`Failed to parse server response: ${text.substring(0, 200)}`)
      }

      if (!response.ok) {
        throw new Error(data.error || 'API request failed')
      }
      const newSpec = data.spec
      const widgetOptions = sanitizeWidgetOptions(data.widget_options || [])
      const widgetTitle = data.widget_title || ''
      const clarification = data.clarification
      const changeType = clarification?.change_type || 'visual_refinement'

      // Determine chart position and relationship based on change_type
      const isDataTransform = changeType === 'data_transformation'

      let newX, newY, svgOverrides

      if (isDataTransform) {
        // Data transformation: position below, connected with orange line, no svgOverrides inheritance
        const chartsAtSameOrigin = chartObjects.filter(c =>
          Math.abs(c.x - selectedChart.x) < 50
        )
        newX = selectedChart.x
        newY = Math.max(...chartsAtSameOrigin.map(c => c.y + c.height)) + 80
        svgOverrides = {}
      } else {
        // Visual refinement: position right, connected to parent, inherit svgOverrides
        newX = selectedChart.x + selectedChart.width + 450
        newY = selectedChart.y
        svgOverrides = selectedChart.svgOverrides ? { ...selectedChart.svgOverrides } : {}
      }

      // Avoid overlapping with existing charts
      const nonOverlap = findNonOverlappingPosition(newX, newY, 480, 350, chartObjects)
      newX = nonOverlap.x
      newY = nonOverlap.y

      const newChart = {
        id: nextChartId,
        x: newX,
        y: newY,
        width: 480,
        height: 350,
        spec: newSpec,
        parentId: selectedChart.id,
        command: nlInput,
        widgetTitle: widgetTitle,
        intent: clarification?.intent || null,
        changeType: changeType,
        widgetOptions: widgetOptions,
        svgOverrides: svgOverrides,
        modifications: [],
        baseSpec: null,
        baseSvgOverrides: null
      }

      setChartObjects(prev => [...prev, newChart])
      setSelectedChartIds([nextChartId])
      setNextChartId(prev => prev + 1)
      setNlInput('')
      setTimeout(() => panToChart(newChart.x, newChart.y, newChart.width, newChart.height), 100)

    } catch (error) {
      console.error('Error processing command:', error)
      alert(`Error: ${error.message}`)
    } finally {
      setIsProcessing(false)
    }
  }

  // Data handlers
  // Called by DataTable when cell selection changes — receives { columns, data }
  const handleSelectionChange = useCallback(({ columns, data }) => {
    setSelectedColumns(columns)
    setSelectedData(data)
  }, [])

  const handleColumnInfoChange = useCallback((colName, newType) => {
    setColumnInfos(prev => prev.map(c => c.name === colName ? { ...c, type: newType } : c))
  }, [])

  const handleDataLoad = useCallback((data, infos, fileName) => {
    setCurrentData(data)
    setColumnInfos(infos)
    setDataSourceName(fileName)
    setSelectedColumns([])
    setSelectedData([])
    setSelectedChartType(null)
  }, [])

  const handleDataSourceCreate = useCallback((data, infos, fileName) => {
    // Deduplicate: reuse existing data source with the same filename
    const existingId = Object.keys(dataSources).find(id => dataSources[id].name === fileName)
    const newId = existingId || `upload-${fileName.replace(/\.\w+$/, '')}-${Date.now()}`
    setDataSources(prev => ({ ...prev, [newId]: { name: fileName, description: 'Uploaded', values: data } }))
    setActiveDataSourceId(newId)
    setCurrentData(data)
    setColumnInfos(infos)
    setDataSourceName(fileName)
    setSelectedColumns([])
    setSelectedData([])
    setSelectedChartType(null)
  }, [dataSources])

  const handleCellEdit = useCallback(({ dataSourceId, rowIndex, columnName, newValue }) => {
    const source = dataSources[dataSourceId]
    if (!source) return
    const newValues = source.values.map((row, i) =>
      i === rowIndex ? { ...row, [columnName]: newValue } : row
    )
    updateDataSource(dataSourceId, newValues)
  }, [dataSources, updateDataSource])

  const handleRowAdd = useCallback(({ dataSourceId, rowIndex }) => {
    const source = dataSources[dataSourceId]
    if (!source) return
    const columns = Object.keys(source.values[0] || {})
    const emptyRow = {}
    columns.forEach(col => { emptyRow[col] = '' })
    const newValues = [...source.values]
    newValues.splice(rowIndex + 1, 0, emptyRow)
    updateDataSource(dataSourceId, newValues)
  }, [dataSources, updateDataSource])

  const handleRowDelete = useCallback(({ dataSourceId, rowIndices }) => {
    const source = dataSources[dataSourceId]
    if (!source) return
    const deleteSet = new Set(rowIndices)
    const newValues = source.values.filter((_, i) => !deleteSet.has(i))
    if (newValues.length === 0) return
    updateDataSource(dataSourceId, newValues)
  }, [dataSources, updateDataSource])

  const handleColumnAdd = useCallback(({ dataSourceId, columnName }) => {
    const source = dataSources[dataSourceId]
    if (!source) return
    const newValues = source.values.map(row => ({ ...row, [columnName]: '' }))
    updateDataSource(dataSourceId, newValues)
  }, [dataSources, updateDataSource])

  const handleColumnRename = useCallback(({ dataSourceId, oldName, newName }) => {
    const source = dataSources[dataSourceId]
    if (!source) return
    const newValues = source.values.map(row => {
      const newRow = {}
      for (const key of Object.keys(row)) {
        newRow[key === oldName ? newName : key] = row[key]
      }
      return newRow
    })
    updateDataSource(dataSourceId, newValues)
    // Also update columnInfos
    setColumnInfos(prev => {
      if (!prev[oldName]) return prev
      const next = { ...prev }
      next[newName] = { ...next[oldName] }
      delete next[oldName]
      return next
    })
  }, [dataSources, updateDataSource])

  const handleColumnDelete = useCallback(({ dataSourceId, columnNames }) => {
    const source = dataSources[dataSourceId]
    if (!source) return
    const delSet = new Set(columnNames)
    const remaining = Object.keys(source.values[0] || {}).filter(c => !delSet.has(c))
    if (remaining.length === 0) return
    const newValues = source.values.map(row => {
      const newRow = {}
      remaining.forEach(c => { newRow[c] = row[c] })
      return newRow
    })
    updateDataSource(dataSourceId, newValues)
  }, [dataSources, updateDataSource])

  const handleResetToSample = useCallback(() => {
    setCurrentData(SAMPLE_DATA)
    setColumnInfos(analyzeColumns(SAMPLE_DATA))
    setDataSourceName('sample_data')
    setSelectedColumns([])
    setSelectedData([])
    setSelectedChartType(null)
  }, [])

  const handleSpecApply = useCallback(() => {
    try {
      const parsed = JSON.parse(specEditText)
      if (!parsed || typeof parsed !== 'object') throw new Error('Must be a JSON object')

      // Restore data.values from original spec (stripped in edit mode for readability)
      const origData = selectedChart?.spec?.data?.values
      if (origData && Array.isArray(origData)) {
        if (!parsed.data) parsed.data = {}
        if (!Array.isArray(parsed.data.values)) {
          parsed.data.values = origData
        }
      }
      // Fallback: inject from data source if still missing
      if (selectedChart?.dataSourceId && dataSources[selectedChart.dataSourceId]) {
        if (!parsed.data?.values?.length) {
          parsed.data = { values: dataSources[selectedChart.dataSourceId].values }
        }
      }

      // The hand-edited JSON is the authoritative new baseline — reset baseSpec/modifications
      // so a later element edit doesn't replay the old stack and revert this direct edit.
      setChartObjects(prev => prev.map(c => c.id === selectedChartId
        ? { ...c, spec: parsed, baseSpec: null, modifications: [], baseSvgOverrides: null }
        : c))
      setSpecEditMode(false)
      setSpecEditError(null)
    } catch (e) {
      setSpecEditError(e.message)
    }
  }, [specEditText, selectedChart, selectedChartId, dataSources])

  const handleSpecImport = useCallback(() => {
    try {
      const parsed = JSON.parse(specImportText)

      if (!parsed || typeof parsed !== 'object') throw new Error('Must be a JSON object')
      if (!parsed.mark && !parsed.layer && !parsed.concat && !parsed.hconcat && !parsed.vconcat) {
        throw new Error('Not a valid Vega-Lite spec: needs mark, layer, or concat')
      }

      if (!parsed.$schema) {
        parsed.$schema = "https://vega.github.io/schema/vega-lite/v6.json"
      }

      // Extract data and register as data source
      let dataSourceId = null
      const dataValues = parsed.data?.values || (parsed.datasets ? Object.values(parsed.datasets)[0] : null)
      if (Array.isArray(dataValues) && dataValues.length > 0) {
        const dsId = `import-${Date.now()}`
        setDataSources(prev => ({ ...prev, [dsId]: { name: 'Imported Spec Data', description: 'From imported spec', values: dataValues } }))
        setActiveDataSourceId(dsId)
        dataSourceId = dsId
      }

      const adjusted = findNonOverlappingPosition(700, 50, 480, 350, chartObjects)
      const newChart = {
        id: nextChartId,
        dataSourceId,
        x: adjusted.x, y: adjusted.y,
        width: 480, height: 350,
        spec: parsed,
        parentId: null,
        command: 'Imported spec',
        intent: 'import',
        changeType: 'import',
        widgetOptions: [],
        svgOverrides: {},
        modifications: [],
        baseSpec: null, baseSvgOverrides: null
      }

      setChartObjects(prev => [...prev, newChart])
      setSelectedChartIds([nextChartId])
      setNextChartId(prev => prev + 1)
      setShowSpecImport(false)
      setTimeout(() => panToChart(newChart.x, newChart.y, 480, 350), 100)
    } catch (e) {
      setSpecImportError(e.message)
    }
  }, [specImportText, chartObjects, nextChartId, findNonOverlappingPosition, panToChart])

  const handleChartTypeSelect = useCallback((chartTypeId) => {
    setSelectedChartType(chartTypeId)

    // Pre-built specs for each chart type
    const prebuiltSpecs = {
      bar: { spec: barSpec, dataset: 'csv-nonfarm', label: 'Bar chart' },
      line: { spec: lineSpec, dataset: 'csv-population', label: 'Line chart' },
      point: { spec: scatterSpec, dataset: 'csv-penguins', label: 'Scatter plot' },
      histogram: { spec: histogramSpec, dataset: 'csv-trials', label: 'Histogram' },
    }

    let spec, dataSourceId, chartLabel

    const ctDef = CHART_TYPES.find(ct => ct.id === chartTypeId)
    const hasActiveData = effectiveDataSourceId && dataSources[effectiveDataSourceId]

    // If user has active data, generate spec from it; otherwise use prebuilt spec as fallback
    if (hasActiveData) {
      if (!ctDef || !ctDef.mark) return
      // Visualize the whole dataset with all columns (auto-encoded), like a standard viz tool
      const dataForChart = dataSources[effectiveDataSourceId].values
      const effectiveColumnInfos = analyzeColumns(dataForChart)
      const columnsForChart = effectiveColumnInfos.map(c => c.name)
      spec = generateSpecFromColumns(dataForChart, columnsForChart, effectiveColumnInfos, ctDef.mark, chartTypeId)
      if (!spec) return
      dataSourceId = effectiveDataSourceId
      chartLabel = `${ctDef.label || chartTypeId} chart`
    } else if (prebuiltSpecs[chartTypeId]) {
      const pre = prebuiltSpecs[chartTypeId]
      const rawSpec = JSON.parse(JSON.stringify(pre.spec))
      setActiveDataSourceId(pre.dataset)
      spec = rawSpec
      dataSourceId = pre.dataset
      chartLabel = pre.label
    } else {
      // No active data and no prebuilt — use currentData as last resort
      if (!ctDef || !ctDef.mark) return
      const dataForChart = currentData
      const effectiveInfos = analyzeColumns(dataForChart)
      const cols = effectiveInfos.map(c => c.name)
      spec = generateSpecFromColumns(dataForChart, cols, effectiveInfos, ctDef.mark, chartTypeId)
      if (!spec) return
      dataSourceId = null
      chartLabel = `${ctDef.label || chartTypeId} chart`
    }

    // Donut = pie (arc) with an inner radius hole
    if (chartTypeId === 'donut') spec = donutifySpec(spec)

    // Create new chart on canvas
    const newX = 700
    const newY = 50
    const adjusted = findNonOverlappingPosition(newX, newY, 480, 350, chartObjects)

    const newChart = {
      id: nextChartId,
      dataSourceId,
      x: adjusted.x,
      y: adjusted.y,
      width: 480,
      height: 350,
      spec,
      parentId: null,
      command: chartLabel,
      intent: 'encoding',
      changeType: 'encoding',
      widgetOptions: [],
      svgOverrides: {},
      modifications: [],
      baseSpec: null,
      baseSvgOverrides: null
    }

    setChartObjects(prev => [...prev, newChart])
    setSelectedChartIds([nextChartId])
    setNextChartId(prev => prev + 1)
    setSelectedChartType(null)
    setTimeout(() => panToChart(newChart.x, newChart.y, newChart.width, newChart.height), 100)
  }, [selectedColumns, selectedData, currentData, columnInfos, chartObjects, nextChartId, findNonOverlappingPosition, panToChart, effectiveDataSourceId, dataSources])

  // NL-driven encoding: send command + data context to server
  const handleEncodingNLSubmit = useCallback(async (command) => {
    if (IS_STATIC_DEMO && !hasApiBase()) { setApiKeyOpen(true); showToast('Connect a backend (enter its URL) to use AI features'); return }
    setIsProcessing(true)
    try {
      // Always visualize the full dataset; selection only picks which columns to encode
      const nlDataForChart = (effectiveDataSourceId && dataSources[effectiveDataSourceId])
        ? dataSources[effectiveDataSourceId].values
        : currentData
      const nlEffectiveColumnInfos = analyzeColumns(nlDataForChart)
      const dataContext = {
        data_columns: nlEffectiveColumnInfos.map(c => ({
          name: c.name,
          type: c.type,
          sample_values: c.sampleValues
        })),
        selected_columns: [],
        user_command: command,
        data: nlDataForChart
      }

      const response = await fetch(apiUrl('/api/create-chart'), {
        method: 'POST',
        headers: withApiKey({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(dataContext)
      })

      if (response.status === 401) { setIsProcessing(false); setApiKeyOpen(true); showToast('Invalid or missing API key'); return }

      const text = await response.text()
      let result
      try {
        result = JSON.parse(text)
      } catch {
        throw new Error('Invalid server response')
      }

      if (!response.ok) {
        throw new Error(result.error || 'Server error')
      }

      if (!result.spec) {
        throw new Error('No spec returned')
      }

      // Ensure data is injected
      if (!result.spec.data?.values?.length) {
        result.spec.data = { values: nlDataForChart }
      }

      const newX = 700
      const newY = 50
      const adjusted = findNonOverlappingPosition(newX, newY, 480, 350, chartObjects)

      const newChart = {
        id: nextChartId,
        dataSourceId: effectiveDataSourceId,
        x: adjusted.x,
        y: adjusted.y,
        width: 480,
        height: 350,
        spec: result.spec,
        parentId: null,
        command: command,
        intent: 'encoding',
        changeType: 'encoding',
        widgetOptions: sanitizeWidgetOptions(result.widget_options || []),
        svgOverrides: {},
        modifications: [],
        baseSpec: null,
        baseSvgOverrides: null
      }

      setChartObjects(prev => [...prev, newChart])
      setSelectedChartIds([nextChartId])
      setNextChartId(prev => prev + 1)
      setTimeout(() => panToChart(newChart.x, newChart.y, newChart.width, newChart.height), 100)
    } catch (error) {
      console.error('Encoding NL error:', error)
      alert(`Error: ${error.message}`)
    } finally {
      setIsProcessing(false)
    }
  }, [columnInfos, selectedColumns, selectedData, currentData, chartObjects, nextChartId, findNonOverlappingPosition, effectiveDataSourceId, dataSources])

  // Freeze the selected chart's whole lineage tree into a static gallery example.
  // Stored under a SEPARATE localStorage key so editing live charts never changes it.
  const GALLERY_KEY = 'chart-authoring-gallery'
  const handleSaveToGallery = useCallback(async () => {
    // Root of the selected chart's tree (walk parentId up)
    let cur = chartObjects.find(c => selectedChartIds.includes(c.id)) || null
    if (!cur) { showToast('Select a chart first'); return }
    while (cur.parentId != null) {
      const p = chartObjects.find(c => c.id === cur.parentId)
      if (!p) break
      cur = p
    }
    // Collect root + all descendants
    const keep = new Set([cur.id])
    for (let changed = true; changed;) {
      changed = false
      for (const c of chartObjects) {
        if (c.parentId != null && keep.has(c.parentId) && !keep.has(c.id)) { keep.add(c.id); changed = true }
      }
    }
    const treeCharts = chartObjects.filter(c => keep.has(c.id))
    const usedDs = {}
    for (const c of treeCharts) if (c.dataSourceId && dataSources[c.dataSourceId]) usedDs[c.dataSourceId] = dataSources[c.dataSourceId]

    const defaultName = (typeof cur.spec?.title === 'string' ? cur.spec.title : cur.spec?.title?.text) || cur.command || `Example (${treeCharts.length} charts)`
    const name = window.prompt('Gallery example name:', defaultName)
    if (name == null) return

    // Bake a PNG thumbnail of the leaf (final) chart — fixed raster keeps the aspect ratio.
    const leaf = treeCharts.find(c => !treeCharts.some(x => x.parentId === c.id)) || treeCharts[treeCharts.length - 1]
    let thumbnail = null
    try {
      const leafHasData = leaf?.spec?.data?.values?.length > 0
      const leafData = leafHasData ? null : ((leaf?.dataSourceId && dataSources[leaf.dataSourceId]?.values) || currentData || [])
      const thumbSpec = leafData ? { ...leaf.spec, data: { values: leafData } } : leaf.spec
      thumbnail = await renderChartPng(thumbSpec, { svgOverrides: leaf?.svgOverrides })
    } catch { /* fall back to live re-render in the gallery */ }

    const example = {
      id: `ex_${Date.now()}`,
      name: name.trim() || 'Untitled',
      createdAt: Date.now(),
      charts: JSON.parse(JSON.stringify(treeCharts)),
      dataSources: usedDs,
      currentData,
      nextChartId,
      thumbnail,
    }
    try {
      const raw = localStorage.getItem(GALLERY_KEY)
      const list = raw ? JSON.parse(raw) : []
      list.push(example)
      localStorage.setItem(GALLERY_KEY, JSON.stringify(list))
      showToast(`Saved "${example.name}" to gallery (${treeCharts.length} charts)`)
    } catch (e) {
      alert('Failed to save to gallery: ' + e.message)
    }
  }, [chartObjects, selectedChartIds, dataSources, currentData, nextChartId, showToast])

  return (
    <div className={`app-container${readOnly ? ' readonly-mode' : ''}`}>
      {/* Header */}
      <header className="app-header">
        {readOnly ? (
          <div className="readonly-header">
            <button
              className="readonly-back-btn"
              onClick={() => { window.location.search = '?gallery' }}
            >
              ← Gallery
            </button>
            <div className="readonly-title-wrap">
              <h1 className="readonly-title">{galleryExample?.name || 'Example'}</h1>
            </div>
          </div>
        ) : (
          <>
          <h1>TailVis</h1>
          <div className="header-btns">
            <button className="header-btn" title="Open the example gallery" onClick={() => { window.location.search = '?gallery' }}>
              ☆ Gallery
            </button>
            {IS_STATIC_DEMO && (
              <button className="header-btn" title="Connect your backend server" onClick={() => setApiKeyOpen(true)}>
                <span className={`key-dot${hasApiBase() ? '' : ' off'}`} />
                Backend
              </button>
            )}
          </div>
          </>
        )}
      </header>

      <div
        className="main-content"
        onMouseMove={(e) => {
          handleSplitMouseMove(e)
          handlePanelResizeMouseMove(e)
        }}
        onMouseUp={() => {
          handleSplitMouseUp()
          handlePanelResizeMouseUp()
        }}
        onMouseLeave={() => {
          handleSplitMouseUp()
          handlePanelResizeMouseUp()
        }}
      >
        {/* Icon Sidebar */}
        <div className="icon-sidebar">
          <button
            className={`sidebar-icon-btn ${layerPanelOpen ? 'active' : ''}`}
            onClick={() => setLayerPanelOpen(prev => !prev)}
            title={layerPanelOpen ? 'Hide Layers' : 'Show Layers'}
          >
            <span className="sidebar-icon">🗂</span>
            <span className="sidebar-label">Layers</span>
          </button>
          <button
            className={`sidebar-icon-btn ${dataTableOpen ? 'active' : ''}`}
            onClick={() => setDataTableOpen(prev => !prev)}
            title={dataTableOpen ? 'Hide Data Table' : 'Show Data Table'}
          >
            <span className="sidebar-icon">📊</span>
            <span className="sidebar-label">Data</span>
          </button>
        </div>

        {/* Layer Panel (collapsible) */}
        {layerPanelOpen && (
          <div
            className={`layer-overlay-panel ${isDraggingLayerResize ? 'resizing' : ''}`}
            ref={leftPanelRef}
            style={{ width: layerPanelWidth }}
          >
            <LayerPanel
              chartId={selectedChartId}
              spec={selectedChart?.spec}
              onLayerSelect={handleLayerSelect}
              selectedLayerId={selectedLayerId}
              selectedDomElement={selectedElement?.element}
              selectedSelector={selectedElement?.selector}
              selectedSelectors={selectedSelectors}
            />
            <div
              className={`overlay-resize-handle ${isDraggingLayerResize ? 'dragging' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); setIsDraggingLayerResize(true) }}
            />
          </div>
        )}

        {/* DataTable Overlay Panel */}
        {dataTableOpen && (
          <div
            className={`datatable-overlay-panel ${isDraggingDataTableResize ? 'resizing' : ''}`}
            style={{ width: dataTableWidth }}
            onMouseDown={() => {
              // Clear canvas element highlight, but keep the chart selected so the
              // data panel keeps showing this chart's data (don't kick back to the
              // dataset list when interacting with the table, e.g. clicking "More").
              setSelectedElement(null)
              setSelectedElements([])
            }}
          >
            <DataTable
                data={tableEffectiveData}
                columnInfos={tableEffectiveColumnInfos}
                onSelectionChange={handleSelectionChange}
                onColumnInfoChange={handleColumnInfoChange}
                onDataLoad={handleDataLoad}
                dataSourceName={dataSourceName}
                dataSources={dataSources}
                activeDataSourceId={activeDataSourceId}
                onSelectDataSource={setActiveDataSourceId}
                selectedChartDataSourceId={selectedChart ? selectedChart.dataSourceId : null}
                onCellEdit={handleCellEdit}
                onRowAdd={handleRowAdd}
                onRowDelete={handleRowDelete}
                onColumnAdd={handleColumnAdd}
                onColumnDelete={handleColumnDelete}
                onColumnRename={handleColumnRename}
                onDataSourceCreate={handleDataSourceCreate}
                encodedFields={selectedChart?.parentId ? [] : chartEncodedFields}
                highlightDatum={(() => {
                  if (!selectedElement) return null
                  const el = selectedElement
                  const datum = el.datum
                  const role = el.semanticRole
                  const spec = selectedChart?.spec || {}

                  // Collect all encodings (top-level + layers)
                  const collectEncodings = (sp) => {
                    const result = {}
                    const enc = sp.encoding || {}
                    for (const ch of Object.keys(enc)) {
                      if (enc[ch]?.field) result[ch] = enc[ch]
                    }
                    if (sp.layer) {
                      for (const layer of sp.layer) {
                        const lEnc = layer.encoding || {}
                        for (const ch of Object.keys(lEnc)) {
                          if (lEnc[ch]?.field && !result[ch]) result[ch] = lEnc[ch]
                        }
                      }
                    }
                    return result
                  }
                  const allEnc = collectEncodings(spec)

                  // Helper: normalize temporal values for comparison
                  const normalizeValue = (val, field) => {
                    if (val == null) return null
                    if (typeof val === 'number' && spec.data?.values) {
                      const isTemp = Object.values(allEnc).some(e => e.field === field && e.type === 'temporal')
                      if (isTemp) {
                        const orig = spec.data.values.find(row => {
                          const rv = row[field]
                          if (rv == null) return false
                          return new Date(rv).getTime() === val
                        })
                        if (orig) return orig[field]
                      }
                    }
                    return val
                  }

                  if (role === 'text' || role === 'other') return null
                  if (role === 'axis' && el.axisSubType !== 'label') return null

                  if (role === 'legend' && el.legendField && el.legendValue != null) {
                    return {
                      elementType: 'legend',
                      matchFields: [el.legendField],
                      matchValues: { [el.legendField]: el.legendValue },
                    }
                  }

                  if (role === 'axis' && el.axisSubType === 'label') {
                    const ch = el.axisChannel
                    const field = allEnc[ch]?.field
                    if (!field) return null
                    const rawData = el.element?.__data__
                    let labelValue = rawData?.datum?.value ?? rawData?.value ?? rawData?.datum ?? null
                    if (labelValue == null && el.element?.textContent) {
                      labelValue = el.element.textContent.trim()
                    }
                    if (labelValue == null) return null
                    const normalized = normalizeValue(labelValue, field)
                    return {
                      elementType: 'axis-label',
                      matchFields: [field],
                      matchValues: { [field]: normalized },
                    }
                  }

                  if (role === 'data-mark' && datum) {
                    // Use ALL encoded fields (including quantitative) to match the exact row
                    const allFields = []
                    const allMatchVals = {}
                    for (const ch of Object.keys(allEnc)) {
                      const f = allEnc[ch].field
                      if (f && datum[f] != null) {
                        allFields.push(f)
                        allMatchVals[f] = normalizeValue(datum[f], f)
                      }
                    }
                    if (allFields.length > 0) {
                      return { elementType: 'data-mark', matchFields: allFields, matchValues: allMatchVals }
                    }
                  }

                  return null
                })()}
            />
            {/* DataTable resize handle */}
            <div
              className={`datatable-resize-handle ${isDraggingDataTableResize ? 'dragging' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); setIsDraggingDataTableResize(true) }}
            />
          </div>
        )}

        {/* Canvas area with encoding bar on top */}
        <div className="canvas-area">
          {!readOnly && (
            <EncodingBar
              selectedChartType={selectedChartType}
              onChartTypeSelect={handleChartTypeSelect}
              onEncodingNLSubmit={handleEncodingNLSubmit}
              isProcessing={isProcessing}
            />
          )}
          <div className="canvas-wrapper" ref={canvasWrapperRef}>
          <Suspense fallback={null}>
          <Canvas
            chartObjects={chartObjects}
            dataSources={dataSources}
            selectedChartIds={selectedChartIds}
            onSelectChart={handleSelectChart}
            onToggleChartSelection={handleToggleChartSelection}
            onSelectCharts={handleSelectCharts}
            onUpdateChart={handleUpdateChart}
            onDeleteChart={handleDeleteChart}
            onCopyChart={handleCopyChart}
            onBranchChart={handleBranchChart}
            onWidgetOptionChange={handleWidgetOptionChange}
            onElementSelect={handleElementSelect}
            activeChatId={activeChatId}
            onElementReference={handleElementReference}
            elementBadges={chatReferences.map(r => ({ selector: r.selector, number: r.number }))}
            previewChart={previewChart}
            onTransformChange={setCanvasTransform}
            panToRef={canvasPanToRef}
            onScopeChange={handleScopeChange}
            onDeleteModification={handleDeleteModification}
            onModificationClick={handleModificationClick}
            onModificationValueChange={handleModificationValueUpdate}
            activeModificationId={activeModificationId}
            onUndo={undo}
            externalSelectedElement={externalSelectedElement}
            onWidgetPreviewChange={(chartId, spec) => {
              if (spec) {
                // Save original spec before first preview
                if (!continueChatOriginalSpec.current || continueChatOriginalSpec.current.chartId !== chartId) {
                  const chart = chartObjects.find(c => c.id === chartId)
                  if (chart) continueChatOriginalSpec.current = { chartId, spec: chart.spec }
                }
                // Swap spec to show preview
                setChartObjects(prev => prev.map(c =>
                  c.id === chartId ? { ...c, spec } : c
                ))
              } else {
                // Restore original spec (cancel)
                if (continueChatOriginalSpec.current && continueChatOriginalSpec.current.chartId === chartId) {
                  const originalSpec = continueChatOriginalSpec.current.spec
                  setChartObjects(prev => prev.map(c =>
                    c.id === chartId ? { ...c, spec: originalSpec } : c
                  ))
                  continueChatOriginalSpec.current = null
                }
              }
            }}
            onWidgetContinueChat={(chartId, result) => {
              // Clear saved original — the new spec is now the real spec
              continueChatOriginalSpec.current = null
              // Update existing chart in-place with continued chat results
              const existingIds = new Set((chartObjects.find(c => c.id === chartId)?.widgetOptions || []).map(w => w.id))
              const mergedWidgets = sanitizeWidgetOptions([
                ...(chartObjects.find(c => c.id === chartId)?.widgetOptions || []),
                ...(result.widgetOptions || []).filter(w => !existingIds.has(w.id))
              ])
              setChartObjects(prev => {
                let updated = prev.map(c =>
                  c.id === chartId
                    ? {
                        ...c,
                        spec: result.spec,
                        widgetOptions: mergedWidgets,
                        conversationHistory: result.conversationHistory || c.conversationHistory,
                        // result.spec already bakes in any prior modifications, so it becomes
                        // the NEW clean baseline. Resetting baseSpec/modifications prevents a
                        // later property-panel edit from replaying the OLD stack over a stale
                        // base and reverting these chat changes (lost point/interpolate/colors).
                        baseSpec: null,
                        modifications: [],
                        baseSvgOverrides: null,
                      }
                    : c
                )
                return updated
              })
            }}
            onRenderError={(chartId, msg) => {
              console.warn(`[RenderError] chart ${chartId}:`, msg)
            }}
            onOpenChat={(chartId, position, initialMessages) => {
              setActiveChatId(chartId)
              setChatCanvasPos(position)
              setChatInitialMessages(initialMessages || null)
              // Ensure ChatAgent doesn't overflow right edge — pan just enough
              const wrapper = canvasWrapperRef.current
              if (wrapper) {
                const k = canvasTransform.k || 1
                const chatRight = position.x * k + canvasTransform.x + (wrapper.getBoundingClientRect()?.left || 0) + 340
                const viewRight = wrapper.getBoundingClientRect().right
                if (chatRight > viewRight) {
                  const shiftX = canvasTransform.x - (chatRight - viewRight) - 20
                  const newTransform = { ...canvasTransform, x: shiftX }
                  if (canvasPanToRef.current) {
                    canvasPanToRef.current(newTransform, { animate: true, duration: 300 })
                  } else {
                    setCanvasTransform(newTransform)
                  }
                }
              }
              setTimeout(() => chatAgentFocusRef.current?.focus(), 100)
              // Snapshot selected elements at chat open time (use refs for latest values)
              if (!initialMessages) {
                const curElements = selectedElementsRef.current
                const curElement = selectedElementRef.current
                const curChartId = elementChartIdRef.current
                const elements = curElements.length > 0
                  ? curElements
                  : curElement ? [curElement] : []
                console.log('[CHAT-OPEN] snapshot', {
                  chartId,
                  curChartId,
                  elementsCount: elements.length,
                  elementsDetail: elements.map(el => ({
                    type: el.type || el.elementInfo?.type,
                    selector: el.selector,
                    scopeType: el._scopeType || el.elementInfo?._scopeType,
                    datum: el.datum ? Object.keys(el.datum).filter(k => !k.startsWith('_')) : null,
                  }))
                })
                if (elements.length > 0 && curChartId === chartId) {
                  const firstWithScope = elements.find(el => el.elementInfo?._scopeType || el._scopeType)
                  if (firstWithScope) {
                    const info = firstWithScope.elementInfo || firstWithScope
                    const scopeInfo = {
                      scopeType: info._scopeType,
                      scopeData: info._scopeData,
                      label: info._scopeLabel,
                      labelEn: info._scopeLabelEn,
                      elementCount: info._scopeElementCount || elements.length
                    }
                    console.log('[CHAT-OPEN] scopeInfo:', scopeInfo)
                    setChatScopeInfo(scopeInfo)
                  } else {
                    console.log('[CHAT-OPEN] no scope found on elements')
                    setChatScopeInfo(null)
                  }
                  setChatElementReferences(elements.map((el, i) => {
                    const datum = el.datum
                    const labelParts = datum
                      ? Object.entries(datum)
                          .filter(([k, v]) => !k.startsWith('_') && v != null && (typeof v === 'string' || typeof v === 'number'))
                          .filter(([, v]) => !(typeof v === 'number' && v > 1e9)) // skip epoch timestamps
                          .map(([k, v]) => `${k}: ${v}`)
                          .slice(0, 2)
                      : []
                    return {
                      ref: i + 1,
                      markType: el.type || 'unknown',
                      semanticRole: el.semanticRole || 'data-mark',
                      datum: datum || null,
                      selector: el.selector || null,
                      properties: el.properties || {},
                      markGroup: el.markGroup || null,
                      label: labelParts.length > 0 ? labelParts.join(' · ') : (el.type || 'element')
                    }
                  }))
                  console.log('[CHAT-OPEN] elementRefs created:', elements.length, 'elements')
                } else {
                  console.log('[CHAT-OPEN] no matching elements for chartId:', chartId, 'curChartId:', curChartId)
                  setChatElementReferences(null)
                  setChatScopeInfo(null)
                }
              } else {
                console.log('[CHAT-OPEN] readOnly mode, skipping element snapshot')
                setChatElementReferences(null)
                setChatScopeInfo(null)
              }
            }}
          />
          </Suspense>

          {/* Reset button */}
          {!readOnly && (
            <button
              className="canvas-reset-btn"
              title="Reset all"
              onClick={() => setShowResetConfirm(true)}
            >
              Reset
            </button>
          )}

          {/* Save to Gallery button hidden per request (handler kept for later use) */}

          </div>
        </div>

        {/* Right resize handle */}
        <div
          className={`panel-resize-handle ${isDraggingRightResize ? 'dragging' : ''}`}
          onMouseDown={handleRightResizeMouseDown}
        />

        {/* Right Panel - Tab View: Properties | Vega-Lite Spec */}
        <div className="right-panel-wrapper" ref={rightPanelRef} style={{ width: rightPanelWidth }}>
          <div className="right-panel-tabs">
            <button
              className={`right-panel-tab ${rightPanelTab === 'properties' ? 'active' : ''}`}
              onClick={() => setRightPanelTab('properties')}
            >
              Properties
            </button>
            <button
              className={`right-panel-tab ${rightPanelTab === 'spec' ? 'active' : ''}`}
              onClick={() => setRightPanelTab('spec')}
            >
              Vega-Lite Spec
            </button>
          </div>
          <div className="right-panel-content">
            {rightPanelTab === 'properties' && (<div className="properties-scroll">
              <PropertyPanel
                readOnly={readOnly}
                selectedElement={selectedElement}
                selectedElements={selectedElements}
                chartId={elementChartId}
                selectedChart={selectedChart}
                onPropertyChange={handlePropertyChange}
                onDeleteElement={handleDeleteElement}
                dataSources={dataSources}
                onUpdateChart={handleUpdateChart}
                onDeselectElements={(remaining) => {
                  if (remaining.length === 0) {
                    setSelectedElements([])
                    setSelectedElement(null)
                  } else if (remaining.length === 1) {
                    setSelectedElements(remaining)
                    setSelectedElement(remaining[0])
                  } else {
                    setSelectedElements(remaining)
                    setSelectedElement(remaining[0])
                  }
                }}
                onChartPropertyChange={(propName, value) => {
                  if (!selectedChartId) return
                  setChartObjects(prev => {
                    const target = prev.find(c => c.id === selectedChartId)
                    if (!target) return prev
                    const s = JSON.parse(JSON.stringify(target.spec))

                    // Property path config: [parentKey, childKey] or [topLevelKey]
                    const PROP_PATH = {
                      width:         ['width'],
                      height:        ['height'],
                      background:    ['background'],
                      padding:       ['padding'],
                      title:         ['title', 'text'],
                      titleFontSize: ['title', 'fontSize'],
                      subtitle:      ['title', 'subtitle'],
                    }

                    const path = PROP_PATH[propName]
                    if (propName === 'width' || propName === 'height') {
                      // Faceted spec ({facet, spec}): the real per-cell size lives in the
                      // inner unit spec. The outer width/height are totals Vega derives, so
                      // write the inner value and drop the stale outer one.
                      if (s.facet && s.spec) {
                        s.spec[propName] = value
                        delete s[propName]
                      } else {
                        s[propName] = value
                      }
                    } else if (path) {
                      if (path.length === 1) {
                        s[path[0]] = value
                      } else {
                        // Nested under an object that may currently be a plain string (e.g. title)
                        const [parent, child] = path
                        if (typeof s[parent] === 'string') {
                          s[parent] = child === 'text' ? value : { text: s[parent], [child]: value }
                        } else {
                          s[parent] = { ...(s[parent] || {}), [child]: value }
                        }
                      }
                    } else if (propName === 'transpose') {
                      if (s.encoding?.x && s.encoding?.y) {
                        const temp = s.encoding.x
                        s.encoding.x = s.encoding.y
                        s.encoding.y = temp
                      }
                    }

                    // Propagate to derived charts — but keep size (width/height) per-chart
                    const propagate = propName !== 'width' && propName !== 'height'
                    const changes = propagate ? diffSpecPaths(target.spec, s) : []
                    const descendantIds = changes.length > 0 ? collectDescendantIds(prev, selectedChartId) : null

                    return prev.map(c => {
                      if (c.id === selectedChartId) {
                        const updated = { ...c, spec: s }
                        if ((propName === 'width' || propName === 'height') && c.baseSpec) {
                          const bs = { ...c.baseSpec }
                          if (bs.facet && bs.spec) {
                            bs.spec = { ...bs.spec, [propName]: value }
                            delete bs[propName]
                          } else {
                            bs[propName] = value
                          }
                          updated.baseSpec = bs
                        }
                        return updated
                      }
                      if (descendantIds?.has(c.id) && c.spec) {
                        const upd = { ...c, spec: applySpecChanges(c.spec, changes) }
                        if (c.baseSpec) upd.baseSpec = applySpecChanges(c.baseSpec, changes)
                        return upd
                      }
                      return c
                    })
                  })
                }}
                onClose={() => {
                  setSelectedElement(null)
                  setElementChartId(null)
                }}
              />
              {ancestorWidgetChain.length > 0 && (
                <AncestorWidgetPanel
                  chain={ancestorWidgetChain}
                  onWidgetOptionChange={handleWidgetOptionChange}
                  selectedChartId={selectedChartId}
                />
              )}
            </div>)}
            {rightPanelTab === 'spec' && (
              <div className="spec-tab-content">
                <div className="spec-tab-toolbar">
                  {selectedChart && !specEditMode && (
                    <button
                      className="spec-copy-btn"
                      onClick={() => {
                        const text = JSON.stringify(selectedChart.spec, null, 2)
                        const onSuccess = () => {
                          const btn = document.querySelector('.spec-copy-btn')
                          if (btn) { btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy', 1500) }
                        }
                        const ta = document.createElement('textarea')
                        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
                        document.body.appendChild(ta); ta.select(); document.execCommand('copy')
                        document.body.removeChild(ta); onSuccess()
                      }}
                    >
                      Copy
                    </button>
                  )}
                  {selectedChart && !specEditMode && (
                    <button
                      className="spec-copy-btn"
                      onClick={() => {
                        // Show the full spec (including data) when editing
                        setSpecEditText(JSON.stringify(selectedChart.spec, null, 2))
                        setSpecEditError(null)
                        setSpecEditMode(true)
                      }}
                    >
                      Edit
                    </button>
                  )}
                  {specEditMode && (
                    <>
                      <button className="spec-copy-btn" onClick={handleSpecApply}>Apply</button>
                      <button className="spec-copy-btn" onClick={() => { setSpecEditMode(false); setSpecEditError(null) }}>Cancel</button>
                    </>
                  )}
                  <button
                    className="spec-copy-btn"
                    onClick={() => { setSpecImportText(''); setSpecImportError(null); setShowSpecImport(true) }}
                  >
                    Import
                  </button>
                </div>
                <div className="spec-content">
                  {specEditMode && selectedChart ? (
                    <>
                      <SpecCodeEditor
                        value={specEditText}
                        onChange={(v) => { setSpecEditText(v); setSpecEditError(null) }}
                      />
                      {specEditError && (
                        <p style={{ color: '#e74c3c', fontSize: 12, margin: '4px 8px 0' }}>{specEditError}</p>
                      )}
                    </>
                  ) : selectedChart ? (
                    <SpecView
                      currentSpec={selectedChart.spec}
                      parentSpec={selectedChart.parentId
                        ? chartObjects.find(c => c.id === selectedChart.parentId)?.spec
                        : null
                      }
                    />
                  ) : (
                    <p className="empty-hint">Select a chart to view its spec</p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Chat Agent — fixed overlay, outside flex layout to prevent layout shifts */}
      {activeChatId && (
        <ChatAgent
          chartId={activeChatId}
          chartSpec={chartObjects.find(c => c.id === activeChatId)?.spec}
          elementReferences={chatElementReferences}
          scopeInfo={chatScopeInfo}
          chatReferences={chatReferences}
          onChatReferencesChange={setChatReferences}
          canvasPos={chatCanvasPos}
          canvasTransform={canvasTransform}
          canvasWrapperRef={canvasWrapperRef}
          initialMessages={chatInitialMessages}
          readOnly={readOnly || !!chatInitialMessages}
          focusRef={chatAgentFocusRef}
          showToast={showToast}
          onClose={() => {
            setActiveChatId(null)
            setChatInitialMessages(null)
            setPreviewChart(null)
            setChatElementReferences(null)
            setChatScopeInfo(null)
            setChatReferences([])
          }}
          onPreviewChange={(spec, changeType) => {
            if (!spec) {
              setPreviewChart(null)
              return
            }
            const sourceChart = chartObjects.find(c => c.id === activeChatId)
            if (!sourceChart) return

            const isNewBranch = changeType === 'data_transformation'
            let previewX, previewY

            if (isNewBranch) {
              const chartsAtSameOrigin = chartObjects.filter(c => Math.abs(c.x - sourceChart.x) < 50)
              previewX = sourceChart.x
              previewY = Math.max(...chartsAtSameOrigin.map(c => c.y + c.height)) + 80
            } else {
              previewX = sourceChart.x + sourceChart.width + 450
              previewY = sourceChart.y
            }

            const adjusted = findNonOverlappingPosition(previewX, previewY, 480, 350, chartObjects)
            previewX = adjusted.x
            previewY = adjusted.y

            // The LLM strips data.values to save tokens — inject the source chart's
            // data so the preview renders immediately (no apply+reload needed).
            const srcData = sourceChart.spec?.data?.values?.length
              ? sourceChart.spec.data.values
              : ((sourceChart.dataSourceId && dataSources[sourceChart.dataSourceId]?.values) || [])
            const previewSpec = injectDataIntoSpec(spec, srcData)

            const isFirstPreview = !previewChart
            setPreviewChart({
              spec: previewSpec,
              x: previewX,
              y: previewY,
              width: 480,
              height: 350,
              sourceChartId: activeChatId,
              changeType
            })
            // Pan to center the ChatAgent only on first preview creation
            if (isFirstPreview) {
              const chatChart = chartObjects.find(c => c.id === activeChatId)
              if (chatChart) {
                const chatAgentX = chatChart.x + chatChart.width + 70
                const chatAgentY = chatChart.y + chatChart.height / 2 - 200
                setTimeout(() => {
                  panToChart(chatAgentX, chatAgentY, 320, 400)
                  chatAgentFocusRef.current?.focus()
                }, 50)
              }
            }
          }}
          onApply={(result) => {
            const sourceChart = chartObjects.find(c => c.id === activeChatId)
            if (!sourceChart) return

            const isDataTransform = result.changeType === 'data_transformation'

            let newX, newY, svgOverrides
            if (isDataTransform) {
              const chartsAtSameOrigin = chartObjects.filter(c => Math.abs(c.x - sourceChart.x) < 50)
              newX = sourceChart.x
              newY = Math.max(...chartsAtSameOrigin.map(c => c.y + c.height)) + 80
              svgOverrides = {}
            } else {
              newX = sourceChart.x + sourceChart.width + 450
              newY = sourceChart.y
              svgOverrides = sourceChart.svgOverrides ? { ...sourceChart.svgOverrides } : {}
            }

            const adjusted = findNonOverlappingPosition(newX, newY, 480, 350, chartObjects)
            newX = adjusted.x
            newY = adjusted.y

            // LLM spec is the clean starting point — no parent modification inheritance.
            // Inject the source chart's data (LLM stripped data.values) so it renders
            // immediately on apply without needing a reload.
            const applySrcData = sourceChart.spec?.data?.values?.length
              ? sourceChart.spec.data.values
              : ((sourceChart.dataSourceId && dataSources[sourceChart.dataSourceId]?.values) || [])
            let finalSpec = injectDataIntoSpec(JSON.parse(JSON.stringify(result.spec)), applySrcData)
            let finalOverrides = svgOverrides

            const newChart = {
              id: nextChartId,
              dataSourceId: sourceChart.dataSourceId || effectiveDataSourceId,
              x: newX,
              y: newY,
              width: 480,
              height: 350,
              spec: finalSpec,
              parentId: sourceChart.id,
              command: result.command || 'Modify via chat',
              changeType: result.changeType,
              widgetOptions: sanitizeWidgetOptions(result.widgetOptions || []),
              svgOverrides: finalOverrides,
              conversationHistory: result.conversationHistory || [],
              modifications: [],
              baseSpec: null,
              baseSvgOverrides: null
            }

            setChartObjects(prev => [...prev, newChart])
            setSelectedChartIds([nextChartId])
            setNextChartId(prev => prev + 1)
            setActiveChatId(null)
            setChatReferences([])
          }}
        />
      )}

      {/* Delete confirmation dialog */}

      <ApiKeyModal
        open={apiKeyOpen}
        onClose={() => setApiKeyOpen(false)}
        onSaved={() => setKeyVersion(v => v + 1)}
      />

      {/* Reset confirmation dialog */}
      {showResetConfirm && (
        <div className="confirm-overlay" onClick={() => setShowResetConfirm(false)}>
          <div className="confirm-dialog" onClick={e => e.stopPropagation()}>
            <p>All charts will be deleted and cannot be undone.<br/>Reset?</p>
            <div className="confirm-buttons">
              <button className="confirm-btn confirm-yes" onClick={() => {
                setChartObjects([])
                setSelectedChartIds([])
                setNextChartId(1)
                setSelectedElement(null)
                setSelectedElements([])
                setActiveDataSourceId(null)
                setSelectedChartType(null)
                localStorage.removeItem('chart-authoring-state')
                setShowResetConfirm(false)
              }}>Yes</button>
              <button className="confirm-btn confirm-no" onClick={() => setShowResetConfirm(false)}>No</button>
            </div>
          </div>
        </div>
      )}

      {/* Spec Import Modal */}
      {showSpecImport && (
        <div className="confirm-overlay" onClick={() => setShowSpecImport(false)}>
          <div className="spec-import-modal" onClick={e => e.stopPropagation()}>
            <h3>Import Vega-Lite Spec</h3>
            <textarea
              className="spec-import-textarea"
              value={specImportText}
              onChange={(e) => { setSpecImportText(e.target.value); setSpecImportError(null) }}
              placeholder='{"$schema": "https://vega.github.io/schema/vega-lite/v6.json", "mark": "bar", ...}'
            />
            <input
              type="file"
              accept=".json"
              ref={specImportFileRef}
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files[0]
                if (!file) return
                const reader = new FileReader()
                reader.onload = (ev) => { setSpecImportText(ev.target.result); setSpecImportError(null) }
                reader.readAsText(file)
                e.target.value = ''
              }}
            />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
              <button className="spec-copy-btn" onClick={() => specImportFileRef.current?.click()}>Upload JSON file</button>
              <div style={{ flex: 1 }} />
              <button className="confirm-btn confirm-no" onClick={() => setShowSpecImport(false)}>Cancel</button>
              <button className="confirm-btn confirm-yes" onClick={handleSpecImport}>Import</button>
            </div>
            {specImportError && (
              <p style={{ color: '#e74c3c', fontSize: 12, marginTop: 4 }}>{specImportError}</p>
            )}
          </div>
        </div>
      )}

      {/* Toast notification */}
      {toastMessage && (
        <div className="toast-notification">{toastMessage}</div>
      )}
    </div>
  )
}

export default App
