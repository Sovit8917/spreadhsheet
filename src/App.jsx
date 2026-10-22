import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import './App.css'
import { createEngine, normText, toNum } from './engine/core.js'
import { loadSampleSmall, loadSampleLarge } from './fixtures/loadSample.js'

const TOTAL_ROWS = 50
const TOTAL_COLS = 50

export default function App() {
  const [engine] = useState(() => createEngine(TOTAL_ROWS, TOTAL_COLS))
  const [, setVersion] = useState(0)
  const [selectedCell, setSelectedCell] = useState(null)
  const [editingCell, setEditingCell] = useState(null)
  const [editValue, setEditValue] = useState('')
  const [cellStyles, setCellStyles] = useState({})
  const cellInputRef = useRef(null)

  // ────── Filter State ──────
  // columnFilters: { [colIndex]: { search: '', selectedValues: Set<string>, condition: { type: 'none'|'contains'|'gt'|'lt'|'isEmpty', val: '' } } }
  const [columnFilters, setColumnFilters] = useState({})
  const [activeFilterDropdownCol, setActiveFilterDropdownCol] = useState(null)
  const [dropdownSearch, setDropdownSearch] = useState('')
  const dropdownRef = useRef(null)

  // ────── Sort State (UI tracking: null | 'asc' | 'desc') ──────
  const [sortState, setSortState] = useState({ col: null, dir: null })

  const forceRerender = useCallback(() => setVersion(v => v + 1), [])

  // Close filter dropdown on outside click
  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setActiveFilterDropdownCol(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // ────── Cell style helpers ──────

  const getCellStyle = useCallback((row, col) => {
    const key = `${row},${col}`
    return cellStyles[key] || {
      bold: false, italic: false, underline: false,
      bg: 'white', color: '#202124', align: 'left', fontSize: 13
    }
  }, [cellStyles])

  const updateCellStyle = useCallback((row, col, updates) => {
    const key = `${row},${col}`
    setCellStyles(prev => ({
      ...prev,
      [key]: { ...getCellStyle(row, col), ...updates }
    }))
  }, [getCellStyle])

  // Remap styles when rows move due to sorting
  const remapStyles = useCallback((rowMapping) => {
    setCellStyles(prev => {
      const next = {}
      for (const [key, style] of Object.entries(prev)) {
        const parts = key.split(',')
        const r = parseInt(parts[0], 10)
        const c = parseInt(parts[1], 10)
        const targetRow = rowMapping.has(r) ? rowMapping.get(r) : r
        next[`${targetRow},${c}`] = style
      }
      return next
    })
  }, [])

  // ────── Cell editing ──────

  const startEditing = useCallback((row, col) => {
    setSelectedCell({ r: row, c: col })
    setEditingCell({ r: row, c: col })
    const cellData = engine.getCell(row, col)
    setEditValue(cellData.raw)
    setTimeout(() => cellInputRef.current?.focus(), 0)
  }, [engine])

  const commitEdit = useCallback((row, col) => {
    const currentCell = engine.getCell(row, col)
    if (currentCell.raw !== editValue) {
      engine.setCell(row, col, editValue)
      forceRerender()
    }
    setEditingCell(null)
  }, [engine, editValue, forceRerender])

  const handleCellClick = useCallback((row, col) => {
    if (editingCell && (editingCell.r !== row || editingCell.c !== col)) {
      commitEdit(editingCell.r, editingCell.c)
    }
    if (!editingCell || editingCell.r !== row || editingCell.c !== col) {
      startEditing(row, col)
    }
  }, [editingCell, commitEdit, startEditing])

  // ────── Keyboard navigation ──────

  const handleKeyDown = useCallback((event, row, col) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitEdit(row, col)
      startEditing(Math.min(row + 1, engine.rows - 1), col)
    } else if (event.key === 'Tab') {
      event.preventDefault()
      commitEdit(row, col)
      startEditing(row, Math.min(col + 1, engine.cols - 1))
    } else if (event.key === 'Escape') {
      setEditValue(engine.getCell(row, col).raw)
      setEditingCell(null)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      commitEdit(row, col)
      startEditing(Math.min(row + 1, engine.rows - 1), col)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      commitEdit(row, col)
      startEditing(Math.max(row - 1, 0), col)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      commitEdit(row, col)
      if (col > 0) {
        startEditing(row, col - 1)
      } else if (row > 0) {
        startEditing(row - 1, engine.cols - 1)
      }
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      commitEdit(row, col)
      startEditing(row, Math.min(col + 1, engine.cols - 1))
    }
  }, [engine, commitEdit, startEditing])

  // ────── Formula bar handlers ──────

  const handleFormulaBarKeyDown = useCallback((event) => {
    if (!editingCell) return
    handleKeyDown(event, editingCell.r, editingCell.c)
  }, [editingCell, handleKeyDown])

  const handleFormulaBarFocus = useCallback(() => {
    if (selectedCell && !editingCell) {
      setEditingCell(selectedCell)
      setEditValue(engine.getCell(selectedCell.r, selectedCell.c).raw)
    }
  }, [selectedCell, editingCell, engine])

  const handleFormulaBarChange = useCallback((value) => {
    if (!editingCell && selectedCell) setEditingCell(selectedCell)
    setEditValue(value)
  }, [editingCell, selectedCell])

  // ────── Undo / Redo ──────

  const handleUndo = useCallback(() => {
    const res = engine.undo()
    if (res) {
      if (res.type === 'sort') {
        // Invert mapping for styles if needed, or re-evaluate styles based on reverse
        const reverseMapping = new Map()
        for (const [oldR, newR] of res.rowMapping.entries()) {
          reverseMapping.set(newR, oldR)
        }
        remapStyles(reverseMapping)
        setSortState({ col: null, dir: null })
      }
      forceRerender()
    }
  }, [engine, forceRerender, remapStyles])

  const handleRedo = useCallback(() => {
    const res = engine.redo()
    if (res) {
      if (res.type === 'sort') {
        remapStyles(res.rowMapping)
      }
      forceRerender()
    }
  }, [engine, forceRerender, remapStyles])

  // ────── Formatting toggles ──────

  const toggleBold = useCallback(() => {
    if (!selectedCell) return
    const style = getCellStyle(selectedCell.r, selectedCell.c)
    updateCellStyle(selectedCell.r, selectedCell.c, { bold: !style.bold })
  }, [selectedCell, getCellStyle, updateCellStyle])

  const toggleItalic = useCallback(() => {
    if (!selectedCell) return
    const style = getCellStyle(selectedCell.r, selectedCell.c)
    updateCellStyle(selectedCell.r, selectedCell.c, { italic: !style.italic })
  }, [selectedCell, getCellStyle, updateCellStyle])

  const toggleUnderline = useCallback(() => {
    if (!selectedCell) return
    const style = getCellStyle(selectedCell.r, selectedCell.c)
    updateCellStyle(selectedCell.r, selectedCell.c, { underline: !style.underline })
  }, [selectedCell, getCellStyle, updateCellStyle])

  const changeFontSize = useCallback((size) => {
    if (!selectedCell) return
    updateCellStyle(selectedCell.r, selectedCell.c, { fontSize: size })
  }, [selectedCell, updateCellStyle])

  const changeAlignment = useCallback((align) => {
    if (!selectedCell) return
    updateCellStyle(selectedCell.r, selectedCell.c, { align })
  }, [selectedCell, updateCellStyle])

  const changeFontColor = useCallback((color) => {
    if (!selectedCell) return
    updateCellStyle(selectedCell.r, selectedCell.c, { color })
  }, [selectedCell, updateCellStyle])

  const changeBackgroundColor = useCallback((color) => {
    if (!selectedCell) return
    updateCellStyle(selectedCell.r, selectedCell.c, { bg: color })
  }, [selectedCell, updateCellStyle])

  // ────── Clear operations ──────

  const clearSelectedCell = useCallback(() => {
    if (!selectedCell) return
    engine.setCell(selectedCell.r, selectedCell.c, '')
    forceRerender()
    const key = `${selectedCell.r},${selectedCell.c}`
    setCellStyles(prev => { const next = { ...prev }; delete next[key]; return next })
    setEditValue('')
  }, [selectedCell, engine, forceRerender])

  const clearAllCells = useCallback(() => {
    for (let r = 0; r < engine.rows; r++) {
      for (let c = 0; c < engine.cols; c++) {
        engine.setCell(r, c, '')
      }
    }
    forceRerender()
    setCellStyles({})
    setSelectedCell(null)
    setEditingCell(null)
    setEditValue('')
    setColumnFilters({})
    setSortState({ col: null, dir: null })
  }, [engine, forceRerender])

  // ────── Sample data ──────

  const loadSample = useCallback((loader) => {
    loader(engine)
    forceRerender()
    setSelectedCell({ r: 0, c: 0 })
    setEditingCell(null)
    setEditValue('')
    setColumnFilters({})
    setSortState({ col: null, dir: null })
  }, [engine, forceRerender])

  // ────── Row / Column operations ──────

  const insertRow = useCallback(() => {
    if (!selectedCell) return
    engine.insertRow(selectedCell.r)
    forceRerender()
    setSelectedCell({ r: selectedCell.r + 1, c: selectedCell.c })
  }, [selectedCell, engine, forceRerender])

  const deleteRow = useCallback(() => {
    if (!selectedCell) return
    engine.deleteRow(selectedCell.r)
    forceRerender()
    if (selectedCell.r >= engine.rows) {
      setSelectedCell({ r: engine.rows - 1, c: selectedCell.c })
    }
  }, [selectedCell, engine, forceRerender])

  const insertColumn = useCallback(() => {
    if (!selectedCell) return
    engine.insertColumn(selectedCell.c)
    forceRerender()
    setSelectedCell({ r: selectedCell.r, c: selectedCell.c + 1 })
  }, [selectedCell, engine, forceRerender])

  const deleteColumn = useCallback(() => {
    if (!selectedCell) return
    engine.deleteColumn(selectedCell.c)
    forceRerender()
    if (selectedCell.c >= engine.cols) {
      setSelectedCell({ r: selectedCell.r, c: engine.cols - 1 })
    }
  }, [selectedCell, engine, forceRerender])

  // ────── Filter Logic ──────

  const blockInfo = useMemo(() => {
    return engine.getDataBlock()
  }, [engine, engine.rows, engine.cols, cellStyles])

  // Distinct values for the active dropdown column
  const activeColDistinctValues = useMemo(() => {
    if (activeFilterDropdownCol === null || !blockInfo) return []
    const { startRow, endRow } = blockInfo
    const map = new Map() // normKey -> { label, count, isBlank }
    let hasBlank = false

    for (let r = startRow; r <= endRow; r++) {
      const cell = engine.getCell(r, activeFilterDropdownCol)
      const val = (cell.computed !== null && cell.computed !== '') ? String(cell.computed) : cell.raw
      const trimmed = val ? val.trim() : ''
      if (!trimmed) {
        hasBlank = true
      } else {
        const key = normText(trimmed)
        if (!map.has(key)) {
          map.set(key, { key, label: trimmed, count: 1 })
        } else {
          map.get(key).count++
        }
      }
    }

    const list = Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
    if (hasBlank) {
      list.push({ key: '__BLANK__', label: '(Blanks)', isBlank: true })
    }
    return list
  }, [activeFilterDropdownCol, blockInfo, engine])

  // Check if a cell satisfies a filter for a column
  const testFilter = useCallback((cellVal, filterConfig) => {
    if (!filterConfig) return true
    const { selectedValues, condition } = filterConfig
    const trimmed = cellVal ? String(cellVal).trim() : ''
    const norm = normText(trimmed)
    const isBlank = !trimmed

    // 1. Distinct values checklist filter
    if (selectedValues && selectedValues.size > 0) {
      if (isBlank) {
        if (!selectedValues.has('__BLANK__')) return false
      } else {
        if (!selectedValues.has(norm)) return false
      }
    }

    // 2. Condition filter
    if (condition && condition.type && condition.type !== 'none') {
      const condVal = condition.val || ''
      switch (condition.type) {
        case 'contains':
          if (!norm.includes(normText(condVal))) return false
          break
        case 'greater than': {
          const numCell = toNum(cellVal)
          const numCond = toNum(condVal)
          if (numCell === null || numCond === null || numCell <= numCond) return false
          break
        }
        case 'less than': {
          const numCell = toNum(cellVal)
          const numCond = toNum(condVal)
          if (numCell === null || numCond === null || numCell >= numCond) return false
          break
        }
        case 'is empty':
          if (!isBlank) return false
          break
        default:
          break
      }
    }

    return true
  }, [])

  // Calculate visible rows
  const visibleRowIndices = useMemo(() => {
    if (!blockInfo) {
      return new Set(Array.from({ length: engine.rows }, (_, i) => i))
    }
    const { startRow, endRow } = blockInfo
    const activeCols = Object.keys(columnFilters).filter(col => {
      const f = columnFilters[col]
      return f && ((f.selectedValues && f.selectedValues.size > 0) || (f.condition && f.condition.type !== 'none'))
    })

    const visible = new Set()
    // Row 0 (header) is always visible
    visible.add(0)

    for (let r = startRow; r <= endRow; r++) {
      let rowMatches = true
      for (const colStr of activeCols) {
        const col = parseInt(colStr, 10)
        const cell = engine.getCell(r, col)
        const val = (cell.computed !== null && cell.computed !== '') ? cell.computed : cell.raw
        if (!testFilter(val, columnFilters[col])) {
          rowMatches = false
          break
        }
      }
      if (rowMatches) {
        visible.add(r)
      }
    }

    // If totals row was pinned, keep it visible!
    if (blockInfo.isTotalsPinned) {
      visible.add(blockInfo.endRow + 1)
    }

    // Any remaining grid buffer rows outside used block
    const maxBlockRow = blockInfo.isTotalsPinned ? blockInfo.endRow + 1 : blockInfo.endRow
    for (let r = maxBlockRow + 1; r < engine.rows; r++) {
      visible.add(r)
    }

    return visible
  }, [blockInfo, columnFilters, engine, testFilter])

  // Count visible data rows for status line
  const dataRowCount = useMemo(() => {
    if (!blockInfo) return { visible: engine.rows - 1, total: engine.rows - 1 }
    const total = blockInfo.endRow - blockInfo.startRow + 1
    let visible = 0
    for (let r = blockInfo.startRow; r <= blockInfo.endRow; r++) {
      if (visibleRowIndices.has(r)) visible++
    }
    return { visible, total }
  }, [blockInfo, visibleRowIndices, engine.rows])

  // ────── Sort action handler ──────

  const handleHeaderSort = useCallback((colIndex) => {
    let nextDir = 'asc'
    if (sortState.col === colIndex) {
      if (sortState.dir === 'asc') nextDir = 'desc'
      else if (sortState.dir === 'desc') nextDir = 'original'
      else nextDir = 'asc'
    }

    const res = engine.sort(colIndex, nextDir, { visibleRows: visibleRowIndices })
    if (res.reorderedCount > 0 && res.rowMapping) {
      remapStyles(res.rowMapping)
    }
    setSortState({ col: colIndex, dir: nextDir === 'original' ? null : nextDir })
    forceRerender()
  }, [sortState, engine, visibleRowIndices, remapStyles, forceRerender])

  // Clear single column filter
  const clearColumnFilter = useCallback((colIndex) => {
    setColumnFilters(prev => {
      const next = { ...prev }
      delete next[colIndex]
      return next
    })
    forceRerender()
  }, [forceRerender])

  // Clear all filters
  const clearAllFilters = useCallback(() => {
    setColumnFilters({})
    setActiveFilterDropdownCol(null)
    forceRerender()
  }, [forceRerender])

  // Toggle dropdown
  const toggleFilterDropdown = useCallback((e, colIndex) => {
    e.stopPropagation()
    if (activeFilterDropdownCol === colIndex) {
      setActiveFilterDropdownCol(null)
    } else {
      setActiveFilterDropdownCol(colIndex)
      setDropdownSearch('')
    }
  }, [activeFilterDropdownCol])

  // ────── Derived selection / UI ──────

  const selectedCellStyle = useMemo(() => {
    return selectedCell ? getCellStyle(selectedCell.r, selectedCell.c) : null
  }, [selectedCell, getCellStyle])

  const getColumnLabel = useCallback((col) => {
    let label = ''
    let num = col + 1
    while (num > 0) {
      num--
      label = String.fromCharCode(65 + (num % 26)) + label
      num = Math.floor(num / 26)
    }
    return label
  }, [])

  const selectedCellLabel = selectedCell
    ? `${getColumnLabel(selectedCell.c)}${selectedCell.r + 1}`
    : 'No cell'

  const formulaBarValue = editingCell
    ? editValue
    : (selectedCell ? engine.getCell(selectedCell.r, selectedCell.c).raw : '')

  const isFilterActive = useMemo(() => {
    return Object.keys(columnFilters).some(c => {
      const f = columnFilters[c]
      return f && ((f.selectedValues && f.selectedValues.size > 0) || (f.condition && f.condition.type !== 'none'))
    })
  }, [columnFilters])

  // ────── Render ──────

  return (
    <div className="app-wrapper">
      <div className="app-header">
        <h2 className="app-title">📊 Spreadsheet App</h2>
        {isFilterActive && (
          <div className="header-status-badge">
            <span>Filtering active: <strong>{dataRowCount.visible} of {dataRowCount.total} rows</strong></span>
            <button className="clear-all-filter-btn" onClick={clearAllFilters}>Clear all filters</button>
          </div>
        )}
      </div>

      <div className="main-content">

        {/* ── Toolbar ── */}
        <div className="toolbar">
          <div className="toolbar-group">
            <button className={`toolbar-btn bold-btn ${selectedCellStyle?.bold ? 'active' : ''}`} onClick={toggleBold} title="Bold">B</button>
            <button className={`toolbar-btn italic-btn ${selectedCellStyle?.italic ? 'active' : ''}`} onClick={toggleItalic} title="Italic">I</button>
            <button className={`toolbar-btn underline-btn ${selectedCellStyle?.underline ? 'active' : ''}`} onClick={toggleUnderline} title="Underline">U</button>
          </div>

          <div className="toolbar-group">
            <span className="toolbar-label">Size:</span>
            <select className="toolbar-select" value={selectedCellStyle?.fontSize || 13} onChange={(e) => changeFontSize(parseInt(e.target.value, 10))}>
              {[8, 10, 11, 12, 13, 14, 16, 18, 20, 24].map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          <div className="toolbar-group">
            <button className={`align-btn ${selectedCellStyle?.align === 'left' ? 'active' : ''}`} onClick={() => changeAlignment('left')} title="Align Left">⬤←</button>
            <button className={`align-btn ${selectedCellStyle?.align === 'center' ? 'active' : ''}`} onClick={() => changeAlignment('center')} title="Align Center">⬤</button>
            <button className={`align-btn ${selectedCellStyle?.align === 'right' ? 'active' : ''}`} onClick={() => changeAlignment('right')} title="Align Right">⬤→</button>
          </div>

          <div className="toolbar-group">
            <span className="toolbar-label">Text:</span>
            <input
              type="color"
              value={selectedCellStyle?.color || '#000000'}
              onChange={(e) => changeFontColor(e.target.value)}
              title="Font color"
              style={{ width: '32px', height: '32px', border: '1px solid #dadce0', cursor: 'pointer', borderRadius: '4px' }}
            />
          </div>

          <div className="toolbar-group">
            <span className="toolbar-label">Fill:</span>
            <select className="toolbar-select" value={selectedCellStyle?.bg || 'white'} onChange={(e) => changeBackgroundColor(e.target.value)}>
              <option value="white">White</option>
              <option value="#ffff99">Yellow</option>
              <option value="#99ffcc">Green</option>
              <option value="#ffcccc">Red</option>
              <option value="#cce5ff">Blue</option>
              <option value="#e0ccff">Purple</option>
              <option value="#ffd9b3">Orange</option>
              <option value="#f0f0f0">Gray</option>
            </select>
          </div>

          <div className="toolbar-group">
            <button className="toolbar-btn" onClick={handleUndo} disabled={!engine.canUndo()} title="Undo">↶ Undo</button>
            <button className="toolbar-btn" onClick={handleRedo} disabled={!engine.canRedo()} title="Redo">↷ Redo</button>
          </div>

          <div className="toolbar-group">
            <button className="toolbar-btn" onClick={insertRow} title="Insert Row">+ Row</button>
            <button className="toolbar-btn" onClick={deleteRow} title="Delete Row">- Row</button>
            <button className="toolbar-btn" onClick={insertColumn} title="Insert Column">+ Col</button>
            <button className="toolbar-btn" onClick={deleteColumn} title="Delete Column">- Col</button>
          </div>

          <div className="toolbar-group">
            <button className="toolbar-btn danger" onClick={clearSelectedCell}>✕ Cell</button>
            <button className="toolbar-btn danger" onClick={clearAllCells}>✕ All</button>
          </div>

          <div className="toolbar-group">
            <button className="toolbar-btn" onClick={() => loadSample(loadSampleSmall)} title="Load fixtures/sales.tsv (33 rows) at A1">⬇ Sample 33</button>
            <button className="toolbar-btn" onClick={() => loadSample(loadSampleLarge)} title="Load fixtures/sales-large.tsv (~3,000 rows) at A1">⬇ Sample 3k</button>
          </div>
        </div>

        {/* ── Formula Bar ── */}
        <div className="formula-bar">
          <span className="formula-bar-label">{selectedCellLabel}</span>
          <input
            className="formula-bar-input"
            value={formulaBarValue}
            onChange={(e) => handleFormulaBarChange(e.target.value)}
            onKeyDown={handleFormulaBarKeyDown}
            onFocus={handleFormulaBarFocus}
            placeholder="Select a cell then type, or enter a formula like =SUM(A1:A5)"
          />
        </div>

        {/* ── Grid ── */}
        <div className="grid-scroll">
          <table className="grid-table">
            <thead>
              <tr>
                <th className="col-header-blank"></th>
                {Array.from({ length: engine.cols }, (_, colIndex) => {
                  const hasActiveFilter = Boolean(columnFilters[colIndex] && (
                    (columnFilters[colIndex].selectedValues && columnFilters[colIndex].selectedValues.size > 0) ||
                    (columnFilters[colIndex].condition && columnFilters[colIndex].condition.type !== 'none')
                  ))
                  const isSorted = sortState.col === colIndex
                  const sortIndicator = isSorted ? (sortState.dir === 'asc' ? ' ▲' : ' ▼') : ''

                  return (
                    <th
                      key={colIndex}
                      className={`col-header ${isSorted ? 'sorted' : ''}`}
                      onClick={() => handleHeaderSort(colIndex)}
                      title={`Click to sort (Asc -> Desc -> Original)`}
                    >
                      <div className="col-header-inner">
                        <span className="col-header-title">{getColumnLabel(colIndex)}{sortIndicator}</span>
                        <button
                          className={`filter-dropdown-trigger ${hasActiveFilter ? 'active' : ''}`}
                          onClick={(e) => toggleFilterDropdown(e, colIndex)}
                          title="Filter column"
                        >
                          ▼
                        </button>
                      </div>

                      {/* Dropdown Menu */}
                      {activeFilterDropdownCol === colIndex && (
                        <div
                          className="filter-dropdown-menu"
                          ref={dropdownRef}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="filter-dropdown-header">
                            <strong>Filter {getColumnLabel(colIndex)}</strong>
                            {hasActiveFilter && (
                              <button
                                className="filter-clear-link"
                                onClick={() => clearColumnFilter(colIndex)}
                              >
                                Clear
                              </button>
                            )}
                          </div>

                          {/* Quick Sort Options */}
                          <div className="filter-sort-section">
                            <button
                              className="filter-sort-btn"
                              onClick={() => {
                                engine.sort(colIndex, 'asc', { visibleRows: visibleRowIndices })
                                setSortState({ col: colIndex, dir: 'asc' })
                                forceRerender()
                              }}
                            >
                              Sort Ascending (A → Z, 1 → 9)
                            </button>
                            <button
                              className="filter-sort-btn"
                              onClick={() => {
                                engine.sort(colIndex, 'desc', { visibleRows: visibleRowIndices })
                                setSortState({ col: colIndex, dir: 'desc' })
                                forceRerender()
                              }}
                            >
                              Sort Descending (Z → A, 9 → 1)
                            </button>
                          </div>

                          {/* Condition Filter */}
                          <div className="filter-section-title">Filter by condition</div>
                          <div className="filter-condition-row">
                            <select
                              className="filter-condition-select"
                              value={columnFilters[colIndex]?.condition?.type || 'none'}
                              onChange={(e) => {
                                const type = e.target.value
                                setColumnFilters(prev => ({
                                  ...prev,
                                  [colIndex]: {
                                    ...prev[colIndex],
                                    condition: { type, val: prev[colIndex]?.condition?.val || '' }
                                  }
                                }))
                                forceRerender()
                              }}
                            >
                              <option value="none">None</option>
                              <option value="contains">Text contains</option>
                              <option value="greater than">Greater than</option>
                              <option value="less than">Less than</option>
                              <option value="is empty">Is empty</option>
                            </select>
                            {columnFilters[colIndex]?.condition?.type &&
                              !['none', 'is empty'].includes(columnFilters[colIndex]?.condition?.type) && (
                                <input
                                  className="filter-condition-input"
                                  placeholder="Value..."
                                  value={columnFilters[colIndex]?.condition?.val || ''}
                                  onChange={(e) => {
                                    const val = e.target.value
                                    setColumnFilters(prev => ({
                                      ...prev,
                                      [colIndex]: {
                                        ...prev[colIndex],
                                        condition: { ...prev[colIndex]?.condition, val }
                                      }
                                    }))
                                    forceRerender()
                                  }}
                                />
                              )}
                          </div>

                          {/* Distinct Values Search & Checklist */}
                          <div className="filter-section-title">Filter by values</div>
                          <input
                            className="filter-search-input"
                            placeholder="Search values..."
                            value={dropdownSearch}
                            onChange={(e) => setDropdownSearch(e.target.value)}
                          />

                          <div className="filter-checklist-actions">
                            <button
                              className="filter-link-btn"
                              onClick={() => {
                                const allKeys = new Set(activeColDistinctValues.map(v => v.key))
                                setColumnFilters(prev => ({
                                  ...prev,
                                  [colIndex]: { ...prev[colIndex], selectedValues: allKeys }
                                }))
                                forceRerender()
                              }}
                            >
                              Select All
                            </button>
                            <button
                              className="filter-link-btn"
                              onClick={() => {
                                setColumnFilters(prev => ({
                                  ...prev,
                                  [colIndex]: { ...prev[colIndex], selectedValues: new Set() }
                                }))
                                forceRerender()
                              }}
                            >
                              Clear
                            </button>
                          </div>

                          <div className="filter-values-checklist">
                            {activeColDistinctValues
                              .filter(item => {
                                if (!dropdownSearch.trim()) return true
                                return normText(item.label).includes(normText(dropdownSearch))
                              })
                              .map(item => {
                                const selected = columnFilters[colIndex]?.selectedValues
                                // If undefined/null, treat as all selected initially
                                const isChecked = selected ? selected.has(item.key) : true

                                return (
                                  <label key={item.key} className="filter-checkbox-label">
                                    <input
                                      type="checkbox"
                                      checked={isChecked}
                                      onChange={(e) => {
                                        const nowChecked = e.target.checked
                                        setColumnFilters(prev => {
                                          const currSelected = prev[colIndex]?.selectedValues
                                            ? new Set(prev[colIndex].selectedValues)
                                            : new Set(activeColDistinctValues.map(v => v.key))
                                          if (nowChecked) {
                                            currSelected.add(item.key)
                                          } else {
                                            currSelected.delete(item.key)
                                          }
                                          return {
                                            ...prev,
                                            [colIndex]: {
                                              ...prev[colIndex],
                                              selectedValues: currSelected
                                            }
                                          }
                                        })
                                        forceRerender()
                                      }}
                                    />
                                    <span className="filter-val-text">{item.label}</span>
                                    {item.count && <span className="filter-val-count">({item.count})</span>}
                                  </label>
                                )
                              })}
                          </div>
                        </div>
                      )}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: engine.rows }, (_, rowIndex) => {
                const isVisible = visibleRowIndices.has(rowIndex)
                if (!isVisible) return null

                return (
                  <tr key={rowIndex}>
                    {/* Row numbers show original gaps when rows are hidden */}
                    <td className="row-header">{rowIndex + 1}</td>
                    {Array.from({ length: engine.cols }, (_, colIndex) => {
                      const isSelected = selectedCell?.r === rowIndex && selectedCell?.c === colIndex
                      const isEditing = editingCell?.r === rowIndex && editingCell?.c === colIndex
                      const cellData = engine.getCell(rowIndex, colIndex)
                      const style = cellStyles[`${rowIndex},${colIndex}`] || {}
                      const displayValue = cellData.error
                        ? cellData.error
                        : (cellData.computed !== null && cellData.computed !== '' ? String(cellData.computed) : cellData.raw)

                      return (
                        <td
                          key={colIndex}
                          className={`cell ${isSelected ? 'selected' : ''}`}
                          style={{ background: style.bg || 'white' }}
                          onMouseDown={(e) => { e.preventDefault(); handleCellClick(rowIndex, colIndex) }}
                        >
                          {isEditing ? (
                            <input
                              autoFocus
                              className="cell-input"
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              onBlur={() => commitEdit(rowIndex, colIndex)}
                              onKeyDown={(e) => handleKeyDown(e, rowIndex, colIndex)}
                              ref={isSelected ? cellInputRef : undefined}
                              style={{
                                fontWeight: style.bold ? 'bold' : 'normal',
                                fontStyle: style.italic ? 'italic' : 'normal',
                                textDecoration: style.underline ? 'underline' : 'none',
                                color: style.color || '#202124',
                                fontSize: (style.fontSize || 13) + 'px',
                                textAlign: style.align || 'left',
                                background: style.bg || 'white',
                              }}
                            />
                          ) : (
                            <div
                              className={`cell-display align-${style.align || 'left'} ${cellData.error ? 'error' : ''}`}
                              style={{
                                fontWeight: style.bold ? 'bold' : 'normal',
                                fontStyle: style.italic ? 'italic' : 'normal',
                                textDecoration: style.underline ? 'underline' : 'none',
                                color: cellData.error ? '#d93025' : (style.color || '#202124'),
                                fontSize: (style.fontSize || 13) + 'px',
                              }}
                            >
                              {displayValue}
                            </div>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="status-footer-bar">
          <span className="status-text">
            {dataRowCount.visible} of {dataRowCount.total} rows {isFilterActive ? '(filtered)' : ''}
          </span>
          <p className="footer-hint">
            Click column headers to sort (Asc → Desc → Original). Use ▼ for search, distinct values, and conditions.
          </p>
        </div>
      </div>
    </div>
  )
}
