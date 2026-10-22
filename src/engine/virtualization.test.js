import { describe, it, expect } from 'vitest'
import { createEngine } from './core.js'
import { createDimensionManager } from './dimensions.js'

describe('createDimensionManager', () => {
    it('initializes default sizes and prefix sums', () => {
        const dm = createDimensionManager(100, 25, 20)
        expect(dm.count).toBe(100)
        expect(dm.getSize(0)).toBe(25)
        expect(dm.getSize(99)).toBe(25)
        expect(dm.getOffset(0)).toBe(0)
        expect(dm.getOffset(1)).toBe(25)
        expect(dm.getOffset(10)).toBe(250)
        expect(dm.getTotalSize()).toBe(2500)
    })

    it('binary searches index at offset accurately', () => {
        const dm = createDimensionManager(100, 25, 20)
        expect(dm.findIndexAtOffset(0)).toBe(0)
        expect(dm.findIndexAtOffset(24)).toBe(0)
        expect(dm.findIndexAtOffset(25)).toBe(1)
        expect(dm.findIndexAtOffset(249)).toBe(9)
        expect(dm.findIndexAtOffset(250)).toBe(10)
    })

    it('handles variable sizes and updates prefix sums dynamically', () => {
        const dm = createDimensionManager(5, 20, 10)
        dm.setSize(1, 50)
        // Offsets: [0:0, 1:20, 2:70, 3:90, 4:110, total:130]
        expect(dm.getOffset(0)).toBe(0)
        expect(dm.getOffset(1)).toBe(20)
        expect(dm.getOffset(2)).toBe(70)
        expect(dm.getOffset(3)).toBe(90)
        expect(dm.getTotalSize()).toBe(130)

        expect(dm.findIndexAtOffset(15)).toBe(0)
        expect(dm.findIndexAtOffset(20)).toBe(1)
        expect(dm.findIndexAtOffset(69)).toBe(1)
        expect(dm.findIndexAtOffset(70)).toBe(2)
    })

    it('shifts custom sizes on insertion and deletion', () => {
        const dm = createDimensionManager(5, 20, 10)
        dm.setSize(2, 60)
        expect(dm.getSize(2)).toBe(60)

        // Insert at index 1 -> size at 2 should now be at index 3
        dm.insertAt(1)
        expect(dm.count).toBe(6)
        expect(dm.getSize(1)).toBe(20)
        expect(dm.getSize(2)).toBe(20)
        expect(dm.getSize(3)).toBe(60)

        // Delete at index 1 -> size at 3 moves back to index 2
        dm.deleteAt(1)
        expect(dm.count).toBe(5)
        expect(dm.getSize(2)).toBe(60)
    })

    it('scales to 100,000 items efficiently', () => {
        const t0 = performance.now()
        const dm = createDimensionManager(100000, 24, 20)
        dm.setSize(50000, 100)
        const total = dm.getTotalSize()
        const offset = dm.getOffset(95000)
        const found = dm.findIndexAtOffset(offset + 10)
        const t1 = performance.now()

        expect(total).toBe(100000 * 24 + (100 - 24))
        expect(found).toBe(95000)
        expect(t1 - t0).toBeLessThan(50) // Prefix sum rebuild for 100k items < 50ms
    })
})

describe('engine Task 3 virtualization and sizing', () => {
    it('supports row and column resizing with single undo step', () => {
        const engine = createEngine(10, 10)
        expect(engine.getColumnWidth(3)).toBe(100)
        engine.setColumnWidth(3, 300)
        expect(engine.getColumnWidth(3)).toBe(300)

        engine.undo()
        expect(engine.getColumnWidth(3)).toBe(100)
        engine.redo()
        expect(engine.getColumnWidth(3)).toBe(300)
    })

    it('preserves column width when inserting a column before it', () => {
        const engine = createEngine(10, 10)
        // Col D is index 3
        engine.setColumnWidth(3, 300)
        expect(engine.getColumnWidth(3)).toBe(300)

        // Insert column before D (at index 3)
        engine.insertColumn(3)
        // New column at index 3 has default width 100
        expect(engine.getColumnWidth(3)).toBe(100)
        // Old D moved to index 4 and kept 300px
        expect(engine.getColumnWidth(4)).toBe(300)

        // Undo restores D to index 3 with 300px
        engine.undo()
        expect(engine.getColumnWidth(3)).toBe(300)
    })

    it('preserves absolute references ($G$2, $G2, G$2) when inserting rows', () => {
        const engine = createEngine(50, 20)
        engine.setCell(1, 6, '10') // G2
        engine.setCell(1, 7, '5')  // H2
        engine.setCell(1, 10, '=G2*H2') // K2
        engine.setCell(1, 11, '=$G$2*H2') // L2

        expect(engine.getCell(1, 10).computed).toBe(50)
        expect(engine.getCell(1, 11).computed).toBe(50)

        // Insert row above row 10 (atIndex 9)
        engine.insertRow(9)

        // L2 formula unchanged ($G$2 stays $G$2, H2 stays H2)
        expect(engine.getCell(1, 11).raw).toBe('=$G$2*H2')

        // If we set L32 (row 31) to '=$G$2*H32' and insert row above 10 (index 9)
        engine.setCell(31, 11, '=$G$2*H32')
        engine.insertRow(9)
        // Row 31 moved to 32 (displayed as 33) and H32 shifted to H33, while $G$2 stayed pinned
        expect(engine.getCell(32, 11).raw).toBe('=$G$2*H33')
    })

    it('can scale to 100,000 rows without allocating cells', () => {
        const engine = createEngine(50, 50)
        engine.ensureCapacity(100000, 200)
        expect(engine.rows).toBe(100000)
        expect(engine.cols).toBe(200)

        // Set cell at row 95,000
        engine.setCell(94999, 9, '42') // J95000
        expect(engine.getCell(94999, 9).computed).toBe(42)
        expect(engine.findRowAtOffset(engine.getRowOffset(94999) + 5)).toBe(94999)
    })

    it('recalculates only dependent cells on edit and meets keystroke latency budget', () => {
        const engine = createEngine(100000, 20)

        // Populate 50,000 cells
        for (let r = 0; r < 50000; r++) {
            engine.setCell(r, 0, String(r)) // A(r+1) = r
        }

        // Dependent cell in column B
        engine.setCell(95000, 1, '=A95001*2') // B95001 depends on A95001
        expect(engine.getCell(95000, 1).computed).toBe(190002)

        // Edit cell A95001 and measure recalculation & keystroke latency
        const t0 = performance.now()
        engine.setCell(95000, 0, '100')
        const t1 = performance.now()
        const latency = t1 - t0

        expect(engine.getCell(95000, 1).computed).toBe(200)
        // With sparse dirty tracking and topological sort over only dirty cells,
        // editing one cell among 50,000 completes in under 16 ms.
        expect(latency).toBeLessThan(16)
    })
})

