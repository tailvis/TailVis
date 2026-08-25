import { useMemo } from 'react'
import './JsonDiffViewer.css'

function findDiffPaths(oldObj, newObj, path = '') {
  const diffs = new Set()

  if (oldObj === newObj) return diffs

  if (typeof oldObj !== typeof newObj) {
    diffs.add(path || 'root')
    return diffs
  }

  if (typeof newObj !== 'object' || newObj === null) {
    if (oldObj !== newObj) {
      diffs.add(path || 'root')
    }
    return diffs
  }

  if (Array.isArray(newObj)) {
    const maxLen = Math.max(
      Array.isArray(oldObj) ? oldObj.length : 0,
      newObj.length
    )
    for (let i = 0; i < maxLen; i++) {
      const oldVal = Array.isArray(oldObj) ? oldObj[i] : undefined
      const childDiffs = findDiffPaths(oldVal, newObj[i], `${path}[${i}]`)
      childDiffs.forEach(d => diffs.add(d))
    }
    return diffs
  }

  // Object
  const allKeys = new Set([
    ...Object.keys(oldObj || {}),
    ...Object.keys(newObj)
  ])

  for (const key of allKeys) {
    const newPath = path ? `${path}.${key}` : key
    const oldVal = oldObj ? oldObj[key] : undefined
    const newVal = newObj[key]

    if (!(key in (oldObj || {}))) {
      diffs.add(newPath)
    } else if (!(key in newObj)) {
    } else {
      const childDiffs = findDiffPaths(oldVal, newVal, newPath)
      childDiffs.forEach(d => diffs.add(d))
    }
  }

  return diffs
}

function isPathChanged(currentPath, diffPaths) {
  for (const diffPath of diffPaths) {
    if (diffPath === currentPath || diffPath.startsWith(currentPath + '.') || diffPath.startsWith(currentPath + '[')) {
      return true
    }
  }
  return false
}

function renderJsonWithHighlight(obj, diffPaths, path = '', indent = 0) {
  const spaces = '  '.repeat(indent)
  const isChanged = isPathChanged(path, diffPaths)

  if (obj === null) {
    return <span className={isChanged ? 'json-changed' : 'json-null'}>null</span>
  }

  if (typeof obj === 'boolean') {
    return <span className={isChanged ? 'json-changed' : 'json-boolean'}>{obj.toString()}</span>
  }

  if (typeof obj === 'number') {
    return <span className={isChanged ? 'json-changed' : 'json-number'}>{obj}</span>
  }

  if (typeof obj === 'string') {
    return <span className={isChanged ? 'json-changed' : 'json-string'}>"{obj}"</span>
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) {
      return <span className={isChanged ? 'json-changed' : ''}>[]</span>
    }

    return (
      <>
        <span className={isChanged ? 'json-changed' : ''}>{'['}</span>
        {obj.map((item, i) => {
          const itemPath = `${path}[${i}]`
          return (
            <div key={i}>
              {spaces}  {renderJsonWithHighlight(item, diffPaths, itemPath, indent + 1)}
              {i < obj.length - 1 ? ',' : ''}
            </div>
          )
        })}
        <span>{spaces}{']'}</span>
      </>
    )
  }

  // Object
  const keys = Object.keys(obj)
  if (keys.length === 0) {
    return <span className={isChanged ? 'json-changed' : ''}>{'{ }'}</span>
  }

  return (
    <>
      <span>{'{'}</span>
      {keys.map((key, i) => {
        const keyPath = path ? `${path}.${key}` : key
        const keyChanged = isPathChanged(keyPath, diffPaths)
        return (
          <div key={key}>
            {spaces}  <span className={keyChanged ? 'json-changed' : 'json-key'}>"{key}"</span>
            <span>: </span>
            {renderJsonWithHighlight(obj[key], diffPaths, keyPath, indent + 1)}
            {i < keys.length - 1 ? ',' : ''}
          </div>
        )
      })}
      <span>{spaces}{'}'}</span>
    </>
  )
}

function JsonDiffViewer({ currentSpec, parentSpec }) {
  // Collapse data.values for display (too large to show inline)
  const displaySpec = useMemo(() => {
    if (!currentSpec) return currentSpec
    const copy = JSON.parse(JSON.stringify(currentSpec))
    if (Array.isArray(copy.data?.values) && copy.data.values.length > 3) {
      const n = copy.data.values.length
      copy.data.values = [copy.data.values[0], `... ${n - 1} more rows`]
    }
    return copy
  }, [currentSpec])

  const displayParent = useMemo(() => {
    if (!parentSpec) return parentSpec
    const copy = JSON.parse(JSON.stringify(parentSpec))
    if (Array.isArray(copy.data?.values) && copy.data.values.length > 3) {
      const n = copy.data.values.length
      copy.data.values = [copy.data.values[0], `... ${n - 1} more rows`]
    }
    return copy
  }, [parentSpec])

  const diffPaths = useMemo(() => {
    if (!displayParent) return new Set()
    return findDiffPaths(displayParent, displaySpec)
  }, [displaySpec, displayParent])

  const hasChanges = diffPaths.size > 0

  return (
    <div className="json-diff-viewer">
      {hasChanges && (
        <div className="diff-legend">
          <span className="legend-item">
            <span className="legend-color changed"></span>
            Changed/Added
          </span>
        </div>
      )}
      <pre className="json-content">
        {renderJsonWithHighlight(displaySpec, diffPaths)}
      </pre>
    </div>
  )
}

export default JsonDiffViewer
