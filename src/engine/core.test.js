import { describe, it, expect } from 'vitest'
import { createEngine, compareValues, toNum, toDate, normText } from './core.js'
import { parseTsv } from '../fixtures/loadSample.js'
import salesSmall from '../../fixtures/sales.tsv?raw'
import salesLarge from '../../fixtures/sales-large.tsv?raw'

describe('engine basics', () => {
    it('evaluates arithmetic and ranges', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, '10')
        engine.setCell(1, 0, '20')
        engine.setCell(2, 0, '=SUM(A1:A2)*2')
        expect(engine.getCell(2, 0).computed).toBe(60)
    })

    it('reports a cycle instead of hanging', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, '=B1')
        engine.setCell(0, 1, '=A1')
        expect(engine.getCell(0, 1).error).toBe('#CYCLE!')
    })

    it('undoes and redoes a single edit', () => {
        const engine = createEngine(10, 10)
        engine.setCell(0, 0, 'hello')
        engine.setCell(0, 0, 'world')
        engine.undo()
        expect(engine.getCell(0, 0).raw).toBe('hello')
        engine.redo()
        expect(engine.getCell(0, 0).raw).toBe('world')
    })

    it('shifts references when a row is inserted above them', () => {
        const engine = createEngine(10, 10)
        engine.setCell(2, 0, '5')       // A3
        engine.setCell(4, 0, '=A3+1')   // A5
        engine.insertRow(1)             // A3 -> A4, A5 -> A6
        expect(engine.getCell(5, 0).raw).toBe('=A4+1')
        expect(engine.getCell(5, 0).computed).toBe(6)
    })
})

describe('Task 2: comparisons & types', () => {
    it('normalises text and coercions', () => {
        expect(normText('  West ')).toBe('west')
        expect(toNum('$1,200.00')).toBe(1200)
        expect(toNum('10%')).toBe(0.1)
        expect(toNum('$ 49.99')).toBe(49.99)
        expect(toNum('N/A')).toBe(null)
        expect(toDate('2024-01-15')).toBe('2024-01-15')
        expect(toDate('1/8/2024')).toBe('2024-01-08')
        expect(toDate('15 Jan 2024')).toBe('2024-01-15')
    })

    it('orders numbers before text, blanks last, dates chronologically', () => {
        expect(compareValues(10, 20)).toBe(-1)
        expect(compareValues(20, 10)).toBe(1)
        expect(compareValues('$10', 'apple')).toBe(-1) // number before text
        expect(compareValues('apple', '$10')).toBe(1)
        expect(compareValues('', 'apple')).toBe(1) // blanks last
        expect(compareValues('apple', '')).toBe(-1)
        expect(compareValues('1/8/2024', '2024-01-15')).toBe(-1)
    })
})

describe('Task 2: Acceptance criteria on sales.tsv', () => {
    function loadSmallSheet() {
        const rows = parseTsv(salesSmall)
        const cols = Math.max(...rows.map(r => r.length))
        const engine = createEngine(rows.length + 10, cols + 5)
        for (let r = 0; r < rows.length; r++) {
            for (let c = 0; c < rows[r].length; c++) {
                engine.setCell(r, c, rows[r][c])
            }
        }
        return { engine, rows, cols }
    }

    it('Put =J2/G2 in K2, fill to K32. Sort by Total descending: K2 shows ORD-1025 price per unit (1080), A33 still reads Total, blank row sorts last', () => {
        const { engine } = loadSmallSheet()
        // Put =J2/G2 in K2 down to K32
        for (let r = 1; r <= 31; r++) {
            engine.setCell(r, 10, `=J${r + 1}/G${r + 1}`)
        }

        // Check A33 reads Total initially
        expect(engine.getCell(32, 0).raw).toBe('Total')

        // Sort by Total (col 9) descending
        const res = engine.sort(9, 'desc')
        expect(res.reorderedCount).toBe(31) // 31 data rows reordered

        // A33 still reads Total (row 32 is row 33 1-based)
        expect(engine.getCell(32, 0).raw).toBe('Total')

        // Top row after descending sort should be ORD-1025 (Total $9,720.00, Units 9, Price $1080)
        expect(engine.getCell(1, 0).raw).toBe('ORD-1025')
        expect(engine.getCell(1, 10).computed).toBe(1080)

        // Blank row in sales.tsv was ORD-1017 (row 18) followed by blank row 19.
        // Blank row must sort last among data rows (row 31, just above Total at 32)
        const lastDataRowOrder = engine.getCell(31, 0).raw
        expect(lastDataRowOrder.trim()).toBe('')

        // One undo restores original order
        engine.undo()
        expect(engine.getCell(1, 0).raw).toBe('ORD-1001')
        expect(engine.getCell(32, 0).raw).toBe('Total')
    })

    it('Filter Region to West, then sort by Units: hidden rows do not move', () => {
        const { engine } = loadSmallSheet()
        // Region is column 2 (index 2). Data rows are 1..31.
        // Identify visible rows matching "west" (case-insensitive & trimmed)
        const visibleRows = new Set()
        for (let r = 1; r <= 31; r++) {
            const regionVal = engine.getCell(r, 2).raw
            if (normText(regionVal) === 'west') {
                visibleRows.add(r)
            }
        }

        // Remember order of non-visible rows
        const hiddenRowsBefore = []
        for (let r = 1; r <= 31; r++) {
            if (!visibleRows.has(r)) {
                hiddenRowsBefore.push({ r, val: engine.getCell(r, 0).raw })
            }
        }

        // Units is column 6 (index 6). Sort visible rows by Units ascending
        engine.sort(6, 'asc', { visibleRows })

        // Check that every hidden row stayed exactly at its original row index!
        for (const item of hiddenRowsBefore) {
            expect(engine.getCell(item.r, 0).raw).toBe(item.val)
        }

        // Visible rows should now be sorted by Units ascending
        const sortedVisibleUnits = Array.from(visibleRows).map(r => toNum(engine.getCell(r, 6).raw))
        for (let i = 0; i < sortedVisibleUnits.length - 1; i++) {
            expect(sortedVisibleUnits[i] <= sortedVisibleUnits[i + 1]).toBe(true)
        }

        // Undo restores original order
        engine.undo()
        for (let r = 1; r <= 31; r++) {
            if (!visibleRows.has(r)) {
                expect(engine.getCell(r, 0).raw).toBe(hiddenRowsBefore.find(h => h.r === r).val)
            }
        }
    })

    it('Three-state sort cycle: asc -> desc -> original order preserves row identity', () => {
        const { engine } = loadSmallSheet()
        const initialOrder = []
        for (let r = 1; r <= 31; r++) {
            initialOrder.push(engine.getCell(r, 0).raw)
        }

        // Sort asc by Order ID (col 0)
        engine.sort(0, 'asc')
        // Sort desc
        engine.sort(0, 'desc')
        // Sort original
        engine.sort(0, 'original')

        const finalOrder = []
        for (let r = 1; r <= 31; r++) {
            finalOrder.push(engine.getCell(r, 0).raw)
        }

        expect(finalOrder).toEqual(initialOrder)
    })
})

describe('Task 2: Performance budget on sales-large.tsv', () => {
    it('sorting 3000+ rows takes well under 300 ms', () => {
        const rows = parseTsv(salesLarge)
        const cols = Math.max(...rows.map(r => r.length))
        const engine = createEngine(rows.length + 5, cols + 5)
        for (let r = 0; r < rows.length; r++) {
            for (let c = 0; c < rows[r].length; c++) {
                engine.setCell(r, c, rows[r][c])
            }
        }

        // Date is col 1
        const t0 = performance.now()
        const res = engine.sort(1, 'asc')
        const t1 = performance.now()
        const elapsed = t1 - t0

        expect(res.reorderedCount).toBeGreaterThan(2500)
        expect(elapsed).toBeLessThan(300)
    })
})
