import { norm, toNum, toDate } from '../engine/queryNormalize.js'

/**
 * Infers a semantic type for a column given sample values according to AI_CONTRACT.md:
 * types: 'number', 'currency', 'percent', 'date', 'text', 'id'
 * @param {string} colName
 * @param {any[]} values
 * @returns {string}
 */
export function inferColumnType(colName, values) {
    const nameNorm = norm(colName)
    if (nameNorm.includes('id') || nameNorm.includes('code') || nameNorm.includes('key') || nameNorm.includes('sku')) {
        return 'id'
    }

    const nonEmpties = values.filter(v => v !== null && v !== undefined && String(v).trim() !== '')
    if (nonEmpties.length === 0) return 'text'

    let currencyCount = 0
    let percentCount = 0
    let dateCount = 0
    let numberCount = 0

    for (const v of nonEmpties) {
        const s = String(v).trim()
        if (s.startsWith('$') || s.includes('$')) {
            currencyCount++
        }
        if (s.endsWith('%') || s.includes('%')) {
            percentCount++
        }
        if (toDate(s) !== null) {
            dateCount++
        }
        if (toNum(s) !== null) {
            numberCount++
        }
    }

    const threshold = nonEmpties.length * 0.5
    if (currencyCount >= threshold) return 'currency'
    if (percentCount >= threshold) return 'percent'
    if (dateCount >= threshold) return 'date'
    if (numberCount >= threshold) return 'number'

    return 'text'
}

/**
 * Builds the compact sheet context object to send to the AI provider.
 * Follows AI_CONTRACT.md §1:
 * - At most five sample rows
 * - Inferred type per column
 * - Never full data
 * - selection, range, rowCount, hasTotalsRow
 *
 * @param {any} engine
 * @param {string} selectionStr (e.g. "A1:J33" or "A1")
 * @returns {object}
 */
export function buildSheetContext(engine, selectionStr = 'A1') {
    const used = engine.getUsedRange ? engine.getUsedRange() : { minRow: 0, minCol: 0, maxRow: -1, maxCol: -1 }
    if (used.maxRow < 0 || used.maxCol < 0) {
        return {
            range: 'A1:A1',
            rowCount: 0,
            columns: [],
            sampleRows: [],
            selection: selectionStr,
            hasTotalsRow: false
        }
    }

    const colCount = used.maxCol + 1
    const rawHeaders = []
    for (let c = 0; c < colCount; c++) {
        const cell = engine.getCell(0, c)
        rawHeaders.push(String(cell ? (cell.computed ?? cell.raw ?? '') : '').trim())
    }

    // Check totals row
    let hasTotalsRow = false
    let lastRow = used.maxRow
    if (lastRow >= 1) {
        let firstNonEmpty = null
        for (let c = 0; c < colCount; c++) {
            const cell = engine.getCell(lastRow, c)
            const text = cell ? String(cell.computed ?? cell.raw ?? '').trim() : ''
            if (text) {
                firstNonEmpty = text
                break
            }
        }
        if (firstNonEmpty && /^(grand\s+)?(total|totals|subtotal|sum)\b/i.test(firstNonEmpty)) {
            hasTotalsRow = true
            lastRow--
        }
    }

    const dataRowCount = Math.max(0, lastRow) // excluding header (row 0) and totals row if present

    // Sample up to 5 data rows
    const sampleRows = []
    const sampleLimit = Math.min(5, dataRowCount)
    for (let r = 1; r <= sampleLimit; r++) {
        const row = []
        for (let c = 0; c < colCount; c++) {
            const cell = engine.getCell(r, c)
            row.push(cell ? String(cell.computed ?? cell.raw ?? '') : '')
        }
        sampleRows.push(row)
    }

    // Infer column metadata
    const columns = []
    for (let c = 0; c < colCount; c++) {
        const name = rawHeaders[c] || `Column ${c + 1}`
        const colVals = sampleRows.map(row => row[c])
        const type = inferColumnType(name, colVals)
        const examples = colVals.filter(v => v.trim() !== '').slice(0, 3)
        columns.push({
            name,
            index: c,
            type,
            examples
        })
    }

    const endColLetter = String.fromCharCode(65 + Math.min(25, used.maxCol))
    const range = `A1:${endColLetter}${used.maxRow + 1}`

    return {
        range,
        rowCount: dataRowCount,
        columns,
        sampleRows,
        selection: selectionStr,
        hasTotalsRow
    }
}
