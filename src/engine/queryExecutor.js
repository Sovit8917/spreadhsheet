import { norm, toNum, toDate } from './queryNormalize.js'
import { FILTER_OPS, AGGREGATE_FNS, MAX_RESULT_ROWS } from '../ai/contract.js'

/**
 * Pure Query Executor for spreadsheet computed data.
 * Implements full semantics from AI_CONTRACT.md §3.
 *
 * @param {any} engine - The spreadsheet engine (pure methods used: getUsedRange() / getCell(r, c))
 * @param {object} plan - Validated query plan
 * @returns {object} Result shape { columns, rows, rowCount, truncated } or { error, detail }
 */
export function executeQuery(engine, plan) {
    if (!plan || plan.type !== 'query') {
        return { error: 'READ_ONLY', detail: 'Executor only accepts query plans' }
    }

    // 1. Determine bounding box / used range
    const usedRange = typeof engine.getUsedRange === 'function'
        ? engine.getUsedRange()
        : fallbackGetUsedRange(engine)

    if (!usedRange || usedRange.maxRow < 0 || usedRange.maxCol < 0) {
        return {
            columns: plan.columns || [],
            rows: [],
            rowCount: 0,
            truncated: false
        }
    }

    // 2. Row 1 (row index 0) is the header
    const colCount = usedRange.maxCol + 1
    const rawHeaders = []
    const headerNormMap = new Map() // norm(header) -> colIndex

    for (let c = 0; c < colCount; c++) {
        const cell = engine.getCell(0, c)
        const text = cell ? String(cell.computed ?? cell.raw ?? '').trim() : ''
        rawHeaders.push(text)
        if (text) {
            headerNormMap.set(norm(text), c)
        }
    }

    // Helper to resolve a column name against headers
    function resolveColumnIndex(colName) {
        if (typeof colName !== 'string') return -1
        const n = norm(colName)
        if (headerNormMap.has(n)) {
            return headerNormMap.get(n)
        }
        return -1
    }

    // 3. Scan data rows (from row index 1 to usedRange.maxRow)
    const excludeTotals = plan.excludeTotalsRow !== false // default true
    let lastRowIndex = usedRange.maxRow

    // Check if the last used row is a totals row (§3.1)
    if (excludeTotals && lastRowIndex >= 1) {
        let firstNonEmpty = null
        for (let c = 0; c < colCount; c++) {
            const cell = engine.getCell(lastRowIndex, c)
            const text = cell ? String(cell.computed ?? cell.raw ?? '').trim() : ''
            if (text) {
                firstNonEmpty = text
                break
            }
        }
        if (firstNonEmpty && /^(grand\s+)?(total|totals|subtotal|sum)\b/i.test(firstNonEmpty)) {
            lastRowIndex--
        }
    }

    // Collect valid data rows (skip rows where all cells are empty after trim)
    const dataRows = []
    for (let r = 1; r <= lastRowIndex; r++) {
        const rowVals = []
        let hasNonEmpty = false
        for (let c = 0; c < colCount; c++) {
            const cell = engine.getCell(r, c)
            // If cell.raw exists, that is the exact text entered (e.g. '$68,400.00').
            // If it's a formula or computed value without raw, use computed.
            const raw = cell ? cell.raw : ''
            const computed = cell ? cell.computed : null
            const val = raw !== '' ? raw : (computed !== null && computed !== undefined ? computed : '')
            rowVals.push(val)
            if (String(val ?? '').trim() !== '') {
                hasNonEmpty = true
            }
        }
        if (hasNonEmpty) {
            dataRows.push(rowVals)
        }
    }

    // 4. Validate all referenced source columns before applying filters/groups/aggregates
    if (plan.filters && plan.filters.length > 0) {
        for (const f of plan.filters) {
            if (resolveColumnIndex(f.column) === -1) {
                return { error: 'UNKNOWN_COLUMN', detail: `UNKNOWN_COLUMN:${f.column}` }
            }
            if (!FILTER_OPS.includes(f.op)) {
                return { error: 'UNKNOWN_OP', detail: `UNKNOWN_OP:${f.op}` }
            }
        }
    }

    if (plan.groupBy && plan.groupBy.length > 0) {
        for (const g of plan.groupBy) {
            if (resolveColumnIndex(g) === -1) {
                return { error: 'UNKNOWN_COLUMN', detail: `UNKNOWN_COLUMN:${g}` }
            }
        }
    }

    if (plan.aggregates && plan.aggregates.length > 0) {
        for (const a of plan.aggregates) {
            if (resolveColumnIndex(a.column) === -1) {
                return { error: 'UNKNOWN_COLUMN', detail: `UNKNOWN_COLUMN:${a.column}` }
            }
            if (!AGGREGATE_FNS.includes(a.fn)) {
                return { error: 'UNKNOWN_FN', detail: `UNKNOWN_FN:${a.fn}` }
            }
        }
    }

    if (plan.columns && plan.columns.length > 0) {
        for (const col of plan.columns) {
            if (resolveColumnIndex(col) === -1) {
                return { error: 'UNKNOWN_COLUMN', detail: `UNKNOWN_COLUMN:${col}` }
            }
        }
    }

    // 5. Apply filters (AND) (§3.3)
    const filteredRows = []
    for (const row of dataRows) {
        let pass = true
        if (plan.filters && plan.filters.length > 0) {
            for (const f of plan.filters) {
                const cIdx = resolveColumnIndex(f.column)
                const cVal = row[cIdx]
                const fVal = f.value
                if (!matchesFilter(cVal, f.op, fVal)) {
                    pass = false
                    break
                }
            }
        }
        if (pass) {
            filteredRows.push(row)
        }
    }

    // 6. Grouping and Aggregates (§3.4)
    const hasAggregates = Array.isArray(plan.aggregates) && plan.aggregates.length > 0
    const hasGroupBy = Array.isArray(plan.groupBy) && plan.groupBy.length > 0

    let outputColumns = []
    let outputRows = []

    if (hasAggregates || hasGroupBy) {
        // Build output column definitions
        const groupCols = plan.groupBy || []
        const aggCols = plan.aggregates || []

        outputColumns = [
            ...groupCols,
            ...aggCols.map(a => a.as || `${a.fn}(${a.column})`)
        ]

        // Group rows by tuple of norm values
        const groups = new Map() // keyString -> { keyTuple, firstSeenLabels, rows }

        for (const row of filteredRows) {
            const keyParts = []
            const firstSeen = []
            for (const gCol of groupCols) {
                const cIdx = resolveColumnIndex(gCol)
                const val = row[cIdx]
                keyParts.push(norm(val))
                // first-seen label is trimmed value of the first row seen in that group
                firstSeen.push(String(val ?? '').trim())
            }
            const groupKey = JSON.stringify(keyParts)
            if (!groups.has(groupKey)) {
                groups.set(groupKey, {
                    labels: firstSeen,
                    rows: []
                })
            }
            groups.get(groupKey).rows.push(row)
        }

        // If there are no group-by columns, but there are aggregates, we have 1 single group over all filteredRows
        if (!hasGroupBy && groups.size === 0) {
            groups.set('[]', { labels: [], rows: [] })
        }

        // Compute aggregates for each group
        for (const group of groups.values()) {
            const resultRow = [...group.labels]
            for (const agg of aggCols) {
                const cIdx = resolveColumnIndex(agg.column)
                const aggVal = computeAggregate(agg.fn, group.rows, cIdx)
                resultRow.push(aggVal)
            }
            outputRows.push(resultRow)
        }
    } else {
        // No aggregates: filtered rows projected on columns (raw cell text, untrimmed) (§3.4)
        if (plan.columns && plan.columns.length > 0) {
            outputColumns = [...plan.columns]
            const colIndices = plan.columns.map(c => resolveColumnIndex(c))
            outputRows = filteredRows.map(row => colIndices.map(idx => row[idx]))
        } else {
            // Default all columns
            outputColumns = [...rawHeaders]
            outputRows = filteredRows.map(row => [...row])
        }
    }

    // 7. Sort (§3.5)
    if (plan.sort && plan.sort.length > 0) {
        // Validate sort columns against outputColumns
        const sortSpecs = []
        for (const s of plan.sort) {
            const sColNorm = norm(s.column)
            const outIdx = outputColumns.findIndex(col => norm(col) === sColNorm)
            if (outIdx === -1) {
                return { error: 'UNKNOWN_SORT_COLUMN', detail: `UNKNOWN_SORT_COLUMN:${s.column}` }
            }
            sortSpecs.push({
                index: outIdx,
                dir: s.dir === 'desc' ? 'desc' : 'asc'
            })
        }

        // Multi-key stable sort
        outputRows.sort((a, b) => {
            for (const spec of sortSpecs) {
                const cmp = compareSortValues(a[spec.index], b[spec.index])
                if (cmp !== 0) {
                    return spec.dir === 'desc' ? -cmp : cmp
                }
            }
            return 0
        })
    }

    // 8. Limit and truncation (§3.5)
    const totalCount = outputRows.length
    const requestedLimit = plan.limit !== undefined ? plan.limit : MAX_RESULT_ROWS
    const effectiveLimit = Math.min(requestedLimit, MAX_RESULT_ROWS)
    const truncated = totalCount > effectiveLimit

    const finalRows = outputRows.slice(0, effectiveLimit)

    // Round numbers to 2 decimal places for output
    const roundedRows = finalRows.map(row =>
        row.map(cell => {
            if (typeof cell === 'number') {
                return Math.round(cell * 100) / 100
            }
            return cell
        })
    )

    return {
        columns: outputColumns,
        rows: roundedRows,
        rowCount: roundedRows.length,
        truncated
    }
}

/**
 * Filter matching according to AI_CONTRACT.md §3.3
 */
function matchesFilter(c, op, v) {
    if (op === 'isEmpty') {
        return norm(c) === ''
    }
    if (op === 'notEmpty') {
        return norm(c) !== ''
    }

    if (op === 'eq' || op === 'neq') {
        const cNum = toNum(c)
        const vNum = toNum(v)
        let isEqual = false
        if (cNum !== null && vNum !== null) {
            isEqual = cNum === vNum
        } else {
            isEqual = norm(c) === norm(v)
        }
        return op === 'eq' ? isEqual : !isEqual
    }

    if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
        // If v parses as a date, compare toDate(c) with it (a cell that is not a date fails the filter)
        const vDate = toDate(v)
        if (vDate !== null) {
            const cDate = toDate(c)
            if (cDate === null) return false
            if (op === 'gt') return cDate > vDate
            if (op === 'gte') return cDate >= vDate
            if (op === 'lt') return cDate < vDate
            if (op === 'lte') return cDate <= vDate
        }

        // Otherwise compare toNum(c) with toNum(v) (a non-number on either side fails)
        const cNum = toNum(c)
        const vNum = toNum(v)
        if (cNum === null || vNum === null) return false
        if (op === 'gt') return cNum > vNum
        if (op === 'gte') return cNum >= vNum
        if (op === 'lt') return cNum < vNum
        if (op === 'lte') return cNum <= vNum
    }

    if (op === 'contains') {
        return norm(c).includes(norm(v))
    }
    if (op === 'startsWith') {
        return norm(c).startsWith(norm(v))
    }
    if (op === 'endsWith') {
        return norm(c).endsWith(norm(v))
    }

    return false
}

/**
 * Aggregate computation according to AI_CONTRACT.md §3.4
 */
function computeAggregate(fn, rows, colIdx) {
    if (fn === 'count') {
        // Number of rows whose cell is non-empty after trim
        let cnt = 0
        for (const r of rows) {
            if (String(r[colIdx] ?? '').trim() !== '') {
                cnt++
            }
        }
        return cnt
    }

    if (fn === 'countDistinct') {
        // Number of distinct non-empty norm values
        const distinct = new Set()
        for (const r of rows) {
            const val = norm(r[colIdx])
            if (val !== '') {
                distinct.add(val)
            }
        }
        return distinct.size
    }

    // sum, avg, min, max: over toNum values that are numbers; with no numeric values the result is null
    const nums = []
    for (const r of rows) {
        const n = toNum(r[colIdx])
        if (n !== null) {
            nums.push(n)
        }
    }

    if (nums.length === 0) {
        return null
    }

    if (fn === 'sum') {
        let total = 0
        for (const n of nums) total += n
        return total
    }

    if (fn === 'avg') {
        let total = 0
        for (const n of nums) total += n
        return total / nums.length
    }

    if (fn === 'min') {
        return Math.min(...nums)
    }

    if (fn === 'max') {
        return Math.max(...nums)
    }

    return null
}

/**
 * Sort value comparator according to AI_CONTRACT.md §3.5:
 * "Numeric when both values are numbers, otherwise numbers before non-numbers, otherwise norm text compare. Stable."
 */
function compareSortValues(a, b) {
    const aIsNum = typeof a === 'number'
    const bIsNum = typeof b === 'number'

    if (aIsNum && bIsNum) {
        return a - b
    }
    if (aIsNum && !bIsNum) {
        return -1 // numbers before non-numbers
    }
    if (!aIsNum && bIsNum) {
        return 1
    }

    // Both are non-numbers: compare norm text
    const aNorm = norm(a)
    const bNorm = norm(b)
    if (aNorm < bNorm) return -1
    if (aNorm > bNorm) return 1
    return 0
}

/**
 * Fallback to compute used range if engine doesn't export getUsedRange directly
 */
function fallbackGetUsedRange(engine) {
    let maxRow = -1
    let maxCol = -1
    for (let r = 0; r < Math.min(engine.rows, 5000); r++) {
        for (let c = 0; c < Math.min(engine.cols, 50); c++) {
            const cell = engine.getCell(r, c)
            if (cell && (cell.raw || (cell.computed !== null && cell.computed !== undefined))) {
                if (r > maxRow) maxRow = r
                if (c > maxCol) maxCol = c
            }
        }
    }
    return { minRow: 0, minCol: 0, maxRow, maxCol }
}
