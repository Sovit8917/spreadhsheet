// Task 1: range operations and fill handle. Acceptance cases use fixtures/sales.tsv.
import { describe, it, expect } from 'vitest'
import { createEngine } from './core.js'
import { buildFillValues, parseDate, formatDate } from './fill.js'
import { shiftFormula, shiftReferencesForStructure } from './refs.js'
import { loadSampleSmall } from '../fixtures/loadSample.js'

// A1-style helpers so tests read like the spec (rows are 1-based here).
const col = (letter) => letter.charCodeAt(0) - 65
const raw = (e, a1) => e.getCell(+a1.slice(1) - 1, col(a1[0])).raw
const put = (e, a1, v) => e.setCell(+a1.slice(1) - 1, col(a1[0]), v)
const range = (a, b) => ({ r1: +a.slice(1) - 1, c1: col(a[0]), r2: +b.slice(1) - 1, c2: col(b[0]) })
const sales = () => {
    const e = createEngine(50, 50)
    loadSampleSmall(e)
    return e
}

describe('acceptance on sales.tsv', () => {
    it('A2:A3 dragged to A6 gives ORD-1003..1005 and one undo restores', () => {
        const e = sales()
        // make the target differ from what is there, so the undo is observable
        for (const a of ['A4', 'A5', 'A6']) put(e, a, 'x')
        e.fillRange(range('A2', 'A3'), range('A2', 'A6'))
        expect(['A4', 'A5', 'A6'].map((a) => raw(e, a))).toEqual(['ORD-1003', 'ORD-1004', 'ORD-1005'])
        e.undo()
        expect(['A4', 'A5', 'A6'].map((a) => raw(e, a))).toEqual(['x', 'x', 'x'])
        e.redo()
        expect(raw(e, 'A6')).toBe('ORD-1005')
    })

    it('a fill always leaves exactly one undo entry, even when it rewrites identical values', () => {
        const e = sales()
        e.fillRange(range('A2', 'A3'), range('A2', 'A6')) // A4:A6 already hold 1003..1005
        e.undo() // undoes the fill ...
        expect(raw(e, 'A1')).toBe('Order ID') // ... not the sample load
    })

    it('relative and absolute formulas fill down; row insert keeps $G$2 pinned', () => {
        const e = sales()
        put(e, 'K2', '=G2*H2')
        put(e, 'L2', '=$G$2*H2')
        e.fillRange(range('K2', 'L2'), range('K2', 'L32'))
        expect(raw(e, 'K32')).toBe('=G32*H32')
        expect(raw(e, 'L32')).toBe('=$G$2*H32')
        e.insertRow(9) // above row 10
        expect(raw(e, 'L33')).toBe('=$G$2*H33')
        expect(raw(e, 'K33')).toBe('=G33*H33')
    })

    it('B2:B4 filled to B8 keeps each seed format', () => {
        const e = sales()
        expect([raw(e, 'B2'), raw(e, 'B3'), raw(e, 'B4')]).toEqual(['2024-01-03', '2024-01-05', '1/8/2024'])
        e.fillRange(range('B2', 'B4'), range('B2', 'B8'))
        // step = last delta (3 days); seed formats repeat ISO, ISO, US, ISO
        expect(['B5', 'B6', 'B7', 'B8'].map((a) => raw(e, a))).toEqual([
            '2024-01-11', '2024-01-14', '1/17/2024', '2024-01-20',
        ])
    })

    it('insert row above a formula shifts a pinned row ($G$2 -> $G$3) when inserted above it', () => {
        const e = sales()
        put(e, 'L40', '=$G$2*H2')
        e.insertRow(0)
        expect(raw(e, 'L41')).toBe('=$G$3*H3')
    })
})

describe('series rules (buildFillValues)', () => {
    const fill = (seeds, n, opts) => buildFillValues(seeds, n, opts)

    it('one numeric seed copies; two seeds continue the step', () => {
        expect(fill(['5'], 3)).toEqual(['5', '5', '5'])
        expect(fill(['1', '2'], 3)).toEqual(['3', '4', '5'])
        expect(fill(['10', '7'], 2)).toEqual(['4', '1'])
        expect(fill(['0.1', '0.2'], 2)).toEqual(['0.3', '0.4'])
    })

    it('text ending in a number increments and keeps zero padding', () => {
        expect(fill(['Item 1'], 2)).toEqual(['Item 2', 'Item 3'])
        expect(fill(['Q4'], 2)).toEqual(['Q5', 'Q6'])
        expect(fill(['2024-W01'], 2)).toEqual(['2024-W02', '2024-W03'])
        expect(fill(['ORD-1001', 'ORD-1002'], 2)).toEqual(['ORD-1003', 'ORD-1004'])
        expect(fill(['A-009'], 2)).toEqual(['A-010', 'A-011'])
        expect(fill(['007', '008'], 2)).toEqual(['009', '010'])
    })

    it('formatted numbers are copied, not incremented', () => {
        expect(fill(['$1,200.00'], 2)).toEqual(['$1,200.00', '$1,200.00'])
        expect(fill(['10%', '20%'], 3)).toEqual(['10%', '20%', '10%'])
    })

    it('dates step by the seed delta and keep their format', () => {
        expect(fill(['2024-01-15'], 2)).toEqual(['2024-01-16', '2024-01-17'])
        expect(fill(['2024-01-15', '2024-01-22'], 2)).toEqual(['2024-01-29', '2024-02-05'])
        expect(fill(['1/15/2024', '1/16/2024'], 2)).toEqual(['1/17/2024', '1/18/2024'])
        expect(fill(['01/30/2024'], 2)).toEqual(['01/31/2024', '02/01/2024'])
        expect(fill(['15 Jan 2024'], 2)).toEqual(['16 Jan 2024', '17 Jan 2024'])
        expect(fill(['2024-02-28'], 2)).toEqual(['2024-02-29', '2024-03-01']) // leap year
    })

    it('weekday and month names cycle and preserve case', () => {
        expect(fill(['Mon'], 3)).toEqual(['Tue', 'Wed', 'Thu'])
        expect(fill(['Sun'], 2)).toEqual(['Mon', 'Tue'])
        expect(fill(['Friday'], 3)).toEqual(['Saturday', 'Sunday', 'Monday'])
        expect(fill(['jan'], 2)).toEqual(['feb', 'mar'])
        expect(fill(['DEC'], 2)).toEqual(['JAN', 'FEB'])
        expect(fill(['January'], 2)).toEqual(['February', 'March'])
        expect(fill(['Mon', 'Wed'], 3)).toEqual(['Fri', 'Sun', 'Tue'])
    })

    it('formulas shift relative references and pin $ parts', () => {
        expect(fill(['=A1+$B$1'], 2, { axis: 'row', sign: 1 })).toEqual(['=A2+$B$1', '=A3+$B$1'])
        expect(fill(['=$A1+B$1'], 2, { axis: 'row', sign: 1 })).toEqual(['=$A2+B$1', '=$A3+B$1'])
        expect(fill(['=A1+B1'], 2, { axis: 'col', sign: 1 })).toEqual(['=B1+C1', '=C1+D1'])
        expect(fill(['=SUM(A1:A3)'], 1, { axis: 'col', sign: 1 })).toEqual(['=SUM(B1:B3)'])
        expect(fill(['=B3+1'], 2, { axis: 'row', sign: -1 })).toEqual(['=B2+1', '=B1+1'])
    })

    it('a reference pushed off the sheet becomes #REF!', () => {
        expect(shiftFormula('=A1+1', -1, 0)).toBe('=#REF!+1')
        const e = createEngine(5, 5)
        e.setCell(1, 0, '=A1+1')
        e.fillRange({ r1: 1, c1: 0, r2: 1, c2: 0 }, { r1: 0, c1: 0, r2: 1, c2: 0 }) // up
        expect(e.getCell(0, 0).error).toBe('#REF!')
    })

    it('unrecognised seeds repeat as a cycle', () => {
        expect(fill(['a', 'b'], 3)).toEqual(['a', 'b', 'a'])
    })

    it('date helpers round trip', () => {
        for (const s of ['2024-01-03', '1/8/2024', '01/08/2024', '15 Jan 2024', '15 JAN 2024']) {
            const p = parseDate(s)
            expect(formatDate(p.days, p.fmt)).toBe(s)
        }
        expect(parseDate('2024-02-31')).toBeNull()
    })
})

describe('fillRange directions, shrink, styles, undo', () => {
    const e0 = () => createEngine(20, 20)

    it('fills right, up and left', () => {
        const e = e0()
        put(e, 'C5', '1'); put(e, 'D5', '2')
        e.fillRange(range('C5', 'D5'), range('C5', 'G5'))
        expect(['E5', 'F5', 'G5'].map((a) => raw(e, a))).toEqual(['3', '4', '5'])
        // up: seeds C5 (1), C6 (2) reading upward continues the step backwards
        put(e, 'J10', '5'); put(e, 'J11', '6')
        e.fillRange(range('J10', 'J11'), range('J8', 'J11'))
        expect([raw(e, 'J9'), raw(e, 'J8')]).toEqual(['4', '3'])
        // left
        put(e, 'H15', 'Mon'); put(e, 'I15', 'Tue')
        e.fillRange(range('H15', 'I15'), range('F15', 'I15'))
        expect([raw(e, 'G15'), raw(e, 'F15')]).toEqual(['Sun', 'Sat'])
    })

    it('fills each column of a 2-D source independently', () => {
        const e = e0()
        put(e, 'A1', '1'); put(e, 'B1', 'Mon')
        put(e, 'A2', '2'); put(e, 'B2', 'Tue')
        e.fillRange(range('A1', 'B2'), range('A1', 'B4'))
        expect([raw(e, 'A3'), raw(e, 'A4'), raw(e, 'B3'), raw(e, 'B4')]).toEqual(['3', '4', 'Wed', 'Thu'])
    })

    it('filled cells inherit the seed style; undo restores values and styles in one step', () => {
        const e = e0()
        put(e, 'A1', '1'); put(e, 'A2', '2')
        e.setStyleRange(range('A1', 'A1'), { bold: true, bg: '#ffff99' })
        e.setStyleRange(range('A2', 'A2'), { italic: true })
        put(e, 'A5', 'old')
        e.setStyleRange(range('A5', 'A5'), { color: '#ff0000' })
        e.fillRange(range('A1', 'A2'), range('A1', 'A6'))
        expect(e.getStyle(2, 0)).toMatchObject({ bold: true, bg: '#ffff99', italic: false })
        expect(e.getStyle(3, 0)).toMatchObject({ italic: true, bold: false })
        expect(e.getStyle(4, 0)).toMatchObject({ bold: true }) // A5 got seed 1's style (cycle)
        expect(e.getStyle(4, 0).color).toBe('#202124')
        e.undo()
        expect(raw(e, 'A5')).toBe('old')
        expect(e.getStyle(4, 0).color).toBe('#ff0000')
        expect(e.getStyle(2, 0).bold).toBe(false)
        expect(raw(e, 'A3')).toBe('')
    })

    it('dragging back shrinks: cells of the source outside the target are cleared', () => {
        const e = e0()
        for (let i = 1; i <= 5; i++) put(e, 'A' + i, String(i))
        e.setStyleRange(range('A5', 'A5'), { bold: true })
        e.fillRange(range('A1', 'A5'), range('A1', 'A3'))
        expect(['A1', 'A2', 'A3', 'A4', 'A5'].map((a) => raw(e, a))).toEqual(['1', '2', '3', '', ''])
        expect(e.getStyle(4, 0).bold).toBe(false)
        e.undo()
        expect(raw(e, 'A5')).toBe('5')
        expect(e.getStyle(4, 0).bold).toBe(true)
    })

    it('a fill that grows then retreats before release only writes the final extent', () => {
        const e = e0()
        put(e, 'A1', '1'); put(e, 'A2', '2')
        e.fillRange(range('A1', 'A2'), range('A1', 'A4'))
        expect(raw(e, 'A5')).toBe('')
    })

    it('rejects a two-axis extension and does not change anything', () => {
        const e = e0()
        put(e, 'A1', '1')
        expect(() => e.fillRange(range('A1', 'A1'), range('A1', 'C3'))).toThrow(RangeError)
        expect(raw(e, 'B2')).toBe('')
    })

    it('redo re-applies the fill', () => {
        const e = e0()
        put(e, 'A1', '1'); put(e, 'A2', '2')
        e.fillRange(range('A1', 'A2'), range('A1', 'A5'))
        e.undo()
        expect(raw(e, 'A5')).toBe('')
        e.redo()
        expect(raw(e, 'A5')).toBe('5')
    })

    it('filled formulas compute', () => {
        const e = e0()
        for (let i = 1; i <= 4; i++) put(e, 'A' + i, String(i * 10))
        put(e, 'B1', '=A1*2')
        e.fillRange(range('B1', 'B1'), range('B1', 'B4'))
        expect(e.getCell(3, 1).computed).toBe(80)
        put(e, 'A3', '100') // dependents recalculate
        expect(e.getCell(2, 1).computed).toBe(200)
    })
})

describe('selection operations', () => {
    it('clearRange clears a rectangle as one undo step; values only by default', () => {
        const e = createEngine(10, 10)
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) e.setCell(r, c, String(r * 3 + c + 1))
        e.setStyleRange({ r1: 0, c1: 0, r2: 2, c2: 2 }, { bold: true })
        e.clearRange({ r1: 0, c1: 0, r2: 1, c2: 1 })
        expect(raw(e, 'A1') + raw(e, 'B2')).toBe('')
        expect(raw(e, 'C3')).toBe('9')
        expect(e.getStyle(0, 0).bold).toBe(true)
        e.undo()
        expect([raw(e, 'A1'), raw(e, 'B2')]).toEqual(['1', '5'])
    })

    it('clearRange with styles removes formatting too', () => {
        const e = createEngine(10, 10)
        e.setCell(0, 0, 'x')
        e.setStyleRange({ r1: 0, c1: 0, r2: 0, c2: 0 }, { bold: true })
        e.clearRange({ r1: 0, c1: 0, r2: 0, c2: 0 }, { styles: true })
        expect(e.getStyle(0, 0).bold).toBe(false)
        e.undo()
        expect(e.getStyle(0, 0).bold).toBe(true)
        expect(raw(e, 'A1')).toBe('x')
    })

    it('clearing an already-empty range creates no undo entry', () => {
        const e = createEngine(10, 10)
        e.setCell(0, 0, 'a')
        e.clearRange({ r1: 5, c1: 5, r2: 6, c2: 6 })
        e.undo()
        expect(raw(e, 'A1')).toBe('') // the undo hit the setCell, not a phantom clear
    })

    it('whole-row / whole-column ranges clear only what exists', () => {
        const e = createEngine(10, 10)
        e.setCell(2, 4, 'x'); e.setCell(2, 8, 'y'); e.setCell(3, 4, 'z')
        e.clearRange({ r1: 2, c1: 0, r2: 2, c2: 9 })
        expect([raw(e, 'E3'), raw(e, 'I3'), raw(e, 'E4')]).toEqual(['', '', 'z'])
    })

    it('formatting applies to every cell of the selection in one undo step', () => {
        const e = createEngine(10, 10)
        e.setStyleRange({ r1: 0, c1: 0, r2: 1, c2: 1 }, { bold: true, align: 'right' })
        expect([e.getStyle(0, 0).bold, e.getStyle(1, 1).align]).toEqual([true, 'right'])
        e.undo()
        expect([e.getStyle(0, 0).bold, e.getStyle(1, 1).align]).toEqual([false, 'left'])
    })

    it('getUsedRange covers all non-empty cells (Ctrl+A)', () => {
        const e = sales()
        expect(e.getUsedRange()).toEqual({ r1: 0, c1: 0, r2: 32, c2: 9 })
        expect(createEngine(5, 5).getUsedRange()).toBeNull()
    })

    it('styles move with their rows and columns', () => {
        const e = createEngine(10, 10)
        e.setCell(2, 2, 'x')
        e.setStyleRange({ r1: 2, c1: 2, r2: 2, c2: 2 }, { bold: true })
        e.insertRow(0)
        expect(e.getStyle(3, 2).bold).toBe(true)
        e.insertColumn(0)
        expect(e.getStyle(3, 3).bold).toBe(true)
        e.undo(); e.undo()
        expect(e.getStyle(2, 2).bold).toBe(true)
        expect(e.getStyle(3, 2).bold).toBe(false)
    })

    it('loading a sample is one undo step', () => {
        const e = sales()
        e.undo()
        expect(raw(e, 'A1')).toBe('')
        expect(e.canUndo()).toBe(false)
    })
})

describe('references after row/column insert and delete', () => {
    it('insert shifts relative, absolute and mixed references', () => {
        expect(shiftReferencesForStructure('=$G$2*H33+G$2+$H33', 'row', 9, 1)).toBe('=$G$2*H34+G$2+$H34')
        expect(shiftReferencesForStructure('=$G$12+G$12', 'row', 9, 1)).toBe('=$G$13+G$13')
        expect(shiftReferencesForStructure('=A1+B1', 'col', 1, 1)).toBe('=A1+C1')
    })

    it('ranges: a range spanning the edit grows; one entirely above is untouched', () => {
        expect(shiftReferencesForStructure('=SUM(J2:J32)', 'row', 9, 1)).toBe('=SUM(J2:J33)')
        expect(shiftReferencesForStructure('=SUM(J2:J5)', 'row', 9, 1)).toBe('=SUM(J2:J5)')
        expect(shiftReferencesForStructure('=SUM(J12:J32)', 'row', 9, 1)).toBe('=SUM(J13:J33)')
    })

    it('delete: references to the deleted line become #REF!, ranges shrink', () => {
        expect(shiftReferencesForStructure('=A5+A9', 'row', 4, -1)).toBe('=#REF!+A8')
        expect(shiftReferencesForStructure('=SUM(A2:A9)', 'row', 4, -1)).toBe('=SUM(A2:A8)')
    })

    it('engine: SUM over a block grows with an inserted row and still computes', () => {
        const e = createEngine(20, 5)
        for (let i = 0; i < 5; i++) e.setCell(i, 0, '10')
        e.setCell(6, 0, '=SUM(A1:A5)')
        e.insertRow(2)
        expect(raw(e, 'A8')).toBe('=SUM(A1:A6)')
        expect(e.getCell(7, 0).computed).toBe(50)
        e.setCell(2, 0, '5') // the new row is inside the range
        expect(e.getCell(7, 0).computed).toBe(55)
    })

    it('undo of an insert restores formulas, dimensions and styles', () => {
        const e = createEngine(10, 10)
        e.setCell(0, 0, '1'); e.setCell(1, 0, '=A1+1')
        e.insertRow(0)
        e.undo()
        expect(raw(e, 'A2')).toBe('=A1+1')
        expect(e.rows).toBe(10)
        e.redo()
        expect(raw(e, 'A3')).toBe('=A2+1')
        expect(e.rows).toBe(11)
    })
})

describe('evaluator fixes needed by Task 1', () => {
    it('ranges, absolute references and range edits evaluate', () => {
        const e = createEngine(10, 5)
        e.setCell(0, 0, '10'); e.setCell(1, 0, '20')
        e.setCell(2, 0, '=SUM(A1:A2)*2')
        e.setCell(3, 0, '=$A$1+A$2+$A2')
        expect(e.getCell(2, 0).computed).toBe(60)
        expect(e.getCell(3, 0).computed).toBe(50)
        e.setCell(1, 0, '30')
        expect(e.getCell(2, 0).computed).toBe(80) // interior edit dirties the range
    })

    it('dates are text, not the number their first digits spell', () => {
        const e = createEngine(5, 5)
        e.setCell(0, 0, '2024-01-03')
        e.setCell(1, 0, '1/8/2024')
        expect(e.getCell(0, 0).computed).toBe('2024-01-03')
        expect(e.getCell(1, 0).computed).toBe('1/8/2024')
    })

    it('a long dependency chain recalculates', () => {
        const e = createEngine(6000, 2)
        e.setCell(0, 0, '1')
        e.setCell(1, 0, '=A1+1')
        e.fillRange({ r1: 1, c1: 0, r2: 1, c2: 0 }, { r1: 1, c1: 0, r2: 4999, c2: 0 })
        expect(e.getCell(4999, 0).computed).toBe(5000)
        e.setCell(0, 0, '11')
        expect(e.getCell(4999, 0).computed).toBe(5010)
    })
})

describe('cycles and long chains', () => {
    it('detects a three-cell cycle and recovers when it is broken', () => {
        const e = createEngine(5, 5)
        e.setCell(0, 0, '=B1')
        e.setCell(0, 1, '=C1')
        e.setCell(0, 2, '=A1')
        expect(e.getCell(0, 2).error).toBe('#CYCLE!')
        e.setCell(0, 2, '7')
        expect(e.getCell(0, 0).computed).toBe(7)
    })

    it('undo and redo of a 5,000-cell chain fill are correct', () => {
        const e = createEngine(6000, 2)
        e.setCell(0, 0, '1')
        e.setCell(1, 0, '=A1+1')
        e.fillRange({ r1: 1, c1: 0, r2: 1, c2: 0 }, { r1: 1, c1: 0, r2: 4999, c2: 0 })
        e.undo()
        expect(e.getCell(2, 0).raw).toBe('')
        expect(e.getCell(1, 0).computed).toBe(2)
        e.redo()
        expect(e.getCell(4999, 0).computed).toBe(5000)
    })
})
