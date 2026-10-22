import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react'
import './VirtualGrid.css'

export default function VirtualGrid({
  engine,
  selectedCell,
  setSelectedCell,
  editingCell,
  editValue,
  setEditValue,
  commitEdit,
  startEditing,
  cellStyles,
  version,
  forceRerender,
  scrollContainerRef
}) {
  const localContainerRef = useRef(null)
  const containerRef = scrollContainerRef || localContainerRef
  const cellInputRef = useRef(null)

  // Scroll viewport offsets [scrollTop, scrollLeft]
  const [scrollState, setScrollState] = useState({ top: 0, left: 0, clientWidth: 1000, clientHeight: 600 })

  // Measure container dimensions
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const updateSize = () => {
      setScrollState(prev => ({
        ...prev,
        clientWidth: el.clientWidth,
        clientHeight: el.clientHeight
      }))
    }

    updateSize()
    const resizeObserver = new ResizeObserver(updateSize)
    resizeObserver.observe(el)
    return () => resizeObserver.disconnect()
  }, [containerRef])

  // Scroll handler updating viewport offsets
  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    setScrollState(prev => ({
      ...prev,
      top: el.scrollTop,
      left: el.scrollLeft
    }))
  }, [containerRef])

  // Resize drag state
  const [resizing, setResizing] = useState(null) // { type: 'col' | 'row', index, startPos, startSize }

  const handleResizeMouseDown = useCallback((e, type, index) => {
    e.preventDefault()
    e.stopPropagation()
    const startPos = type === 'col' ? e.clientX : e.clientY
    const startSize = type === 'col' ? engine.getColumnWidth(index) : engine.getRowHeight(index)
    setResizing({ type, index, startPos, startSize })
  }, [engine])

  useEffect(() => {
    if (!resizing) return

    const onMouseMove = (e) => {
      const currentPos = resizing.type === 'col' ? e.clientX : e.clientY
      const delta = currentPos - resizing.startPos
      const newSize = Math.max(resizing.type === 'col' ? 30 : 20, resizing.startSize + delta)
      if (resizing.type === 'col') {
        engine.colWidths.setSize(resizing.index, newSize)
      } else {
        engine.rowHeights.setSize(resizing.index, newSize)
      }
      forceRerender()
    }

    const onMouseUp = (e) => {
      const currentPos = resizing.type === 'col' ? e.clientX : e.clientY
      const delta = currentPos - resizing.startPos
      const finalSize = Math.max(resizing.type === 'col' ? 30 : 20, resizing.startSize + delta)
      // Reset back to start size first so executeSet* creates the correct undo entry
      if (resizing.type === 'col') {
        engine.colWidths.setSize(resizing.index, resizing.startSize)
        engine.setColumnWidth(resizing.index, finalSize)
      } else {
        engine.rowHeights.setSize(resizing.index, resizing.startSize)
        engine.setRowHeight(resizing.index, finalSize)
      }
      setResizing(null)
      forceRerender()
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [resizing, engine, forceRerender])

  // Auto-fit column on double click
  const handleColHeaderDoubleClick = useCallback((colIndex) => {
    // Measure content of visible / used cells in this column
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    ctx.font = '13px "Courier New", monospace'

    let maxTextWidth = 40 // minimum base
    // Sample rows up to 100 cells or visible rows
    const start = Math.max(0, engine.findRowAtOffset(scrollState.top) - 10)
    const end = Math.min(engine.rows - 1, start + 80)
    for (let r = start; r <= end; r++) {
      const cellData = engine.getCell(r, colIndex)
      const text = cellData.error || (cellData.computed !== null && cellData.computed !== '' ? String(cellData.computed) : cellData.raw)
      if (text) {
        const metrics = ctx.measureText(text)
        if (metrics.width > maxTextWidth) {
          maxTextWidth = metrics.width
        }
      }
    }
    const fitWidth = Math.min(600, Math.max(50, Math.ceil(maxTextWidth + 24)))
    engine.setColumnWidth(colIndex, fitWidth)
    forceRerender()
  }, [engine, scrollState.top, forceRerender])

  // Column letters
  const getColLabel = useCallback((col) => {
    let label = ''
    let num = col + 1
    while (num > 0) {
      num--
      label = String.fromCharCode(65 + (num % 26)) + label
      num = Math.floor(num / 26)
    }
    return label
  }, [])

  // Virtual ranges (overscan = 5)
  // Frozen row 0 and frozen col 0 are always pinned at top/left.
  // The scrollable body renders rows 1..N and cols 1..M.
  const rowRange = useMemo(() => {
    const range = engine.getVisibleRowRange(scrollState.top, scrollState.top + scrollState.clientHeight, 6)
    // ensure row 0 is handled separately as frozen
    const start = Math.max(1, range.startIndex)
    const end = Math.min(engine.rows - 1, range.endIndex)
    return { start, end }
  }, [engine, scrollState.top, scrollState.clientHeight, version])

  const colRange = useMemo(() => {
    const range = engine.getVisibleColumnRange(scrollState.left, scrollState.left + scrollState.clientWidth, 4)
    const start = Math.max(1, range.startIndex)
    const end = Math.min(engine.cols - 1, range.endIndex)
    return { start, end }
  }, [engine, scrollState.left, scrollState.clientWidth, version])

  const frozenRowHeight = engine.getRowHeight(0)
  const frozenColWidth = engine.getColumnWidth(0)
  const totalGridHeight = engine.getTotalHeight()
  const totalGridWidth = engine.getTotalWidth()
  const rowHeaderWidth = 56

  // Scroll selected cell into view if needed
  useEffect(() => {
    if (!selectedCell || !containerRef.current) return
    const el = containerRef.current
    if (selectedCell.r === 0 && selectedCell.c === 0) return

    const cellTop = engine.getRowOffset(selectedCell.r)
    const cellHeight = engine.getRowHeight(selectedCell.r)
    const cellLeft = engine.getColumnOffset(selectedCell.c)
    const cellWidth = engine.getColumnWidth(selectedCell.c)

    // Frozen area boundaries
    const frozenTopBoundary = el.scrollTop + frozenRowHeight + 28
    const frozenLeftBoundary = el.scrollLeft + frozenColWidth + rowHeaderWidth

    if (selectedCell.r > 0) {
      if (cellTop < frozenTopBoundary) {
        el.scrollTop = Math.max(0, cellTop - frozenRowHeight - 28)
      } else if (cellTop + cellHeight > el.scrollTop + el.clientHeight) {
        el.scrollTop = cellTop + cellHeight - el.clientHeight
      }
    }

    if (selectedCell.c > 0) {
      if (cellLeft < frozenLeftBoundary) {
        el.scrollLeft = Math.max(0, cellLeft - frozenColWidth - rowHeaderWidth)
      } else if (cellLeft + cellWidth > el.scrollLeft + el.clientWidth) {
        el.scrollLeft = cellLeft + cellWidth - el.clientWidth
      }
    }
  }, [selectedCell, engine, frozenRowHeight, frozenColWidth, rowHeaderWidth])

  return (
    <div
      className="virtual-grid-container"
      ref={containerRef}
      onScroll={handleScroll}
      tabIndex={0}
    >
      {/* Scroll canvas sizer */}
      <div
        className="virtual-grid-sizer"
        style={{
          width: totalGridWidth + rowHeaderWidth,
          height: totalGridHeight + 30
        }}
      />

      {/* TOP-LEFT CORNER (Pinned row 0, col 0 + row header) */}
      <div
        className="corner-header-cell"
        style={{
          width: rowHeaderWidth,
          height: 28,
          transform: `translate3d(${scrollState.left}px, ${scrollState.top}px, 0)`
        }}
      >
        <span className="corner-icon">⚏</span>
      </div>

      {/* TOP-LEFT FROZEN ROW 0 HEADER */}
      <div
        className="corner-row0-header"
        style={{
          width: rowHeaderWidth,
          height: frozenRowHeight,
          transform: `translate3d(${scrollState.left}px, ${scrollState.top + 28}px, 0)`
        }}
      >
        1
        <div
          className="row-resizer"
          onMouseDown={(e) => handleResizeMouseDown(e, 'row', 0)}
        />
      </div>

      {/* TOP-LEFT FROZEN COL 0 HEADER */}
      <div
        className="corner-col0-header"
        style={{
          width: frozenColWidth,
          height: 28,
          transform: `translate3d(${scrollState.left + rowHeaderWidth}px, ${scrollState.top}px, 0)`
        }}
        onDoubleClick={() => handleColHeaderDoubleClick(0)}
      >
        {getColLabel(0)}
        <div
          className="col-resizer"
          onMouseDown={(e) => handleResizeMouseDown(e, 'col', 0)}
        />
      </div>

      {/* TOP-LEFT FROZEN CELL (0, 0) */}
      {(() => {
        const isSel = selectedCell?.r === 0 && selectedCell?.c === 0
        const isEdit = editingCell?.r === 0 && editingCell?.c === 0
        const cellData = engine.getCell(0, 0)
        const style = cellStyles['0,0'] || {}
        const val = cellData.error || (cellData.computed !== null && cellData.computed !== '' ? String(cellData.computed) : cellData.raw)

        return (
          <div
            className={`virtual-cell frozen-cell ${isSel ? 'selected' : ''}`}
            style={{
              width: frozenColWidth,
              height: frozenRowHeight,
              transform: `translate3d(${scrollState.left + rowHeaderWidth}px, ${scrollState.top + 28}px, 0)`,
              zIndex: 35,
              background: style.bg || '#ffffff',
              fontWeight: style.bold ? 'bold' : 'normal',
              fontStyle: style.italic ? 'italic' : 'normal',
              textDecoration: style.underline ? 'underline' : 'none',
              color: cellData.error ? '#d93025' : (style.color || '#202124'),
              fontSize: (style.fontSize || 13) + 'px',
              textAlign: style.align || 'left'
            }}
            onMouseDown={() => {
              if (editingCell && (editingCell.r !== 0 || editingCell.c !== 0)) {
                commitEdit(editingCell.r, editingCell.c)
              }
              setSelectedCell({ r: 0, c: 0 })
            }}
            onDoubleClick={() => startEditing(0, 0)}
          >
            {isEdit ? (
              <input
                autoFocus
                className="virtual-cell-input"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={() => commitEdit(0, 0)}
                ref={cellInputRef}
              />
            ) : (
              <span className="virtual-cell-text">{val}</span>
            )}
          </div>
        )
      })()}

      {/* FROZEN TOP ROW (Column headers for cols 1..N) */}
      {(() => {
        const headers = []
        for (let c = colRange.start; c <= colRange.end; c++) {
          const colX = engine.getColumnOffset(c) + rowHeaderWidth
          const colW = engine.getColumnWidth(c)
          headers.push(
            <div
              key={`col-hdr-${c}`}
              className="virtual-col-header"
              style={{
                width: colW,
                height: 28,
                transform: `translate3d(${colX}px, ${scrollState.top}px, 0)`
              }}
              onDoubleClick={() => handleColHeaderDoubleClick(c)}
            >
              <span className="header-label">{getColLabel(c)}</span>
              <div
                className="col-resizer"
                onMouseDown={(e) => handleResizeMouseDown(e, 'col', c)}
              />
            </div>
          )
        }
        return headers
      })()}

      {/* FROZEN ROW 0 CELLS (Row 0 for cols 1..N) */}
      {(() => {
        const cells = []
        for (let c = colRange.start; c <= colRange.end; c++) {
          const isSel = selectedCell?.r === 0 && selectedCell?.c === c
          const isEdit = editingCell?.r === 0 && editingCell?.c === c
          const colX = engine.getColumnOffset(c) + rowHeaderWidth
          const colW = engine.getColumnWidth(c)
          const cellData = engine.getCell(0, c)
          const style = cellStyles[`0,${c}`] || {}
          const val = cellData.error || (cellData.computed !== null && cellData.computed !== '' ? String(cellData.computed) : cellData.raw)

          cells.push(
            <div
              key={`frozen-r0-c${c}`}
              className={`virtual-cell frozen-row-cell ${isSel ? 'selected' : ''}`}
              style={{
                width: colW,
                height: frozenRowHeight,
                transform: `translate3d(${colX}px, ${scrollState.top + 28}px, 0)`,
                background: style.bg || '#ffffff',
                fontWeight: style.bold ? 'bold' : 'normal',
                fontStyle: style.italic ? 'italic' : 'normal',
                textDecoration: style.underline ? 'underline' : 'none',
                color: cellData.error ? '#d93025' : (style.color || '#202124'),
                fontSize: (style.fontSize || 13) + 'px',
                textAlign: style.align || 'left'
              }}
              onMouseDown={() => {
                if (editingCell && (editingCell.r !== 0 || editingCell.c !== c)) {
                  commitEdit(editingCell.r, editingCell.c)
                }
                setSelectedCell({ r: 0, c })
              }}
              onDoubleClick={() => startEditing(0, c)}
            >
              {isEdit ? (
                <input
                  autoFocus
                  className="virtual-cell-input"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={() => commitEdit(0, c)}
                />
              ) : (
                <span className="virtual-cell-text">{val}</span>
              )}
            </div>
          )
        }
        return cells
      })()}

      {/* FROZEN LEFT COLUMN (Row headers for rows 1..N) */}
      {(() => {
        const headers = []
        for (let r = rowRange.start; r <= rowRange.end; r++) {
          const rowY = engine.getRowOffset(r) + 28
          const rowH = engine.getRowHeight(r)
          headers.push(
            <div
              key={`row-hdr-${r}`}
              className="virtual-row-header"
              style={{
                width: rowHeaderWidth,
                height: rowH,
                transform: `translate3d(${scrollState.left}px, ${rowY}px, 0)`
              }}
            >
              <span className="header-label">{r + 1}</span>
              <div
                className="row-resizer"
                onMouseDown={(e) => handleResizeMouseDown(e, 'row', r)}
              />
            </div>
          )
        }
        return headers
      })()}

      {/* FROZEN COL 0 CELLS (Col 0 for rows 1..N) */}
      {(() => {
        const cells = []
        for (let r = rowRange.start; r <= rowRange.end; r++) {
          const isSel = selectedCell?.r === r && selectedCell?.c === 0
          const isEdit = editingCell?.r === r && editingCell?.c === 0
          const rowY = engine.getRowOffset(r) + 28
          const rowH = engine.getRowHeight(r)
          const cellData = engine.getCell(r, 0)
          const style = cellStyles[`${r},0`] || {}
          const val = cellData.error || (cellData.computed !== null && cellData.computed !== '' ? String(cellData.computed) : cellData.raw)

          cells.push(
            <div
              key={`frozen-c0-r${r}`}
              className={`virtual-cell frozen-col-cell ${isSel ? 'selected' : ''}`}
              style={{
                width: frozenColWidth,
                height: rowH,
                transform: `translate3d(${scrollState.left + rowHeaderWidth}px, ${rowY}px, 0)`,
                background: style.bg || '#ffffff',
                fontWeight: style.bold ? 'bold' : 'normal',
                fontStyle: style.italic ? 'italic' : 'normal',
                textDecoration: style.underline ? 'underline' : 'none',
                color: cellData.error ? '#d93025' : (style.color || '#202124'),
                fontSize: (style.fontSize || 13) + 'px',
                textAlign: style.align || 'left'
              }}
              onMouseDown={() => {
                if (editingCell && (editingCell.r !== r || editingCell.c !== 0)) {
                  commitEdit(editingCell.r, editingCell.c)
                }
                setSelectedCell({ r, c: 0 })
              }}
              onDoubleClick={() => startEditing(r, 0)}
            >
              {isEdit ? (
                <input
                  autoFocus
                  className="virtual-cell-input"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={() => commitEdit(r, 0)}
                />
              ) : (
                <span className="virtual-cell-text">{val}</span>
              )}
            </div>
          )
        }
        return cells
      })()}

      {/* MAIN BODY CELLS (Rows 1..N, Cols 1..M) */}
      {(() => {
        const cells = []
        for (let r = rowRange.start; r <= rowRange.end; r++) {
          const rowY = engine.getRowOffset(r) + 28
          const rowH = engine.getRowHeight(r)

          for (let c = colRange.start; c <= colRange.end; c++) {
            const isSel = selectedCell?.r === r && selectedCell?.c === c
            const isEdit = editingCell?.r === r && editingCell?.c === c
            const colX = engine.getColumnOffset(c) + rowHeaderWidth
            const colW = engine.getColumnWidth(c)
            const cellData = engine.getCell(r, c)
            const style = cellStyles[`${r},${c}`] || {}
            const val = cellData.error || (cellData.computed !== null && cellData.computed !== '' ? String(cellData.computed) : cellData.raw)

            cells.push(
              <div
                key={`cell-${r}-${c}`}
                className={`virtual-cell ${isSel ? 'selected' : ''}`}
                style={{
                  width: colW,
                  height: rowH,
                  transform: `translate3d(${colX}px, ${rowY}px, 0)`,
                  background: style.bg || '#ffffff',
                  fontWeight: style.bold ? 'bold' : 'normal',
                  fontStyle: style.italic ? 'italic' : 'normal',
                  textDecoration: style.underline ? 'underline' : 'none',
                  color: cellData.error ? '#d93025' : (style.color || '#202124'),
                  fontSize: (style.fontSize || 13) + 'px',
                  textAlign: style.align || 'left'
                }}
                onMouseDown={() => {
                  if (editingCell && (editingCell.r !== r || editingCell.c !== c)) {
                    commitEdit(editingCell.r, editingCell.c)
                  }
                  setSelectedCell({ r, c })
                }}
                onDoubleClick={() => startEditing(r, c)}
              >
                {isEdit ? (
                  <input
                    autoFocus
                    className="virtual-cell-input"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={() => commitEdit(r, c)}
                  />
                ) : (
                  <span className="virtual-cell-text">{val}</span>
                )}
              </div>
            )
          }
        }
        return cells
      })()}
    </div>
  )
}
