import { useState, useEffect, useRef } from 'react'
import './LayerPanel.css'

function generateSelector(el, svgElement) {
  if (!el || el === svgElement) return null

  const tag = el.tagName?.toLowerCase()
  if (!tag) return null

  const buildFullPath = (element) => {
    const pathParts = []
    let current = element

    while (current && current !== svgElement && current.parentElement) {
      const currentTag = current.tagName?.toLowerCase()
      if (!currentTag) break

      const parent = current.parentElement

      const ariaLabel = current.getAttribute('aria-label')
      if (ariaLabel) {
        const escaped = ariaLabel.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        pathParts.unshift(`${currentTag}[aria-label="${escaped}"]`)
        const candidateSelector = pathParts.join(' > ')
        try {
          const matches = svgElement.querySelectorAll(candidateSelector)
          if (matches.length <= 1) break
        } catch { break }
        current = parent
        continue
      }

      const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName)
      const index = siblings.indexOf(current)
      pathParts.unshift(`${currentTag}:nth-of-type(${index + 1})`)

      current = parent
    }

    return pathParts.join(' > ')
  }

  return buildFullPath(el) || null
}

function parseSvgToLayers(svgElement) {
  if (!svgElement) return []

  let idCounter = 0

  const getElementName = (el) => {
    const tag = el.tagName?.toLowerCase()

    if (tag === 'text') {
      const textContent = el.textContent?.trim() || ''
      if (textContent) {
        return textContent.length > 20 ? textContent.slice(0, 20) + '...' : textContent
      }
      return 'text'
    }

    if (tag === 'g') {
      const ariaRole = el.getAttribute('aria-roledescription')
      const ariaLabel = el.getAttribute('aria-label') || ''

      if (ariaRole === 'axis') {
        if (ariaLabel.toLowerCase().startsWith('x-axis')) return 'X axis'
        if (ariaLabel.toLowerCase().startsWith('y-axis')) return 'Y axis'
        return 'axis'
      }

      if (ariaRole) return ariaRole
      if (ariaLabel) return ariaLabel

      let className = ''
      if (el.className) {
        className = typeof el.className === 'string' ? el.className : el.className.baseVal || ''
      }
      if (className) return className

      return 'group'
    }

    let className = ''
    if (el.className) {
      className = typeof el.className === 'string' ? el.className : el.className.baseVal || ''
    }
    if (className) return className

    const id = el.getAttribute('id')
    if (id) return `#${id}`

    return tag
  }

  const processElement = (el, depth = 0) => {
    const tag = el.tagName?.toLowerCase()
    if (!tag) return null

    let className = (typeof el.className === 'string' ? el.className : el.className?.baseVal) || ''
    if (className === 'background' || className === 'foreground') {
      return null
    }

    const id = `layer-${idCounter++}`
    const children = []

    Array.from(el.children || []).forEach(child => {
      const childLayer = processElement(child, depth + 1)
      if (childLayer) children.push(childLayer)
    })

    if (tag === 'g' && children.length === 1 && children[0].tag === 'g') {
      const child = children[0]
      child.depth = depth
      return child
    }

    const ariaRole = el.getAttribute('aria-roledescription') || ''
    const ariaLabel = el.getAttribute('aria-label') || ''

    const detectType = () => {
      if (ariaRole === 'axis') {
        if (ariaLabel.toLowerCase().startsWith('x-axis')) return 'axis-x'
        if (ariaLabel.toLowerCase().startsWith('y-axis')) return 'axis-y'
        return 'axis'
      }

      if (ariaRole === 'title') return 'title'

      if (ariaRole === 'mark' || ariaRole === 'graphics-symbol') return 'mark'

      if (ariaRole === 'legend') return 'legend'

      if (tag === 'text') return 'text'
      if (tag === 'line') return 'line'
      if (tag === 'path') return 'path'
      if (tag === 'rect') return 'rect'
      if (tag === 'circle') return 'circle'

      if (tag === 'g') return 'group'

      return tag
    }

    return {
      id,
      name: getElementName(el),
      tag,
      type: detectType(),
      role: ariaRole,
      ariaLabel,
      element: el,
      selector: generateSelector(el, svgElement),
      depth,
      children,
      visible: true,
      expanded: true
    }
  }

  const layers = []
  Array.from(svgElement.children || []).forEach(child => {
    const layer = processElement(child, 0)
    if (layer) layers.push(layer)
  })

  return layers
}

function LayerItem({ layer, selectedId, selectedSelectors, onSelect, onToggleExpand, onToggleVisibility, onHover, onHoverEnd, depth = 0, scrollToSelected }) {
  const itemRef = useRef(null)
  const hasChildren = layer.children && layer.children.length > 0
  const isSelected = selectedId === layer.id || (selectedSelectors && layer.selector && selectedSelectors.includes(layer.selector))

  useEffect(() => {
    if (isSelected && scrollToSelected && itemRef.current) {
      const container = itemRef.current.closest('.layer-list')
      if (container) {
        const containerRect = container.getBoundingClientRect()
        const itemRect = itemRef.current.getBoundingClientRect()

        const isVisible = itemRect.top >= containerRect.top &&
                          itemRect.bottom <= containerRect.bottom

        if (!isVisible) {
          itemRef.current.scrollIntoView({
            behavior: 'smooth',
            block: 'start'
          })
        }
      }
    }
  }, [isSelected, scrollToSelected])

  const getIcon = (type, tag) => {
    switch (type) {
      case 'title': return '📝'
      case 'axis-x':
      case 'axis-y': return '📏'
      case 'mark': return '📊'
      case 'legend': return '🏷️'
      case 'grid': return '⊞'
      case 'text': return 'T'
      default:
        if (tag === 'g') return '📁'
        if (tag === 'rect') return '⬜'
        if (tag === 'circle') return '⚪'
        if (tag === 'line') return '—'
        if (tag === 'path') return '〰️'
        return '•'
    }
  }

  return (
    <div className="layer-item-container" ref={itemRef}>
      <div
        className={`layer-item ${isSelected ? 'selected' : ''}`}
        style={{ paddingLeft: `${8 + depth * 10}px` }}
        onClick={(e) => onSelect(layer, e.shiftKey)}
        onMouseEnter={() => onHover(layer)}
        onMouseLeave={() => onHoverEnd()}
      >
        {hasChildren && (
          <span
            className="expand-toggle"
            onClick={(e) => {
              e.stopPropagation()
              onToggleExpand(layer.id)
            }}
          >
            {layer.expanded ? '▼' : '▶'}
          </span>
        )}
        {!hasChildren && <span className="expand-placeholder" />}

        <span className="layer-icon">{getIcon(layer.type, layer.tag)}</span>
        <span className="layer-name">{layer.name}</span>
        <span className="layer-tag">{layer.tag === 'g' ? 'group' : layer.tag}</span>

        <button
          className={`visibility-toggle ${layer.visible ? '' : 'hidden'}`}
          onClick={(e) => {
            e.stopPropagation()
            onToggleVisibility(layer)
          }}
        >
          {layer.visible ? '👁️' : '👁️‍🗨️'}
        </button>
      </div>

      {hasChildren && layer.expanded && (
        <div className="layer-children">
          {layer.children.map(child => (
            <LayerItem
              key={child.id}
              layer={child}
              selectedId={selectedId}
              selectedSelectors={selectedSelectors}
              onSelect={onSelect}
              onToggleExpand={onToggleExpand}
              onToggleVisibility={onToggleVisibility}
              onHover={onHover}
              onHoverEnd={onHoverEnd}
              depth={depth + 1}
              scrollToSelected={scrollToSelected}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function LayerPanel({ chartId, spec, onLayerSelect, selectedLayerId, selectedDomElement, selectedSelector, selectedSelectors }) {
  const [layers, setLayers] = useState([])
  const [shouldScrollToSelected, setShouldScrollToSelected] = useState(false)
  const prevElementRef = useRef(null)

  const findLayerByElement = (items, targetElement, path = []) => {
    if (!targetElement) return null

    for (const item of items) {
      if (item.element === targetElement) {
        return { layer: item, path: [...path, item.id] }
      }
      if (item.children) {
        const found = findLayerByElement(item.children, targetElement, [...path, item.id])
        if (found) return found
      }
    }
    return null
  }

  const findLayerBySelector = (items, targetSelector, path = []) => {
    if (!targetSelector) return null

    for (const item of items) {
      if (item.selector === targetSelector) {
        return { layer: item, path: [...path, item.id] }
      }
      if (item.children) {
        const found = findLayerBySelector(item.children, targetSelector, [...path, item.id])
        if (found) return found
      }
    }
    return null
  }

  const matchResult = selectedDomElement
    ? findLayerByElement(layers, selectedDomElement) || findLayerBySelector(layers, selectedSelector)
    : null
  const effectiveSelectedId = matchResult?.layer?.id || selectedLayerId

  useEffect(() => {
    if (selectedDomElement && selectedDomElement !== prevElementRef.current) {
      setShouldScrollToSelected(true)
      prevElementRef.current = selectedDomElement
      const timer = setTimeout(() => setShouldScrollToSelected(false), 500)
      return () => clearTimeout(timer)
    }
  }, [selectedDomElement])

  useEffect(() => {
    if (matchResult?.path && matchResult.path.length > 1) {
      const parentIds = matchResult.path.slice(0, -1)

      setLayers(prevLayers => {
        const expandParents = (items) => {
          return items.map(item => {
            const shouldExpand = parentIds.includes(item.id)
            const newItem = shouldExpand ? { ...item, expanded: true } : item
            if (item.children) {
              return { ...newItem, children: expandParents(item.children) }
            }
            return newItem
          })
        }
        return expandParents(prevLayers)
      })
    }
  }, [selectedDomElement, layers.length])

  const specString = JSON.stringify(spec)

  // Find SVG container directly from DOM and parse layers
  useEffect(() => {
    if (!chartId) {
      setLayers([])
      return
    }

    // Find the SVG container in DOM using chartId
    const findAndParseSvg = () => {
      const container = document.getElementById(`vega-chart-${chartId}`)
      if (!container) return false

      const svgElement = container.querySelector('svg')
      if (!svgElement) return false

      // Check if SVG has content
      const descendants = svgElement.querySelectorAll('*')
      if (descendants.length < 5) return false

      const parsedLayers = parseSvgToLayers(svgElement)
      setLayers(parsedLayers)
      return true
    }

    const timer = setTimeout(() => {
      findAndParseSvg()
    }, 100)

    return () => clearTimeout(timer)
  }, [chartId, specString])

  const handleToggleExpand = (layerId) => {
    setLayers(prevLayers => {
      const toggleExpand = (items) => {
        return items.map(item => {
          if (item.id === layerId) {
            return { ...item, expanded: !item.expanded }
          }
          if (item.children) {
            return { ...item, children: toggleExpand(item.children) }
          }
          return item
        })
      }
      return toggleExpand(prevLayers)
    })
  }

  const handleToggleVisibility = (layer) => {
    if (layer.element) {
      const currentDisplay = layer.element.style.display
      layer.element.style.display = currentDisplay === 'none' ? '' : 'none'

      setLayers(prevLayers => {
        const toggleVisibility = (items) => {
          return items.map(item => {
            if (item.id === layer.id) {
              return { ...item, visible: !item.visible }
            }
            if (item.children) {
              return { ...item, children: toggleVisibility(item.children) }
            }
            return item
          })
        }
        return toggleVisibility(prevLayers)
      })
    }
  }

  const hoverOverlayRef = useRef(null)

  const handleHover = (layer) => {
    // Remove previous hover overlay
    if (hoverOverlayRef.current) { hoverOverlayRef.current.remove(); hoverOverlayRef.current = null }

    const container = document.getElementById(`vega-chart-${chartId}`)
    const svg = container?.querySelector('svg')
    if (!svg) return

    let targetElement = layer.element
    if (!targetElement || !svg.contains(targetElement)) {
      if (layer.selector) {
        try { targetElement = svg.querySelector(layer.selector) } catch (e) {}
      }
    }
    if (!targetElement || targetElement.classList.contains('element-selected')) return

    try {
      const bbox = targetElement.getBBox()
      const ctm = targetElement.getCTM()
      const svgCTM = svg.getCTM()
      if (!ctm || !svgCTM) return
      const toRoot = svgCTM.inverse().multiply(ctm)
      const pad = 3
      const corners = [
        [bbox.x - pad, bbox.y - pad], [bbox.x + bbox.width + pad, bbox.y - pad],
        [bbox.x + bbox.width + pad, bbox.y + bbox.height + pad], [bbox.x - pad, bbox.y + bbox.height + pad]
      ].map(([cx, cy]) => { const pt = svg.createSVGPoint(); pt.x = cx; pt.y = cy; return pt.matrixTransform(toRoot) })
      const xs = corners.map(c => c.x), ys = corners.map(c => c.y)
      const ns = 'http://www.w3.org/2000/svg'
      const overlay = document.createElementNS(ns, 'rect')
      overlay.setAttribute('x', Math.min(...xs)); overlay.setAttribute('y', Math.min(...ys))
      overlay.setAttribute('width', Math.max(...xs) - Math.min(...xs))
      overlay.setAttribute('height', Math.max(...ys) - Math.min(...ys))
      overlay.setAttribute('rx', '2'); overlay.setAttribute('fill', 'none')
      overlay.setAttribute('stroke', '#4a9eff'); overlay.setAttribute('stroke-width', '2')
      overlay.setAttribute('pointer-events', 'none')
      svg.appendChild(overlay)
      hoverOverlayRef.current = overlay
    } catch {}
  }

  const handleHoverEnd = () => {
    if (hoverOverlayRef.current) { hoverOverlayRef.current.remove(); hoverOverlayRef.current = null }
  }

  const handleSelect = (layer, isShiftClick = false) => {
    const container = document.getElementById(`vega-chart-${chartId}`)
    const svg = container?.querySelector('svg')
    if (!svg) return

    let targetElement = layer.element
    if (!targetElement || !svg.contains(targetElement)) {
      if (layer.selector) {
        try {
          targetElement = svg.querySelector(layer.selector)
        } catch (e) {}
      }
    }

    onLayerSelect({ ...layer, element: targetElement }, isShiftClick)
  }

  if (!chartId) {
    return (
      <div className="layer-panel empty">
        <p>Select a chart</p>
      </div>
    )
  }

  if (layers.length === 0) {
    return (
      <div className="layer-panel empty">
        <p>Loading layers...</p>
      </div>
    )
  }

  return (
    <div className="layer-panel">
      <div className="layer-panel-header">
        <span>Layers</span>
        <span className="layer-count">{layers.length}</span>
      </div>
      <div className="layer-list">
        {layers.map(layer => (
          <LayerItem
            key={layer.id}
            layer={layer}
            selectedId={effectiveSelectedId}
            selectedSelectors={selectedSelectors}
            onSelect={handleSelect}
            onToggleExpand={handleToggleExpand}
            onToggleVisibility={handleToggleVisibility}
            onHover={handleHover}
            onHoverEnd={handleHoverEnd}
            scrollToSelected={shouldScrollToSelected}
          />
        ))}
      </div>
    </div>
  )
}

export default LayerPanel
