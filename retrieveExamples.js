// Runtime retrieval for example-injection RAG. Synchronous, dependency-free,
// NO network. Loads chartExamples.json once at module load.
//
// Phase 1 = keyword/category scoring (English whitespace + Korean substring).
// embedAndRank is a stub for a future embedding upgrade — intentionally NOT wired.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let EXAMPLES = []
try {
  EXAMPLES = JSON.parse(fs.readFileSync(path.join(__dirname, 'chartExamples.json'), 'utf8'))
  console.log(`[retrieveExamples] loaded ${EXAMPLES.length} examples`)
} catch (e) {
  console.warn('[retrieveExamples] chartExamples.json not found — run scripts/buildExamples.mjs. Retrieval disabled.')
}

// Category trigger terms (english + korean) — weaker signal than keyword hits.
const CATEGORY_TERMS = {
  distribution: ['distribution', 'violin', 'density', 'boxplot', 'box plot', 'histogram', 'ridgeline', 'spread',
                 '분포', '바이올린', '밀도', '박스플롯', '히스토그램', '리지라인'],
  trendline:    ['trend', 'trendline', 'regression', 'loess', 'fit line',
                 '추세선', '추세', '회귀', '경향'],
  annotation:   ['annotation', 'highlight', 'background', 'region', 'rect', 'rule', 'reference line', 'shade', 'mark area',
                 '강조', '배경', '영역', '주석', '표시', '구간'],
  layout:       ['facet', 'trellis', 'grid', 'small multiple', 'split', 'per ',
                 '패싯', '격자', '나누기', '분할', '별로'],
  multiseries:  ['series', 'grouped', 'stacked', 'multiple', 'by category',
                 '시리즈', '다중', '그룹', '여러'],
  color:        ['color', 'colour', 'legend', 'scheme', 'gradient', 'palette',
                 '색', '색상', '범례', '컬러'],
  axis:         ['axis', 'label', 'rotate', 'tick', 'log scale', 'sort',
                 '축', '라벨', '회전', '눈금', '정렬'],
  basic:        ['bar', 'line', 'scatter', 'point', 'area', 'pie',
                 '막대', '선', '산점도', '점', '면적', '파이'],
}

const isCJK = (s) => /[　-〿㄰-㆏가-힯一-鿿]/.test(s)

function tokenMatches(term, command) {
  const t = term.toLowerCase()
  if (!t) return false
  if (isCJK(t)) return command.includes(t)              // korean/cjk: substring
  // ascii: word-ish boundary to avoid 'bar' matching 'barley' etc.
  return new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(command)
}

function scoreExample(ex, command) {
  let score = 0
  for (const kw of (ex.keywords || [])) {
    if (tokenMatches(kw, command)) score += 2
  }
  for (const term of (CATEGORY_TERMS[ex.category] || [])) {
    if (tokenMatches(term, command)) { score += 1; break }   // category counted once
  }
  return score
}

const specSize = (ex) => JSON.stringify(ex.spec).length

/**
 * retrieveExamples(userCommand, { topK }) → array of example entries.
 * Returns top scoring examples (score > 0). If nothing scores, returns a small
 * default layered set so the model always sees well-formed layered structure.
 */
export function retrieveExamples(userCommand, { topK = 3 } = {}) {
  if (!EXAMPLES.length) return []
  const command = String(userCommand || '').toLowerCase()

  const scored = EXAMPLES
    .map(ex => ({ ex, score: scoreExample(ex, command) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || specSize(a.ex) - specSize(b.ex))   // tie-break: simpler spec

  if (!scored.length) return defaultSet()
  return scored.slice(0, topK).map(s => s.ex)
}

// Always-valid fallback: one layered bar + one layered line if present.
function defaultSet() {
  const pick = (id) => EXAMPLES.find(e => e.id === id)
  const fallbacks = [pick('bar'), pick('line') || pick('line_color_label')].filter(Boolean)
  if (fallbacks.length) return fallbacks
  // last resort: two simplest basics
  return EXAMPLES.filter(e => e.category === 'basic').sort((a, b) => specSize(a) - specSize(b)).slice(0, 2)
}

/**
 * Format retrieved examples as a prompt block. Reference, not output — the
 * caller injects this AFTER rules, BEFORE the task.
 */
export function formatExamplesForPrompt(examples) {
  if (!examples || !examples.length) return ''
  const anyPlaceholder = examples.some(e => e._placeholderFields)
  const header =
    'RELEVANT EXAMPLE SPECS (validated; follow the required conventions — ADAPT to ' +
    "the user's data and request; do NOT copy verbatim." +
    (anyPlaceholder ? ' Where a field shows __FIELD__, substitute a real numeric column from the data.' : '') +
    '):'
  const blocks = examples.map((e, i) =>
    `Example ${i + 1} — ${e.intent}:\n${JSON.stringify(e.spec, null, 2)}`
  )
  return `${header}\n\n${blocks.join('\n\n')}`
}

// ── future upgrade stub (do NOT wire now — adds latency/cost) ────────────────
// Swap in by replacing the scored= computation in retrieveExamples with this.
// eslint-disable-next-line no-unused-vars
export async function embedAndRank(userCommand, { topK = 3 } = {}) {
  throw new Error('embedAndRank not implemented — Phase 1 uses keyword scoring')
}
