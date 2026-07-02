// Render a Vega-Lite spec (with the chart's svgOverrides applied) to a PNG data URL.
// Used at "Save to Gallery" time so example thumbnails are a fixed raster with the
// correct aspect ratio, instead of being re-rendered (which distorts proportions).

import vegaEmbed from 'vega-embed'

const SVG_ATTR_MAP = {
  fill: 'fill', stroke: 'stroke', strokeWidth: 'stroke-width', opacity: 'opacity',
  strokeDasharray: 'stroke-dasharray', fontSize: 'font-size', fontWeight: 'font-weight', color: 'fill',
}

// Compact port of Canvas.applySvgOverrides — enough to reproduce the final look.
function applySvgOverrides(svg, overrides) {
  if (!svg || !overrides) return
  for (const [selector, props] of Object.entries(overrides)) {
    let els
    try { els = svg.querySelectorAll(selector) } catch { continue }
    els.forEach(el => {
      for (const [k, v] of Object.entries(props)) {
        if (k === 'transform') { el.setAttribute('transform', v); continue }
        if (k === 'dx' || k === 'dy') {
          if (el.dataset.origTransform == null) el.dataset.origTransform = el.getAttribute('transform') || ''
          const dx = parseFloat(props.dx) || 0, dy = parseFloat(props.dy) || 0
          el.setAttribute('transform', (dx || dy) ? `${el.dataset.origTransform} translate(${dx},${dy})`.trim() : el.dataset.origTransform)
          continue
        }
        if (k === 'text' && el.tagName.toLowerCase() === 'text') { el.textContent = v; continue }
        const attr = SVG_ATTR_MAP[k]
        if (!attr) continue
        if (k === 'strokeDasharray' && v === 'solid') { el.removeAttribute('stroke-dasharray'); continue }
        el.setAttribute(attr, v)
        if (['fill', 'stroke', 'opacity', 'font-weight', 'font-size'].includes(attr)) {
          const existing = el.getAttribute('style') || ''
          const cleaned = existing.split(';').filter(s => !s.trim().startsWith(attr)).join(';')
          el.setAttribute('style', `${cleaned};${attr}:${v}`.replace(/^;/, ''))
        }
      }
    })
  }
}

// Rasterize an SVG DOM node to a PNG data URL. A viewBox is set so the browser can
// determine the image's intrinsic aspect ratio (without it, an SVG data URL loaded into
// an <img> falls back to 300×150 and gets stretched → distorted thumbnails).
async function rasterizeSvg(svg, scale) {
  const w = parseFloat(svg.getAttribute('width')) || svg.getBoundingClientRect().width || 400
  const h = parseFloat(svg.getAttribute('height')) || svg.getBoundingClientRect().height || 300
  svg.setAttribute('width', String(w))
  svg.setAttribute('height', String(h))
  if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
  if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')

  const xml = new XMLSerializer().serializeToString(svg)
  const svgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml)
  return await new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(w * scale))
        canvas.height = Math.max(1, Math.round(h * scale))
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/png'))
      } catch (e) { reject(e) }
    }
    img.onerror = reject
    img.src = svgUrl
  })
}

/**
 * @param {object} spec  Vega-Lite spec (should already carry data.values)
 * @param {object} opts  { svgOverrides, scale }
 * @returns {Promise<string|null>} PNG data URL, or null on failure
 */
export async function renderChartPng(spec, { svgOverrides, scale = 2 } = {}) {
  const holder = document.createElement('div')
  holder.style.cssText = 'position:fixed;left:-99999px;top:-99999px;pointer-events:none;opacity:0;'
  document.body.appendChild(holder)
  let view
  try {
    const res = await vegaEmbed(holder, spec, { actions: false, renderer: 'svg', config: { background: 'white' } })
    view = res.view
    const hasOverrides = svgOverrides && Object.keys(svgOverrides).length > 0

    // No manual overrides → use Vega's own exporter (correct size + aspect, no SVG-load quirks).
    if (!hasOverrides && view?.toImageURL) {
      try { return await view.toImageURL('png', scale) } catch { /* fall through to SVG path */ }
    }

    // Overrides present (or exporter unavailable): apply them to the SVG DOM and rasterize.
    const svg = holder.querySelector('svg')
    if (!svg) return null
    if (hasOverrides) applySvgOverrides(svg, svgOverrides)
    await new Promise(r => requestAnimationFrame(r))
    return await rasterizeSvg(svg, scale)
  } catch {
    return null
  } finally {
    try { view?.finalize() } catch { /* noop */ }
    holder.remove()
  }
}
