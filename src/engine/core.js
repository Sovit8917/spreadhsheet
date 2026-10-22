// ─────────────────────────────────────────────────────────────
//  Operator precedence for expression parsing
// ─────────────────────────────────────────────────────────────

const OPERATOR_PRECEDENCE = { '+': 1, '-': 1, '*': 2, '/': 2 }
const MAX_UNDO_HISTORY = 100

import {
    columnLetterToIndex,
    indexToCellKey,
    parseCellKey,
    shiftReferencesForStructure,
    extractCellReferences,
    normalizeRange,
} from './refs.js'
import { buildFillValues } from './fill.js'

// Default cell style. Cells with no entry in the style store render with this.
export const DEFAULT_STYLE = Object.freeze({
    bold: false, italic: false, underline: false,
    bg: 'white', color: '#202124', align: 'left', fontSize: 13,
})

// A cell value counts as a number only if the WHOLE string is numeric.
// (parseFloat("2024-01-03") is 2024 and parseFloat("1/8/2024") is 1, which
// made date cells evaluate to garbage.)
const STRICT_NUMBER = /^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?\s*$/
function toStrictNumber(raw) {
    return STRICT_NUMBER.test(raw) ? Number(raw) : NaN
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

    // Removes the edges FROM `cell` (what it reads). Edges from other cells
    // that read `cell` are kept: they are still valid when `cell` changes.
    function removeAllDependencies(cell) {
        const deps = forwardEdges.get(cell)
        if (deps) {
            for (const dep of deps) {
                const rev = reverseEdges.get(dep)
                if (rev) {
                    rev.delete(cell)
                    if (rev.size === 0) reverseEdges.delete(dep)
                }
            }
            forwardEdges.delete(cell)
        }
    }

    function getDependencies(cell) {
        return forwardEdges.get(cell) || new Set()
    }

    function getDependents(cell) {
        return reverseEdges.get(cell) || new Set()
    }

    // Iterative (no recursion limit on long chains) and one shared result set.
    function getAllDependentsRecursive(cell) {
        const result = new Set()
        const stack = [cell]
        while (stack.length > 0) {
            const current = stack.pop()
            for (const dependent of getDependents(current)) {
                if (!result.has(dependent)) {
                    result.add(dependent)
                    stack.push(dependent)
                }
            }
        }
        return result
    }

    // A cycle through `cell` exists iff one of the cells it reads (or itself)
    // also depends on it. Walking dependents instead of dependencies is O(1)
    // while a chain is being filled top-down (nothing depends on the new cell
    // yet), where walking dependencies was O(chain length) per cell.
    function hasCycle(startCell) {
        const deps = getDependencies(startCell)
        if (deps.size === 0) return false
        if (deps.has(startCell)) return true
        const dependents = getAllDependentsRecursive(startCell)
        if (dependents.size === 0) return false
        for (const dep of deps) if (dependents.has(dep)) return true
        return false
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
        for (let head = 0; head < queue.length; head++) {
            const cell = queue[head]
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

const CELL_TOKEN = /\$?[A-Za-z]+\$?\d+(?![A-Za-z0-9(])/y

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

        if (char === '#') throw new Error('REF')

        if ((char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char === '$') {
            // A1, $A1, A$1, $A$1 (a pinned reference evaluates like a plain one)
            CELL_TOKEN.lastIndex = position
            const cellMatch = CELL_TOKEN.exec(expression)
            if (cellMatch) {
                tokens.push({ type: 'cell', value: cellMatch[0].replace(/\$/g, '').toUpperCase() })
                position += cellMatch[0].length
                continue
            }
            let identifier = ''
            while (position < expression.length && ((expression[position] >= 'A' && expression[position] <= 'Z') || (expression[position] >= 'a' && expression[position] <= 'z') || (expression[position] >= '0' && expression[position] <= '9'))) {
                identifier += expression[position].toUpperCase()
                position++
            }
            if (identifier === '') throw new Error(`Unexpected character: ${char}`)
            tokens.push({ type: 'function', value: identifier })
            continue
        }

        throw new Error(`Unexpected character: ${char}`)
    }

    return tokens
}

// ─────────────────────────────────────────────────────────────
//  Parser — converts tokens into an AST using shunting-yard
// ─────────────────────────────────────────────────────────────

function mergeRanges(tokens) {
    const merged = []
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]
        if (token.type === 'cell' && tokens[i + 1]?.type === 'range') {
            const end = tokens[i + 2]
            if (!end || end.type !== 'cell') throw new Error('Range must be between two cell references')
            merged.push({ type: 'range', start: token.value, end: end.value })
            i += 2
        } else if (token.type === 'range') {
            throw new Error('Invalid range syntax')
        } else {
            merged.push(token)
        }
    }
    return merged
}

function parseTokensToAST(rawTokens) {
    const tokens = mergeRanges(rawTokens)
    const outputQueue = []
    const operatorStack = []
    let position = 0

    while (position < tokens.length) {
        const token = tokens[position]

        if (token.type === 'number' || token.type === 'cell' || token.type === 'range') {
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
    const startMatch = startKey.match(/^([A-Z]+)(\d+)$/)
    const endMatch = endKey.match(/^([A-Z]+)(\d+)$/)
    if (!startMatch || !endMatch) throw new Error('REF')

    const startCol = columnLetterToIndex(startMatch[1])
    const startRow = parseInt(startMatch[2]) - 1
    const endCol = columnLetterToIndex(endMatch[1])
    const endRow = parseInt(endMatch[2]) - 1

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
        const key = ast.value
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
            const num = typeof value === 'number' ? value : toStrictNumber(String(value))
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
//  Main engine factory
// ─────────────────────────────────────────────────────────────

export function createEngine(initialRows = 50, initialCols = 50) {
    let rows = initialRows
    let cols = initialCols
    const cells = new Map()
    // Style store: cell key -> frozen, fully-resolved style object. A cell with
    // no entry uses DEFAULT_STYLE. Lives in the engine (not React) so that it
    // shares undo/redo with values and moves with rows/columns.
    const styles = new Map()
    const graph = createDependencyGraph()
    const dirtyCells = new Set()
    const computedCache = new Map()
    const undoStack = []
    const redoStack = []

    // Incremented on every mutation. Cache entries from an older generation are
    // treated as stale and recomputed on read.
    let _generation = 0

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
        // Ranges are expanded, so editing any cell inside SUM(A1:A9) dirties it.
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

    // ── Style helpers ──

    const internedStyles = new WeakSet()

    function stylesEqual(a, b) {
        if (a === b) return true
        const x = a || DEFAULT_STYLE
        const y = b || DEFAULT_STYLE
        for (const k of Object.keys(DEFAULT_STYLE)) if (x[k] !== y[k]) return false
        return true
    }

    // Returns a frozen, fully-resolved style, or null when it equals the default.
    function normalizeStyle(style) {
        if (!style) return null
        if (internedStyles.has(style)) return style
        const merged = { ...DEFAULT_STYLE, ...style }
        if (stylesEqual(merged, DEFAULT_STYLE)) return null
        Object.freeze(merged)
        internedStyles.add(merged)
        return merged
    }

    function setStyleRaw(key, style) {
        if (style) styles.set(key, style)
        else styles.delete(key)
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
            const numericValue = toStrictNumber(cell.raw)
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

        // Topological order: every dependency is computed before its dependents.
        // Each cell leaves `dirtyCells` as soon as it is computed, so a long chain
        // (=A1+1 filled down 5,000 rows) is evaluated once per cell, not once per
        // cell per dependent.
        for (const cell of sorted) {
            if (dirtyCells.has(cell)) {
                computedCache.delete(cell)
                resolveCellValue(cell)
                dirtyCells.delete(cell)
            }
        }
        // Cells the sort could not order (cycles) are still dirty.
        for (const cell of affected) {
            if (dirtyCells.has(cell)) {
                computedCache.delete(cell)
                resolveCellValue(cell)
                dirtyCells.delete(cell)
            }
        }
        dirtyCells.clear()
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
        const snapCells = new Map()
        for (const [key, value] of cells.entries()) snapCells.set(key, { ...value })
        // Style objects are frozen, so the map can share them.
        return { cells: snapCells, styles: new Map(styles) }
    }

    function restoreSnapshot(snapshot) {
        cells.clear()
        styles.clear()
        for (const [key, value] of snapshot.cells.entries()) cells.set(key, { ...value })
        for (const [key, value] of snapshot.styles.entries()) styles.set(key, value)
        graph.clear()
        computedCache.clear()
        dirtyCells.clear()
        _generation++
        for (const [key, value] of cells.entries()) {
            if (value.raw && value.raw.startsWith('=')) updateDependencies(key, value.raw)
        }
        markAllCellsDirty()
    }

    // ── Row / Column structural operations ──

    // Moves cells and styles, rewrites every formula, rebuilds the graph.
    //   axis 'row' | 'col', atIndex edit position, delta +1 insert / -1 delete
    function restructure(snapshot, axis, atIndex, delta) {
        cells.clear()
        styles.clear()
        graph.clear()
        computedCache.clear()
        dirtyCells.clear()
        _generation++

        const isRow = axis === 'row'
        // New coordinates of a cell, or null if it sat on a deleted line.
        const remap = (coords) => {
            const pos = isRow ? coords.row : coords.col
            let next = pos
            if (delta > 0) {
                if (pos >= atIndex) next = pos + 1
            } else {
                if (pos === atIndex) return null
                if (pos > atIndex) next = pos - 1
            }
            return isRow ? { row: next, col: coords.col } : { row: coords.row, col: next }
        }

        for (const [key, value] of snapshot.cells.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            const moved = remap(coords)
            if (!moved) continue
            cells.set(cellKey(moved.row, moved.col), {
                ...value,
                raw: shiftReferencesForStructure(value.raw, axis, atIndex, delta),
            })
        }
        for (const [key, value] of snapshot.styles.entries()) {
            const coords = cellCoords(key)
            if (!coords) continue
            const moved = remap(coords)
            if (moved) styles.set(cellKey(moved.row, moved.col), value)
        }

        if (isRow) rows += delta
        else cols += delta

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

    // Applies the old or new side of a batch entry, then recalculates once.
    function applyChanges(changes, useNew) {
        // Undo walks the list backwards. Clearing a dependency chain top-down
        // would re-dirty every downstream dependent for every cell (O(n^2));
        // clearing bottom-up leaves nothing downstream to dirty.
        for (let i = 0; i < changes.length; i++) {
            const ch = changes[useNew ? i : changes.length - 1 - i]
            const raw = useNew ? ch.newRaw : ch.oldRaw
            const style = useNew ? ch.newStyle : ch.oldStyle
            const current = cells.get(ch.key)
            if ((current ? current.raw : '') !== raw) setCellRaw(ch.r, ch.c, raw)
            setStyleRaw(ch.key, style)
        }
        _generation++
        recalculate()
    }

    /**
     * The single write path for values and styles. `changes` is
     * [{ r, c, raw?, style? }]: raw undefined leaves the value alone; style
     * undefined leaves the style alone, null clears it, an object replaces it.
     * Everything lands in ONE undo entry and ONE recalculation.
     * options.keepNoOps keeps unchanged cells in the undo entry (fill uses it so
     * that a fill always has an entry, even if it rewrote identical values).
     */
    function commitChanges(changes, { keepNoOps = false } = {}) {
        const byKey = new Map()
        for (const ch of changes) {
            if (ch.r < 0 || ch.c < 0) continue
            byKey.set(cellKey(ch.r, ch.c), ch) // last write to a cell wins
        }
        const list = []
        for (const [key, ch] of byKey) {
            const current = cells.get(key)
            const oldRaw = current ? current.raw : ''
            const oldStyle = styles.get(key) || null
            let newRaw = ch.raw === undefined ? oldRaw : String(ch.raw ?? '')
            if (newRaw.trim() === '') newRaw = ''
            const newStyle = ch.style === undefined ? oldStyle : normalizeStyle(ch.style)
            if (!keepNoOps && newRaw === oldRaw && stylesEqual(newStyle, oldStyle)) continue
            list.push({ key, r: ch.r, c: ch.c, oldRaw, newRaw, oldStyle, newStyle })
        }
        if (list.length === 0) return { changed: 0 }
        let needRows = rows
        let needCols = cols
        for (const ch of list) {
            if (ch.r + 1 > needRows) needRows = ch.r + 1
            if (ch.c + 1 > needCols) needCols = ch.c + 1
        }
        rows = needRows
        cols = needCols
        pushToUndoStack({ type: 'batch', changes: list })
        applyChanges(list, true)
        return { changed: list.length }
    }

    function executeSetCell(row, col, value) {
        commitChanges([{ r: row, c: col, raw: value }])
    }

    function executeStructural(type, axis, atIndex, delta) {
        const snapshot = takeSnapshot()
        pushToUndoStack({ type, snap: snapshot, oldRows: rows, oldCols: cols })
        restructure(snapshot, axis, atIndex, delta)
        recalculate()
    }

    function undo() {
        if (undoStack.length === 0) return false
        const entry = undoStack.pop()

        if (entry.type === 'batch') {
            applyChanges(entry.changes, false)
            redoStack.push(entry)
        } else {
            redoStack.push({
                ...entry,
                restoreSnap: takeSnapshot(),
                restoreRows: rows,
                restoreCols: cols,
            })
            restoreSnapshot(entry.snap)
            rows = entry.oldRows
            cols = entry.oldCols
            recalculate()
        }
        return true
    }

    function redo() {
        if (redoStack.length === 0) return false
        const entry = redoStack.pop()

        if (entry.type === 'batch') {
            applyChanges(entry.changes, true)
            undoStack.push(entry)
        } else {
            undoStack.push({
                ...entry,
                snap: takeSnapshot(),
                oldRows: rows,
                oldCols: cols,
            })
            restoreSnapshot(entry.restoreSnap)
            rows = entry.restoreRows
            cols = entry.restoreCols
            recalculate()
        }
        return true
    }

    // ── Range operations ──

    function clampRange(range) {
        const r = normalizeRange(range)
        return {
            r1: Math.max(0, r.r1),
            c1: Math.max(0, r.c1),
            r2: Math.min(rows - 1, r.r2),
            c2: Math.min(cols - 1, r.c2),
        }
    }

    // Keys of cells that hold a value or a style inside `range`. Walks whichever
    // is smaller: the range area, or the sparse stores.
    function existingCellsIn(range, includeStyles) {
        const area = (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1)
        const out = []
        if (area <= cells.size + (includeStyles ? styles.size : 0)) {
            for (let r = range.r1; r <= range.r2; r++) {
                for (let c = range.c1; c <= range.c2; c++) out.push({ r, c })
            }
            return out
        }
        const seen = new Set()
        const visit = (key) => {
            if (seen.has(key)) return
            seen.add(key)
            const p = cellCoords(key)
            if (p && p.row >= range.r1 && p.row <= range.r2 && p.col >= range.c1 && p.col <= range.c2) {
                out.push({ r: p.row, c: p.col })
            }
        }
        for (const key of cells.keys()) visit(key)
        if (includeStyles) for (const key of styles.keys()) visit(key)
        return out
    }

    /** Clears values (and styles when options.styles). One undo step. */
    function clearRange(range, { styles: clearStyles = false } = {}) {
        const r = clampRange(range)
        if (r.r2 < r.r1 || r.c2 < r.c1) return { changed: 0 }
        const changes = existingCellsIn(r, clearStyles).map(({ r: row, c }) => (
            clearStyles ? { r: row, c, raw: '', style: null } : { r: row, c, raw: '' }
        ))
        return commitChanges(changes)
    }

    /** Merges `patch` into the style of every cell in the range. One undo step. */
    function setStyleRange(range, patch) {
        const r = clampRange(range)
        const changes = []
        for (let row = r.r1; row <= r.r2; row++) {
            for (let c = r.c1; c <= r.c2; c++) {
                const base = styles.get(cellKey(row, c)) || DEFAULT_STYLE
                changes.push({ r: row, c, style: { ...base, ...patch } })
            }
        }
        return commitChanges(changes)
    }

    /** Smallest rectangle covering every cell that has a value, or null. */
    function getUsedRange() {
        let r1 = Infinity, c1 = Infinity, r2 = -1, c2 = -1
        for (const key of cells.keys()) {
            const p = cellCoords(key)
            if (!p) continue
            if (p.row < r1) r1 = p.row
            if (p.row > r2) r2 = p.row
            if (p.col < c1) c1 = p.col
            if (p.col > c2) c2 = p.col
        }
        return r2 < 0 ? null : { r1, c1, r2, c2 }
    }

    /**
     * Fill handle. `source` is the selected seed range; `target` is the whole
     * rectangle after the drag (source plus the dragged-over cells).
     *   target extends the source down/up/right/left -> series fill
     *   target lies inside the source                 -> shrink: cells of the
     *                                                    source outside the target
     *                                                    are cleared (value + style)
     * Extending along two axes at once throws. One undo step.
     */
    function fillRange(sourceIn, targetIn) {
        const src = normalizeRange(sourceIn)
        const tgt = clampRange(targetIn)
        const down = tgt.r2 > src.r2
        const up = tgt.r1 < src.r1
        const right = tgt.c2 > src.c2
        const left = tgt.c1 < src.c1
        const directions = [down, up, right, left].filter(Boolean).length
        if (directions > 1) throw new RangeError('fillRange: extend along one axis at a time')

        const changes = []

        if (directions === 0) {
            const inside = tgt.r1 >= src.r1 && tgt.r2 <= src.r2 && tgt.c1 >= src.c1 && tgt.c2 <= src.c2
            if (!inside) throw new RangeError('fillRange: target must contain or lie inside the source')
            for (let r = src.r1; r <= src.r2; r++) {
                for (let c = src.c1; c <= src.c2; c++) {
                    const kept = r >= tgt.r1 && r <= tgt.r2 && c >= tgt.c1 && c <= tgt.c2
                    if (!kept) changes.push({ r, c, raw: '', style: null })
                }
            }
            return commitChanges(changes, { keepNoOps: true })
        }

        const vertical = down || up
        const sign = down || right ? 1 : -1
        const count = down ? tgt.r2 - src.r2 : up ? src.r1 - tgt.r1 : right ? tgt.c2 - src.c2 : src.c1 - tgt.c1
        const lines = vertical ? src.c2 - src.c1 + 1 : src.r2 - src.r1 + 1
        const length = vertical ? src.r2 - src.r1 + 1 : src.c2 - src.c1 + 1

        for (let line = 0; line < lines; line++) {
            const seedRaws = []
            const seedStyles = []
            // seeds in fill order: nearest to the target last
            for (let i = 0; i < length; i++) {
                const offset = sign > 0 ? i : length - 1 - i
                const r = vertical ? src.r1 + offset : src.r1 + line
                const c = vertical ? src.c1 + line : src.c1 + offset
                const key = cellKey(r, c)
                const cell = cells.get(key)
                seedRaws.push(cell ? cell.raw : '')
                seedStyles.push(styles.get(key) || null)
            }
            const values = buildFillValues(seedRaws, count, { axis: vertical ? 'row' : 'col', sign })
            for (let k = 1; k <= count; k++) {
                let r, c
                if (down) { r = src.r2 + k; c = src.c1 + line }
                else if (up) { r = src.r1 - k; c = src.c1 + line }
                else if (right) { r = src.r1 + line; c = src.c2 + k }
                else { r = src.r1 + line; c = src.c1 - k }
                changes.push({ r, c, raw: values[k - 1], style: seedStyles[(k - 1) % length] })
            }
        }
        return commitChanges(changes, { keepNoOps: true })
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
        setCells: (changes, options) => commitChanges(changes, options),
        getStyle: (row, col) => styles.get(cellKey(row, col)) || DEFAULT_STYLE,
        setStyleRange,
        clearRange,
        fillRange,
        getUsedRange,
        insertRow: (atIndex) => executeStructural('rowins', 'row', atIndex, 1),
        deleteRow: (atIndex) => executeStructural('rowdel', 'row', atIndex, -1),
        insertColumn: (atIndex) => executeStructural('colins', 'col', atIndex, 1),
        deleteColumn: (atIndex) => executeStructural('coldel', 'col', atIndex, -1),
        undo,
        redo,
        canUndo: () => undoStack.length > 0,
        canRedo: () => redoStack.length > 0,
        // Grow the grid so that at least minRows x minCols exist. The engine is
        // sparse, so this only moves the bounds; nothing is allocated.
        ensureCapacity: (minRows, minCols) => {
            if (minRows > rows) rows = minRows
            if (minCols > cols) cols = minCols
        },
    }
}
