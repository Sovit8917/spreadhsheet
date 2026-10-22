// ─────────────────────────────────────────────────────────────
//  Pure cell-reference utilities. No React, no DOM, no engine state.
//
//  A reference may be relative (A1), column-pinned ($A1), row-pinned (A$1)
//  or fully pinned ($A$1). Pinning matters for fill (copy) only; row/column
//  insert and delete move every reference that points past the edit.
// ─────────────────────────────────────────────────────────────

export function columnLetterToIndex(letters) {
    let index = 0
    for (let i = 0; i < letters.length; i++) {
        index = index * 26 + (letters.charCodeAt(i) - 64)
    }
    return index - 1
}

export function indexToColumnLetter(col) {
    let label = ''
    let n = col + 1
    while (n > 0) {
        n--
        label = String.fromCharCode(65 + (n % 26)) + label
        n = Math.floor(n / 26)
    }
    return label
}

export function indexToCellKey(row, col) {
    return indexToColumnLetter(col) + (row + 1)
}

export function parseCellKey(cellKey) {
    const match = /^([A-Z]+)(\d+)$/.exec(cellKey)
    if (!match) return null
    return { row: parseInt(match[2], 10) - 1, col: columnLetterToIndex(match[1]) }
}

// One reference, optionally the start of a range: [$]COL[$]ROW[:[$]COL[$]ROW]
// Not preceded by a letter/digit/$ (so it can't match inside a longer word)
// and not followed by "(" (so a function name like LOG10( is not a cell).
const RANGE_OR_REF = /(?<![A-Za-z0-9_$])(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?::(\$?)([A-Za-z]{1,3})(\$?)(\d+))?(?![A-Za-z0-9_(])/g

const REF_ERROR = '#REF!'

/**
 * Shift the relative parts of every reference in a formula by (dRow, dCol).
 * Pinned parts ($) do not move. A reference pushed off the sheet (row/col < 0)
 * becomes #REF! (the evaluator reports it as #REF!).
 * Used by fill. Non-formulas are returned unchanged.
 */
export function shiftFormula(formula, dRow, dCol) {
    if (typeof formula !== 'string' || !formula.startsWith('=')) return formula
    return formula.replace(RANGE_OR_REF, (match, cAbs1, col1, rAbs1, row1, cAbs2, col2, rAbs2, row2) => {
        const a = shiftOne(cAbs1, col1, rAbs1, row1, dRow, dCol)
        if (a === null) return REF_ERROR
        if (col2 === undefined) return a
        const b = shiftOne(cAbs2, col2, rAbs2, row2, dRow, dCol)
        if (b === null) return REF_ERROR
        return a + ':' + b
    })
}

function shiftOne(colAbs, colLetters, rowAbs, rowDigits, dRow, dCol) {
    let col = columnLetterToIndex(colLetters.toUpperCase())
    let row = parseInt(rowDigits, 10) - 1
    if (!colAbs) col += dCol
    if (!rowAbs) row += dRow
    if (col < 0 || row < 0) return null
    return (colAbs ? '$' : '') + indexToColumnLetter(col) + (rowAbs ? '$' : '') + (row + 1)
}

/**
 * Rewrite references after a structural edit.
 *   axis  'row' | 'col'
 *   index where the edit happens (0-based)
 *   delta +1 = one line inserted before `index`, -1 = line `index` deleted
 * Pinned ($) references move too: pinning only protects against fill.
 * Ranges grow when a line is inserted inside them and shrink when one is
 * deleted; a reference to a deleted line becomes #REF!.
 */
export function shiftReferencesForStructure(formula, axis, index, delta) {
    if (typeof formula !== 'string' || !formula.startsWith('=')) return formula
    const isRow = axis === 'row'
    return formula.replace(RANGE_OR_REF, (match, cAbs1, col1, rAbs1, row1, cAbs2, col2, rAbs2, row2) => {
        const isRange = col2 !== undefined
        const p1 = { col: columnLetterToIndex(col1.toUpperCase()), row: parseInt(row1, 10) - 1 }
        const p2 = isRange
            ? { col: columnLetterToIndex(col2.toUpperCase()), row: parseInt(row2, 10) - 1 }
            : p1
        const key = isRow ? 'row' : 'col'
        const moved = moveSpan(p1[key], p2[key], index, delta)
        if (!moved) return REF_ERROR
        const n1 = { ...p1, [key]: moved[0] }
        const n2 = { ...p2, [key]: moved[1] }
        const text1 = (cAbs1 || '') + indexToColumnLetter(n1.col) + (rAbs1 || '') + (n1.row + 1)
        if (!isRange) return text1
        const text2 = (cAbs2 || '') + indexToColumnLetter(n2.col) + (rAbs2 || '') + (n2.row + 1)
        return text1 + ':' + text2
    })
}

// Move the span [start, end] on one axis. Returns null if it is deleted.
function moveSpan(start, end, index, delta) {
    const lo = Math.min(start, end)
    const hi = Math.max(start, end)
    if (delta > 0) {
        const nlo = lo >= index ? lo + delta : lo
        const nhi = hi >= index ? hi + delta : hi
        return start <= end ? [nlo, nhi] : [nhi, nlo]
    }
    // delete line `index`
    if (lo === index && hi === index) return null
    const nlo = lo > index ? lo - 1 : lo
    const nhi = hi >= index ? hi - 1 : hi
    return start <= end ? [nlo, nhi] : [nhi, nlo]
}

/**
 * Every cell key a formula reads, with $ stripped, ranges expanded.
 * Used for the dependency graph.
 */
export function extractCellReferences(formula) {
    const refs = new Set()
    if (typeof formula !== 'string' || !formula.startsWith('=')) return refs
    RANGE_OR_REF.lastIndex = 0
    let m
    while ((m = RANGE_OR_REF.exec(formula)) !== null) {
        const c1 = columnLetterToIndex(m[2].toUpperCase())
        const r1 = parseInt(m[4], 10) - 1
        if (m[6] === undefined) {
            refs.add(indexToCellKey(r1, c1))
            continue
        }
        const c2 = columnLetterToIndex(m[6].toUpperCase())
        const r2 = parseInt(m[8], 10) - 1
        for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
            for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
                refs.add(indexToCellKey(r, c))
            }
        }
    }
    return refs
}

// ── Range helpers (a range is { r1, c1, r2, c2 }, inclusive, normalised) ──

export function normalizeRange(a) {
    return {
        r1: Math.min(a.r1, a.r2),
        c1: Math.min(a.c1, a.c2),
        r2: Math.max(a.r1, a.r2),
        c2: Math.max(a.c1, a.c2),
    }
}

export function rangeArea(range) {
    return (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1)
}
