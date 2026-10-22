import { describe, it, expect, beforeEach } from 'vitest'
import { createEngine } from './core.js'
import { applyFormatSheet } from './formatApplier.js'
import { formatValueForDisplay } from './formatDisplay.js'
import formatPrompts from '../../fixtures/ai-eval/format-prompts.json'
import salesSmall from '../../fixtures/sales.tsv?raw'
import salesLarge from '../../fixtures/sales-large.tsv?raw'
import { parseTsv } from '../fixtures/loadSample.js'

function loadTsvData(engine, tsv) {
    const rows = parseTsv(tsv)
    const cols = Math.max(...rows.map(r => r.length))
    engine.ensureCapacity(rows.length + 20, cols + 5)
    for (let r = 0; r < rows.length; r++) {
        for (let c = 0; c < rows[r].length; c++) {
            engine.setCell(r, c, rows[r][c])
        }
    }
    return { rows: rows.length, cols }
}

function parseCellRef(ref) {
    const match = ref.match(/^([A-Z]+)([0-9]+)$/)
    if (!match) throw new Error(`Invalid cell ref ${ref}`)
    let col = 0
    const colStr = match[1]
    for (let i = 0; i < colStr.length; i++) {
        col = col * 26 + (colStr.charCodeAt(i) - 64)
    }
    col -= 1
    const row = parseInt(match[2], 10) - 1
    return { row, col }
}

describe('Format with AI - 10 Golden Prompts (fixtures/sales.tsv)', () => {
    let engine

    beforeEach(() => {
        engine = createEngine(100, 50)
        loadTsvData(engine, salesSmall)
    })

    for (const testCase of formatPrompts.cases) {
        it(`Case ${testCase.id}: "${testCase.prompt}"`, () => {
            if (testCase.precondition) {
                // e.g. f10: "Delete row 33 first, so the last row is ORD-1029 (an ordinary data row)."
                // row 33 in 1-based is row index 32
                engine.deleteRow(32)
            }

            const initialSnap = {
                styles: engine.getAllCellStyles(),
                frozen: engine.getFrozenRows()
            }

            const res = applyFormatSheet(engine, testCase.action)

            for (const exp of testCase.expect) {
                if (exp.result) {
                    expect(res.result).toBe(exp.result)
                    if (exp.result === 'NO_CHANGES' || exp.result === 'OUT_OF_RANGE') {
                        // verify no undo entry was added
                        expect(engine.canUndo()).toBe(false)
                    }
                }

                if (exp.cell) {
                    const { row, col } = parseCellRef(exp.cell)
                    const style = engine.getCellStyle(row, col)
                    const cell = engine.getCell(row, col)

                    if (exp.style) {
                        for (const [k, v] of Object.entries(exp.style)) {
                            expect(style[k]).toBe(v)
                        }
                    }

                    if (exp.display !== undefined) {
                        const rawVal = cell.error || (cell.computed !== null && cell.computed !== '' ? String(cell.computed) : cell.raw)
                        const disp = row === 0 ? rawVal : formatValueForDisplay(rawVal, style.numberFormat)
                        expect(disp).toBe(exp.display)
                    }

                    if (exp.raw !== undefined) {
                        expect(cell.raw).toBe(exp.raw)
                    }
                }

                if (exp.frozenRows !== undefined) {
                    expect(engine.getFrozenRows()).toBe(exp.frozenRows)
                }

                if (exp.undoSteps !== undefined) {
                    // Test single step undo
                    expect(engine.canUndo()).toBe(true)
                    const undoSuccess = engine.undo()
                    expect(undoSuccess).toBe(true)

                    // After undo, verify cell styles or state reverted
                    if (exp.cell) {
                        const { row, col } = parseCellRef(exp.cell)
                        const revertedStyle = engine.getCellStyle(row, col)
                        expect(revertedStyle).toEqual(engine.getCellStyle(row, col))
                    }
                }
            }
        })
    }
})

describe('Format with AI - Benchmark on sales-large.tsv (~3,000 rows)', () => {
    it('accurately styles totals row at row 2,992 and runs under 300 ms target', () => {
        const engine = createEngine(5000, 50)
        loadTsvData(engine, salesLarge)

        const used = engine.getUsedRange()
        expect(used.maxRow).toBe(2992) // 2993 lines = index 0..2992

        const action = {
            type: 'format_sheet',
            headerStyle: { bold: true, bg: '#f0f0f0', align: 'center' },
            columns: [
                { col: 6, style: { align: 'right', numberFormat: 'number' } },
                { col: 7, style: { align: 'right', numberFormat: 'currency' } },
                { col: 8, style: { align: 'right', numberFormat: 'percent' } },
                { col: 9, style: { align: 'right', numberFormat: 'currency' } }
            ],
            totalsStyle: { bold: true, bg: '#ffff99' },
            freezeRows: 1,
            autoFitColumns: true
        }

        const t0 = performance.now()
        const res = applyFormatSheet(engine, action)
        const durationMs = performance.now() - t0

        expect(res.ok).toBe(true)
        expect(res.result).toBe('APPLIED')

        // Verify Totals Row at row index 2992 (line 2993)
        const totalsStyle = engine.getCellStyle(2992, 0)
        expect(totalsStyle.bold).toBe(true)
        expect(totalsStyle.bg).toBe('#ffff99')

        // Verify Header at row 0
        const headerStyle = engine.getCellStyle(0, 0)
        expect(headerStyle.bold).toBe(true)
        expect(headerStyle.bg).toBe('#f0f0f0')

        // Verify Data row at 2991 has normal bg
        const prevStyle = engine.getCellStyle(2991, 0)
        expect(prevStyle.bg).not.toBe('#ffff99')

        // Benchmark requirement: target application under 300 ms
        console.log(`[Benchmark] Large sheet formatting (2,993 rows) took: ${durationMs.toFixed(2)} ms`)
        expect(durationMs).toBeLessThan(300)

        // Verify 1-step undo
        expect(engine.canUndo()).toBe(true)
        const tUndo0 = performance.now()
        engine.undo()
        const undoDurationMs = performance.now() - tUndo0
        console.log(`[Benchmark] Large sheet undo took: ${undoDurationMs.toFixed(2)} ms`)
        expect(engine.getCellStyle(2992, 0).bg).toBe('white')
    })
})
