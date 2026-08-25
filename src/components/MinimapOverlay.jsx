import React, { useMemo, useCallback } from 'react'
import './MinimapOverlay.css'

const MINIMAP_WIDTH = 120
const MINIMAP_HEIGHT = 80

function MinimapOverlay({ chartObjects, transform, canvasWidth, canvasHeight, onPan }) {
  const bounds = useMemo(() => {
    if (chartObjects.length === 0) return { minX: 0, minY: 0, maxX: 800, maxY: 600 }
    const minX = Math.min(...chartObjects.map(c => c.x)) - 50
    const minY = Math.min(...chartObjects.map(c => c.y)) - 50
    const maxX = Math.max(...chartObjects.map(c => c.x + (c.width || 480))) + 50
    const maxY = Math.max(...chartObjects.map(c => c.y + (c.height || 350))) + 50
    return { minX, minY, maxX, maxY }
  }, [chartObjects])

  const worldW = bounds.maxX - bounds.minX
  const worldH = bounds.maxY - bounds.minY
  const scaleX = MINIMAP_WIDTH / worldW
  const scaleY = MINIMAP_HEIGHT / worldH
  const scale = Math.min(scaleX, scaleY)

  const toMini = useCallback((x, y) => ({
    x: (x - bounds.minX) * scale,
    y: (y - bounds.minY) * scale,
  }), [bounds, scale])

  // Viewport rectangle in world space
  const vpMinX = -transform.x / transform.k
  const vpMinY = -transform.y / transform.k
  const vpMaxX = vpMinX + canvasWidth / transform.k
  const vpMaxY = vpMinY + canvasHeight / transform.k

  const vpMini = toMini(vpMinX, vpMinY)
  const vpW = (vpMaxX - vpMinX) * scale
  const vpH = (vpMaxY - vpMinY) * scale

  const handleMouseDown = (e) => {
    e.stopPropagation()
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const panTo = (clientX, clientY) => {
      const miniX = clientX - rect.left
      const miniY = clientY - rect.top
      const worldX = miniX / scale + bounds.minX
      const worldY = miniY / scale + bounds.minY
      const newX = canvasWidth / 2 - worldX * transform.k
      const newY = canvasHeight / 2 - worldY * transform.k
      onPan({ x: newX, y: newY, k: transform.k })
    }
    panTo(e.clientX, e.clientY)
    const onMove = (me) => panTo(me.clientX, me.clientY)
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const actualW = worldW * scale
  const actualH = worldH * scale
  const displayW = Math.max(actualW, MINIMAP_WIDTH)
  const displayH = Math.max(actualH, MINIMAP_HEIGHT)

  // Build parent→child arrow lines
  const arrows = useMemo(() => {
    const result = []
    for (const chart of chartObjects) {
      if (!chart.parentId) continue
      const parent = chartObjects.find(c => c.id === chart.parentId)
      if (!parent) continue
      const pw = parent.width || 480
      const ph = parent.height || 350
      const cw = chart.width || 480
      const ch = chart.height || 350
      // right-center of parent → left-center of child
      const fromX = parent.x + pw
      const fromY = parent.y + ph / 2
      const toX = chart.x
      const toY = chart.y + ch / 2
      result.push({ fromX, fromY, toX, toY, id: `${parent.id}-${chart.id}` })
    }
    return result
  }, [chartObjects])

  return (
    <div className="minimap-overlay" style={{ width: displayW, height: displayH }}
      onMouseDown={handleMouseDown}>
      <svg width={displayW} height={displayH} style={{ display: 'block' }}>
        <defs>
          <marker id="minimap-arrow" markerWidth="6" markerHeight="4" refX="5" refY="2" orient="auto">
            <path d="M0,0 L6,2 L0,4 Z" fill="#999" />
          </marker>
        </defs>
        {arrows.map(a => {
          const from = toMini(a.fromX, a.fromY)
          const to = toMini(a.toX, a.toY)
          return (
            <line
              key={a.id}
              x1={from.x} y1={from.y}
              x2={to.x} y2={to.y}
              stroke="#999"
              strokeWidth={1}
              markerEnd="url(#minimap-arrow)"
            />
          )
        })}
        {chartObjects.map(chart => {
          const pos = toMini(chart.x, chart.y)
          return (
            <rect
              key={chart.id}
              x={pos.x}
              y={pos.y}
              width={(chart.width || 480) * scale}
              height={(chart.height || 350) * scale}
              fill="#4a90d9"
              fillOpacity={0.3}
              stroke="#4a90d9"
              strokeWidth={1}
              rx={2}
            />
          )
        })}
        <rect
          x={vpMini.x}
          y={vpMini.y}
          width={Math.max(vpW, 10)}
          height={Math.max(vpH, 10)}
          fill="none"
          stroke="#333"
          strokeWidth={1.5}
          strokeDasharray="3,2"
        />
      </svg>
    </div>
  )
}

export default MinimapOverlay
