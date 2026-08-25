// Build-time extractor: pulls Vega-Lite example specs from the vega-lite GitHub
// repo, normalizes them to this system's conventions, dedupes, validates with
// vl.compile, tags with keywords/category, and writes chartExamples.json.
//
// RUN:  node scripts/buildExamples.mjs
// This is BUILD-TIME only. No LLM calls. Runtime retrieval never touches network.
//
// Two sources, merged into one chartExamples.json:
//   1. vega-lite GitHub examples/specs (fetched live below).
//   2. scripts/altairSpecs.json — a curated set of Altair-gallery charts the
//      vega-lite repo lacks (heatmap, bump, candlestick, streamgraph, dumbbell,
//      parallel coords, CI band, rolling mean, ...). Altair charts are Python
//      that emit Vega-Lite via chart.to_dict(), so once converted they flow
//      through the SAME normalize/compile/tag pipeline. See mergeAltairCurated().

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import * as vl from 'vega-lite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, '..', 'chartExamples.json')

const SCHEMA = 'https://vega.github.io/schema/vega-lite/v6.json'
const LIST_API = 'https://api.github.com/repos/vega/vega-lite/contents/examples/specs?ref=main'
const RAW_BASE = 'https://raw.githubusercontent.com/vega/vega-lite/main/examples/specs/'

const PER_CATEGORY_CAP = 12          // no single category dominates
const PER_MARK_SUBCAP = 4            // within a category, diversify mark types (avoid 12 bars)
const TARGET_MAX = 80                 // overall ceiling after dedupe

// Names that teach the wrong thing / aren't real chart patterns.
const NAME_EXCLUDE = /invalid|_test\b|^test_|debug|deprecated|issue|regression_test/i

// Upstream examples that violate the LAYER OVERLAY INVARIANT (see server.js prompt):
// an appended layer aggregates a SHARED axis channel, so vl.compile concatenates the
// base + overlay axis titles into a corrupted "title, title" (verified by compile).
// Served as RAG, they teach the exact anti-pattern and override the invariant — so we
// exclude them by id. NOTE: this is NOT a general structural filter — auto-detecting
// "bad overlay" is unreliable (legit fold charts have intentional "a, b" combined
// titles), so we only denylist examples proven corrupt + highly retrieved.
const INVARIANT_VIOLATORS = new Set([
  'line_last_value_label', // y-axis compiles to "price, price for max date"
])

// ─── fetch helpers (concurrency pool, build-time only) ──────────────────────

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'chart-authoring-build' } })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.json()
}

async function pool(items, size, worker) {
  const out = new Array(items.length)
  let i = 0
  const runners = Array.from({ length: size }, async () => {
    while (i < items.length) {
      const idx = i++
      try { out[idx] = await worker(items[idx], idx) }
      catch (e) { out[idx] = { __error: e.message, name: items[idx]?.name } }
    }
  })
  await Promise.all(runners)
  return out
}

// ─── spec structure helpers ─────────────────────────────────────────────────

const MULTIVIEW_KEYS = ['concat', 'hconcat', 'vconcat', 'facet', 'repeat']
const isMultiView = (s) => MULTIVIEW_KEYS.some(k => k in s)
const hasFacetChannel = (enc) => !!(enc && (enc.row || enc.column || enc.facet))

const markType = (m) => (typeof m === 'string' ? m : m?.type)

// Collect mark types, channel names, transform types from a (possibly layered) spec.
function structuralFingerprint(spec) {
  const marks = new Set(), channels = new Set(), transforms = new Set()
  const units = spec.layer ? spec.layer : [spec]
  for (const u of units) {
    const mt = markType(u.mark)
    if (mt) marks.add(mt)
    for (const ch of Object.keys(u.encoding || {})) channels.add(ch)
  }
  for (const t of (spec.transform || [])) {
    for (const k of Object.keys(t)) {
      if (['density', 'regression', 'loess', 'aggregate', 'window', 'fold',
           'filter', 'calculate', 'bin', 'timeUnit', 'stack', 'quantile',
           'pivot', 'flatten', 'joinaggregate', 'impute'].includes(k)) transforms.add(k)
    }
  }
  return [
    [...marks].sort().join(','),
    [...channels].sort().join(','),
    [...transforms].sort().join(','),
  ].join('|')
}

// ─── normalization ──────────────────────────────────────────────────────────

// Density/KDE-family fields are data-dependent; mark the source field with a
// placeholder so the runtime layer/model substitutes a real numeric column.
const FIELD = '__FIELD__'

function blankData(spec) {
  // Top-level data → empty values (frontend injects real data). Drop url.
  if (spec.data) spec.data = { values: [] }
  else spec.data = { values: [] }
}

function normalize(rawSpec, name) {
  // Work on a clone.
  let spec = JSON.parse(JSON.stringify(rawSpec))

  // Drop multi-view top-level operators (don't fit single-layered structure).
  if (isMultiView(spec)) return { drop: 'multiview' }

  // Drop interactive-core specs (selection/params driven). Strip benign params.
  if (Array.isArray(spec.params) && spec.params.some(p => p.select)) return { drop: 'interactive' }
  delete spec.params

  spec.$schema = SCHEMA

  // Density-family detection (violin / ridgeline / stacked density). Scan BOTH the
  // top-level transform AND per-layer transforms — a violin with an overlaid point
  // strip must scope its density to the violin layer (else the points get aggregated
  // too), so the density transform lives inside that layer, not at the top level.
  const placeholderFields = []
  let isDensity = false
  const scanDensity = (transforms) => {
    for (const t of (transforms || [])) {
      if (t.density) { isDensity = true; placeholderFields.push(t.density); t.density = FIELD }
      if (t.regression) { /* trendline source field kept; not blanked */ }
    }
  }
  // Walk the whole spec tree: top-level, layers, and the inner spec of a facet
  // operator ({facet, spec}). A violin+points chart scopes density to its layer,
  // and a faceted layered chart nests that under spec.spec.layer.
  const walkDensity = (node) => {
    if (!node || typeof node !== 'object') return
    scanDensity(node.transform)
    if (Array.isArray(node.layer)) node.layer.forEach(walkDensity)
    if (node.spec) walkDensity(node.spec)
  }
  walkDensity(spec)

  // Layer-wrap bare unit specs — BUT not faceted units (row/column/facet
  // channels can't live inside a layer; keep those as valid faceted unit specs).
  if (spec.mark && spec.encoding) {
    if (hasFacetChannel(spec.encoding)) {
      // keep as-is (valid faceted unit spec — shows correct facet structure)
    } else {
      const { mark, encoding, ...rest } = spec
      spec = { ...rest, layer: [{ mark, encoding }] }
    }
  }

  blankData(spec)

  const result = { spec }
  if (placeholderFields.length) {
    result.isDensity = true   // tracked on the entry, NOT inside the spec (keeps injected spec valid)
  }
  return result
}

// ─── tagging ────────────────────────────────────────────────────────────────

const CATEGORY_RULES = [
  // [category, predicate]
  ['distribution', (s, f) => /density|boxplot|histogram|errorband|errorbar|violin|ridge|tick|quantile|strip/.test(f)],
  ['trendline',    (s, f) => /regression|loess|trend/.test(f) || (s.transform || []).some(t => t.regression || t.loess)],
  ['annotation',   (s, f) => /rect|rule|text|annotation|highlight|threshold|mean_overlay|layer_/.test(f) ||
                              fpMarks(s).some(m => ['rect', 'rule', 'text'].includes(m))],
  ['layout',       (s, f) => /trellis|facet|row|column|grid/.test(f) || hasFacetChannel(unitEnc(s))],
  ['multiseries',  (s, f) => /multi|series|grouped|stacked/.test(f) || hasColorSeries(s)],
  ['color',        (s, f) => /color|scheme|gradient|legend/.test(f)],
  ['axis',         (s, f) => /axis|label|tick|angle|log|sort/.test(f)],
  ['basic',        () => true],
]

function fpMarks(spec) {
  const units = spec.layer ? spec.layer : [spec]
  return units.map(u => markType(u.mark)).filter(Boolean)
}
function unitEnc(spec) {
  const units = spec.layer ? spec.layer : [spec]
  return units[0]?.encoding
}
function hasColorSeries(spec) {
  const units = spec.layer ? spec.layer : [spec]
  return units.some(u => u.encoding?.color?.field && (u.encoding.color.type === 'nominal' || u.encoding.color.type === 'ordinal'))
}

function categorize(spec, name) {
  for (const [cat, pred] of CATEGORY_RULES) {
    try { if (pred(spec, name)) return cat } catch { /* skip */ }
  }
  return 'basic'
}

// Korean synonyms by category + intent — so CJK user commands retrieve well.
const KO_SYNONYMS = {
  // NOTE: 'violin' intentionally NOT here — density curves aren't true violins;
  // the dedicated curated `violin_plot` (altairSpecs.json) owns those terms.
  distribution: ['분포', '밀도', '박스플롯', '히스토그램', '리지라인'],
  trendline:    ['추세선', '추세', '회귀', '경향'],
  annotation:   ['강조', '배경', '영역', '주석', '표시', '구간'],
  layout:       ['패싯', '격자', '나누기', '분할'],
  multiseries:  ['여러', '시리즈', '다중', '그룹'],
  color:        ['색', '색상', '범례', '컬러'],
  axis:         ['축', '라벨', '회전', '눈금'],
  // NOTE: no mark-type words here — 'basic' mixes bar/line/point/area, so blanket
  // synonyms would wrongly tag every bar as scatter. Per-mark keywords are added
  // in deriveKeywords() based on the actual mark instead.
  basic:        ['기본'],
}

function deriveKeywords(spec, name, category) {
  const kw = new Set()
  // filename tokens
  for (const tok of name.replace(/\.vl\.json$/, '').split(/[_\-]/)) {
    if (tok.length > 1) kw.add(tok.toLowerCase())
  }
  // marks + transforms + channels
  for (const m of fpMarks(spec)) kw.add(m)
  for (const t of (spec.transform || [])) for (const k of Object.keys(t)) kw.add(k.toLowerCase())
  const enc = unitEnc(spec) || {}
  for (const ch of Object.keys(enc)) kw.add(ch.toLowerCase())
  // density → violin alias
  if ((spec.transform || []).some(t => t.density === FIELD)) {
    // density/KDE curve — NOT a violin (no center-stack mirror); 'violin' is reserved
    // for the dedicated curated violin_plot so it wins that query.
    ['density', 'distribution', 'ridgeline'].forEach(k => kw.add(k))
  }
  // mark-aware aliases (esp. scatter — point/circle with quantitative x & y)
  const marks = fpMarks(spec)
  if (marks.some(m => ['point', 'circle'].includes(m)) &&
      enc.x?.type === 'quantitative' && enc.y?.type === 'quantitative') {
    ['scatter', 'scatterplot', '산점도', '점'].forEach(k => kw.add(k))
  }
  if (marks.includes('bar')) ['막대', 'bar'].forEach(k => kw.add(k))
  if (marks.includes('line')) ['선', 'line', '추이'].forEach(k => kw.add(k))
  if (marks.includes('area')) ['면적', 'area'].forEach(k => kw.add(k))
  if (marks.includes('arc')) ['파이', 'pie', 'donut', '도넛'].forEach(k => kw.add(k))
  // korean synonyms
  for (const k of (KO_SYNONYMS[category] || [])) kw.add(k)
  return [...kw]
}

function intentOf(spec, name) {
  if (spec.title) return typeof spec.title === 'string' ? spec.title : (spec.title.text || name)
  if (spec.description) return spec.description
  return name.replace(/\.vl\.json$/, '').replace(/[_\-]/g, ' ')
}

// ─── compile check ──────────────────────────────────────────────────────────

function compiles(spec) {
  // For the compile check only: swap placeholder field + give a dummy datum so
  // structural validity (not data) is what we test.
  const probe = JSON.parse(JSON.stringify(spec))
  delete probe._placeholderFields
  const asStr = JSON.stringify(probe).replace(new RegExp(FIELD, 'g'), 'probeField')
  const test = JSON.parse(asStr)
  if (test.data) test.data = { values: [{ probeField: 1 }] }
  try { vl.compile(test); return { ok: true } }
  catch (e) { return { ok: false, error: e.message } }
}

// ─── curated Altair merge ─────────────────────────────────────────────────────

const ALTAIR_FILE = path.join(__dirname, 'altairSpecs.json')
const ALTAIR_MAX = 20   // separate, additive quota — does not eat vega-lite slots

function mergeAltairCurated(examples, stats) {
  let curated
  try {
    curated = JSON.parse(fs.readFileSync(ALTAIR_FILE, 'utf8'))
  } catch {
    console.log('\n[altair] scripts/altairSpecs.json absent — skipping curated merge')
    return
  }
  const astats = { compileFail: 0, dropped: 0, kept: 0 }
  const existingIds = new Set(examples.map(e => e.id))
  for (const item of curated) {
    if (astats.kept >= ALTAIR_MAX) break
    if (!item?.spec || existingIds.has(item.id)) { astats.dropped++; continue }
    const norm = normalize(item.spec, item.id)
    if (norm.drop) { astats.dropped++; continue }
    const spec = norm.spec
    const chk = compiles(spec)
    if (!chk.ok) { astats.compileFail++; console.log('  [altair] compile-fail', item.id, '::', chk.error?.slice(0, 100)); continue }
    const category = item.category || categorize(spec, item.id)
    const entry = {
      id: item.id,
      source: 'altair',
      category,
      keywords: (item.keywords && item.keywords.length) ? item.keywords : deriveKeywords(spec, item.id, category),
      intent: item.intent || intentOf(spec, item.id),
      spec,
    }
    if (norm.isDensity) entry._placeholderFields = [FIELD]
    examples.push(entry)
    existingIds.add(item.id)
    astats.kept++
  }
  stats.altairKept = astats.kept
  console.log('\n[altair] curated merge:', astats)
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('Listing vega-lite examples/specs ...')
  const listing = await fetchJson(LIST_API)
  const names = listing.filter(e => e.name.endsWith('.vl.json')).map(e => e.name)
  console.log(`Found ${names.length} .vl.json files. Fetching ...`)

  const fetched = await pool(names, 16, async (name) => {
    const res = await fetch(RAW_BASE + name, { headers: { 'User-Agent': 'chart-authoring-build' } })
    if (!res.ok) throw new Error(`${res.status}`)
    return { name, spec: await res.json() }
  })

  const stats = { fetchErr: 0, excluded: 0, multiview: 0, interactive: 0, compileFail: 0, dup: 0, kept: 0 }
  const byCategory = {}
  const byCatMark = {}
  const seen = new Set()
  const examples = []
  const dropped = []

  for (const item of fetched) {
    if (!item || item.__error) { stats.fetchErr++; continue }
    const { name, spec: raw } = item
    if (NAME_EXCLUDE.test(name)) { stats.excluded++; continue }
    if (INVARIANT_VIOLATORS.has(name.replace(/\.vl\.json$/, ''))) { stats.excluded++; continue }
    const norm = normalize(raw, name)
    if (norm.drop) { stats[norm.drop]++; continue }

    const spec = norm.spec
    const chk = compiles(spec)
    if (!chk.ok) { stats.compileFail++; dropped.push({ name, error: chk.error?.slice(0, 120) }); continue }

    const fp = structuralFingerprint(spec)
    if (seen.has(fp)) { stats.dup++; continue }

    const category = categorize(spec, name)
    if ((byCategory[category] || 0) >= PER_CATEGORY_CAP) { continue }
    // diversify mark types within a category so 'basic' isn't 12 bars
    const primaryMark = (fpMarks(spec)[0] || 'none')
    const cmKey = `${category}|${primaryMark}`
    if ((byCatMark[cmKey] || 0) >= PER_MARK_SUBCAP) { continue }
    if (examples.length >= TARGET_MAX) break

    seen.add(fp)
    byCategory[category] = (byCategory[category] || 0) + 1
    byCatMark[cmKey] = (byCatMark[cmKey] || 0) + 1
    const entry = {
      id: name.replace(/\.vl\.json$/, ''),
      source: 'vega-lite',
      category,
      keywords: deriveKeywords(spec, name, category),
      intent: intentOf(spec, name),
      spec,
    }
    if (norm.isDensity) entry._placeholderFields = [FIELD]
    examples.push(entry)
    stats.kept++
  }

  // ─── merge curated Altair-gallery specs (optional, build-time) ─────────────
  // Appended AFTER the vega-lite source so they only ADD coverage. This is a
  // hand-picked novelty set, so we deliberately DON'T run it through the coarse
  // structural dedup above (which keys only on marks|channels|transforms and
  // would wrongly drop e.g. streamgraph as "just an area chart"). Each curated
  // entry may carry its own category/keywords/intent; otherwise we auto-derive.
  // Counted against a SEPARATE quota so it never displaces vega-lite examples.
  mergeAltairCurated(examples, stats)

  fs.writeFileSync(OUT, JSON.stringify(examples, null, 2))

  console.log('\n=== BUILD SUMMARY ===')
  console.log('stats:', stats)
  console.log('by category:', byCategory)
  const bySource = examples.reduce((a, e) => ((a[e.source] = (a[e.source] || 0) + 1), a), {})
  console.log('by source:', bySource)
  console.log(`kept ${examples.length} → ${OUT}`)
  if (dropped.length) {
    console.log(`\ndropped (compile-fail) ${dropped.length}:`)
    for (const d of dropped.slice(0, 15)) console.log('  -', d.name, '::', d.error)
  }
  // sanity: is the violin/density case present?
  const dens = examples.filter(e => e._placeholderFields)
  console.log(`\ndensity/violin examples kept: ${dens.length} ->`, dens.map(d => d.id).join(', '))
}

main().catch(e => { console.error('BUILD FAILED:', e); process.exit(1) })
