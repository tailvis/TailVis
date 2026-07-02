import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { parseCSV, analyzeColumns } from '../utils/dataUtils'
import './DataTable.css'


const TYPE_BADGES = {
  Q: { label: 'Q', title: 'Quantitative', className: 'type-q' },
  N: { label: 'N', title: 'Nominal', className: 'type-n' },
  O: { label: 'O', title: 'Ordinal', className: 'type-o' },
  T: { label: 'T', title: 'Temporal', className: 'type-t' }
}

const TYPE_CYCLE = ['Q', 'N', 'O', 'T']

const INITIAL_VISIBLE_ROWS = 200 // initial rows rendered; "More" loads more, "Show less" collapses back


function DataTable({ data, columnInfos, onSelectionChange, onColumnInfoChange, onDataLoad, dataSourceName,
  dataSources, activeDataSourceId, onSelectDataSource, selectedChartDataSourceId, onCellEdit, onRowAdd, onRowDelete, onColumnAdd, onColumnDelete, onColumnRename, highlightDatum, encodedFields, onDataSourceCreate }) {
  const fileInputRef = useRef(null)
  const panelRef = useRef(null)

  // Cell editing state
  const [editingCell, setEditingCell] = useState(null) // { rowIdx, colIdx, originalDataIndex }
  const [editValue, setEditValue] = useState('')

  // Column name editing state
  const [editingColName, setEditingColName] = useState(null) // colIdx or null
  const [editColNameValue, setEditColNameValue] = useState('')

  // Focused cell (cursor position)
  const [focusedCell, setFocusedCell] = useState(null) // { rowIdx, colIdx }

  // Selection state
  const [selectedCells, setSelectedCells] = useState(new Set())
  const [visibleRows, setVisibleRows] = useState(INITIAL_VISIBLE_ROWS)
  const [dragStart, setDragStart] = useState(null)
  const isDraggingRef = useRef(false)
  const tableRef = useRef(null)

  // Sort state
  const [sortConfig, setSortConfig] = useState({ column: null, direction: null })

  // Filter state
  const [columnFilters, setColumnFilters] = useState({})
  const [filterMenuColumn, setFilterMenuColumn] = useState(null)
  const [filterMenuPosition, setFilterMenuPosition] = useState({ top: 0, left: 0 })

  // Undo/redo history
  const historyRef = useRef([])
  const historyIndexRef = useRef(-1)
  const isRestoringRef = useRef(false)

  // Encoded field names set for quick lookup
  const encodedFieldSet = useMemo(() => new Set((encodedFields || []).map(f => f.field)), [encodedFields])

  // Keep original column order
  const columns = useMemo(() => columnInfos.map(c => c.name), [columnInfos])

  // ─── Effective data source ─────────────────
  const effectiveDataSourceId = selectedChartDataSourceId || activeDataSourceId || null

  // Save current state to history
  const pushHistory = useCallback((cells, sort, filters) => {
    if (isRestoringRef.current) return
    const history = historyRef.current
    const index = historyIndexRef.current
    historyRef.current = history.slice(0, index + 1)
    historyRef.current.push({
      selectedCells: new Set(cells),
      sortConfig: { ...sort },
      columnFilters: JSON.parse(JSON.stringify(filters, (_, v) => v instanceof Set ? [...v] : v))
    })
    historyIndexRef.current = historyRef.current.length - 1
    if (historyRef.current.length > 30) {
      historyRef.current = historyRef.current.slice(-30)
      historyIndexRef.current = historyRef.current.length - 1
    }
  }, [])

  const deserializeFilters = (filters) => {
    const result = {}
    for (const [k, v] of Object.entries(filters)) {
      result[k] = Array.isArray(v) ? new Set(v) : v
    }
    return result
  }

  const undo = useCallback(() => {
    const index = historyIndexRef.current
    if (index <= 0) return
    isRestoringRef.current = true
    historyIndexRef.current = index - 1
    const state = historyRef.current[index - 1]
    setSelectedCells(new Set(state.selectedCells))
    setSortConfig({ ...state.sortConfig })
    setColumnFilters(deserializeFilters(state.columnFilters))
    setTimeout(() => { isRestoringRef.current = false }, 0)
  }, [])

  const redo = useCallback(() => {
    const index = historyIndexRef.current
    if (index >= historyRef.current.length - 1) return
    isRestoringRef.current = true
    historyIndexRef.current = index + 1
    const state = historyRef.current[index + 1]
    setSelectedCells(new Set(state.selectedCells))
    setSortConfig({ ...state.sortConfig })
    setColumnFilters(deserializeFilters(state.columnFilters))
    setTimeout(() => { isRestoringRef.current = false }, 0)
  }, [])

  // Cmd+Z / Cmd+Shift+Z handler
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (!panelRef.current?.contains(document.activeElement) && document.activeElement !== document.body) return
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'z') return
      if (e.shiftKey) {
        if (historyIndexRef.current < historyRef.current.length - 1) {
          e.preventDefault(); e.stopPropagation(); redo()
        }
      } else {
        if (historyIndexRef.current > 0) {
          e.preventDefault(); e.stopPropagation(); undo()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [undo, redo])

  // Reset selection/sort/filter when data changes
  const prevDataRef = useRef(data)
  useEffect(() => {
    setColumnFilters({})
    setSortConfig({ column: null, direction: null })
    setVisibleRows(INITIAL_VISIBLE_ROWS)
    setSelectedCells(new Set())
    setDragStart(null)
    setFocusedCell(null)
    setEditingCell(null)
    historyRef.current = []
    historyIndexRef.current = -1
    prevDataRef.current = data
  }, [data])

  // Apply column filters
  const filteredData = useMemo(() => {
    if (!data || data.length === 0) return []
    const activeFilters = Object.entries(columnFilters).filter(([, values]) => values.size > 0)
    if (activeFilters.length === 0) return data
    return data.filter(row =>
      activeFilters.every(([colName, allowedValues]) => {
        const cellValue = row[colName] != null ? String(row[colName]) : ''
        return allowedValues.has(cellValue)
      })
    )
  }, [data, columnFilters])

  // Apply sort
  const displayData = useMemo(() => {
    if (!sortConfig.column || !sortConfig.direction) return filteredData
    const sorted = [...filteredData]
    const col = sortConfig.column
    const dir = sortConfig.direction === 'asc' ? 1 : -1
    sorted.sort((a, b) => {
      const aVal = a[col], bVal = b[col]
      if (aVal == null && bVal == null) return 0
      if (aVal == null) return 1
      if (bVal == null) return -1
      if (typeof aVal === 'number' && typeof bVal === 'number') return (aVal - bVal) * dir
      return String(aVal).localeCompare(String(bVal)) * dir
    })
    return sorted
  }, [filteredData, sortConfig])

  const maxRow = Math.min(displayData.length, visibleRows) - 1
  const maxCol = columns.length - 1

  // Map displayData row index → original data index
  const originalDataIndices = useMemo(() => {
    if (!data || data.length === 0) return []
    return displayData.map(row => data.indexOf(row))
  }, [data, displayData])

  // Compute range selection
  const getRangeKeys = useCallback((start, end) => {
    if (!start || !end) return new Set()
    const minRow = Math.min(start.row, end.row), maxR = Math.max(start.row, end.row)
    const minCol = Math.min(start.col, end.col), maxC = Math.max(start.col, end.col)
    const keys = new Set()
    for (let r = minRow; r <= maxR; r++) for (let c = minCol; c <= maxC; c++) keys.add(`${r},${c}`)
    return keys
  }, [])

  // Derive selected columns
  const localSelectedCols = useMemo(() => {
    const cols = new Set()
    selectedCells.forEach(key => {
      const colIdx = parseInt(key.split(',')[1])
      if (colIdx >= 0 && colIdx < columns.length) cols.add(columns[colIdx])
    })
    return columns.filter(c => cols.has(c))
  }, [selectedCells, columns])

  // Notify parent of selection changes
  const lastSelectionRef = useRef('')
  useEffect(() => {
    const cols = new Set()
    const rowIndices = new Set()
    selectedCells.forEach(key => {
      const parts = key.split(',')
      const rowIdx = parseInt(parts[0]), colIdx = parseInt(parts[1])
      if (colIdx >= 0 && colIdx < columns.length) cols.add(columns[colIdx])
      if (rowIdx >= 0 && rowIdx < displayData.length) rowIndices.add(rowIdx)
    })
    const sortedCols = columns.filter(c => cols.has(c))
    const subsetData = Array.from(rowIndices).sort((a, b) => a - b).map(idx => {
      const row = displayData[idx]
      const filtered = {}
      sortedCols.forEach(col => { filtered[col] = row[col] })
      return filtered
    })
    const key = JSON.stringify({ columns: sortedCols, rows: Array.from(rowIndices).sort() })
    if (key === lastSelectionRef.current) return
    lastSelectionRef.current = key
    onSelectionChange({ columns: sortedCols, data: subsetData })
  }, [selectedCells, columns, displayData, onSelectionChange])

  // ─── Navigation ─────────────────
  const navigateToCell = useCallback((rowIdx, colIdx) => {
    const r = Math.max(0, Math.min(rowIdx, maxRow))
    const c = Math.max(0, Math.min(colIdx, maxCol))
    setFocusedCell({ rowIdx: r, colIdx: c })
    const key = `${r},${c}`
    setSelectedCells(new Set([key]))
    setDragStart({ row: r, col: c })
  }, [maxRow, maxCol])

  // ─── Cell editing ─────────────────
  const startEditExisting = useCallback((rowIdx, colIdx) => {
    if (!effectiveDataSourceId) return
    const originalIndex = originalDataIndices[rowIdx]
    const col = columns[colIdx]
    const value = displayData[rowIdx][col]
    setEditingCell({ rowIdx, colIdx, originalDataIndex: originalIndex })
    setEditValue(value != null ? String(value) : '')
    setFocusedCell({ rowIdx, colIdx })
  }, [effectiveDataSourceId, originalDataIndices, columns, displayData])

  const startEditByTyping = useCallback((rowIdx, colIdx, char) => {
    if (!effectiveDataSourceId) return
    const originalIndex = originalDataIndices[rowIdx]
    setEditingCell({ rowIdx, colIdx, originalDataIndex: originalIndex })
    setEditValue(char)
    setFocusedCell({ rowIdx, colIdx })
  }, [effectiveDataSourceId, originalDataIndices])

  const commitCellEdit = useCallback((moveDirection = null) => {
    if (!editingCell || !effectiveDataSourceId) {
      setEditingCell(null)
      return
    }
    const col = columns[editingCell.colIdx]
    const originalIndex = editingCell.originalDataIndex

    // Smart type detection: store numeric strings as numbers
    let newValue = editValue
    if (newValue !== '' && !isNaN(parseFloat(newValue)) && isFinite(newValue)) {
      newValue = parseFloat(newValue)
    }

    if (onCellEdit) {
      onCellEdit({
        dataSourceId: effectiveDataSourceId,
        rowIndex: originalIndex,
        columnName: col,
        newValue
      })
    }

    setEditingCell(null)

    // Navigate after commit
    if (moveDirection && editingCell) {
      const { rowIdx, colIdx } = editingCell
      switch (moveDirection) {
        case 'down': navigateToCell(rowIdx + 1, colIdx); break
        case 'up': navigateToCell(rowIdx - 1, colIdx); break
        case 'right': navigateToCell(rowIdx, colIdx + 1); break
        case 'left': navigateToCell(rowIdx, colIdx - 1); break
      }
    }
  }, [editingCell, effectiveDataSourceId, columns, editValue, onCellEdit, navigateToCell])

  const cancelCellEdit = useCallback(() => {
    setEditingCell(null)
  }, [])

  // Column name edit commit
  const commitColNameEdit = useCallback(() => {
    if (editingColName == null || !effectiveDataSourceId) {
      setEditingColName(null)
      return
    }
    const oldName = columns[editingColName]
    const newName = editColNameValue.trim()
    setEditingColName(null)
    if (!newName || newName === oldName || columns.includes(newName)) return
    if (onColumnRename) {
      onColumnRename({ dataSourceId: effectiveDataSourceId, oldName, newName })
    }
  }, [editingColName, editColNameValue, columns, effectiveDataSourceId, onColumnRename])

  const handleEditKeyDown = useCallback((e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitCellEdit(e.shiftKey ? 'up' : 'down')
    } else if (e.key === 'Tab') {
      e.preventDefault()
      commitCellEdit(e.shiftKey ? 'left' : 'right')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelCellEdit()
    }
  }, [commitCellEdit, cancelCellEdit])

  // ─── Clipboard ─────────────────
  const handleCopy = useCallback(() => {
    if (selectedCells.size === 0) return
    let minRow = Infinity, maxR = -1, minCol = Infinity, maxC = -1
    selectedCells.forEach(key => {
      const [r, c] = key.split(',').map(Number)
      minRow = Math.min(minRow, r); maxR = Math.max(maxR, r)
      minCol = Math.min(minCol, c); maxC = Math.max(maxC, c)
    })
    const lines = []
    for (let r = minRow; r <= maxR; r++) {
      const row = []
      for (let c = minCol; c <= maxC; c++) {
        if (r < displayData.length && c < columns.length) {
          const v = displayData[r][columns[c]]
          row.push(v != null ? String(v) : '')
        } else {
          row.push('')
        }
      }
      lines.push(row.join('\t'))
    }
    navigator.clipboard.writeText(lines.join('\n')).catch(() => {})
  }, [selectedCells, displayData, columns])

  // Distribute clipboard text across the grid (Excel/Sheets-style): rows split on
  // newlines, columns on tabs, written starting at (startRowIdx, startColIdx).
  const distributePastedText = useCallback((text, startRowIdx, startColIdx) => {
    if (!effectiveDataSourceId || text == null) return
    const rows = text.replace(/\r/g, '').split('\n')
    // Drop a single trailing empty line (copying a column usually ends with a newline).
    while (rows.length > 1 && rows[rows.length - 1] === '') rows.pop()
    const newCells = new Set()
    rows.forEach((line, ri) => {
      const cells = line.split('\t')
      cells.forEach((val, ci) => {
        const r = startRowIdx + ri
        const c = startColIdx + ci
        if (r <= maxRow && c <= maxCol) {
          const originalIndex = originalDataIndices[r]
          const col = columns[c]
          let newValue = val
          if (newValue !== '' && !isNaN(parseFloat(newValue)) && isFinite(newValue)) {
            newValue = parseFloat(newValue)
          }
          if (onCellEdit) {
            onCellEdit({ dataSourceId: effectiveDataSourceId, rowIndex: originalIndex, columnName: col, newValue })
          }
          newCells.add(`${r},${c}`)
        }
      })
    })
    if (newCells.size > 0) setSelectedCells(newCells)
  }, [effectiveDataSourceId, maxRow, maxCol, originalDataIndices, columns, onCellEdit])

  const handlePaste = useCallback(async () => {
    if (!effectiveDataSourceId || !focusedCell) return
    try {
      const text = await navigator.clipboard.readText()
      distributePastedText(text, focusedCell.rowIdx, focusedCell.colIdx)
    } catch { /* clipboard access denied */ }
  }, [effectiveDataSourceId, focusedCell, distributePastedText])

  const handleDeleteSelectedCells = useCallback(() => {
    if (!effectiveDataSourceId || selectedCells.size === 0) return
    selectedCells.forEach(key => {
      const [r, c] = key.split(',').map(Number)
      if (r < displayData.length && c < columns.length) {
        const originalIndex = originalDataIndices[r]
        const col = columns[c]
        if (onCellEdit) {
          onCellEdit({ dataSourceId: effectiveDataSourceId, rowIndex: originalIndex, columnName: col, newValue: '' })
        }
      }
    })
  }, [effectiveDataSourceId, selectedCells, displayData, columns, originalDataIndices, onCellEdit])

  // ─── Global keyboard handler ─────────────────
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const handleKeyDown = (e) => {
      // Skip if editing cell (handled by handleEditKeyDown) or filter menu open
      if (editingCell || filterMenuColumn) return

      const meta = e.metaKey || e.ctrlKey

      // Ctrl+C
      if (meta && e.key === 'c') { e.preventDefault(); handleCopy(); return }
      // Ctrl+V
      if (meta && e.key === 'v') { e.preventDefault(); handlePaste(); return }

      if (!focusedCell) return

      // Arrow keys
      if (e.key === 'ArrowUp') { e.preventDefault(); navigateToCell(focusedCell.rowIdx - 1, focusedCell.colIdx); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); navigateToCell(focusedCell.rowIdx + 1, focusedCell.colIdx); return }
      if (e.key === 'ArrowLeft') { e.preventDefault(); navigateToCell(focusedCell.rowIdx, focusedCell.colIdx - 1); return }
      if (e.key === 'ArrowRight') { e.preventDefault(); navigateToCell(focusedCell.rowIdx, focusedCell.colIdx + 1); return }

      // Tab
      if (e.key === 'Tab') {
        e.preventDefault()
        if (e.shiftKey) navigateToCell(focusedCell.rowIdx, focusedCell.colIdx - 1)
        else navigateToCell(focusedCell.rowIdx, focusedCell.colIdx + 1)
        return
      }

      // Enter / F2 → start editing
      if (e.key === 'Enter' || e.key === 'F2') {
        e.preventDefault()
        startEditExisting(focusedCell.rowIdx, focusedCell.colIdx)
        return
      }

      // Delete / Backspace
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        handleDeleteSelectedCells()
        return
      }

      // Printable character → start typing
      if (e.key.length === 1 && !meta && !e.altKey) {
        e.preventDefault()
        startEditByTyping(focusedCell.rowIdx, focusedCell.colIdx, e.key)
        return
      }
    }
    panel.addEventListener('keydown', handleKeyDown)
    return () => panel.removeEventListener('keydown', handleKeyDown)
  }, [editingCell, filterMenuColumn, focusedCell, navigateToCell, handleCopy, handlePaste, handleDeleteSelectedCells, startEditExisting, startEditByTyping])

  // ─── Selection helpers ─────────────────

  const commitSelection = useCallback((newCells) => {
    setSelectedCells(newCells)
    pushHistory(newCells, sortConfig, columnFilters)
  }, [pushHistory, sortConfig, columnFilters])

  // Row click → select entire row
  const handleRowClick = useCallback((rowIdx, e) => {
    e.preventDefault()
    const colCount = columns.length
    if (e.metaKey || e.ctrlKey) {
      const next = new Set(selectedCells)
      let allSelected = true
      for (let c = 0; c < colCount; c++) { if (!next.has(`${rowIdx},${c}`)) { allSelected = false; break } }
      for (let c = 0; c < colCount; c++) {
        const key = `${rowIdx},${c}`
        if (allSelected) next.delete(key); else next.add(key)
      }
      commitSelection(next)
    } else if (e.shiftKey && dragStart) {
      const minRow = Math.min(dragStart.row, rowIdx), maxR = Math.max(dragStart.row, rowIdx)
      const keys = new Set()
      for (let r = minRow; r <= maxR; r++) for (let c = 0; c < colCount; c++) keys.add(`${r},${c}`)
      commitSelection(keys)
    } else {
      const keys = new Set()
      for (let c = 0; c < colCount; c++) keys.add(`${rowIdx},${c}`)
      commitSelection(keys)
      setDragStart({ row: rowIdx, col: 0 })
    }
    setFocusedCell({ rowIdx, colIdx: 0 })
    panelRef.current?.focus()
  }, [columns.length, selectedCells, dragStart, commitSelection])

  // Header click → select entire column
  const handleHeaderClick = useCallback((colIdx, e) => {
    e.preventDefault()
    const rowCount = Math.min(displayData.length, visibleRows)
    if (e.metaKey) {
      const next = new Set(selectedCells)
      let allSelected = true
      for (let r = 0; r < rowCount; r++) { if (!next.has(`${r},${colIdx}`)) { allSelected = false; break } }
      for (let r = 0; r < rowCount; r++) {
        const key = `${r},${colIdx}`
        if (allSelected) next.delete(key); else next.add(key)
      }
      commitSelection(next)
    } else if (e.shiftKey && dragStart) {
      const minC = Math.min(dragStart.col, colIdx), maxC = Math.max(dragStart.col, colIdx)
      const keys = new Set()
      for (let c = minC; c <= maxC; c++) for (let r = 0; r < rowCount; r++) keys.add(`${r},${c}`)
      commitSelection(keys)
    } else {
      const keys = new Set()
      for (let r = 0; r < rowCount; r++) keys.add(`${r},${colIdx}`)
      commitSelection(keys)
      setDragStart({ row: 0, col: colIdx })
    }
    setFocusedCell({ rowIdx: 0, colIdx })
    panelRef.current?.focus()
  }, [displayData.length, selectedCells, dragStart, commitSelection, visibleRows])

  // Cell mouse handlers
  const handleCellMouseDown = useCallback((rowIdx, colIdx, e) => {
    if (e.button !== 0) return
    e.preventDefault()
    isDraggingRef.current = true
    setFocusedCell({ rowIdx, colIdx })

    if (e.shiftKey && dragStart) {
      const keys = getRangeKeys(dragStart, { row: rowIdx, col: colIdx })
      commitSelection(keys)
    } else if (e.metaKey || e.ctrlKey) {
      const key = `${rowIdx},${colIdx}`
      const next = new Set(selectedCells)
      if (next.has(key)) next.delete(key); else next.add(key)
      setSelectedCells(next)
      setDragStart({ row: rowIdx, col: colIdx })
    } else {
      setSelectedCells(new Set([`${rowIdx},${colIdx}`]))
      setDragStart({ row: rowIdx, col: colIdx })
    }
    panelRef.current?.focus()
  }, [dragStart, selectedCells, getRangeKeys, commitSelection])

  const handleCellMouseEnter = useCallback((rowIdx, colIdx) => {
    if (!isDraggingRef.current || !dragStart) return
    const keys = getRangeKeys(dragStart, { row: rowIdx, col: colIdx })
    setSelectedCells(keys)
  }, [dragStart, getRangeKeys])

  useEffect(() => {
    const handleMouseUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false
        commitSelection(selectedCells)
      }
    }
    window.addEventListener('mouseup', handleMouseUp)
    return () => window.removeEventListener('mouseup', handleMouseUp)
  }, [commitSelection, selectedCells])

  // Double-click → edit
  const handleCellDoubleClick = useCallback((rowIdx, colIdx) => {
    startEditExisting(rowIdx, colIdx)
  }, [startEditExisting])

  // ─── Sort ─────────────────
  const handleSortClick = useCallback((colName, e) => {
    e.stopPropagation()
    const newSort = (() => {
      if (sortConfig.column !== colName) return { column: colName, direction: 'asc' }
      if (sortConfig.direction === 'asc') return { column: colName, direction: 'desc' }
      return { column: null, direction: null }
    })()
    setSortConfig(newSort)
    setSelectedCells(new Set())
    setFocusedCell(null)
    pushHistory(new Set(), newSort, columnFilters)
  }, [sortConfig, columnFilters, pushHistory])

  // ─── Filter ─────────────────
  const handleHeaderContextMenu = useCallback((colIdx, e) => {
    e.preventDefault()
    setFilterMenuColumn(columns[colIdx])
    setFilterMenuPosition({ top: e.clientY, left: e.clientX })
  }, [columns])

  const getUniqueValues = useCallback((colName) => {
    if (!data) return []
    const values = data.map(row => row[colName] != null ? String(row[colName]) : '')
    return [...new Set(values)].sort()
  }, [data])

  const toggleFilterValue = useCallback((colName, value) => {
    setColumnFilters(prev => {
      const allValues = getUniqueValues(colName)
      const current = prev[colName] || new Set(allValues)
      const next = new Set(current)
      if (next.has(value)) next.delete(value); else next.add(value)
      if (next.size === allValues.length) {
        const result = { ...prev }; delete result[colName]
        setSelectedCells(new Set()); pushHistory(new Set(), sortConfig, result)
        return result
      }
      const result = { ...prev, [colName]: next }
      setSelectedCells(new Set()); pushHistory(new Set(), sortConfig, result)
      return result
    })
  }, [getUniqueValues, sortConfig, pushHistory])

  const clearFilter = useCallback((colName) => {
    setColumnFilters(prev => {
      const result = { ...prev }; delete result[colName]
      setSelectedCells(new Set()); pushHistory(new Set(), sortConfig, result)
      return result
    })
    setFilterMenuColumn(null)
  }, [sortConfig, pushHistory])

  const handleFilterIconClick = useCallback((col, e) => {
    e.stopPropagation()
    const rect = e.target.getBoundingClientRect()
    setFilterMenuColumn(prev => prev === col ? null : col)
    setFilterMenuPosition({ top: rect.bottom + 2, left: rect.left })
  }, [])

  // ─── Other handlers ─────────────────

  const handleTypeClick = (colName, currentType, e) => {
    e.stopPropagation()
    const idx = TYPE_CYCLE.indexOf(currentType)
    const nextType = TYPE_CYCLE[(idx + 1) % TYPE_CYCLE.length]
    onColumnInfoChange(colName, nextType)
  }

  const handleFileUpload = (e) => {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (event) => {
      const text = event.target.result
      let parsed
      const ext = file.name.split('.').pop().toLowerCase()
      if (ext === 'json') {
        try {
          parsed = JSON.parse(text)
          if (!Array.isArray(parsed) || parsed.length === 0 || typeof parsed[0] !== 'object') {
            alert('JSON must be an array of objects'); return
          }
        } catch (err) { alert('Invalid JSON file: ' + err.message); return }
      } else {
        parsed = parseCSV(text)
      }
      if (parsed && parsed.length > 0) {
        const infos = analyzeColumns(parsed)
        if (onDataSourceCreate) onDataSourceCreate(parsed, infos, file.name)
        else onDataLoad(parsed, infos, file.name)
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  // Highlight rows matching chart element datum
  const highlightRowIndices = useMemo(() => {
    if (!highlightDatum || !displayData.length) return []
    const valuesMatch = (expected, actual) => {
      if (expected == null && actual == null) return true
      if (expected == null || actual == null) return false
      // eslint-disable-next-line eqeqeq
      if (expected == actual) return true
      const sa = String(actual), se = String(expected)
      if (sa === se) return true
      if (sa.startsWith(se) || se.startsWith(sa)) return true
      const da = new Date(actual).getTime(), de = new Date(expected).getTime()
      if (!isNaN(da) && !isNaN(de) && da === de) return true
      return false
    }
    if (highlightDatum.matchFields && highlightDatum.matchValues) {
      const { matchFields, matchValues, elementType } = highlightDatum
      if (elementType === 'axis-title' || matchFields.length === 0) return []
      const indices = []
      displayData.forEach((row, idx) => {
        if (idx >= visibleRows) return
        if (matchFields.every(field => valuesMatch(matchValues[field], row[field]))) indices.push(idx)
      })
      return indices
    }
    return []
  }, [highlightDatum, displayData, visibleRows])

  const highlightRowSet = useMemo(() => new Set(highlightRowIndices), [highlightRowIndices])

  // Highlight columns from chart element datum (matchFields)
  const highlightColSet = useMemo(() => {
    if (!highlightDatum?.matchFields || highlightDatum.matchFields.length === 0) return new Set()
    return new Set(highlightDatum.matchFields)
  }, [highlightDatum])

  // Auto-scroll to first highlighted row
  const highlightRowRef = useRef(null)
  useEffect(() => {
    if (highlightRowIndices.length > 0 && highlightRowRef.current) {
      highlightRowRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [highlightRowIndices])

  // Row add
  const handleAddRow = useCallback(() => {
    if (!effectiveDataSourceId || !onRowAdd) return
    const selectedRows = new Set()
    selectedCells.forEach(key => {
      const rowIdx = parseInt(key.split(',')[0])
      if (rowIdx >= 0 && rowIdx < displayData.length) selectedRows.add(originalDataIndices[rowIdx])
    })
    const lastOrigIdx = selectedRows.size > 0 ? Math.max(...selectedRows) : (data.length - 1)
    onRowAdd({ dataSourceId: effectiveDataSourceId, rowIndex: lastOrigIdx })
    setSelectedCells(new Set())
  }, [effectiveDataSourceId, onRowAdd, selectedCells, displayData, originalDataIndices, data])

  // Row delete
  const handleDeleteRows = useCallback(() => {
    if (!effectiveDataSourceId || !onRowDelete) return
    const rowIndices = new Set()
    selectedCells.forEach(key => {
      const rowIdx = parseInt(key.split(',')[0])
      if (rowIdx >= 0 && rowIdx < displayData.length) rowIndices.add(originalDataIndices[rowIdx])
    })
    if (rowIndices.size === 0) return
    onRowDelete({ dataSourceId: effectiveDataSourceId, rowIndices: [...rowIndices] })
    setSelectedCells(new Set())
  }, [effectiveDataSourceId, onRowDelete, selectedCells, displayData, originalDataIndices])

  // Column add
  const handleAddColumn = useCallback(() => {
    if (!effectiveDataSourceId || !onColumnAdd) return
    let idx = 1
    while (columns.includes(`new_${idx}`)) idx++
    onColumnAdd({ dataSourceId: effectiveDataSourceId, columnName: `new_${idx}` })
  }, [effectiveDataSourceId, onColumnAdd, columns])

  // Column delete
  const handleDeleteColumns = useCallback(() => {
    if (!effectiveDataSourceId || !onColumnDelete) return
    const colNames = [...new Set(
      [...selectedCells].map(key => {
        const colIdx = parseInt(key.split(',')[1])
        return columns[colIdx]
      }).filter(Boolean)
    )]
    if (colNames.length === 0) return
    onColumnDelete({ dataSourceId: effectiveDataSourceId, columnNames: colNames })
    setSelectedCells(new Set())
  }, [effectiveDataSourceId, onColumnDelete, selectedCells, columns])

  // ─── Render ─────────────────

  // No active data: show data source list
  if (!selectedChartDataSourceId && !activeDataSourceId) {
    const dsList = dataSources ? Object.entries(dataSources) : []
    return (
      <div className="data-table-panel" ref={panelRef} tabIndex={-1}>
        <input type="file" accept=".csv,.json,.tsv" ref={fileInputRef} style={{ display: 'none' }} onChange={handleFileUpload} />
        <div className="data-table-header">
          <span className="data-table-title">Data</span>
          <span className="data-source-name">Select a dataset</span>
        </div>
        <div className="dataset-selector">
          {dsList.map(([id, ds]) => (
            <button key={id} className="dataset-card" onClick={() => onSelectDataSource?.(id)}>
              <span className="dataset-card-name">{ds.name}</span>
              {ds.description && <span className="dataset-card-desc">{ds.description}</span>}
              {ds.values && <span className="dataset-card-rows">{ds.values.length} rows</span>}
            </button>
          ))}
          <button className="dataset-card upload-card" onClick={() => fileInputRef.current?.click()}>
            <span style={{ fontSize: 20, lineHeight: 1 }}>+</span>
            <span className="dataset-card-name">Upload CSV / JSON</span>
          </button>
        </div>
      </div>
    )
  }

  if (!data || data.length === 0) {
    return (
      <div className="data-table-panel" ref={panelRef} tabIndex={-1}>
        <div className="data-table-header">
          <span className="data-table-title">Data</span>
        </div>
        <div className="data-table-empty"><p>No data loaded</p></div>
      </div>
    )
  }

  const getColumnSelectionState = (colIdx) => {
    const rowCount = Math.min(displayData.length, visibleRows)
    let count = 0
    for (let r = 0; r < rowCount; r++) { if (selectedCells.has(`${r},${colIdx}`)) count++ }
    if (count === 0) return 'none'
    if (count === rowCount) return 'full'
    return 'partial'
  }

  const getRowSelectionState = (rowIdx) => {
    const colCount = columns.length
    let count = 0
    for (let c = 0; c < colCount; c++) { if (selectedCells.has(`${rowIdx},${c}`)) count++ }
    if (count === 0) return 'none'
    if (count === colCount) return 'full'
    return 'partial'
  }

  const selectedRowCount = (() => {
    const rows = new Set()
    selectedCells.forEach(key => rows.add(parseInt(key.split(',')[0])))
    return rows.size
  })()

  const hasActiveFilters = Object.keys(columnFilters).length > 0

  return (
    <div className="data-table-panel" ref={panelRef} tabIndex={-1}>
      <input type="file" accept=".csv,.json,.tsv" ref={fileInputRef} style={{ display: 'none' }} onChange={handleFileUpload} />
      <div className="data-table-header">
        {!selectedChartDataSourceId && (
          <button className="data-back-btn" onClick={() => onSelectDataSource?.(null)} title="Back to datasets">←</button>
        )}
        <span className="data-table-title">Data</span>
        <span className="data-source-name">
          {effectiveDataSourceId && dataSources?.[effectiveDataSourceId]
            ? dataSources[effectiveDataSourceId].name
            : dataSourceName || 'sample'}
        </span>
        {/* <button className="data-upload-btn" onClick={() => fileInputRef.current?.click()} title="Upload data file">Upload</button> */}
        {hasActiveFilters && <span className="filter-active-badge" title="Filters active">F</span>}
      </div>

      <div className="data-table-scroll" ref={tableRef}>
        <table className="data-table">
          <thead>
            {/* Header row: A, B, C... like Excel */}
            <tr className="col-letter-row">
              <th className="row-num-header">
                <div className="corner-cell" />
              </th>
              {columns.map((col, colIdx) => {
                const colState = getColumnSelectionState(colIdx)
                return (
                  <th
                    key={col}
                    className={[
                      'col-letter-cell',
                      colState !== 'none' ? `col-selected ${colState === 'full' ? 'col-full' : 'col-partial'}` : '',
                    ].filter(Boolean).join(' ')}
                    onClick={(e) => handleHeaderClick(colIdx, e)}
                  >
                    {col}
                  </th>
                )
              })}
              {effectiveDataSourceId && (
                <th className="add-col-header" onClick={handleAddColumn} title="Add column">
                  <span className="add-col-btn">+</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {displayData.slice(0, visibleRows).map((row, rowIdx) => {
              const rowState = getRowSelectionState(rowIdx)
              const isHighlighted = highlightRowSet.has(rowIdx)
              return (
                <tr
                  key={rowIdx}
                  ref={isHighlighted && rowIdx === highlightRowIndices[0] ? highlightRowRef : undefined}
                  className={isHighlighted ? 'row-datum-highlight' : ''}
                >
                  <td
                    className={`row-num ${rowState !== 'none' ? `row-selected ${rowState === 'full' ? 'row-full' : 'row-partial'}` : ''}${isHighlighted ? ' row-datum-highlight' : ''}`}
                    onClick={(e) => handleRowClick(rowIdx, e)}
                  >
                    {rowIdx + 1}
                  </td>
                  {columns.map((col, colIdx) => {
                    const cellKey = `${rowIdx},${colIdx}`
                    const isSelected = selectedCells.has(cellKey)
                    const isFocused = focusedCell && focusedCell.rowIdx === rowIdx && focusedCell.colIdx === colIdx
                    const isEditing = editingCell && editingCell.rowIdx === rowIdx && editingCell.colIdx === colIdx
                    const isEncoded = encodedFieldSet.has(col)
                    const isCellHighlightCol = highlightColSet.has(col)

                    return (
                      <td
                        key={col}
                        className={[
                          isSelected ? 'cell-selected' : '',
                          isFocused ? 'cell-focused' : '',
                          isEncoded ? 'cell-encoded' : '',
                          isCellHighlightCol && isHighlighted ? 'cell-datum-highlight' : ''
                        ].filter(Boolean).join(' ')}
                        onMouseDown={(e) => handleCellMouseDown(rowIdx, colIdx, e)}
                        onMouseEnter={() => handleCellMouseEnter(rowIdx, colIdx)}
                        onDoubleClick={() => handleCellDoubleClick(rowIdx, colIdx)}
                      >
                        {isEditing ? (
                          <input
                            className="cell-edit-input"
                            type="text"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={() => commitCellEdit()}
                            onKeyDown={handleEditKeyDown}
                            onPaste={(e) => {
                              // Multi-cell clipboard while editing → distribute across the
                              // grid instead of dumping everything into this one cell.
                              const text = e.clipboardData?.getData('text') || ''
                              if (/[\t\n]/.test(text.replace(/\n+$/, ''))) {
                                e.preventDefault()
                                cancelCellEdit()
                                distributePastedText(text, rowIdx, colIdx)
                              }
                            }}
                            autoFocus
                          />
                        ) : (
                          row[col] != null ? String(row[col]) : ''
                        )}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
            {effectiveDataSourceId && (
              <tr className="add-row-tr">
                <td className="add-row-cell" onClick={handleAddRow} title="Add row">
                  <span className="add-row-btn">+</span>
                </td>
                {columns.map((col) => <td key={col} className="add-row-empty" />)}
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="data-table-footer">
        <span className="footer-info">
          {highlightRowIndices.length > 0
            ? <span><span className="highlight-count">{highlightRowIndices.length} rows highlighted</span> · {displayData.length} rows</span>
            : localSelectedCols.length > 0
              ? `Selected: ${localSelectedCols.join(', ')} (${selectedRowCount} rows)`
              : `${displayData.length}${hasActiveFilters ? ` of ${data.length}` : ''} rows`
          }
        </span>
        {(displayData.length > visibleRows || visibleRows > INITIAL_VISIBLE_ROWS) && (
          <span className="footer-more">
            <span className="footer-more-count">showing {Math.min(visibleRows, displayData.length).toLocaleString()} / {displayData.length.toLocaleString()}</span>
            {displayData.length > visibleRows && (
              <>
                <button
                  className="footer-more-btn"
                  onClick={() => setVisibleRows(v => Math.min(displayData.length, v + 1000))}
                >
                  More
                </button>
                <button
                  className="footer-more-btn"
                  onClick={() => setVisibleRows(displayData.length)}
                >
                  Show all
                </button>
              </>
            )}
            {visibleRows > INITIAL_VISIBLE_ROWS && (
              <button
                className="footer-more-btn"
                onClick={() => setVisibleRows(INITIAL_VISIBLE_ROWS)}
              >
                Show less
              </button>
            )}
          </span>
        )}
        {effectiveDataSourceId && selectedRowCount > 0 && (() => {
          const rCount = Math.min(displayData.length, visibleRows)
          const fullCols = localSelectedCols.filter((_, i) => {
            const colIdx = columns.indexOf(localSelectedCols[i])
            for (let r = 0; r < rCount; r++) { if (!selectedCells.has(`${r},${colIdx}`)) return false }
            return true
          })
          const selectedRows = new Set()
          selectedCells.forEach(key => selectedRows.add(parseInt(key.split(',')[0])))
          const fullRows = [...selectedRows].filter(r => {
            for (let c = 0; c < columns.length; c++) { if (!selectedCells.has(`${r},${c}`)) return false }
            return true
          })
          const isFullColSelection = fullCols.length > 0 && fullCols.length === localSelectedCols.length
          const isFullRowSelection = fullRows.length > 0
          if (isFullColSelection) {
            return (
              <span className="footer-actions">
                <button className="footer-action-btn delete-btn" onClick={handleDeleteColumns}
                  title={`Delete column(s): ${fullCols.join(', ')}`}
                >Delete {fullCols.length} col{fullCols.length > 1 ? 's' : ''}</button>
              </span>
            )
          }
          if (isFullRowSelection) {
            return (
              <span className="footer-actions">
                <button className="footer-action-btn delete-btn" onClick={handleDeleteRows}
                  title={`Delete ${fullRows.length} row(s)`}
                >Delete {fullRows.length} row{fullRows.length > 1 ? 's' : ''}</button>
              </span>
            )
          }
          return null
        })()}
      </div>

      {/* Filter dropdown menu */}
      {filterMenuColumn && (
        <div className="filter-menu-overlay" onClick={() => setFilterMenuColumn(null)}>
          <div
            className="filter-menu"
            style={{ top: filterMenuPosition.top, left: filterMenuPosition.left }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="filter-menu-header">
              <span>Filter: {filterMenuColumn}</span>
              <button onClick={() => clearFilter(filterMenuColumn)}>Clear</button>
            </div>
            <div className="filter-menu-items">
              {getUniqueValues(filterMenuColumn).map(val => {
                const currentFilter = columnFilters[filterMenuColumn]
                const isChecked = !currentFilter || currentFilter.has(val)
                return (
                  <label key={val} className="filter-menu-item">
                    <input type="checkbox" checked={isChecked} onChange={() => toggleFilterValue(filterMenuColumn, val)} />
                    <span>{val || '(empty)'}</span>
                  </label>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default DataTable
