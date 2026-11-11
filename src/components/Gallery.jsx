import { applySvgTransformOverrides } from '../utils/svgTransform'
import { useState, useEffect, useMemo, useRef } from 'react'
import { GALLERY_EXAMPLES } from '../data/galleryExamples.js'
import './Gallery.css'
import FeatureIllustrations from './FeatureIllustrations'

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
  strokeDasharray: 'stroke-dasharray', fontSize: 'font-size', font: 'font-family', fontWeight: 'font-weight', color: 'fill',
}
function applySvgOverrides(svg, overrides) {
  if (!svg || !overrides) return
  for (const [selector, props] of Object.entries(overrides)) {
    let els
    try { els = svg.querySelectorAll(selector) } catch { continue }
    els.forEach(el => {
      applySvgTransformOverrides(el, props)
      for (const [k, v] of Object.entries(props)) {
        if (k === 'childrenFont') {
          el.querySelectorAll('text').forEach(text => {
            text.setAttribute('font-family', v)
            text.style.setProperty('font-family', v)
          })
          continue
        }
        if (['transform', 'angle', 'dx', 'dy'].includes(k)) continue
        if (k === 'text' && el.tagName.toLowerCase() === 'text') { el.textContent = v; continue }
        const attr = SVG_ATTR_MAP[k]
        if (!attr) continue
        if (k === 'strokeDasharray' && v === 'solid') { el.removeAttribute('stroke-dasharray'); continue }
        el.setAttribute(attr, v)
        if (k === 'font') el.style.setProperty('font-family', v)
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
    import('vega-embed').then(({ default: vegaEmbed }) => vegaEmbed(el, spec, { actions: false, renderer: 'svg', config: { background: 'white' } }))
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
  const [examples] = useState(loadExamples)
  const total = examples.length

  const open = (id) => {
    const params = new URLSearchParams(window.location.search)
    params.set('gallery', '')
    params.set('example', id)
    window.location.search = '?' + params.toString()
  }

  return (
    <div className="gallery-root">
      <div className="gallery-grid-view">
        <nav className="project-nav" aria-label="Main navigation">
          <a className="project-wordmark" href="?gallery">TailVis</a>
          <div><a href="#overview">Overview</a><a href="#examples">Gallery</a><a href="?demo">Try demo <span aria-hidden="true">↗</span></a></div>
        </nav>
        <section className="project-hero" aria-labelledby="project-title">
          <h1 id="project-title"><b>TailVis</b>: Expressive Chart Refinement<br /><span>Preserving Data-Binding Integrity</span></h1>
          <div className="project-intro">
            <p>Refine charts through direct selection, natural-language requests, and reusable widgets while preserving their connection to the data.</p>
            <div className="project-actions">
              <div className="project-action">
                <a className="project-primary" href="?demo">Try demo</a>
                <p>Try hands-on refinement with prepared requests.</p>
              </div>
            </div>
          </div>
        </section>
        <section id="overview" className="project-overview" aria-labelledby="overview-title">
          <div className="project-video">
            <video controls playsInline preload="metadata" aria-label="TailVis demonstration">
              <source src={`${import.meta.env.BASE_URL}media/tailvis-demo.mp4`} type="video/mp4" />
              Your browser does not support embedded video.
            </video>
          </div>
          <div className="project-overview-copy">
            <h2 id="overview-title">How TailVis works</h2>
            <FeatureIllustrations />
          </div>
        </section>
        <section id="examples" className="project-gallery-intro" aria-labelledby="gallery-title">
          <h2 id="gallery-title">Gallery</h2>
          <p>Browse finished examples and follow their refinement histories.<br />Select a chart below to explore it in a read-only view.</p>
        </section>
        {total === 0 ? (
          <div className="gallery-empty big">
            No examples yet.<br />
            In the editor, select a chart’s tree and click <b>Save to Gallery</b> to freeze it here.
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
                      <span className="gallery-badge">{count} chart{count === 1 ? '' : 's'} in the history</span><span className="gallery-card-open" aria-hidden="true">Explore ↗</span>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        )}
        <section id="full-system" className="project-full-system" aria-labelledby="system-title">
          <div>
            <span className="project-eyebrow">Go further</span>
            <h2 id="system-title">Work with your own charts.</h2>
            <p>Open the full editor to use your own data and explore free-form refinement.</p>
            <p className="project-system-note">AI features require a connected backend with an Anthropic API key.</p>
          </div>
          <a href="?system">Open full system <span aria-hidden="true">↗</span></a>
        </section>
        <footer className="project-footer">
          <div><span>TailVis</span><p className="project-paper"><a href="https://arxiv.org/abs/2607.25386" target="_blank" rel="noreferrer">Paper ↗</a> · Expressive Chart Refinement Preserving Data-Binding Integrity</p></div>
          <a href="https://github.com/tailvis/TailVis" target="_blank" rel="noreferrer">Source code ↗</a>
        </footer>
      </div>
    </div>
  )
}
