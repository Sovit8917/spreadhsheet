import { useState, useRef, useEffect, useCallback } from 'react'
import './App.css'
import { createEngine } from './engine/core.js'
import { indexToColumnLetter } from './engine/refs.js'
import { loadSampleSmall, loadSampleLarge } from './fixtures/loadSample.js'

const TOTAL_ROWS = 50
const TOTAL_COLS = 50

const label = (r, c) => `${indexToColumnLetter(c)}${r + 1}`
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const inRect = (r, c, rect) => r >= rect.r1 && r <= rect.r2 && c >= rect.c1 && c <= rect.c2

// sel = { ar, ac } anchor (the active cell) + { fr, fc } focus (the moving corner)
const toRange = (sel) => ({
  r1: Math.min(sel.ar, sel.fr), c1: Math.min(sel.ac, sel.fc),
  r2: Math.max(sel.ar, sel.fr), c2: Math.max(sel.ac, sel.fc),
})

// Rectangle after dragging the fill handle over cell (hr, hc). Works along the
// dominant axis only; hovering back inside the source shrinks it.
function computeFillTarget(src, hr, hc) {
  const dr = hr > src.r2 ? hr - src.r2 : hr < src.r1 ? hr - src.r1 : 0
  const dc = hc > src.c2 ? hc - src.c2 : hc < src.c1 ? hc - src.c1 : 0
  if (dr !== 0 || dc !== 0) {
    if (Math.abs(dr) >= Math.abs(dc)) {
      return dr > 0 ? { ...src, r2: hr } : { ...src, r1: hr }
    }
    return dc > 0 ? { ...src, c2: hc } : { ...src, c1: hc }
  }
  // inside the source: shrink from the bottom/right edge
  const shrinkRows = src.r2 - hr
  const shrinkCols = src.c2 - hc
  if (shrinkRows <= 0 && shrinkCols <= 0) return src
  return shrinkRows >= shrinkCols ? { ...src, r2: hr } : { ...src, c2: hc }
}

export default function App() {
  const [engine] = useState(() => createEngine(TOTAL_ROWS, TOTAL_COLS))
  const [, setVersion] = useState(0)
  const [sel, setSel] = useState({ ar: 0, ac: 0, fr: 0, fc: 0 })
  const [editing, setEditing] = useState(null) // { r, c } while a cell is being edited
  const [editValue, setEditValue] = useState('')
  const [fillTarget, setFillTarget] = useState(null) // preview rectangle while dragging the handle

  const gridRef = useRef(null)
  const cellInputRef = useRef(null)
  // Refs mirror the state the drag/keyboard handlers need synchronously.
  const editingRef = useRef(null)
  const editValueRef = useRef('')
  const selRef = useRef(sel)
  const dragRef = useRef(null) // { mode: 'select' } | { mode: 'fill', source }
  const fillTargetRef = useRef(null)

  const forceRerender = useCallback(() => setVersion(v => v + 1), [])

  const range = toRange(sel)
  const activeStyle = engine.getStyle(sel.ar, sel.ac)

  const updateSel = (next) => {
    selRef.current = next
    setSel(next)
  }

  // ────── Editing ──────

  const setEditText = (text) => {
    editValueRef.current = text
    setEditValue(text)
  }

  const beginEdit = (r, c, initialText, focusInput = true) => {
    editingRef.current = { r, c }
    setEditing({ r, c })
    setEditText(initialText !== undefined ? initialText : engine.getCell(r, c).raw)
    if (focusInput) {
      setTimeout(() => {
        const el = cellInputRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }, 0)
    }
  }

  const finishEdit = (commit) => {
    const current = editingRef.current
    if (!current) return
    editingRef.current = null
    setEditing(null)
    if (commit && engine.getCell(current.r, current.c).raw !== editValueRef.current) {
      engine.setCell(current.r, current.c, editValueRef.current)
      forceRerender()
    }
  }

  const focusGrid = () => gridRef.current?.focus()

  // ────── Selection ──────

  const selectCell = (r, c) => updateSel({ ar: r, ac: c, fr: r, fc: c })

  const moveSelection = (dr, dc, extend) => {
    const s = selRef.current
    const baseR = extend ? s.fr : s.ar
    const baseC = extend ? s.fc : s.ac
    const nr = clamp(baseR + dr, 0, engine.rows - 1)
    const nc = clamp(baseC + dc, 0, engine.cols - 1)
    updateSel(extend ? { ...s, fr: nr, fc: nc } : { ar: nr, ac: nc, fr: nr, fc: nc })
  }

  const selectAll = () => {
    const used = engine.getUsedRange()
    if (!used) return selectCell(0, 0)
    updateSel({ ar: used.r1, ac: used.c1, fr: used.r2, fc: used.c2 })
  }

  const handleCellMouseDown = (event, r, c) => {
    if (event.button !== 0) return
    if (event.target.tagName === 'INPUT') return // caret placement inside the editor
    event.preventDefault()
    if (editingRef.current) finishEdit(true)
    if (event.shiftKey) {
      updateSel({ ...selRef.current, fr: r, fc: c })
    } else {
      selectCell(r, c)
    }
    dragRef.current = { mode: 'select' }
    focusGrid()
  }

  const handleCellMouseEnter = (r, c) => {
    const drag = dragRef.current
    if (!drag) return
    if (drag.mode === 'select') {
      const s = selRef.current
      if (s.fr !== r || s.fc !== c) updateSel({ ...s, fr: r, fc: c })
    } else if (drag.mode === 'fill') {
      const target = computeFillTarget(drag.source, r, c)
      const prev = fillTargetRef.current
      if (!prev || prev.r1 !== target.r1 || prev.r2 !== target.r2 || prev.c1 !== target.c1 || prev.c2 !== target.c2) {
        fillTargetRef.current = target
        setFillTarget(target)
      }
    }
  }

  const handleHeaderClick = (event, kind, index) => {
    if (editingRef.current) finishEdit(true)
    const s = selRef.current
    const lastRow = engine.rows - 1
    const lastCol = engine.cols - 1
    if (kind === 'col') {
      updateSel(event.shiftKey ? { ...s, ar: 0, fr: lastRow, fc: index } : { ar: 0, ac: index, fr: lastRow, fc: index })
    } else {
      updateSel(event.shiftKey ? { ...s, ac: 0, fc: lastCol, fr: index } : { ar: index, ac: 0, fr: index, fc: lastCol })
    }
    focusGrid()
  }

  const handleFillHandleMouseDown = (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (editingRef.current) finishEdit(true)
    const source = toRange(selRef.current)
    dragRef.current = { mode: 'fill', source }
    fillTargetRef.current = source
    setFillTarget(source)
  }

  // Mouse release anywhere ends a drag-select or commits a fill (ONE engine call).
  useEffect(() => {
    const onMouseUp = () => {
      const drag = dragRef.current
      dragRef.current = null
      if (!drag || drag.mode !== 'fill') return
      const target = fillTargetRef.current
      fillTargetRef.current = null
      setFillTarget(null)
      if (!target) return
      const src = drag.source
      if (target.r1 === src.r1 && target.r2 === src.r2 && target.c1 === src.c1 && target.c2 === src.c2) return
      engine.fillRange(src, target)
      updateSel({ ar: target.r1, ac: target.c1, fr: target.r2, fc: target.c2 })
      forceRerender()
    }
    window.addEventListener('mouseup', onMouseUp)
    return () => window.removeEventListener('mouseup', onMouseUp)
  }, [engine, forceRerender])

  // Keep the active corner in view while moving with the keyboard / dragging.
  useEffect(() => {
    gridRef.current
      ?.querySelector(`td[data-r="${sel.fr}"][data-c="${sel.fc}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [sel.fr, sel.fc])

  // ────── Keyboard ──────

  const handleEditorKeyDown = (event) => {
    const current = editingRef.current
    if (!current) return
    if (event.key === 'Enter') {
      event.preventDefault()
      finishEdit(true)
      moveSelection(event.shiftKey ? -1 : 1, 0, false)
      focusGrid()
    } else if (event.key === 'Tab') {
      event.preventDefault()
      finishEdit(true)
      moveSelection(0, event.shiftKey ? -1 : 1, false)
      focusGrid()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      finishEdit(false)
      focusGrid()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      finishEdit(true)
      moveSelection(event.key === 'ArrowDown' ? 1 : -1, 0, false)
      focusGrid()
    }
  }

  const handleGridKeyDown = (event) => {
    if (editingRef.current) return
    const s = selRef.current
    const mod = event.ctrlKey || event.metaKey

    if (mod) {
      if (event.key === 'a' || event.key === 'A') {
        event.preventDefault()
        selectAll()
      }
      return // Ctrl+Z / Ctrl+Y are handled by the window listener
    }

    switch (event.key) {
      case 'ArrowUp': event.preventDefault(); moveSelection(-1, 0, event.shiftKey); return
      case 'ArrowDown': event.preventDefault(); moveSelection(1, 0, event.shiftKey); return
      case 'ArrowLeft': event.preventDefault(); moveSelection(0, -1, event.shiftKey); return
      case 'ArrowRight': event.preventDefault(); moveSelection(0, 1, event.shiftKey); return
      case 'Tab': event.preventDefault(); moveSelection(0, event.shiftKey ? -1 : 1, false); return
      case 'Enter':
      case 'F2':
        event.preventDefault()
        beginEdit(s.ar, s.ac)
        return
      case 'Delete':
      case 'Backspace':
        event.preventDefault()
        engine.clearRange(toRange(s))
        forceRerender()
        return
      case 'Escape':
        selectCell(s.ar, s.ac)
        return
      default:
        // a printable key starts editing and replaces the content
        if (event.key.length === 1 && !event.altKey) {
          event.preventDefault()
          beginEdit(s.ar, s.ac, event.key)
        }
    }
  }

  const handleUndo = useCallback(() => { if (engine.undo()) forceRerender() }, [engine, forceRerender])
  const handleRedo = useCallback(() => { if (engine.redo()) forceRerender() }, [engine, forceRerender])

  // Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z anywhere except inside a text field.
  useEffect(() => {
    const onKey = (event) => {
      if (!(event.ctrlKey || event.metaKey)) return
      const tag = event.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const key = event.key.toLowerCase()
      if (key === 'z' && !event.shiftKey) { event.preventDefault(); handleUndo() }
      else if (key === 'y' || (key === 'z' && event.shiftKey)) { event.preventDefault(); handleRedo() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleUndo, handleRedo])

  // ────── Formula bar ──────

  const handleFormulaBarFocus = () => {
    if (!editingRef.current) beginEdit(sel.ar, sel.ac, undefined, false)
  }

  const handleFormulaBarChange = (value) => {
    if (!editingRef.current) beginEdit(sel.ar, sel.ac, value, false)
    else setEditText(value)
  }

  const handleFormulaBarKeyDown = (event) => {
    if (!editingRef.current) return
    if (event.key === 'Escape') {
      event.preventDefault()
      finishEdit(false)
      event.currentTarget.blur()
      focusGrid()
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      handleEditorKeyDown(event)
      event.currentTarget.blur()
    }
  }

  // ────── Formatting (applies to the whole selection, one undo step) ──────

  const applyStyle = (patch) => {
    engine.setStyleRange(range, patch)
    forceRerender()
  }

  const toggleBold = () => applyStyle({ bold: !activeStyle.bold })
  const toggleItalic = () => applyStyle({ italic: !activeStyle.italic })
  const toggleUnderline = () => applyStyle({ underline: !activeStyle.underline })
  const changeFontSize = (size) => applyStyle({ fontSize: size })
  const changeAlignment = (align) => applyStyle({ align })
  const changeFontColor = (color) => applyStyle({ color })
  const changeBackgroundColor = (color) => applyStyle({ bg: color })

  // ────── Clear operations (one undo step each) ──────

  const clearSelection = () => {
    if (editingRef.current) finishEdit(false)
    engine.clearRange(range, { styles: true })
    forceRerender()
  }

  const clearAllCells = () => {
    if (editingRef.current) finishEdit(false)
    engine.clearRange({ r1: 0, c1: 0, r2: engine.rows - 1, c2: engine.cols - 1 }, { styles: true })
    selectCell(0, 0)
    forceRerender()
  }

  // ────── Sample data (fixtures/sales.tsv) ──────

  const loadSample = (loader) => {
    if (editingRef.current) finishEdit(false)
    loader(engine)
    forceRerender()
    selectCell(0, 0)
  }

  // ────── Row / Column operations ──────

  const insertRow = () => {
    if (editingRef.current) finishEdit(true)
    engine.insertRow(sel.ar)
    updateSel({ ...sel, ar: sel.ar + 1, fr: sel.fr + 1 })
    forceRerender()
  }

  const deleteRow = () => {
    if (editingRef.current) finishEdit(true)
    engine.deleteRow(sel.ar)
    const r = Math.min(sel.ar, engine.rows - 1)
    updateSel({ ar: r, ac: sel.ac, fr: r, fc: sel.ac })
    forceRerender()
  }

  const insertColumn = () => {
    if (editingRef.current) finishEdit(true)
    engine.insertColumn(sel.ac)
    updateSel({ ...sel, ac: sel.ac + 1, fc: sel.fc + 1 })
    forceRerender()
  }

  const deleteColumn = () => {
    if (editingRef.current) finishEdit(true)
    engine.deleteColumn(sel.ac)
    const c = Math.min(sel.ac, engine.cols - 1)
    updateSel({ ar: sel.ar, ac: c, fr: sel.ar, fc: c })
    forceRerender()
  }

  // ────── Derived state ──────

  const isSingle = range.r1 === range.r2 && range.c1 === range.c2
  const selectedCellLabel = isSingle
    ? label(range.r1, range.c1)
    : `${label(range.r1, range.c1)}:${label(range.r2, range.c2)}`

  const formulaBarValue = editing ? editValue : engine.getCell(sel.ar, sel.ac).raw

  // ────── Render ──────

  return (
    <div className="app-wrapper">
      <div className="app-header">
        <h2 className="app-title">📊 Spreadsheet App</h2>
      </div>

      <div className="main-content">

        {/* ── Toolbar ── */}
        <div className="toolbar">
          <div className="toolbar-group">
            <button className={`toolbar-btn bold-btn ${activeStyle.bold ? 'active' : ''}`} onClick={toggleBold} title="Bold">B</button>
            <button className={`toolbar-btn italic-btn ${activeStyle.italic ? 'active' : ''}`} onClick={toggleItalic} title="Italic">I</button>
            <button className={`toolbar-btn underline-btn ${activeStyle.underline ? 'active' : ''}`} onClick={toggleUnderline} title="Underline">U</button>
          </div>

          <div className="toolbar-group">
            <span className="toolbar-label">Size:</span>
            <select className="toolbar-select" value={activeStyle.fontSize} onChange={(e) => changeFontSize(parseInt(e.target.value))}>
              {[8, 10, 11, 12, 13, 14, 16, 18, 20, 24].map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          <div className="toolbar-group">
            <button className={`align-btn ${activeStyle.align === 'left' ? 'active' : ''}`} onClick={() => changeAlignment('left')} title="Align Left">⬤←</button>
            <button className={`align-btn ${activeStyle.align === 'center' ? 'active' : ''}`} onClick={() => changeAlignment('center')} title="Align Center">⬤</button>
            <button className={`align-btn ${activeStyle.align === 'right' ? 'active' : ''}`} onClick={() => changeAlignment('right')} title="Align Right">⬤→</button>
          </div>

          <div className="toolbar-group">
            <span className="toolbar-label">Text:</span>
            <input
              type="color"
              value={activeStyle.color}
              onChange={(e) => changeFontColor(e.target.value)}
              title="Font color"
              style={{ width: '32px', height: '32px', border: '1px solid #dadce0', cursor: 'pointer', borderRadius: '4px' }}
            />
          </div>

          <div className="toolbar-group">
            <span className="toolbar-label">Fill:</span>
            <select className="toolbar-select" value={activeStyle.bg} onChange={(e) => changeBackgroundColor(e.target.value)}>
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
            <button className="toolbar-btn" onClick={handleUndo} disabled={!engine.canUndo()} title="Undo (Ctrl+Z)">↶ Undo</button>
            <button className="toolbar-btn" onClick={handleRedo} disabled={!engine.canRedo()} title="Redo (Ctrl+Y)">↷ Redo</button>
          </div>

          <div className="toolbar-group">
            <button className="toolbar-btn" onClick={insertRow} title="Insert Row">+ Row</button>
            <button className="toolbar-btn" onClick={deleteRow} title="Delete Row">- Row</button>
            <button className="toolbar-btn" onClick={insertColumn} title="Insert Column">+ Col</button>
            <button className="toolbar-btn" onClick={deleteColumn} title="Delete Column">- Col</button>
          </div>

          <div className="toolbar-group">
            <button className="toolbar-btn danger" onClick={clearSelection} title="Clear values and formatting of the selection">✕ Selection</button>
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
        <div className="grid-scroll" ref={gridRef} tabIndex={0} onKeyDown={handleGridKeyDown}>
          <table className="grid-table">
            <thead>
              <tr>
                <th className="col-header-blank" onClick={() => { selectAll(); focusGrid() }} title="Select used range (Ctrl+A)"></th>
                {Array.from({ length: engine.cols }, (_, colIndex) => (
                  <th
                    key={colIndex}
                    className={`col-header ${colIndex >= range.c1 && colIndex <= range.c2 ? 'header-selected' : ''}`}
                    onClick={(e) => handleHeaderClick(e, 'col', colIndex)}
                  >
                    {indexToColumnLetter(colIndex)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: engine.rows }, (_, rowIndex) => (
                <tr key={rowIndex}>
                  <td
                    className={`row-header ${rowIndex >= range.r1 && rowIndex <= range.r2 ? 'header-selected' : ''}`}
                    onClick={(e) => handleHeaderClick(e, 'row', rowIndex)}
                  >
                    {rowIndex + 1}
                  </td>
                  {Array.from({ length: engine.cols }, (_, colIndex) => {
                    const isActive = sel.ar === rowIndex && sel.ac === colIndex
                    const isEditing = editing?.r === rowIndex && editing?.c === colIndex
                    const inSel = inRect(rowIndex, colIndex, range)
                    const cellData = engine.getCell(rowIndex, colIndex)
                    const style = engine.getStyle(rowIndex, colIndex)
                    const isFormula = cellData.raw.startsWith('=')
                    const displayValue = cellData.error
                      ? cellData.error
                      : (isFormula ? String(cellData.computed ?? '') : cellData.raw)

                    const classes = ['cell']
                    if (inSel) {
                      classes.push('in-range')
                      if (rowIndex === range.r1) classes.push('sel-top')
                      if (rowIndex === range.r2) classes.push('sel-bottom')
                      if (colIndex === range.c1) classes.push('sel-left')
                      if (colIndex === range.c2) classes.push('sel-right')
                    }
                    if (isActive) classes.push('active')
                    if (fillTarget && inRect(rowIndex, colIndex, fillTarget)) {
                      if (!inRect(rowIndex, colIndex, range)) classes.push('fill-preview')
                      if (rowIndex === fillTarget.r1) classes.push('fp-top')
                      if (rowIndex === fillTarget.r2) classes.push('fp-bottom')
                      if (colIndex === fillTarget.c1) classes.push('fp-left')
                      if (colIndex === fillTarget.c2) classes.push('fp-right')
                    }
                    const showHandle = !editing && !fillTarget && rowIndex === range.r2 && colIndex === range.c2
                    if (showHandle) classes.push('has-handle')

                    return (
                      <td
                        key={colIndex}
                        data-r={rowIndex}
                        data-c={colIndex}
                        className={classes.join(' ')}
                        style={{ backgroundColor: style.bg }}
                        onMouseDown={(e) => handleCellMouseDown(e, rowIndex, colIndex)}
                        onMouseEnter={() => handleCellMouseEnter(rowIndex, colIndex)}
                        onDoubleClick={() => beginEdit(rowIndex, colIndex)}
                      >
                        {isEditing ? (
                          <input
                            className="cell-input"
                            value={editValue}
                            onChange={(e) => setEditText(e.target.value)}
                            onBlur={() => finishEdit(true)}
                            onKeyDown={handleEditorKeyDown}
                            ref={cellInputRef}
                            style={{
                              fontWeight: style.bold ? 'bold' : 'normal',
                              fontStyle: style.italic ? 'italic' : 'normal',
                              textDecoration: style.underline ? 'underline' : 'none',
                              color: style.color,
                              fontSize: style.fontSize + 'px',
                              textAlign: style.align,
                            }}
                          />
                        ) : (
                          <div
                            className={`cell-display align-${style.align} ${cellData.error ? 'error' : ''}`}
                            style={{
                              fontWeight: style.bold ? 'bold' : 'normal',
                              fontStyle: style.italic ? 'italic' : 'normal',
                              textDecoration: style.underline ? 'underline' : 'none',
                              color: cellData.error ? '#d93025' : style.color,
                              fontSize: style.fontSize + 'px',
                            }}
                          >
                            {displayValue}
                          </div>
                        )}
                        {showHandle && (
                          <div className="fill-handle" onMouseDown={handleFillHandleMouseDown} title="Drag to fill" />
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="footer-hint">
          Click selects · double-click/Enter/F2/typing edits · drag or Shift+click/arrows select ranges · Ctrl+A used range · Delete clears · drag the corner square to fill · Ctrl+Z undo · Formulas: =A1+B1 · =$A$1*B2 · =SUM(A1:A5) · AVG · MIN · MAX
        </p>
      </div>
    </div>
  )
}
