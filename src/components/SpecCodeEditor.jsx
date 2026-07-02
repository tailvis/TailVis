import { useEffect, useMemo, useRef } from 'react'
import { EditorState, StateEffect, StateField } from '@codemirror/state'
import { EditorView, Decoration } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { json } from '@codemirror/lang-json'
import { indentationMarkers } from '@replit/codemirror-indentation-markers'
import { prettySpecForView, changedLineSet } from '../utils/specDiff'
import './SpecCodeEditor.css'

// ─── Diff line highlighting (background on changed/added lines) ───
const lineDeco = Decoration.line({ class: 'cm-diff-line' })
const setDiffLines = StateEffect.define() // value: Set<number> (0-based line indices)

const diffField = StateField.define({
  create() { return { lines: new Set(), deco: Decoration.none } },
  update(val, tr) {
    let lines = val.lines
    let linesChanged = false
    for (const e of tr.effects) {
      if (e.is(setDiffLines)) { lines = e.value; linesChanged = true }
    }
    if (linesChanged || tr.docChanged) {
      const doc = tr.state.doc
      const ranges = []
      for (const ln of lines) {
        if (ln >= 0 && ln < doc.lines) ranges.push(lineDeco.range(doc.line(ln + 1).from))
      }
      ranges.sort((a, b) => a.from - b.from)
      return { lines, deco: Decoration.set(ranges) }
    }
    return val
  },
  provide: f => EditorView.decorations.from(f, v => v.deco),
})

const baseTheme = EditorView.theme({
  '&': { fontSize: '12px', height: '100%', backgroundColor: '#ffffff' },
  '.cm-scroller': {
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    lineHeight: '1.5',
    overflow: 'auto',
  },
  '.cm-gutters': { backgroundColor: '#fafafa', color: '#bbb', border: 'none' },
  '.cm-diff-line': { backgroundColor: 'rgba(70, 167, 88, 0.16)' },
  '&.cm-focused': { outline: 'none' },
})

/**
 * CodeMirror 6 editor for Vega-Lite specs — line numbers, indentation guides,
 * JSON syntax highlighting. Read-only mode also paints changed lines (diff).
 */
function SpecCodeEditor({ value, onChange, readOnly = false, changedLines = null }) {
  const elRef = useRef(null)
  const viewRef = useRef(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // Create the editor once
  useEffect(() => {
    const extensions = [
      basicSetup,
      json(),
      indentationMarkers(),
      diffField,
      baseTheme,
    ]
    if (readOnly) {
      extensions.push(EditorState.readOnly.of(true))
    } else {
      extensions.push(EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current?.(u.state.doc.toString())
      }))
    }
    const view = new EditorView({
      parent: elRef.current,
      state: EditorState.create({ doc: value ?? '', extensions }),
    })
    viewRef.current = view
    return () => { view.destroy(); viewRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly])

  // Sync external value + diff lines
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const cur = view.state.doc.toString()
    const tr = { effects: setDiffLines.of(changedLines || new Set()) }
    if (value != null && value !== cur) {
      tr.changes = { from: 0, to: cur.length, insert: value }
    }
    view.dispatch(tr)
  }, [value, changedLines])

  return <div ref={elRef} className="spec-code-editor" />
}

/**
 * Read-only spec view with parent-diff highlighting (replaces JsonDiffViewer).
 */
export function SpecView({ currentSpec, parentSpec }) {
  const text = useMemo(() => prettySpecForView(currentSpec), [currentSpec])
  const parentText = useMemo(() => prettySpecForView(parentSpec), [parentSpec])
  const changedLines = useMemo(() => changedLineSet(text, parentText), [text, parentText])

  if (!currentSpec) return <p className="empty-hint">Select a chart to view its spec</p>
  return (
    <div className="spec-view-wrap">
      {changedLines.size > 0 && (
        <div className="spec-diff-legend">
          <span className="spec-diff-swatch" />
          Changed / Added
        </div>
      )}
      <SpecCodeEditor value={text} readOnly changedLines={changedLines} />
    </div>
  )
}

export default SpecCodeEditor
