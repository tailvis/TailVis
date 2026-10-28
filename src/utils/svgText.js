// Keep editable line breaks intact across SVG rendering, reselection and export.
export function readSvgText(element) {
  const lines = Array.from(element.children || []).filter(c => c.tagName?.toLowerCase() === 'tspan')
  return lines.length ? lines.map(line => line.textContent === '\u200b' ? '' : line.textContent).join('\n') : element.textContent || ''
}

export function setSvgText(element, value) {
  const lines = String(value ?? '').split(/\r\n|\r|\n/)
  element.style.whiteSpace = 'pre'
  element.textContent = ''
  if (lines.length === 1) {
    element.textContent = lines[0]
    return
  }
  const x = element.getAttribute('x') || '0'
  lines.forEach((line, index) => {
    const span = element.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'tspan')
    span.setAttribute('x', x)
    // em units continue to track font size changes, including on empty lines.
    span.setAttribute('dy', index ? '1.2em' : '0')
    span.textContent = line || '\u200b'
    element.appendChild(span)
  })
}
