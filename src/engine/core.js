import { createDimensionManager } from './dimensions.js'

// ─────────────────────────────────────────────────────────────
//  Operator precedence for expression parsing
// ─────────────────────────────────────────────────────────────

const OPERATOR_PRECEDENCE = { '+': 1, '-': 1, '*': 2, '/': 2 }
const MAX_UNDO_HISTORY = 100


// ─────────────────────────────────────────────────────────────
//  Column / Cell coordinate utilities
// ─────────────────────────────────────────────────────────────

function columnLetterToIndex(columnLetter) {
    let index = 0
    for (let i = 0; i < columnLetter.length; i++) {
        index = index * 26 + (columnLetter.charCodeAt(i) - 64)
    }
    return index - 1
}

function indexToCellKey(row, col) {
    let columnLabel = ''
    let colNumber = col + 1
    while (colNumber > 0) {
        colNumber--
        columnLabel = String.fromCharCode(65 + (colNumber % 26)) + columnLabel
        colNumber = Math.floor(colNumber / 26)
    }
    return columnLabel + (row + 1)
}

function parseCellKey(cellKey) {
    const match = cellKey.match(/^(\$?)([A-Z]+)(\$?)([0-9]+)$/)
    if (!match) return null
    return {
        row: parseInt(match[4], 10) - 1,
        col: columnLetterToIndex(match[2]),
        colAbs: match[1] === '$',
        rowAbs: match[3] === '$'
    }
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
//  Tokenizer — converts formula string into tokens
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

        if (char === '$' || (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z')) {
            let identifier = ''
            while (position < expression.length && (
                expression[position] === '$' ||
                (expression[position] >= 'A' && expression[position] <= 'Z') ||
                (expression[position] >= 'a' && expression[position] <= 'z') ||
                (expression[position] >= '0' && expression[position] <= '9')
            )) {
                identifier += expression[position].toUpperCase()
                position++
            }
            if (position < expression.length && expression[position] === ':') {
                tokens.push({ type: 'cell', value: identifier })
            } else {
                const cellMatch = identifier.match(/^(\$?)([A-Z]+)(\$?)([0-9]+)$/)
                if (cellMatch) {
                    tokens.push({ type: 'cell', value: identifier })
                } else if (!identifier.includes('$')) {
                    tokens.push({ type: 'function', value: identifier })
                } else {
                    throw new Error(`Invalid identifier: ${identifier}`)
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

function expandCellRange(startKey, endKey) {
    const startMatch = startKey.match(/^(\$?)([A-Z]+)(\$?)([0-9]+)$/)
    const endMatch = endKey.match(/^(\$?)([A-Z]+)(\$?)([0-9]+)$/)
    if (!startMatch || !endMatch) throw new Error('REF')

    const startCol = columnLetterToIndex(startMatch[2])
    const startRow = parseInt(startMatch[4], 10) - 1
    const endCol = columnLetterToIndex(endMatch[2])
    const endRow = parseInt(endMatch[4], 10) - 1

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
        const key = ast.value.replace(/\$/g, '')
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
            const num = parseFloat(value)
            return isNaN(num) ? 0 : num
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
//  Reference shifting (for insert/delete row/col)
// ─────────────────────────────────────────────────────────────

function shiftCellReferences(formula, rowShift, colShift, atIndex, isColumnOperation = false) {
    if (!formula || !formula.startsWith('=')) return formula

    return formula.replace(/(\$?)([A-Z]+)(\$?)([0-9]+)/g, (match, colDol, colLetter, rowDol, rowStr) => {
        const isColAbs = colDol === '$'
        const isRowAbs = rowDol === '$'
        const colIdx = columnLetterToIndex(colLetter)
        const rowIdx = parseInt(rowStr, 10) - 1
        let newRow = rowIdx
        let newCol = colIdx

        if (isColumnOperation) {
            // If column is relative, shift if at or after insertion/deletion point
            if (!isColAbs && colIdx >= atIndex) {
                newCol = colIdx + colShift
            }
        } else {
            // If row is relative, shift if at or after insertion/deletion point
            if (!isRowAbs && rowIdx >= atIndex) {
                newRow = rowIdx + rowShift
            }
        }

        if (newRow < 0 || newCol < 0) return match
        const baseKey = indexToCellKey(newRow, newCol)
        const parsed = parseCellKey(baseKey)
        let colLabel = ''
        let colNum = parsed.col + 1
        while (colNum > 0) {
            colNum--
            colLabel = String.fromCharCode(65 + (colNum % 26)) + colLabel
            colNum = Math.floor(colNum / 26)
        }
        return `${isColAbs ? '$' : ''}${colLabel}${isRowAbs ? '$' : ''}${parsed.row + 1}`
    })
}

function extractCellReferences(formula) {
    const references = new Set()
    const regex = /(\$?)([A-Z]+)(\$?)([0-9]+)/g
    let match
    while ((match = regex.exec(formula)) !== null) {
        references.add(match[2] + match[4])
    }
    return references
}

// ─────────────────────────────────────────────────────────────
//  Main engine factory
// ─────────────────────────────────────────────────────────────

export function createEngine(initialRows = 50, initialCols = 50) {
    let rows = initialRows
    let cols = initialCols
    const rowHeights = createDimensionManager(initialRows, 25, 20)
    const colWidths = createDimensionManager(initialCols, 100, 30)

    const cells = new Map()
    const cellStyles = new Map() // key "r,c" -> style object
    let frozenRows = 1 // default frozen header row
    const graph = createDependencyGraph()
    const dirtyCells = new Set()
    const computedCache = new Map()
    const undoStack = []
    const redoStack = []

    // Internal generation counter — incremented on every structural mutation.
    // Used by the cache to validate entries and by the engine to track state integrity.
    let _generation = 0
    let _batchMode = false
    let _batchCallbacks = []
    let _styleChangeListeners = new Set()

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
        // Extract all cell references from the formula
        // Note: This includes references in ranges (e.g., A1:A5 includes A1, A2, A3, A4, A5)
        // but the current implementation only tracks the range endpoints
        for (const ref of extractCellReferences(rawFormula)) {
            if (isValidCellKey(ref)) graph.addDependency(cell, ref)
        }
        // TODO: Consider tracking individual cells within ranges for more granular dependency tracking
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

    // ── Value resolution ──

    function resolveCellValue(cellKey, visited = new Set()) {
        if (visited.has(cellKey)) return '#CYCLE!'
        visited.add(cellKey)

        if (computedCache.has(cellKey)) {
            const cached = computedCache.get(cellKey)
            // Validate cache generation — stale entries from a previous generation are discarded
            // Note: _generation is incremented on structural changes, but cache validation
            // must account for cells that may have been invalidated by dependency changes
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

        // Process sorted cells first (topological order ensures dependencies are resolved)
        for (const cell of sorted) {
            if (dirtyCells.has(cell)) {
                computedCache.delete(cell)
                resolveCellValue(cell)
            }
        }
        // Process any remaining affected cells that weren't in the sorted list
        // (e.g., cells with no dependencies or circular dependencies)
        for (const cell of affected) {
            if (!sorted.includes(cell)) {
                computedCache.delete(cell)
                resolveCellValue(cell)
            }
        }

        dirtyCells.clear()

        // Notify batch listeners if in batch mode
        // WARNING: Batch mode is currently unused but may be needed for future features
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

    // ── Snapshot / Restore (for undo of structural changes) ──

    function takeSnapshot() {
        // Create a deep copy of all cell data and styles for undo/redo operations
        const snapshot = new Map()
        for (const [key, value] of cells.entries()) {
            snapshot.set(key, { ...value })
        }
        const styleSnapshot = new Map()
        for (const [key, value] of cellStyles.entries()) {
            styleSnapshot.set(key, { ...value })
        }
        return {
            cells: snapshot,
            styles: styleSnapshot,
            frozenRows
        }
    }

    function restoreSnapshot(snapObj) {
        // Handle both older snapshots (Map) and new object snapshots ({ cells, styles, frozenRows })
        const cellMap = (snapObj && snapObj.cells) ? snapObj.cells : snapObj
        const styleMap = (snapObj && snapObj.styles) ? snapObj.styles : null

        cells.clear()
        for (const [key, value] of cellMap.entries()) {
            cells.set(key, { ...value })
        }

        cellStyles.clear()
        if (styleMap) {
            for (const [key, value] of styleMap.entries()) {
                cellStyles.set(key, { ...value })
            }
        }
        if (snapObj && typeof snapObj.frozenRows === 'number') {
            frozenRows = snapObj.frozenRows
        }

        graph.clear()
        computedCache.clear()
        dirtyCells.clear()
        _generation++
        // Rebuild dependency graph from restored cells
        for (const [key, value] of cells.entries()) {
            if (value.raw && value.raw.startsWith('=')) updateDependencies(key, value.raw)
        }
        markAllCellsDirty()
    }

    // ── Row / Column structural operations ──

    function performInsertRow(atIndex) {
        const snapshot = takeSnapshot()
        cells.clear()
        cellStyles.clear()
        graph.clear()
        computedCache.clear()
        dirtyCells.clear()
        _generation++

        for (const [key, value] of snapshot.cells.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            if (coords.row >= atIndex) {
                const newKey = cellKey(coords.row + 1, coords.col)
                cells.set(newKey, { ...value, raw: shiftCellReferences(value.raw, 1, 0, atIndex) })
            } else {
                cells.set(key, { ...value, raw: shiftCellReferences(value.raw, 1, 0, atIndex) })
            }
        }
        for (const [key, value] of snapshot.styles.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            if (coords.row >= atIndex) {
                const newKey = cellKey(coords.row + 1, coords.col)
                cellStyles.set(newKey, { ...value })
            } else {
                cellStyles.set(key, { ...value })
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
        cellStyles.clear()
        graph.clear()
        computedCache.clear()
        dirtyCells.clear()
        _generation++

        for (const [key, value] of snapshot.cells.entries()) {
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
        for (const [key, value] of snapshot.styles.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            if (coords.row === atIndex) continue
            if (coords.row > atIndex) {
                const newKey = cellKey(coords.row - 1, coords.col)
                cellStyles.set(newKey, { ...value })
            } else {
                cellStyles.set(key, { ...value })
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
        cellStyles.clear()
        graph.clear()
        computedCache.clear()
        dirtyCells.clear()
        _generation++

        for (const [key, value] of snapshot.cells.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            if (coords.col >= atIndex) {
                const newKey = cellKey(coords.row, coords.col + 1)
                cells.set(newKey, { ...value, raw: shiftCellReferences(value.raw, 0, 1, atIndex, true) })
            } else {
                cells.set(key, { ...value, raw: shiftCellReferences(value.raw, 0, 1, atIndex, true) })
            }
        }
        for (const [key, value] of snapshot.styles.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            if (coords.col >= atIndex) {
                const newKey = cellKey(coords.row, coords.col + 1)
                cellStyles.set(newKey, { ...value })
            } else {
                cellStyles.set(key, { ...value })
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
        cellStyles.clear()
        graph.clear()
        computedCache.clear()
        dirtyCells.clear()
        _generation++

        for (const [key, value] of snapshot.cells.entries()) {
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
        for (const [key, value] of snapshot.styles.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            if (coords.col === atIndex) continue
            if (coords.col > atIndex) {
                const newKey = cellKey(coords.row, coords.col - 1)
                cellStyles.set(newKey, { ...value })
            } else {
                cellStyles.set(key, { ...value })
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
        // Only create undo entry if value actually changed
        // This prevents undo stack pollution with no-op edits
        if (previousValue !== value) {
            pushToUndoStack({ type: 'set', r: row, c: col, oldVal: previousValue, newVal: value })
        }
        setCellRaw(row, col, value)
        _generation++
        recalculate()
    }

    function executeSetRowHeight(row, height) {
        if (row < 0 || row >= rows) return
        const oldHeight = rowHeights.getSize(row)
        const targetHeight = Math.max(rowHeights.minSize, Math.round(height))
        if (oldHeight === targetHeight) return
        pushToUndoStack({ type: 'rowheight', row, oldHeight, newHeight: targetHeight })
        rowHeights.setSize(row, targetHeight)
        _generation++
    }

    function executeSetColumnWidth(col, width) {
        if (col < 0 || col >= cols) return
        const oldWidth = colWidths.getSize(col)
        const targetWidth = Math.max(colWidths.minSize, Math.round(width))
        if (oldWidth === targetWidth) return
        pushToUndoStack({ type: 'colwidth', col, oldWidth, newWidth: targetWidth })
        colWidths.setSize(col, targetWidth)
        _generation++
    }

    function executeInsertRow(atIndex) {
        const snapshot = takeSnapshot()
        const previousRows = rows
        const previousRowHeights = rowHeights.snapshot()
        pushToUndoStack({
            type: 'rowins',
            snap: snapshot,
            oldRows: previousRows,
            oldRowHeights: previousRowHeights
        })
        rowHeights.insertAt(atIndex)
        performInsertRow(atIndex)
        recalculate()
    }

    function executeDeleteRow(atIndex) {
        const snapshot = takeSnapshot()
        const previousRows = rows
        const previousRowHeights = rowHeights.snapshot()
        pushToUndoStack({
            type: 'rowdel',
            snap: snapshot,
            oldRows: previousRows,
            oldRowHeights: previousRowHeights
        })
        rowHeights.deleteAt(atIndex)
        performDeleteRow(atIndex)
        recalculate()
    }

    function executeInsertColumn(atIndex) {
        const snapshot = takeSnapshot()
        const previousCols = cols
        const previousColWidths = colWidths.snapshot()
        pushToUndoStack({
            type: 'colins',
            snap: snapshot,
            oldCols: previousCols,
            oldColWidths: previousColWidths
        })
        colWidths.insertAt(atIndex)
        performInsertColumn(atIndex)
        recalculate()
    }

    function executeDeleteColumn(atIndex) {
        const snapshot = takeSnapshot()
        const previousCols = cols
        const previousColWidths = colWidths.snapshot()
        pushToUndoStack({
            type: 'coldel',
            snap: snapshot,
            oldCols: previousCols,
            oldColWidths: previousColWidths
        })
        colWidths.deleteAt(atIndex)
        performDeleteColumn(atIndex)
        recalculate()
    }

    function undo() {
        if (undoStack.length === 0) return false
        const entry = undoStack.pop()

        if (entry.type === 'set') {
            const currentValue = getCellRaw(entry.r, entry.c).raw
            redoStack.push({ ...entry, newVal: currentValue })
            setCellRaw(entry.r, entry.c, entry.oldVal)
            _generation++
            recalculate()
        } else if (entry.type === 'batch_set') {
            const currentCells = entry.cells.map(({ r, c }) => ({
                r, c, val: getCellRaw(r, c).raw
            }))
            redoStack.push({ type: 'batch_set', cells: currentCells })
            for (const { r, c, oldVal } of entry.cells) {
                setCellRaw(r, c, oldVal)
            }
            _generation++
            recalculate()
        } else if (entry.type === 'rowheight') {
            const currentHeight = rowHeights.getSize(entry.row)
            redoStack.push({ ...entry, newHeight: currentHeight })
            rowHeights.setSize(entry.row, entry.oldHeight)
            _generation++
        } else if (entry.type === 'colwidth') {
            const currentWidth = colWidths.getSize(entry.col)
            redoStack.push({ ...entry, newWidth: currentWidth })
            colWidths.setSize(entry.col, entry.oldWidth)
            _generation++
        } else if (entry.type === 'format_batch') {
            // Restore previous styles
            for (const { key, oldStyle } of entry.styles) {
                if (oldStyle && Object.keys(oldStyle).length > 0) {
                    cellStyles.set(key, { ...oldStyle })
                } else {
                    cellStyles.delete(key)
                }
            }
            // Restore previous frozen rows
            if (entry.freezeRows) {
                frozenRows = entry.freezeRows.oldVal
            }
            // Restore previous column widths
            if (entry.columnWidths) {
                for (const { col, oldWidth } of entry.columnWidths) {
                    colWidths.setSize(col, oldWidth)
                }
            }
            redoStack.push({ ...entry })
            _generation++
            notifyStyleChange()
        } else {
            redoStack.push({
                ...entry,
                restoreSnap: takeSnapshot(),
                restoreRows: rows,
                restoreCols: cols,
                restoreRowHeights: rowHeights.snapshot(),
                restoreColWidths: colWidths.snapshot()
            })
            restoreSnapshot(entry.snap)
            if (entry.type === 'rowins' || entry.type === 'rowdel') {
                rows = entry.oldRows
                if (entry.oldRowHeights) rowHeights.restore(entry.oldRowHeights)
            } else if (entry.type === 'colins' || entry.type === 'coldel') {
                cols = entry.oldCols
                if (entry.oldColWidths) colWidths.restore(entry.oldColWidths)
            }
            recalculate()
            notifyStyleChange()
        }
        return true
    }

    function redo() {
        if (redoStack.length === 0) return false
        const entry = redoStack.pop()

        if (entry.type === 'set') {
            const currentValue = getCellRaw(entry.r, entry.c).raw
            undoStack.push({ ...entry, oldVal: currentValue })
            setCellRaw(entry.r, entry.c, entry.newVal)
            _generation++
            recalculate()
        } else if (entry.type === 'batch_set') {
            const currentCells = entry.cells.map(({ r, c }) => ({
                r, c, oldVal: getCellRaw(r, c).raw
            }))
            undoStack.push({ type: 'batch_set', cells: currentCells })
            for (const { r, c, val } of entry.cells) {
                setCellRaw(r, c, val)
            }
            _generation++
            recalculate()
        } else if (entry.type === 'rowheight') {
            const currentHeight = rowHeights.getSize(entry.row)
            undoStack.push({ ...entry, oldHeight: currentHeight })
            rowHeights.setSize(entry.row, entry.newHeight)
            _generation++
        } else if (entry.type === 'colwidth') {
            const currentWidth = colWidths.getSize(entry.col)
            undoStack.push({ ...entry, oldWidth: currentWidth })
            colWidths.setSize(entry.col, entry.newWidth)
            _generation++
        } else if (entry.type === 'format_batch') {
            // Re-apply new styles
            for (const { key, newStyle } of entry.styles) {
                if (newStyle && Object.keys(newStyle).length > 0) {
                    cellStyles.set(key, { ...newStyle })
                } else {
                    cellStyles.delete(key)
                }
            }
            // Re-apply new frozen rows
            if (entry.freezeRows) {
                frozenRows = entry.freezeRows.newVal
            }
            // Re-apply new column widths
            if (entry.columnWidths) {
                for (const { col, newWidth } of entry.columnWidths) {
                    colWidths.setSize(col, newWidth)
                }
            }
            undoStack.push({ ...entry })
            _generation++
            notifyStyleChange()
        } else {
            undoStack.push({
                ...entry,
                snap: takeSnapshot(),
                oldRows: rows,
                oldCols: cols,
                oldRowHeights: rowHeights.snapshot(),
                oldColWidths: colWidths.snapshot()
            })
            restoreSnapshot(entry.restoreSnap)
            rows = entry.restoreRows
            cols = entry.restoreCols
            if (entry.restoreRowHeights) rowHeights.restore(entry.restoreRowHeights)
            if (entry.restoreColWidths) colWidths.restore(entry.restoreColWidths)
            recalculate()
            notifyStyleChange()
        }
        return true
    }

    function getUsedRange() {
        if (cells.size === 0) return { minRow: 0, minCol: 0, maxRow: -1, maxCol: -1 }
        let minRow = Infinity, minCol = Infinity, maxRow = -1, maxCol = -1
        for (const [key, cell] of cells.entries()) {
            if (!cell || (!cell.raw && cell.computed === null)) continue
            const coords = cellCoords(key)
            if (!coords) continue
            if (coords.row < minRow) minRow = coords.row
            if (coords.row > maxRow) maxRow = coords.row
            if (coords.col < minCol) minCol = coords.col
            if (coords.col > maxCol) maxCol = coords.col
        }
        if (maxRow === -1) return { minRow: 0, minCol: 0, maxRow: -1, maxCol: -1 }
        return { minRow, minCol, maxRow, maxCol }
    }

    /**
     * Inserts a 2D matrix of values starting at (startRow, startCol).
     * Reverts all written cells in one undo step.
     */
    function executeInsertValues(startRow, startCol, matrix) {
        if (!matrix || matrix.length === 0) return
        const matrixRows = matrix.length
        const matrixCols = Math.max(...matrix.map(r => (Array.isArray(r) ? r.length : 1)))
        
        // Ensure capacity
        if (startRow + matrixRows > rows || startCol + matrixCols > cols) {
            const newRows = Math.max(rows, startRow + matrixRows + 10)
            const newCols = Math.max(cols, startCol + matrixCols + 10)
            rows = newRows
            rowHeights.ensureCount(newRows)
            cols = newCols
            colWidths.ensureCount(newCols)
        }

        const undoRecord = []
        for (let r = 0; r < matrixRows; r++) {
            const rowData = matrix[r]
            if (!Array.isArray(rowData)) continue
            for (let c = 0; c < rowData.length; c++) {
                const targetR = startRow + r
                const targetC = startCol + c
                const oldVal = getCellRaw(targetR, targetC).raw
                const newVal = String(rowData[c] ?? '')
                if (oldVal !== newVal) {
                    undoRecord.push({ r: targetR, c: targetC, oldVal, newVal })
                    setCellRaw(targetR, targetC, newVal)
                }
            }
        }

        if (undoRecord.length > 0) {
            pushToUndoStack({ type: 'batch_set', cells: undoRecord })
        }
        _generation++
        recalculate()
    }

    function notifyStyleChange() {
        for (const cb of _styleChangeListeners) {
            try { cb() } catch {}
        }
    }

    function getCellStyle(row, col) {
        const key = `${row},${col}`
        const st = cellStyles.get(key)
        return st ? { ...st } : {
            bold: false,
            italic: false,
            underline: false,
            bg: 'white',
            color: '#202124',
            align: 'left',
            fontSize: 13,
            numberFormat: 'general'
        }
    }

    function setCellStyle(row, col, patch) {
        const key = `${row},${col}`
        const cur = getCellStyle(row, col)
        const updated = { ...cur, ...patch }
        const oldStyle = cellStyles.get(key) ? { ...cellStyles.get(key) } : null

        pushToUndoStack({
            type: 'format_batch',
            styles: [{ key, oldStyle, newStyle: updated }],
            freezeRows: null,
            columnWidths: null
        })

        cellStyles.set(key, updated)
        _generation++
        notifyStyleChange()
    }

    function applyFormatBatch(batch) {
        const undoRecord = []
        if (batch.styles) {
            for (const [key, { oldStyle, newStyle }] of batch.styles.entries()) {
                undoRecord.push({ key, oldStyle, newStyle })
                cellStyles.set(key, { ...newStyle })
            }
        }

        if (batch.freezeRows) {
            frozenRows = batch.freezeRows.newVal
        }

        if (batch.columnWidths) {
            for (const { col, newWidth } of batch.columnWidths) {
                colWidths.setSize(col, newWidth)
            }
        }

        pushToUndoStack({
            type: 'format_batch',
            styles: undoRecord,
            freezeRows: batch.freezeRows,
            columnWidths: batch.columnWidths
        })

        _generation++
        notifyStyleChange()
    }

    function getAllCellStyles() {
        const res = {}
        for (const [key, style] of cellStyles.entries()) {
            res[key] = { ...style }
        }
        return res
    }

    function setFrozenRows(num) {
        if (num === frozenRows) return
        const oldVal = frozenRows
        pushToUndoStack({
            type: 'format_batch',
            styles: [],
            freezeRows: { oldVal, newVal: num },
            columnWidths: null
        })
        frozenRows = num
        _generation++
        notifyStyleChange()
    }

    // ── Public cell display (returns raw + computed + error) ──

    function getCellForDisplay(row, col) {
        const cell = getCellRaw(row, col)
        const key = cellKey(row, col)
        const value = resolveCellValue(key)

        if (typeof value === 'string' && value.startsWith('#')) {
            return { raw: cell.raw, computed: null, error: value }
        }
        return { raw: cell.raw, computed: value, error: null }
    }

    // ── Public API ──

    return {
        get rows() { return rows },
        get cols() { return cols },
        getCell: getCellForDisplay,
        setCell: executeSetCell,
        insertValues: executeInsertValues,
        getUsedRange,
        insertRow: executeInsertRow,
        deleteRow: executeDeleteRow,
        insertColumn: executeInsertColumn,
        deleteColumn: executeDeleteColumn,
        undo,
        redo,
        canUndo: () => undoStack.length > 0,
        canRedo: () => redoStack.length > 0,
        ensureCapacity: (minRows, minCols) => {
            if (minRows > rows) {
                rows = minRows
                rowHeights.ensureCount(minRows)
            }
            if (minCols > cols) {
                cols = minCols
                colWidths.ensureCount(minCols)
            }
        },
        // Styling and formatting API
        getCellStyle,
        setCellStyle,
        getAllCellStyles,
        applyFormatBatch,
        getFrozenRows: () => frozenRows,
        setFrozenRows,
        subscribeStyles: (listener) => {
            _styleChangeListeners.add(listener)
            return () => _styleChangeListeners.delete(listener)
        },
        // Dimension methods for virtualization & resizing
        rowHeights,
        colWidths,
        getRowHeight: (r) => rowHeights.getSize(r),
        setRowHeight: executeSetRowHeight,
        getColumnWidth: (c) => colWidths.getSize(c),
        setColumnWidth: executeSetColumnWidth,
        getRowOffset: (r) => rowHeights.getOffset(r),
        getColumnOffset: (c) => colWidths.getOffset(c),
        getTotalHeight: () => rowHeights.getTotalSize(),
        getTotalWidth: () => colWidths.getTotalSize(),
        findRowAtOffset: (y) => rowHeights.findIndexAtOffset(y),
        findColumnAtOffset: (x) => colWidths.findIndexAtOffset(x),
        getVisibleRowRange: (start, end, overscan) => rowHeights.getVisibleRange(start, end, overscan),
        getVisibleColumnRange: (start, end, overscan) => colWidths.getVisibleRange(start, end, overscan)
    }
}

