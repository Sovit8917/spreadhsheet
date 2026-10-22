// ─────────────────────────────────────────────────────────────
//  Pure Spreadsheet Engine - Task 2: Sort, Filter, Row Identity
// ─────────────────────────────────────────────────────────────

export const OPERATOR_PRECEDENCE = { '+': 1, '-': 1, '*': 2, '/': 2 }
export const MAX_UNDO_HISTORY = 100

// ─────────────────────────────────────────────────────────────
//  Column / Cell coordinate utilities
// ─────────────────────────────────────────────────────────────

export function columnLetterToIndex(columnLetter) {
    let index = 0
    for (let i = 0; i < columnLetter.length; i++) {
        index = index * 26 + (columnLetter.charCodeAt(i) - 64)
    }
    return index - 1
}

export function indexToCellKey(row, col) {
    let columnLabel = ''
    let colNumber = col + 1
    while (colNumber > 0) {
        colNumber--
        columnLabel = String.fromCharCode(65 + (colNumber % 26)) + columnLabel
        colNumber = Math.floor(colNumber / 26)
    }
    return columnLabel + (row + 1)
}

export function parseCellKey(cellKey) {
    const match = cellKey.match(/^([A-Z]+)(\d+)$/)
    if (!match) return null
    return { row: parseInt(match[2], 10) - 1, col: columnLetterToIndex(match[1]) }
}

// ─────────────────────────────────────────────────────────────
//  Data type coercion and normalisation (Contract §3.2 & Task 2)
// ─────────────────────────────────────────────────────────────

export function normText(v) {
    if (v === null || v === undefined) return ''
    return String(v).trim().toLowerCase()
}

export function toNum(v) {
    if (v === null || v === undefined) return null
    if (typeof v === 'number') return isNaN(v) ? null : v
    let s = String(v).trim()
    if (!s) return null
    const hasPercent = s.endsWith('%')
    s = s.replace(/[\$,\s%]/g, '')
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null
    const num = parseFloat(s)
    if (isNaN(num)) return null
    return hasPercent ? num / 100 : num
}

const MONTHS = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
}

export function toDate(v) {
    if (v === null || v === undefined) return null
    const s = String(v).trim()
    if (!s) return null

    // 1. YYYY-M-D or YYYY-MM-DD
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
    if (m) {
        const y = m[1], mo = m[2].padStart(2, '0'), d = m[3].padStart(2, '0')
        return `${y}-${mo}-${d}`
    }

    // 2. M/D/YYYY
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
    if (m) {
        const mo = m[1].padStart(2, '0'), d = m[2].padStart(2, '0'), y = m[3]
        return `${y}-${mo}-${d}`
    }

    // 3. D Mon YYYY (e.g. 15 Jan 2024 or 20 Feb 2024)
    m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/)
    if (m) {
        const d = m[1].padStart(2, '0')
        const monKey = m[2].slice(0, 3).toLowerCase()
        const mo = MONTHS[monKey]
        if (mo) {
            return `${m[3]}-${mo}-${d}`
        }
    }

    return null
}

export function compareValues(a, b) {
    const isBlankA = a === null || a === undefined || a === ''
    const isBlankB = b === null || b === undefined || b === ''
    if (isBlankA && isBlankB) return 0
    if (isBlankA) return 1  // blanks always sort last
    if (isBlankB) return -1

    const numA = toNum(a)
    const numB = toNum(b)
    const isNumA = numA !== null
    const isNumB = numB !== null

    if (isNumA && isNumB) {
        return numA < numB ? -1 : (numA > numB ? 1 : 0)
    }
    if (isNumA) return -1 // numbers before non-numbers
    if (isNumB) return 1

    const dateA = toDate(a)
    const dateB = toDate(b)
    const isDateA = dateA !== null
    const isDateB = dateB !== null

    if (isDateA && isDateB) {
        return dateA < dateB ? -1 : (dateA > dateB ? 1 : 0)
    }
    if (isDateA) return -1 // dates before generic text
    if (isDateB) return 1

    const textA = normText(a)
    const textB = normText(b)
    return textA < textB ? -1 : (textA > textB ? 1 : 0)
}

// ─────────────────────────────────────────────────────────────
//  Dependency graph (tracks which cells depend on which)
// ─────────────────────────────────────────────────────────────

function createDependencyGraph() {
    const forwardEdges = new Map()
    const reverseEdges = new Map()

    function addDependency(cell, dependsOn) {
        if (!forwardEdges.has(cell)) forwardEdges.set(cell, new Set())
        if (!reverseEdges.has(dependsOn)) reverseEdges.set(dependsOn, new Set())
        forwardEdges.get(cell).add(dependsOn)
        reverseEdges.get(dependsOn).add(cell)
    }

    function removeAllDependencies(cell) {
        const deps = forwardEdges.get(cell)
        if (deps) {
            for (const dep of deps) {
                if (reverseEdges.has(dep)) {
                    reverseEdges.get(dep).delete(cell)
                    if (reverseEdges.get(dep).size === 0) reverseEdges.delete(dep)
                }
            }
            forwardEdges.delete(cell)
        }
        const dependents = reverseEdges.get(cell)
        if (dependents) {
            for (const dependent of dependents) {
                if (forwardEdges.has(dependent)) {
                    forwardEdges.get(dependent).delete(cell)
                    if (forwardEdges.get(dependent).size === 0) forwardEdges.delete(dependent)
                }
            }
            reverseEdges.delete(cell)
        }
    }

    function getDependencies(cell) {
        return forwardEdges.get(cell) || new Set()
    }

    function getDependents(cell) {
        return reverseEdges.get(cell) || new Set()
    }

    function getAllDependentsRecursive(cell, visited = new Set()) {
        if (visited.has(cell)) return new Set()
        visited.add(cell)
        const result = new Set()
        for (const dependent of getDependents(cell)) {
            result.add(dependent)
            for (const indirect of getAllDependentsRecursive(dependent, visited)) {
                result.add(indirect)
            }
        }
        return result
    }

    function hasCycle(startCell) {
        const visited = new Set()
        const recursionStack = new Set()
        const dfs = (node) => {
            if (recursionStack.has(node)) return true
            if (visited.has(node)) return false
            visited.add(node)
            recursionStack.add(node)
            for (const dep of getDependencies(node)) {
                if (dfs(dep)) return true
            }
            recursionStack.delete(node)
            return false
        }
        return dfs(startCell)
    }

    function topologicalSort(affectedCells) {
        const inDegree = new Map()
        const queue = []
        const sorted = []

        for (const cell of affectedCells) inDegree.set(cell, 0)
        for (const cell of affectedCells) {
            for (const dep of getDependencies(cell)) {
                if (affectedCells.has(dep)) {
                    inDegree.set(cell, (inDegree.get(cell) || 0) + 1)
                }
            }
        }
        for (const cell of affectedCells) {
            if (inDegree.get(cell) === 0) queue.push(cell)
        }
        while (queue.length > 0) {
            const cell = queue.shift()
            sorted.push(cell)
            for (const dependent of getDependents(cell)) {
                if (affectedCells.has(dependent)) {
                    inDegree.set(dependent, inDegree.get(dependent) - 1)
                    if (inDegree.get(dependent) === 0) queue.push(dependent)
                }
            }
        }
        return sorted
    }

    function clear() {
        forwardEdges.clear()
        reverseEdges.clear()
    }

    return {
        addDependency,
        removeAllDependencies,
        getDependencies,
        getDependents,
        getAllDependentsRecursive,
        hasCycle,
        topologicalSort,
        clear
    }
}

// ─────────────────────────────────────────────────────────────
//  Tokenizer — converts formula string into tokens (supports $)
// ─────────────────────────────────────────────────────────────

function tokenize(expression) {
    const tokens = []
    let position = 0

    while (position < expression.length) {
        const char = expression[position]

        if (char === ' ') {
            position++
            continue
        }

        if (char === '(' || char === ')') {
            tokens.push({ type: 'paren', value: char })
            position++
            continue
        }

        if ('+-*/,'.includes(char)) {
            tokens.push({ type: 'operator', value: char })
            position++
            continue
        }

        if (char === ':') {
            tokens.push({ type: 'range', value: ':' })
            position++
            continue
        }

        if ((char >= '0' && char <= '9') || char === '.') {
            let numberStr = ''
            while (position < expression.length && ((expression[position] >= '0' && expression[position] <= '9') || expression[position] === '.')) {
                numberStr += expression[position]
                position++
            }
            tokens.push({ type: 'number', value: parseFloat(numberStr) })
            continue
        }

        if ((char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char === '$') {
            let identifier = ''
            while (position < expression.length && (
                (expression[position] >= 'A' && expression[position] <= 'Z') ||
                (expression[position] >= 'a' && expression[position] <= 'z') ||
                (expression[position] >= '0' && expression[position] <= '9') ||
                expression[position] === '$'
            )) {
                identifier += expression[position].toUpperCase()
                position++
            }
            if (position < expression.length && expression[position] === ':') {
                tokens.push({ type: 'cell', value: identifier })
            } else {
                const cellMatch = identifier.match(/^\$?([A-Z]+)\$?(\d+)$/)
                if (cellMatch) {
                    tokens.push({ type: 'cell', value: identifier })
                } else {
                    tokens.push({ type: 'function', value: identifier })
                }
            }
            continue
        }

        throw new Error(`Unexpected character: ${char}`)
    }

    return tokens
}

// ─────────────────────────────────────────────────────────────
//  Parser — converts tokens into an AST using shunting-yard
// ─────────────────────────────────────────────────────────────

function parseTokensToAST(tokens) {
    const outputQueue = []
    const operatorStack = []
    let position = 0

    while (position < tokens.length) {
        const token = tokens[position]

        if (token.type === 'number' || token.type === 'cell') {
            outputQueue.push(token)
            position++
        } else if (token.type === 'function') {
            operatorStack.push(token)
            position++
        } else if (token.type === 'operator') {
            while (
                operatorStack.length > 0 &&
                operatorStack[operatorStack.length - 1].type === 'operator' &&
                OPERATOR_PRECEDENCE[operatorStack[operatorStack.length - 1].value] >= OPERATOR_PRECEDENCE[token.value]
            ) {
                outputQueue.push(operatorStack.pop())
            }
            operatorStack.push(token)
            position++
        } else if (token.type === 'paren' && token.value === '(') {
            operatorStack.push(token)
            position++
        } else if (token.type === 'paren' && token.value === ')') {
            while (operatorStack.length > 0 && operatorStack[operatorStack.length - 1].value !== '(') {
                outputQueue.push(operatorStack.pop())
            }
            if (operatorStack.length > 0 && operatorStack[operatorStack.length - 1].value === '(') {
                operatorStack.pop()
            }
            if (operatorStack.length > 0 && operatorStack[operatorStack.length - 1].type === 'function') {
                const funcToken = operatorStack.pop()
                if (outputQueue.length > 0 && outputQueue[outputQueue.length - 1].type === 'range') {
                    const rangeToken = outputQueue.pop()
                    outputQueue.push({ type: 'function', name: funcToken.value, range: rangeToken })
                } else {
                    outputQueue.push(funcToken)
                }
            }
            position++
        } else if (token.type === 'range') {
            if (outputQueue.length < 2) throw new Error('Invalid range syntax')
            const endCell = outputQueue.pop()
            const startCell = outputQueue.pop()
            if (startCell.type !== 'cell' || endCell.type !== 'cell') {
                throw new Error('Range must be between two cell references')
            }
            outputQueue.push({ type: 'range', start: startCell.value, end: endCell.value })
            position++
        } else {
            position++
        }
    }

    while (operatorStack.length > 0) {
        if (operatorStack[operatorStack.length - 1].value === '(') {
            throw new Error('Mismatched parentheses')
        }
        outputQueue.push(operatorStack.pop())
    }

    return buildASTFromRPN(outputQueue)
}

function buildASTFromRPN(rpnTokens) {
    const stack = []

    for (const token of rpnTokens) {
        if (token.type === 'number' || token.type === 'cell' || token.type === 'range') {
            stack.push(token)
        } else if (token.type === 'operator') {
            if (stack.length < 2) throw new Error('Invalid expression')
            const right = stack.pop()
            const left = stack.pop()
            stack.push({ type: 'binary', operator: token.value, left, right })
        } else if (token.type === 'function') {
            if (token.range) {
                stack.push(token)
            } else {
                if (stack.length === 0) throw new Error(`Function ${token.value} requires arguments`)
                const argument = stack.pop()
                if (argument.type === 'range') {
                    stack.push({ type: 'function', name: token.value, range: argument })
                } else {
                    throw new Error(`Function ${token.value} requires a range`)
                }
            }
        }
    }

    if (stack.length !== 1) throw new Error('Invalid expression')
    return stack[0]
}

// ─────────────────────────────────────────────────────────────
//  Evaluator — walks the AST and computes values
// ─────────────────────────────────────────────────────────────

function cleanCellRef(ref) {
    return ref.replace(/\$/g, '')
}

function expandCellRange(startKey, endKey) {
    const cleanStart = cleanCellRef(startKey)
    const cleanEnd = cleanCellRef(endKey)
    const startMatch = cleanStart.match(/^([A-Z]+)(\d+)$/)
    const endMatch = cleanEnd.match(/^([A-Z]+)(\d+)$/)
    if (!startMatch || !endMatch) throw new Error('REF')

    const startCol = columnLetterToIndex(startMatch[1])
    const startRow = parseInt(startMatch[2], 10) - 1
    const endCol = columnLetterToIndex(endMatch[1])
    const endRow = parseInt(endMatch[2], 10) - 1

    const cells = []
    for (let r = Math.min(startRow, endRow); r <= Math.max(startRow, endRow); r++) {
        for (let c = Math.min(startCol, endCol); c <= Math.max(startCol, endCol); c++) {
            cells.push(indexToCellKey(r, c))
        }
    }
    return cells
}

function evaluateAST(ast, getCellValue, visited = new Set()) {
    if (!ast) return 0

    if (ast.type === 'number') return ast.value

    if (ast.type === 'cell') {
        const key = cleanCellRef(ast.value)
        if (visited.has(key)) throw new Error('CIRCULAR')
        visited.add(key)
        const value = getCellValue(key, visited)
        visited.delete(key)
        return value
    }

    if (ast.type === 'range') throw new Error('VALUE')

    if (ast.type === 'binary') {
        const leftVal = evaluateAST(ast.left, getCellValue, visited)
        const rightVal = evaluateAST(ast.right, getCellValue, visited)
        if (typeof leftVal !== 'number' || typeof rightVal !== 'number') throw new Error('VALUE')
        switch (ast.operator) {
            case '+': return leftVal + rightVal
            case '-': return leftVal - rightVal
            case '*': return leftVal * rightVal
            case '/':
                if (rightVal === 0) throw new Error('VALUE')
                return leftVal / rightVal
            default: throw new Error('VALUE')
        }
    }

    if (ast.type === 'function') {
        const rangeCells = expandCellRange(ast.range.start, ast.range.end)
        const values = rangeCells.map(cellKey => {
            if (visited.has(cellKey)) throw new Error('CIRCULAR')
            visited.add(cellKey)
            const value = getCellValue(cellKey, visited)
            visited.delete(cellKey)
            const num = toNum(value)
            return num === null ? (isNaN(parseFloat(value)) ? 0 : parseFloat(value)) : num
        })

        switch (ast.name) {
            case 'SUM': return values.reduce((sum, val) => sum + val, 0)
            case 'AVG': return values.length === 0 ? 0 : values.reduce((sum, val) => sum + val, 0) / values.length
            case 'MIN': return values.length === 0 ? 0 : Math.min(...values)
            case 'MAX': return values.length === 0 ? 0 : Math.max(...values)
            default: throw new Error('VALUE')
        }
    }

    throw new Error('VALUE')
}

function evaluateFormula(expression, getCellValue) {
    try {
        if (!expression || expression.trim() === '') return { value: '', error: null }
        if (!expression.startsWith('=')) return { value: expression, error: null }

        const formulaBody = expression.slice(1).trim()
        if (formulaBody === '') return { value: '', error: null }

        const tokens = tokenize(formulaBody)
        const ast = parseTokensToAST(tokens)
        const result = evaluateAST(ast, getCellValue)
        return { value: result, error: null }
    } catch (error) {
        if (error.message === 'CIRCULAR') return { value: null, error: '#CYCLE!' }
        if (error.message === 'REF') return { value: null, error: '#REF!' }
        if (error.message === 'VALUE') return { value: null, error: '#VALUE!' }
        return { value: null, error: '#PARSE!' }
    }
}

// ─────────────────────────────────────────────────────────────
//  Reference shifting & rewrite
// ─────────────────────────────────────────────────────────────

function shiftCellReferences(formula, rowShift, colShift, atIndex, isColumnOperation = false) {
    if (!formula || !formula.startsWith('=')) return formula

    return formula.replace(/(\$?)([A-Z]+)(\$?)(\d+)/g, (match, colAbs, colLetter, rowAbs, rowStr) => {
        const colIdx = columnLetterToIndex(colLetter)
        const rowIdx = parseInt(rowStr, 10) - 1
        let newRow = rowIdx
        let newCol = colIdx

        if (isColumnOperation) {
            if (colIdx >= atIndex) newCol = colIdx + colShift
        } else {
            if (rowIdx >= atIndex) newRow = rowIdx + rowShift
        }

        if (newRow < 0 || newCol < 0) return match
        const newColLetter = indexToCellKey(0, newCol).replace(/\d+/, '')
        return `${colAbs}${newColLetter}${rowAbs}${newRow + 1}`
    })
}

function extractCellReferences(formula) {
    const references = new Set()
    const regex = /\$?([A-Z]+)\$?(\d+)/g
    let match
    while ((match = regex.exec(formula)) !== null) {
        references.add(match[1] + match[2])
    }
    return references
}

/**
 * Rewrites single cell references in a formula using rowMapping and preserves ranges.
 * Range spanning the whole block (e.g. J2:J32) or any range is unchanged if it spans the block.
 */
export function rewriteFormulaForSort(formula, rowMapping, blockStartRow, blockEndRow) {
    if (!formula || !formula.startsWith('=')) return formula

    const tokens = []
    const rangeRegex = /([A-Za-z0-9_]+)?\(\s*(\$?)([A-Z]+)(\$?)(\d+)\s*:\s*(\$?)([A-Z]+)(\$?)(\d+)\s*\)|(\$?)([A-Z]+)(\$?)(\d+)/g
    let lastIndex = 0
    let result = ''
    let m

    while ((m = rangeRegex.exec(formula)) !== null) {
        result += formula.slice(lastIndex, m.index)
        if (m[3] !== undefined) {
            // It's a range like SUM($J$2:$J$32) or J2:J32
            const fn = m[1] || ''
            const startColAbs = m[2], startCol = m[3], startRowAbs = m[4], startRowStr = m[5]
            const endColAbs = m[6], endCol = m[7], endRowAbs = m[8], endRowStr = m[9]
            const sRow = parseInt(startRowStr, 10) - 1
            const eRow = parseInt(endRowStr, 10) - 1
            const minR = Math.min(sRow, eRow)
            const maxR = Math.max(sRow, eRow)

            // If range spans the whole sorted block, keep it unchanged
            if (minR <= blockStartRow && maxR >= blockEndRow) {
                result += m[0]
            } else {
                // Otherwise update endpoints if mapped
                const newSRow = rowMapping.has(sRow) ? rowMapping.get(sRow) : sRow
                const newERow = rowMapping.has(eRow) ? rowMapping.get(eRow) : eRow
                if (fn) {
                    result += `${fn}(${startColAbs}${startCol}${startRowAbs}${newSRow + 1}:${endColAbs}${endCol}${endRowAbs}${newERow + 1})`
                } else {
                    result += `${startColAbs}${startCol}${startRowAbs}${newSRow + 1}:${endColAbs}${endCol}${endRowAbs}${newERow + 1}`
                }
            }
        } else {
            // Single cell reference
            const colAbs = m[10], col = m[11], rowAbs = m[12], rowStr = m[13]
            const r = parseInt(rowStr, 10) - 1
            const newR = rowMapping.has(r) ? rowMapping.get(r) : r
            result += `${colAbs}${col}${rowAbs}${newR + 1}`
        }
        lastIndex = rangeRegex.lastIndex
    }
    result += formula.slice(lastIndex)
    return result
}

// ─────────────────────────────────────────────────────────────
//  Main engine factory
// ─────────────────────────────────────────────────────────────

export function createEngine(initialRows = 50, initialCols = 50) {
    let rows = initialRows
    let cols = initialCols
    const cells = new Map()
    const rowIdentities = new Map() // row index -> stable id
    let nextRowId = 1
    const graph = createDependencyGraph()
    const dirtyCells = new Set()
    const computedCache = new Map()
    const undoStack = []
    const redoStack = []

    let _generation = 0
    let _batchMode = false
    let _batchCallbacks = []

    // ── Internal helpers ──

    function cellKey(row, col) {
        return indexToCellKey(row, col)
    }

    function cellCoords(key) {
        return parseCellKey(key)
    }

    function isValidCellKey(key) {
        const coords = cellCoords(key)
        return coords && coords.row >= 0 && coords.row < rows && coords.col >= 0 && coords.col < cols
    }

    function updateDependencies(cell, rawFormula) {
        for (const ref of extractCellReferences(rawFormula)) {
            if (isValidCellKey(ref)) graph.addDependency(cell, ref)
        }
    }

    function markCellDirty(cell) {
        dirtyCells.add(cell)
        for (const dependent of graph.getAllDependentsRecursive(cell)) {
            dirtyCells.add(dependent)
        }
    }

    function markAllCellsDirty() {
        for (const key of cells.keys()) dirtyCells.add(key)
    }

    function getRowId(r) {
        if (!rowIdentities.has(r)) {
            rowIdentities.set(r, nextRowId++)
        }
        return rowIdentities.get(r)
    }

    function ensureRowIdsUpTo(maxRow) {
        for (let r = 0; r <= maxRow; r++) {
            if (!rowIdentities.has(r)) {
                rowIdentities.set(r, nextRowId++)
            }
        }
    }

    // ── Value resolution ──

    function resolveCellValue(cellKey, visited = new Set()) {
        if (visited.has(cellKey)) return '#CYCLE!'
        visited.add(cellKey)

        if (computedCache.has(cellKey)) {
            const cached = computedCache.get(cellKey)
            if (cached._gen === _generation && !dirtyCells.has(cellKey)) {
                visited.delete(cellKey)
                return cached.error || cached.computed
            }
            computedCache.delete(cellKey)
        }

        const cell = cells.get(cellKey)
        if (!cell || !cell.raw) {
            visited.delete(cellKey)
            return ''
        }

        if (!cell.raw.startsWith('=')) {
            const numericValue = parseFloat(cell.raw)
            visited.delete(cellKey)
            return isNaN(numericValue) ? cell.raw : numericValue
        }

        const result = evaluateFormula(cell.raw, (key) => resolveCellValue(key, visited))
        visited.delete(cellKey)

        if (result.error) {
            computedCache.set(cellKey, { computed: null, error: result.error, _gen: _generation })
            return result.error
        }

        computedCache.set(cellKey, { computed: result.value, error: null, _gen: _generation })
        return result.value
    }

    // ── Recalculation ──

    function recalculate() {
        if (dirtyCells.size === 0) return

        const affected = new Set(dirtyCells)
        const sorted = graph.topologicalSort(affected)

        for (const cell of sorted) {
            if (dirtyCells.has(cell)) {
                computedCache.delete(cell)
                resolveCellValue(cell)
            }
        }
        for (const cell of affected) {
            if (!sorted.includes(cell)) {
                computedCache.delete(cell)
                resolveCellValue(cell)
            }
        }

        dirtyCells.clear()

        if (_batchMode) {
            _batchCallbacks.forEach(cb => cb())
        }
    }

    // ── Core cell operations ──

    function setCellRaw(row, col, raw) {
        const key = cellKey(row, col)
        graph.removeAllDependencies(key)
        computedCache.delete(key)

        if (!raw || raw.trim() === '') {
            cells.delete(key)
            markCellDirty(key)
            return
        }

        if (raw.startsWith('=')) {
            cells.set(key, { raw, computed: null, error: null })
            updateDependencies(key, raw)
            if (graph.hasCycle(key)) {
                graph.removeAllDependencies(key)
                cells.set(key, { raw, computed: null, error: '#CYCLE!' })
                markCellDirty(key)
                return
            }
        } else {
            cells.set(key, { raw, computed: null, error: null })
        }

        markCellDirty(key)
    }

    function getCellRaw(row, col) {
        const key = cellKey(row, col)
        const cell = cells.get(key)
        if (!cell) return { raw: '', computed: null, error: null }
        return { ...cell }
    }

    // ── Snapshot / Restore ──

    function takeSnapshot() {
        const snapshot = new Map()
        for (const [key, value] of cells.entries()) {
            snapshot.set(key, { ...value })
        }
        return snapshot
    }

    function restoreSnapshot(snapshot) {
        cells.clear()
        for (const [key, value] of snapshot.entries()) {
            cells.set(key, { ...value })
        }
        graph.clear()
        computedCache.clear()
        dirtyCells.clear()
        _generation++
        for (const [key, value] of cells.entries()) {
            if (value.raw && value.raw.startsWith('=')) updateDependencies(key, value.raw)
        }
        markAllCellsDirty()
    }

    // ── Used range & Totals row detection ──

    function getUsedRange() {
        let minR = Infinity, maxR = -1, minC = Infinity, maxC = -1
        for (const key of cells.keys()) {
            const cell = cells.get(key)
            if (cell && cell.raw && cell.raw.trim() !== '') {
                const coords = cellCoords(key)
                if (coords) {
                    if (coords.row < minR) minR = coords.row
                    if (coords.row > maxR) maxR = coords.row
                    if (coords.col < minC) minC = coords.col
                    if (coords.col > maxC) maxC = coords.col
                }
            }
        }
        if (maxR === -1) {
            return { minRow: 0, maxRow: 0, minCol: 0, maxCol: 0, hasData: false }
        }
        return { minRow: minR, maxRow: maxR, minCol: minC, maxCol: maxC, hasData: true }
    }

    function isTotalsRow(r, minCol, maxCol) {
        // AI_CONTRACT §3.1 / CHALLENGE 2:
        // "the last used row when its first non-empty cell matches /^(grand\s+)?(total|totals|subtotal|sum)\b/i"
        for (let c = minCol; c <= maxCol; c++) {
            const raw = getCellRaw(r, c).raw
            if (raw && raw.trim() !== '') {
                return /^(grand\s+)?(total|totals|subtotal|sum)\b/i.test(raw.trim())
            }
        }
        return false
    }

    // ── Sorting Implementation ──

    function getDataBlock(selection = null) {
        const used = getUsedRange()
        if (!used.hasData) return null

        let startRow, endRow, minCol, maxCol, isTotalsPinned = false

        if (selection && selection.r1 !== undefined && selection.r2 !== undefined) {
            startRow = Math.min(selection.r1, selection.r2)
            endRow = Math.max(selection.r1, selection.r2)
            minCol = Math.min(selection.c1, selection.c2)
            maxCol = Math.max(selection.c1, selection.c2)
            // Selection sort: if user selected multiple rows, row 1 of selection can be data if specified,
            // but standard behavior on sheet data block:
            // "the selection if there is one, otherwise the used range with row 1 as header and a trailing totals row pinned at the bottom"
        } else {
            // Header is row 0 (row 1 in 1-based index)
            startRow = 1 // 0-based row 1 (the 2nd row) is start of data
            endRow = used.maxRow
            minCol = 0
            maxCol = Math.max(used.maxCol, cols - 1)

            if (endRow >= startRow && isTotalsRow(endRow, 0, used.maxCol)) {
                isTotalsPinned = true
                endRow = endRow - 1
            }
        }

        return { startRow, endRow, minCol, maxCol, isTotalsPinned }
    }

    /**
     * Sorts the data block by a column index.
     * @param {number} colIndex 
     * @param {'asc'|'desc'|'original'} direction 
     * @param {Object} options { visibleRows: Set<number>|null, selection: Object|null }
     */
    function sort(colIndex, direction = 'asc', options = {}) {
        const block = getDataBlock(options.selection)
        if (!block || block.endRow < block.startRow) {
            return { reorderedCount: 0, block }
        }

        const { startRow, endRow, minCol, maxCol } = block
        ensureRowIdsUpTo(Math.max(endRow + (block.isTotalsPinned ? 1 : 0), rows - 1))

        // Determine which rows are subject to sort
        const candidateRows = []
        for (let r = startRow; r <= endRow; r++) {
            if (!options.visibleRows || options.visibleRows.has(r)) {
                candidateRows.push(r)
            }
        }

        if (candidateRows.length <= 1) {
            return { reorderedCount: 0, block }
        }

        // Snapshot current state for single-step undo
        const cellSnapshot = takeSnapshot()
        const rowIdSnapshot = new Map(rowIdentities)

        // Read values for candidate rows
        const rowEntries = candidateRows.map(r => {
            const cell = getCellForDisplay(r, colIndex)
            const val = (cell.computed !== null && cell.computed !== '') ? cell.computed : cell.raw
            const originalId = getRowId(r)
            return { r, val, originalId }
        })

        if (direction === 'original') {
            // Sort stable by originalId ascending
            rowEntries.sort((a, b) => a.originalId - b.originalId)
        } else {
            const dirMultiplier = direction === 'desc' ? -1 : 1
            // Stable sort
            rowEntries.sort((a, b) => {
                const cmp = compareValues(a.val, b.val)
                if (cmp !== 0) return cmp * dirMultiplier
                return 0 // JS sort is stable in ES2019+
            })
        }

        // Check if order actually changed
        let hasChanged = false
        for (let i = 0; i < candidateRows.length; i++) {
            if (rowEntries[i].r !== candidateRows[i]) {
                hasChanged = true
                break
            }
        }
        if (!hasChanged) {
            return { reorderedCount: 0, block }
        }

        // Build mapping: old row -> new row
        const rowMapping = new Map() // oldRow -> newRow
        const newRowOrder = [] // list of old row indices in their new positions

        for (let i = 0; i < candidateRows.length; i++) {
            const oldRow = rowEntries[i].r
            const newRow = candidateRows[i]
            rowMapping.set(oldRow, newRow)
            newRowOrder.push(oldRow)
        }

        // Perform physical row swap: extract row cells, rewrite formulas, place in new rows
        // Note: columns outside minCol..maxCol? A row reorder reorders entire row cells!
        // Requirement: "Formulas follow rows. References to moved rows point to where those rows went.
        // A range spanning the whole block (=SUM(J2:J32)) is unchanged. Styles move with their rows."
        
        // Extract all cells for candidate rows across all columns
        const extractedRows = new Map()
        for (const oldRow of candidateRows) {
            const rowData = new Map()
            for (let c = 0; c < cols; c++) {
                const rawVal = getCellRaw(oldRow, c).raw
                if (rawVal !== '') {
                    rowData.set(c, rawVal)
                }
            }
            extractedRows.set(oldRow, rowData)
        }

        // Clear affected cells in grid
        for (const r of candidateRows) {
            for (let c = 0; c < cols; c++) {
                const key = cellKey(r, c)
                cells.delete(key)
                graph.removeAllDependencies(key)
                computedCache.delete(key)
            }
        }

        // Place rows in new positions with rewritten formulas
        for (let i = 0; i < candidateRows.length; i++) {
            const newRow = candidateRows[i]
            const oldRow = newRowOrder[i]
            const rowData = extractedRows.get(oldRow)
            
            // Assign stable row id
            const oldId = rowIdSnapshot.get(oldRow)
            rowIdentities.set(newRow, oldId)

            for (const [c, rawVal] of rowData.entries()) {
                const rewrittenRaw = rewriteFormulaForSort(rawVal, rowMapping, startRow, endRow)
                const key = cellKey(newRow, c)
                cells.set(key, { raw: rewrittenRaw, computed: null, error: null })
                if (rewrittenRaw.startsWith('=')) {
                    updateDependencies(key, rewrittenRaw)
                }
            }
        }

        // Also, rewrite any formulas in un-moved rows (e.g. totals row or other rows) that referenced moved rows!
        for (const [key, cell] of cells.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            // If cell is outside candidate rows and has formula
            if (!candidateRows.includes(coords.row) && cell.raw && cell.raw.startsWith('=')) {
                const rewritten = rewriteFormulaForSort(cell.raw, rowMapping, startRow, endRow)
                if (rewritten !== cell.raw) {
                    graph.removeAllDependencies(key)
                    cells.set(key, { raw: rewritten, computed: null, error: null })
                    updateDependencies(key, rewritten)
                }
            }
        }

        _generation++
        markAllCellsDirty()
        recalculate()

        // Push undo entry
        pushToUndoStack({
            type: 'sort',
            cellSnapshot,
            rowIdSnapshot,
            rowMapping // To allow UI (styles/selection) to undo
        })

        return {
            reorderedCount: candidateRows.length,
            rowMapping,
            block
        }
    }

    // ── Structural Insert/Delete ──

    function performInsertRow(atIndex) {
        const snapshot = takeSnapshot()
        cells.clear()
        graph.clear()
        computedCache.clear()
        dirtyCells.clear()
        _generation++

        // Shift rowIdentities
        const newIdentities = new Map()
        for (const [r, id] of rowIdentities.entries()) {
            if (r >= atIndex) {
                newIdentities.set(r + 1, id)
            } else {
                newIdentities.set(r, id)
            }
        }
        rowIdentities.clear()
        for (const [r, id] of newIdentities.entries()) {
            rowIdentities.set(r, id)
        }

        for (const [key, value] of snapshot.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            if (coords.row >= atIndex) {
                const newKey = cellKey(coords.row + 1, coords.col)
                cells.set(newKey, { ...value, raw: shiftCellReferences(value.raw, 1, 0, atIndex) })
            } else {
                cells.set(key, { ...value, raw: shiftCellReferences(value.raw, 1, 0, atIndex) })
            }
        }
        rows++
        for (const [key, value] of cells.entries()) {
            if (value.raw.startsWith('=')) updateDependencies(key, value.raw)
        }
        markAllCellsDirty()
    }

    function performDeleteRow(atIndex) {
        const snapshot = takeSnapshot()
        cells.clear()
        graph.clear()
        computedCache.clear()
        dirtyCells.clear()
        _generation++

        // Shift rowIdentities
        const newIdentities = new Map()
        for (const [r, id] of rowIdentities.entries()) {
            if (r === atIndex) continue
            if (r > atIndex) {
                newIdentities.set(r - 1, id)
            } else {
                newIdentities.set(r, id)
            }
        }
        rowIdentities.clear()
        for (const [r, id] of newIdentities.entries()) {
            rowIdentities.set(r, id)
        }

        for (const [key, value] of snapshot.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            if (coords.row === atIndex) continue
            if (coords.row > atIndex) {
                const newKey = cellKey(coords.row - 1, coords.col)
                cells.set(newKey, { ...value, raw: shiftCellReferences(value.raw, -1, 0, atIndex) })
            } else {
                cells.set(key, { ...value, raw: shiftCellReferences(value.raw, -1, 0, atIndex) })
            }
        }
        rows--
        for (const [key, value] of cells.entries()) {
            if (value.raw.startsWith('=')) updateDependencies(key, value.raw)
        }
        markAllCellsDirty()
    }

    function performInsertColumn(atIndex) {
        const snapshot = takeSnapshot()
        cells.clear()
        graph.clear()
        computedCache.clear()
        dirtyCells.clear()
        _generation++

        for (const [key, value] of snapshot.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            if (coords.col >= atIndex) {
                const newKey = cellKey(coords.row, coords.col + 1)
                cells.set(newKey, { ...value, raw: shiftCellReferences(value.raw, 0, 1, atIndex, true) })
            } else {
                cells.set(key, { ...value, raw: shiftCellReferences(value.raw, 0, 1, atIndex, true) })
            }
        }
        cols++
        for (const [key, value] of cells.entries()) {
            if (value.raw.startsWith('=')) updateDependencies(key, value.raw)
        }
        markAllCellsDirty()
    }

    function performDeleteColumn(atIndex) {
        const snapshot = takeSnapshot()
        cells.clear()
        graph.clear()
        computedCache.clear()
        dirtyCells.clear()
        _generation++

        for (const [key, value] of snapshot.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            if (coords.col === atIndex) continue
            if (coords.col > atIndex) {
                const newKey = cellKey(coords.row, coords.col - 1)
                cells.set(newKey, { ...value, raw: shiftCellReferences(value.raw, 0, -1, atIndex, true) })
            } else {
                cells.set(key, { ...value, raw: shiftCellReferences(value.raw, 0, -1, atIndex, true) })
            }
        }
        cols--
        for (const [key, value] of cells.entries()) {
            if (value.raw.startsWith('=')) updateDependencies(key, value.raw)
        }
        markAllCellsDirty()
    }

    // ── Undo / Redo ──

    function pushToUndoStack(entry) {
        undoStack.push({ ...entry, _gen: _generation })
        if (undoStack.length > MAX_UNDO_HISTORY) undoStack.shift()
        redoStack.length = 0
    }

    function executeSetCell(row, col, value) {
        const previousValue = getCellRaw(row, col).raw
        if (previousValue !== value) {
            pushToUndoStack({ type: 'set', r: row, c: col, oldVal: previousValue, newVal: value })
        }
        setCellRaw(row, col, value)
        _generation++
        recalculate()
    }

    function executeInsertRow(atIndex) {
        const snapshot = takeSnapshot()
        const previousRows = rows
        pushToUndoStack({ type: 'rowins', snap: snapshot, oldRows: previousRows, rowIdSnap: new Map(rowIdentities) })
        performInsertRow(atIndex)
        recalculate()
    }

    function executeDeleteRow(atIndex) {
        const snapshot = takeSnapshot()
        const previousRows = rows
        pushToUndoStack({ type: 'rowdel', snap: snapshot, oldRows: previousRows, rowIdSnap: new Map(rowIdentities) })
        performDeleteRow(atIndex)
        recalculate()
    }

    function executeInsertColumn(atIndex) {
        const snapshot = takeSnapshot()
        const previousCols = cols
        pushToUndoStack({ type: 'colins', snap: snapshot, oldCols: previousCols })
        performInsertColumn(atIndex)
        recalculate()
    }

    function executeDeleteColumn(atIndex) {
        const snapshot = takeSnapshot()
        const previousCols = cols
        pushToUndoStack({ type: 'coldel', snap: snapshot, oldCols: previousCols })
        performDeleteColumn(atIndex)
        recalculate()
    }

    function undo() {
        if (undoStack.length === 0) return null
        const entry = undoStack.pop()

        if (entry.type === 'set') {
            const currentValue = getCellRaw(entry.r, entry.c).raw
            redoStack.push({ ...entry, newVal: currentValue })
            setCellRaw(entry.r, entry.c, entry.oldVal)
            _generation++
            recalculate()
            return { type: 'set', r: entry.r, c: entry.c }
        } else if (entry.type === 'sort') {
            // Restore sort
            const currentCellSnap = takeSnapshot()
            const currentRowIdSnap = new Map(rowIdentities)
            redoStack.push({
                type: 'sort',
                cellSnapshot: currentCellSnap,
                rowIdSnapshot: currentRowIdSnap,
                rowMapping: entry.rowMapping
            })
            restoreSnapshot(entry.cellSnapshot)
            rowIdentities.clear()
            for (const [r, id] of entry.rowIdSnapshot.entries()) {
                rowIdentities.set(r, id)
            }
            recalculate()
            return { type: 'sort', rowMapping: entry.rowMapping, undo: true }
        } else {
            redoStack.push({
                ...entry,
                restoreSnap: takeSnapshot(),
                restoreRows: rows,
                restoreCols: cols,
                restoreRowIdSnap: new Map(rowIdentities)
            })
            restoreSnapshot(entry.snap)
            if (entry.rowIdSnap) {
                rowIdentities.clear()
                for (const [r, id] of entry.rowIdSnap.entries()) {
                    rowIdentities.set(r, id)
                }
            }
            if (entry.type === 'rowins' || entry.type === 'rowdel') rows = entry.oldRows
            else if (entry.type === 'colins' || entry.type === 'coldel') cols = entry.oldCols
            recalculate()
            return { type: entry.type }
        }
    }

    function redo() {
        if (redoStack.length === 0) return null
        const entry = redoStack.pop()

        if (entry.type === 'set') {
            const currentValue = getCellRaw(entry.r, entry.c).raw
            undoStack.push({ ...entry, oldVal: currentValue })
            setCellRaw(entry.r, entry.c, entry.newVal)
            _generation++
            recalculate()
            return { type: 'set', r: entry.r, c: entry.c }
        } else if (entry.type === 'sort') {
            const currentCellSnap = takeSnapshot()
            const currentRowIdSnap = new Map(rowIdentities)
            undoStack.push({
                type: 'sort',
                cellSnapshot: currentCellSnap,
                rowIdSnapshot: currentRowIdSnap,
                rowMapping: entry.rowMapping
            })
            restoreSnapshot(entry.cellSnapshot)
            rowIdentities.clear()
            for (const [r, id] of entry.rowIdSnapshot.entries()) {
                rowIdentities.set(r, id)
            }
            recalculate()
            return { type: 'sort', rowMapping: entry.rowMapping, redo: true }
        } else {
            undoStack.push({
                ...entry,
                snap: takeSnapshot(),
                oldRows: rows,
                oldCols: cols,
                rowIdSnap: new Map(rowIdentities)
            })
            restoreSnapshot(entry.restoreSnap)
            if (entry.restoreRowIdSnap) {
                rowIdentities.clear()
                for (const [r, id] of entry.restoreRowIdSnap.entries()) {
                    rowIdentities.set(r, id)
                }
            }
            rows = entry.restoreRows
            cols = entry.restoreCols
            recalculate()
            return { type: entry.type }
        }
    }

    // ── Public cell display ──

    function getCellForDisplay(row, col) {
        const cell = getCellRaw(row, col)
        const key = cellKey(row, col)
        const value = resolveCellValue(key)

        if (typeof value === 'string' && value.startsWith('#')) {
            return { raw: cell.raw, computed: null, error: value }
        }
        return { raw: cell.raw, computed: value, error: null }
    }

    return {
        get rows() { return rows },
        get cols() { return cols },
        getCell: getCellForDisplay,
        setCell: executeSetCell,
        insertRow: executeInsertRow,
        deleteRow: executeDeleteRow,
        insertColumn: executeInsertColumn,
        deleteColumn: executeDeleteColumn,
        undo,
        redo,
        canUndo: () => undoStack.length > 0,
        canRedo: () => redoStack.length > 0,
        ensureCapacity: (minRows, minCols) => {
            if (minRows > rows) rows = minRows
            if (minCols > cols) cols = minCols
        },
        // Sort & Filter API additions
        sort,
        getDataBlock,
        getUsedRange,
        getRowId,
        isTotalsRow: (r) => {
            const used = getUsedRange()
            return isTotalsRow(r, 0, used.maxCol)
        }
    }
}
