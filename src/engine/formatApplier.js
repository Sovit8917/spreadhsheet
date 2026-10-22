// ─────────────────────────────────────────────────────────────
//  Format Sheet Applier according to CHALLENGE.md & AI_CONTRACT.md §4
//  Zero React / DOM dependencies — pure engine logic.
// ─────────────────────────────────────────────────────────────
import { formatValueForDisplay } from './formatDisplay.js'

/**
 * Checks if a given row is a totals row according to AI_CONTRACT.md §3.1 & §4:
 * The totals row is the last used row only if it looks like one:
 * 1. its first filled cell matches `/^(grand\s+)?(total|totals|subtotal|sum)\b/i`, OR
 * 2. it reads as a summary line (a non-numeric label first, then numbers,
 *    with at least one column left empty, and at least two filled cells, not all cells filled).
 *
 * @param {any} engine
 * @param {number} row
 * @param {number} colCount
 * @returns {boolean}
 */
export function isTotalsRow(engine, row, colCount) {
    if (row < 1 || colCount <= 0) return false

    let firstFilledCell = null
    let filledCount = 0
    let emptyCount = 0
    let nonNumericFirst = false
    let numbersAfter = 0

    for (let c = 0; c < colCount; c++) {
        const cell = engine.getCell(row, c)
        const text = cell ? String(cell.computed ?? cell.raw ?? '').trim() : ''
        if (text) {
            filledCount++
            if (firstFilledCell === null) {
                firstFilledCell = text
                // Check if non-numeric
                const stripped = text.replace(/[\$,%\s]/g, '')
                if (!/^-?\d+(\.\d+)?$/.test(stripped)) {
                    nonNumericFirst = true
                }
            } else {
                const stripped = text.replace(/[\$,%\s]/g, '')
                if (/^-?\d+(\.\d+)?$/.test(stripped)) {
                    numbersAfter++
                }
            }
        } else {
            emptyCount++
        }
    }

    if (filledCount === 0) return false

    // Condition 1: regex match on first filled cell
    if (firstFilledCell && /^(grand\s+)?(total|totals|subtotal|sum)\b/i.test(firstFilledCell)) {
        return true
    }

    // Condition 2: summary line: non-numeric label first, then numbers,
    // at least one column left empty, at least two filled cells, not all cells filled
    if (nonNumericFirst && numbersAfter > 0 && emptyCount >= 1 && filledCount >= 2 && filledCount < colCount) {
        return true
    }

    return false
}

/**
 * Measures text width using monospace calculation (consistent with 13px Courier New):
 * width ~ text.length * 8 + 24 padding, clamped between 50 and 600.
 *
 * @param {string} text
 * @returns {number}
 */
export function calculateFitWidth(text) {
    const len = text ? String(text).length : 0
    const measured = len * 8.5 + 24
    return Math.min(600, Math.max(50, Math.ceil(measured)))
}

/**
 * Applies a format_sheet action to the engine.
 *
 * Requirements & semantics (AI_CONTRACT.md §4):
 * 1. Used range bounding box: row 0 is header, row 1 to maxRow is body.
 * 2. Out-of-range freezeRows check: if freezeRows >= used row count (or < 0),
 *    refuse with { ok: false, result: 'OUT_OF_RANGE' } and change NOTHING.
 * 3. totalsStyle: checked on last used row via isTotalsRow. If not a totals row,
 *    totalsStyle is dropped silently.
 * 4. Application order:
 *    - clearFormatting (first, over the whole used range)
 *    - bodyStyle (body rows 1..maxRow, all used cols)
 *    - columns[] (body rows of that column; header is never number-formatted or realigned)
 *    - totalsStyle (on totals row if present)
 *    - headerStyle (applied last, row 0, cols 0..maxCol)
 * 5. freezeRows: applied if different from current; 0 unfreezes; null/absent untouched.
 * 6. columnWidths: clamped cols 0..maxCol, width 30..600.
 * 7. autoFitColumns: measures formatted text and updates column widths.
 * 8. If nothing changed, return { ok: true, result: 'NO_CHANGES' } and create NO undo entry.
 *    Otherwise, entire action is ONE undo step.
 *
 * @param {any} engine
 * @param {object} action
 * @param {object} [options]
 * @returns {{ ok: boolean, result: 'APPLIED'|'NO_CHANGES'|'OUT_OF_RANGE'|'INVALID', message?: string }}
 */
export function applyFormatSheet(engine, action) {
    if (!action || action.type !== 'format_sheet') {
        return { ok: false, result: 'INVALID', message: 'Action type must be format_sheet' }
    }

    const used = engine.getUsedRange ? engine.getUsedRange() : { minRow: 0, minCol: 0, maxRow: -1, maxCol: -1 }
    // If sheet is completely empty
    if (used.maxRow < 0 || used.maxCol < 0) {
        return { ok: true, result: 'NO_CHANGES' }
    }

    const usedRowCount = used.maxRow + 1
    const usedColCount = used.maxCol + 1

    // ── Check OUT_OF_RANGE on freezeRows ──
    if (action.freezeRows !== undefined && action.freezeRows !== null) {
        if (action.freezeRows >= usedRowCount || action.freezeRows < 0) {
            return {
                ok: false,
                result: 'OUT_OF_RANGE',
                message: `Cannot freeze ${action.freezeRows} rows on a table with ${usedRowCount} rows`
            }
        }
    }

    // ── Check Totals Row ──
    const lastRow = used.maxRow
    const hasTotals = isTotalsRow(engine, lastRow, usedColCount)
    const effectiveTotalsRow = hasTotals ? lastRow : null
    const effectiveBodyEndRow = hasTotals ? lastRow - 1 : lastRow

    // ── Determine changes to styles ──
    const styleChanges = new Map() // key "r,c" -> { oldStyle, newStyle }
    const initialStyles = engine.getAllCellStyles ? engine.getAllCellStyles() : {}

    function getCurStyle(r, c) {
        const key = `${r},${c}`
        if (styleChanges.has(key)) {
            return styleChanges.get(key).newStyle
        }
        return engine.getCellStyle(r, c)
    }

    function setNextStyle(r, c, patch) {
        const key = `${r},${c}`
        const cur = getCurStyle(r, c)
        const baseOld = styleChanges.has(key) ? styleChanges.get(key).oldStyle : { ...cur }
        const updated = { ...cur, ...patch }
        styleChanges.set(key, { oldStyle: baseOld, newStyle: updated })
    }

    let modified = false

    // 1. clearFormatting (over the whole used range)
    if (action.clearFormatting === true) {
        for (let r = 0; r <= used.maxRow; r++) {
            for (let c = 0; c <= used.maxCol; c++) {
                const cur = engine.getCellStyle(r, c)
                // If it has non-default styling
                if (cur.bold || cur.italic || cur.underline ||
                    (cur.bg && cur.bg !== 'white') ||
                    (cur.color && cur.color !== '#202124') ||
                    (cur.align && cur.align !== 'left') ||
                    (cur.fontSize && cur.fontSize !== 13) ||
                    (cur.numberFormat && cur.numberFormat !== 'general')) {
                    setNextStyle(r, c, {
                        bold: false,
                        italic: false,
                        underline: false,
                        bg: 'white',
                        color: '#202124',
                        align: 'left',
                        fontSize: 13,
                        numberFormat: 'general'
                    })
                }
            }
        }
    }

    // 2. bodyStyle (body rows 1..effectiveBodyEndRow, all used cols)
    if (action.bodyStyle && typeof action.bodyStyle === 'object') {
        for (let r = 1; r <= used.maxRow; r++) {
            for (let c = 0; c <= used.maxCol; c++) {
                setNextStyle(r, c, action.bodyStyle)
            }
        }
    }

    // 3. columns[] entries (body rows of that column; header is NEVER formatted by column)
    if (Array.isArray(action.columns)) {
        for (const colEntry of action.columns) {
            const c = colEntry.col
            if (c >= 0 && c <= used.maxCol && colEntry.style) {
                for (let r = 1; r <= used.maxRow; r++) {
                    setNextStyle(r, c, colEntry.style)
                }
            }
        }
    }

    // 4. totalsStyle (totals row only, if present)
    if (action.totalsStyle && effectiveTotalsRow !== null && typeof action.totalsStyle === 'object') {
        for (let c = 0; c <= used.maxCol; c++) {
            setNextStyle(effectiveTotalsRow, c, action.totalsStyle)
        }
    }

    // 5. headerStyle (applied last, row 0, cols 0..used.maxCol)
    if (action.headerStyle && typeof action.headerStyle === 'object') {
        for (let c = 0; c <= used.maxCol; c++) {
            setNextStyle(0, c, action.headerStyle)
        }
    }

    // ── Filter out no-op style changes ──
    const finalStyleDiff = new Map()
    for (const [key, { oldStyle, newStyle }] of styleChanges.entries()) {
        let isDiff = false
        const allKeys = new Set([...Object.keys(oldStyle || {}), ...Object.keys(newStyle || {})])
        for (const k of allKeys) {
            if ((oldStyle?.[k] ?? '') !== (newStyle?.[k] ?? '')) {
                isDiff = true
                break
            }
        }
        if (isDiff) {
            finalStyleDiff.set(key, { oldStyle, newStyle })
        }
    }

    // ── Dimension / freezeRows changes ──
    let oldFrozenRows = engine.getFrozenRows ? engine.getFrozenRows() : 1
    let newFrozenRows = oldFrozenRows
    let freezeChanged = false
    if (action.freezeRows !== undefined && action.freezeRows !== null) {
        if (action.freezeRows !== oldFrozenRows) {
            newFrozenRows = action.freezeRows
            freezeChanged = true
        }
    }

    // ── Column widths changes ──
    const widthChanges = []
    if (Array.isArray(action.columnWidths)) {
        for (const cw of action.columnWidths) {
            const col = cw.col
            const width = cw.width
            if (col >= 0 && col <= used.maxCol && width >= 30 && width <= 600) {
                const oldWidth = engine.getColumnWidth(col)
                if (oldWidth !== width) {
                    widthChanges.push({ col, oldWidth, newWidth: width })
                }
            }
        }
    }

    // ── Auto-fit columns ──
    if (action.autoFitColumns === true) {
        for (let c = 0; c <= used.maxCol; c++) {
            let maxW = 40
            for (let r = 0; r <= used.maxRow; r++) {
                const cell = engine.getCell(r, c)
                const rawVal = cell ? (cell.error || (cell.computed !== null && cell.computed !== '' ? cell.computed : cell.raw)) : ''
                const style = finalStyleDiff.has(`${r},${c}`)
                    ? finalStyleDiff.get(`${r},${c}`).newStyle
                    : engine.getCellStyle(r, c)
                const display = formatValueForDisplay(rawVal, style?.numberFormat)
                if (display) {
                    const fitW = calculateFitWidth(display)
                    if (fitW > maxW) maxW = fitW
                }
            }
            const currentW = widthChanges.find(w => w.col === c)?.newWidth ?? engine.getColumnWidth(c)
            if (maxW !== currentW) {
                const existingIdx = widthChanges.findIndex(w => w.col === c)
                if (existingIdx >= 0) {
                    widthChanges[existingIdx].newWidth = maxW
                } else {
                    widthChanges.push({ col: c, oldWidth: currentW, newWidth: maxW })
                }
            }
        }
    }

    // If absolutely nothing changed across styles, freezeRows, or columnWidths
    if (finalStyleDiff.size === 0 && !freezeChanged && widthChanges.length === 0) {
        return { ok: true, result: 'NO_CHANGES' }
    }

    // ── Apply atomically in engine with ONE undo entry ──
    engine.applyFormatBatch({
        styles: finalStyleDiff,
        freezeRows: freezeChanged ? { oldVal: oldFrozenRows, newVal: newFrozenRows } : null,
        columnWidths: widthChanges
    })

    return { ok: true, result: 'APPLIED' }
}
