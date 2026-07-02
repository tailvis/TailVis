// Helpers for the Vega-Lite spec viewer/editor.

/**
 * Pretty-print a spec for read-only viewing, collapsing large data.values arrays
 * (too long to show inline) the same way the old JsonDiffViewer did.
 */
export function prettySpecForView(spec) {
  if (!spec) return ''
  const copy = JSON.parse(JSON.stringify(spec))
  if (Array.isArray(copy.data?.values) && copy.data.values.length > 3) {
    const n = copy.data.values.length
    copy.data.values = [copy.data.values[0], `... ${n - 1} more rows`]
  }
  return JSON.stringify(copy, null, 2)
}

/**
 * Line-level diff: returns the set of 0-based line indices in `currentText` that
 * are added/changed relative to `parentText` (LCS-based). Empty set when there is
 * no parent (non-derived chart) — nothing to compare against.
 */
export function changedLineSet(currentText, parentText) {
  if (!parentText || !currentText) return new Set()
  const a = parentText.split('\n')
  const b = currentText.split('\n')
  const m = a.length
  const n = b.length

  // LCS length table
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const changed = new Set()
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) { i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { i++ }          // line only in parent (removed)
    else { changed.add(j); j++ }                             // line only in current (added/changed)
  }
  while (j < n) { changed.add(j); j++ }                      // trailing additions
  return changed
}
