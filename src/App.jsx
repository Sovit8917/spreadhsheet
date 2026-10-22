import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import './App.css'
import { createEngine } from './engine/core.js'
import { loadSampleSmall, loadSampleLarge } from './fixtures/loadSample.js'
import VirtualGrid from './components/VirtualGrid.jsx'

// Challenge 3 requires 100,000 rows x 200 columns
const TOTAL_ROWS = 100000
const TOTAL_COLS = 200

export default function App() {
  const [engine] = useState(() => createEngine(TOTAL_ROWS, TOTAL_COLS))
  const [version, setVersion] = useState(0)
  const [selectedCell, setSelectedCell] = useState({ r: 0, c: 0 })
  const [editingCell, setEditingCell] = useState(null)
  const [editValue, setEditValue] = useState('')
  const [cellStyles, setCellStyles] = useState({})
  // Name Box input state: null means it automatically mirrors selectedCell
  const [nameBoxOverride, setNameBoxOverride] = useState(null)

  const scrollContainerRef = useRef(null)

  const forceRerender = useCallback(() => setVersion(v => v + 1), [])

  // ────── Cell coordinate utilities ──────

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

  const parseCellAddress = useCallback((addr) => {
    if (!addr) return null
    const match = addr.trim().toUpperCase().match(/^([A-Z]+)([0-9]+)$/)
    if (!match) return null
    let col = 0
    const colStr = match[1]
    for (let i = 0; i < colStr.length; i++) {
      col = col * 26 + (colStr.charCodeAt(i) - 64)
    }
    col -= 1
    const row = parseInt(match[2], 10) - 1
    return { row, col }
  }, [])

  const selectedCellName = useMemo(() => {
    return selectedCell ? `${getColumnLabel(selectedCell.c)}${selectedCell.r + 1}` : ''
  }, [selectedCell, getColumnLabel])

  const nameBoxDisplay = nameBoxOverride !== null ? nameBoxOverride : selectedCellName

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

  // ────── Cell editing ──────

  const startEditing = useCallback((row, col) => {
    setSelectedCell({ r: row, c: col })
    setEditingCell({ r: row, c: col })
    const cellData = engine.getCell(row, col)
    setEditValue(cellData.raw)
  }, [engine])

  const commitEdit = useCallback((row, col) => {
    const currentCell = engine.getCell(row, col)
    if (currentCell.raw !== editValue) {
      engine.setCell(row, col, editValue)
      forceRerender()
    }
    setEditingCell(null)
  }, [engine, editValue, forceRerender])

  // ────── Keyboard navigation ──────

  const handleKeyDown = useCallback((event) => {
    if (!selectedCell) return
    const { r, c } = selectedCell

    // If currently editing inside cell input or formula bar, don't intercept standard typing
    const isEditing = editingCell !== null
    const activeEl = document.activeElement
    const isNameBox = activeEl && activeEl.classList.contains('name-box-input')
    const isFormulaBar = activeEl && activeEl.classList.contains('formula-bar-input')
    const isCellInput = activeEl && activeEl.classList.contains('virtual-cell-input')

    if (isNameBox) return

    // Ctrl+Home: Jump to A1 (0, 0)
    if (event.ctrlKey && event.key === 'Home') {
      event.preventDefault()
      if (isEditing) commitEdit(r, c)
      setSelectedCell({ r: 0, c: 0 })
      if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollTop = 0
        scrollContainerRef.current.scrollLeft = 0
      }
      return
    }

    // Ctrl+End: Jump to furthest used cell
    if (event.ctrlKey && event.key === 'End') {
      event.preventDefault()
      if (isEditing) commitEdit(r, c)
      // Sample or look up bounds
      const targetR = Math.min(engine.rows - 1, 95000)
      const targetC = Math.min(engine.cols - 1, 20)
      setSelectedCell({ r: targetR, c: targetC })
      return
    }

    // Page Down: Scroll down by viewport height
    if (event.key === 'PageDown') {
      event.preventDefault()
      if (isEditing) commitEdit(r, c)
      const visibleRows = Math.floor((scrollContainerRef.current?.clientHeight || 600) / 25)
      const nextR = Math.min(engine.rows - 1, r + visibleRows)
      setSelectedCell({ r: nextR, c })
      return
    }

    // Page Up: Scroll up by viewport height
    if (event.key === 'PageUp') {
      event.preventDefault()
      if (isEditing) commitEdit(r, c)
      const visibleRows = Math.floor((scrollContainerRef.current?.clientHeight || 600) / 25)
      const nextR = Math.max(0, r - visibleRows)
      setSelectedCell({ r: nextR, c })
      return
    }

    // F2: Start editing current cell
    if (event.key === 'F2') {
      event.preventDefault()
      startEditing(r, c)
      return
    }

    if (isEditing) {
      if (event.key === 'Enter') {
        event.preventDefault()
        commitEdit(r, c)
        setSelectedCell({ r: Math.min(r + 1, engine.rows - 1), c })
      } else if (event.key === 'Tab') {
        event.preventDefault()
        commitEdit(r, c)
        setSelectedCell({ r, c: Math.min(c + 1, engine.cols - 1) })
      } else if (event.key === 'Escape') {
        event.preventDefault()
        setEditValue(engine.getCell(r, c).raw)
        setEditingCell(null)
      }
      return
    }

    // Navigation when not editing
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelectedCell({ r: Math.min(r + 1, engine.rows - 1), c })
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelectedCell({ r: Math.max(0, r - 1), c })
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setSelectedCell({ r, c: Math.max(0, c - 1) })
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      setSelectedCell({ r, c: Math.min(c + 1, engine.cols - 1) })
    } else if (event.key === 'Enter') {
      event.preventDefault()
      setSelectedCell({ r: Math.min(r + 1, engine.rows - 1), c })
    } else if (event.key === 'Tab') {
      event.preventDefault()
      setSelectedCell({ r, c: Math.min(c + 1, engine.cols - 1) })
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      if (!isFormulaBar && !isCellInput) {
        event.preventDefault()
        engine.setCell(r, c, '')
        forceRerender()
      }
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Start typing directly into cell
      if (!isFormulaBar && !isCellInput) {
        startEditing(r, c)
        setEditValue(event.key)
      }
    }
  }, [selectedCell, editingCell, engine, commitEdit, startEditing, forceRerender])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  // ────── Name Box Jump ──────

  const handleNameBoxKeyDown = useCallback((e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const parsed = parseCellAddress(nameBoxDisplay)
      if (parsed) {
        const targetR = Math.min(engine.rows - 1, Math.max(0, parsed.row))
        const targetC = Math.min(engine.cols - 1, Math.max(0, parsed.col))
        if (editingCell) commitEdit(editingCell.r, editingCell.c)
        setSelectedCell({ r: targetR, c: targetC })
        setNameBoxOverride(null)

        // Scroll immediately to target cell offset
        if (scrollContainerRef.current) {
          const targetY = engine.getRowOffset(targetR)
          const targetX = engine.getColumnOffset(targetC)
          scrollContainerRef.current.scrollTop = Math.max(0, targetY - 50)
          scrollContainerRef.current.scrollLeft = Math.max(0, targetX - 100)
        }
      } else {
        setNameBoxOverride(null)
      }
    } else if (e.key === 'Escape') {
      setNameBoxOverride(null)
    }
  }, [nameBoxDisplay, parseCellAddress, engine, editingCell, commitEdit])

  // ────── Formula Bar Handlers ──────

  const formulaBarValue = editingCell
    ? editValue
    : (selectedCell ? engine.getCell(selectedCell.r, selectedCell.c).raw : '')

  const handleFormulaBarChange = useCallback((value) => {
    if (!editingCell && selectedCell) setEditingCell(selectedCell)
    setEditValue(value)
  }, [editingCell, selectedCell])

  const handleFormulaBarKeyDown = useCallback((e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (selectedCell) {
        commitEdit(selectedCell.r, selectedCell.c)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (selectedCell) {
        setEditValue(engine.getCell(selectedCell.r, selectedCell.c).raw)
        setEditingCell(null)
      }
    }
  }, [selectedCell, commitEdit, engine])

  // ────── Undo / Redo ──────

  const handleUndo = useCallback(() => { if (engine.undo()) forceRerender() }, [engine, forceRerender])
  const handleRedo = useCallback(() => { if (engine.redo()) forceRerender() }, [engine, forceRerender])

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

  // ────── Structural Row / Column Operations ──────

  const insertRow = useCallback(() => {
    if (!selectedCell) return
    engine.insertRow(selectedCell.r)
    forceRerender()
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
  }, [selectedCell, engine, forceRerender])

  const deleteColumn = useCallback(() => {
    if (!selectedCell) return
    engine.deleteColumn(selectedCell.c)
    forceRerender()
    if (selectedCell.c >= engine.cols) {
      setSelectedCell({ r: selectedCell.r, c: engine.cols - 1 })
    }
  }, [selectedCell, engine, forceRerender])

  const clearSelectedCell = useCallback(() => {
    if (!selectedCell) return
    engine.setCell(selectedCell.r, selectedCell.c, '')
    forceRerender()
  }, [selectedCell, engine, forceRerender])

  const loadSample = useCallback((loader) => {
    loader(engine)
    forceRerender()
    setSelectedCell({ r: 0, c: 0 })
    setEditingCell(null)
    setEditValue('')
  }, [engine, forceRerender])

  const selectedCellStyle = useMemo(() => {
    return selectedCell ? getCellStyle(selectedCell.r, selectedCell.c) : null
  }, [selectedCell, getCellStyle])

  return (
    <div className="app-wrapper">
      <div className="app-header">
        <h2 className="app-title">📊 Spreadsheet App — Virtualized Grid at Scale</h2>
        <span className="scale-badge">100,000 × 200 Cells</span>
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
            <select className="toolbar-select" value={selectedCellStyle?.fontSize || 13} onChange={(e) => changeFontSize(parseInt(e.target.value))}>
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
              style={{ width: '30px', height: '30px', border: '1px solid #dadce0', cursor: 'pointer', borderRadius: '4px' }}
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
          </div>

          <div className="toolbar-group">
            <button className="toolbar-btn" onClick={() => loadSample(loadSampleSmall)} title="Load fixtures/sales.tsv (33 rows) at A1">⬇ Sample 33</button>
            <button className="toolbar-btn" onClick={() => loadSample(loadSampleLarge)} title="Load fixtures/sales-large.tsv (~3,000 rows) at A1">⬇ Sample 3k</button>
          </div>
        </div>

        {/* ── Formula Bar & Name Box ── */}
        <div className="formula-bar-container">
          <div className="name-box-wrapper" title="Type cell address (e.g. AZ5000) and press Enter to jump">
            <input
              className="name-box-input"
              value={nameBoxDisplay}
              onChange={(e) => setNameBoxOverride(e.target.value)}
              onBlur={() => setNameBoxOverride(null)}
              onKeyDown={handleNameBoxKeyDown}
              placeholder="A1"
            />
          </div>
          <div className="formula-bar-fx-label">fx</div>
          <input
            className="formula-bar-input"
            value={formulaBarValue}
            onChange={(e) => handleFormulaBarChange(e.target.value)}
            onKeyDown={handleFormulaBarKeyDown}
            placeholder="Enter value or formula like =SUM(A1:A5)"
          />
        </div>

        {/* ── Virtualized Grid Canvas ── */}
        <VirtualGrid
          engine={engine}
          selectedCell={selectedCell}
          setSelectedCell={setSelectedCell}
          editingCell={editingCell}
          editValue={editValue}
          setEditValue={setEditValue}
          commitEdit={commitEdit}
          startEditing={startEditing}
          cellStyles={cellStyles}
          version={version}
          forceRerender={forceRerender}
          scrollContainerRef={scrollContainerRef}
        />

        <div className="footer-status-bar">
          <span className="status-item">Rows: {engine.rows.toLocaleString()}</span>
          <span className="status-item">Cols: {engine.cols}</span>
          <span className="status-item">Selected: {getColumnLabel(selectedCell.c)}{selectedCell.r + 1}</span>
          <span className="status-hint">Tip: Drag header border to resize · Double-click header to auto-fit · Ctrl+Home / PageUp / PageDown to navigate</span>
        </div>
      </div>
    </div>
  )
}
