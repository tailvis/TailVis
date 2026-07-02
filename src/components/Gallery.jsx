import { useState, useEffect, useMemo, useRef } from 'react'
import vegaEmbed from 'vega-embed'
import { GALLERY_EXAMPLES } from '../data/galleryExamples.js'
import './Gallery.css'

// ──────────────────────────────────────────────────────────────────────────
// Example gallery — a grid of FROZEN examples (saved from the editor via
// "Save to Gallery"). Clicking a card opens the real editor read-only, scoped
// to that example's lineage tree (?gallery&example=<id>, handled in main.jsx).
// This component only lists/deletes examples; it never reflects live edits.
// ──────────────────────────────────────────────────────────────────────────

const GALLERY_KEY = 'chart-authoring-gallery'

const BUNDLED_IDS = new Set(GALLERY_EXAMPLES.map(e => e.id))
function loadExamples() {
  // Bundled (shipped in the repo) examples first, then user-saved ones from localStorage.
  let ls = []
  try {
    const list = JSON.parse(localStorage.getItem(GALLERY_KEY) || '[]')
    if (Array.isArray(list)) ls = list.filter(e => !BUNDLED_IDS.has(e.id))
  } catch { /* ignore */ }
  return [...GALLERY_EXAMPLES, ...ls]
}
// The "leaf" chart of a tree makes the best thumbnail (most evolved state).
function leafChart(example) {
  const charts = example.charts || []
  if (!charts.length) return null
  const hasChild = new Set(charts.filter(c => c.parentId != null).map(c => c.parentId))
  return charts.find(c => !hasChild.has(c.id)) || charts[charts.length - 1]
}

function chartRows(example, chart) {
  if (chart?.spec?.data?.values?.length) return chart.spec.data.values
  if (chart?.dataSourceId && example.dataSources?.[chart.dataSourceId]?.values) return example.dataSources[chart.dataSourceId].values
  return example.currentData || []
}

// Compact port of Canvas.applySvgOverrides — reproduce the saved look on thumbnails.
const SVG_ATTR_MAP = {
  fill: 'fill', stroke: 'stroke', strokeWidth: 'stroke-width', opacity: 'opacity',
  strokeDasharray: 'stroke-dasharray', fontSize: 'font-size', fontWeight: 'font-weight', color: 'fill',
}
function applySvgOverrides(svg, overrides) {
  if (!svg || !overrides) return
  for (const [selector, props] of Object.entries(overrides)) {
    let els
    try { els = svg.querySelectorAll(selector) } catch { continue }
    els.forEach(el => {
      for (const [k, v] of Object.entries(props)) {
        if (k === 'transform') { el.setAttribute('transform', v); continue }
        if (k === 'text' && el.tagName.toLowerCase() === 'text') { el.textContent = v; continue }
        const attr = SVG_ATTR_MAP[k]
        if (!attr) continue
        if (k === 'strokeDasharray' && v === 'solid') { el.removeAttribute('stroke-dasharray'); continue }
        el.setAttribute(attr, v)
      }
    })
  }
}

function Thumbnail({ example }) {
  // Prefer the PNG baked at save time — a fixed raster, so the aspect ratio never distorts.
  if (example.thumbnail) {
    return (
      <div className="gallery-mini">
        <img className="gallery-thumb-img" src={example.thumbnail} alt={example.name || 'chart'} />
      </div>
    )
  }
  return <LiveThumbnail example={example} />
}

function LiveThumbnail({ example }) {
  const ref = useRef(null)
  useEffect(() => {
    let view
    const el = ref.current
    const chart = leafChart(example)
    if (!el || !chart?.spec) { if (el) el.innerHTML = '<div class="gallery-mini-err">no chart</div>'; return }
    const spec = JSON.parse(JSON.stringify(chart.spec))
    if (!spec.data?.values?.length) spec.data = { values: chartRows(example, chart) }
    delete spec.width; delete spec.height
    vegaEmbed(el, spec, { actions: false, renderer: 'svg', config: { background: 'white' } })
      .then(r => {
        view = r.view
        const svg = el.querySelector('svg')
        if (svg) {
          if (chart.svgOverrides) applySvgOverrides(svg, chart.svgOverrides)
          svg.removeAttribute('width'); svg.removeAttribute('height')
          svg.style.maxWidth = '100%'; svg.style.height = 'auto'
        }
      })
      .catch(() => { el.innerHTML = '<div class="gallery-mini-err">⚠ render error</div>' })
    return () => { try { view?.finalize() } catch { /* noop */ } }
  }, [example])
  return <div className="gallery-mini" ref={ref} />
}

export default function Gallery() {
  const [examples, setExamples] = useState(loadExamples)
  const total = examples.length

  const open = (id) => {
    const params = new URLSearchParams(window.location.search)
    params.set('example', id)
    window.location.search = '?' + params.toString()
  }

  return (
    <div className="gallery-root">
      <div className="gallery-grid-view">
        <header className="gallery-grid-head">
          <div className="gallery-grid-head-text">
            <h1>TailVis Example Gallery</h1>
            <p className="gallery-grid-sub">
              {total} example{total === 1 ? '' : 's'} · click to open a read-only, selectable view.
            </p>
          </div>
          <button
            className="gallery-system-btn"
            title="Open the TailVis editor"
            onClick={() => { window.location.search = '' }}
          >
            System →
          </button>
        </header>

        {total === 0 ? (
          <div className="gallery-empty big">
            No examples yet.<br />
            In the editor, select a chart’s tree and click <b>☆ Save to Gallery</b> to freeze it here.
          </div>
        ) : (
          <div className="gallery-grid">
            {examples.map(ex => {
              const count = (ex.charts || []).length
              return (
                <button className="gallery-card" key={ex.id} onClick={() => open(ex.id)}>
                  <Thumbnail example={ex} />
                  <div className="gallery-card-body">
                    <div className="gallery-card-title">{ex.name || 'Untitled'}</div>
                    <div className="gallery-card-meta">
                      <span className="gallery-badge">{count} chart{count === 1 ? '' : 's'}</span>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
