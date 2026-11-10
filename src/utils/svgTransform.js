// Compose presentation offsets separately from data coordinates. Prefixing the
// translation keeps X/Y in chart axes even when the label itself is rotated.
export function applySvgTransformOverrides(element, props) {
  const has = key => Object.prototype.hasOwnProperty.call(props, key)
  const textAngle = has('angle') && element.tagName?.toLowerCase() === 'text'
  if (!has('transform') && !has('dx') && !has('dy') && !textAngle) return
  if (element.dataset.editorBaseTransform == null) element.dataset.editorBaseTransform = element.getAttribute('transform') || ''
  let transform = has('transform') ? String(props.transform || '') : element.dataset.editorBaseTransform
  if (textAngle) {
    const rotation = `rotate(${Number(props.angle) || 0})`
    transform = /rotate\([^)]*\)/.test(transform)
      ? transform.replace(/rotate\([^)]*\)/, rotation)
      : `${transform} ${rotation}`.trim()
  }
  const dx = Number(props.dx) || 0
  const dy = Number(props.dy) || 0
  if (dx || dy) transform = `translate(${dx},${dy}) ${transform}`.trim()
  if (transform) element.setAttribute('transform', transform)
  else element.removeAttribute('transform')
}
