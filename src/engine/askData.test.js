import { describe, it, expect } from 'vitest'
import { createEngine } from './core.js'
import { executeQuery } from './queryExecutor.js'
import { parseAndValidateAction } from '../ai/validator.js'
import { loadSampleLarge } from '../fixtures/loadSample.js'

describe('Challenge 4 Unit & Performance Budgets', () => {
    it('enforces limit capped at 500 even when plan requests more', () => {
        const engine = createEngine(1000, 10)
        engine.setCell(0, 0, 'Val')
        for (let i = 1; i <= 600; i++) {
            engine.setCell(i, 0, String(i))
        }

        const res = executeQuery(engine, {
            type: 'query',
            limit: 1000
        })

        expect(res.rowCount).toBe(500)
        expect(res.truncated).toBe(true)
    })

    it('rejects unknown column with UNKNOWN_COLUMN and asks user', () => {
        const engine = createEngine(10, 5)
        engine.setCell(0, 0, 'Region')
        engine.setCell(0, 1, 'Total')

        const res = executeQuery(engine, {
            type: 'query',
            filters: [{ column: 'Territory', op: 'eq', value: 'West' }]
        })

        expect(res.error).toBe('UNKNOWN_COLUMN')
        expect(res.detail).toContain('UNKNOWN_COLUMN:Territory')
    })

    it('rejects mutations with READ_ONLY guardrail', () => {
        const validation = parseAndValidateAction(JSON.stringify({
            type: 'mutation',
            action: 'deleteRows'
        }))

        expect(validation.ok).toBe(false)
        expect(validation.error).toBe('READ_ONLY')
    })

    it('handles one-step undo and redo for insertValues', () => {
        const engine = createEngine(10, 10)
        engine.setCell(1, 1, 'Existing')

        const table = [
            ['Header1', 'Header2'],
            ['Val1', 'Val2'],
            ['Val3', 'Val4']
        ]

        engine.insertValues(1, 1, table)
        expect(engine.getCell(1, 1).raw).toBe('Header1')
        expect(engine.getCell(1, 2).raw).toBe('Header2')
        expect(engine.getCell(2, 1).raw).toBe('Val1')
        expect(engine.getCell(3, 2).raw).toBe('Val4')

        // One-step undo restores existing cell and clears inserted cells
        expect(engine.undo()).toBe(true)
        expect(engine.getCell(1, 1).raw).toBe('Existing')
        expect(engine.getCell(1, 2).raw).toBe('')
        expect(engine.getCell(2, 1).raw).toBe('')
        expect(engine.getCell(3, 2).raw).toBe('')

        // Redo restores table
        expect(engine.redo()).toBe(true)
        expect(engine.getCell(1, 1).raw).toBe('Header1')
        expect(engine.getCell(3, 2).raw).toBe('Val4')
    })

    it('executes golden plan over sales-large.tsv in under 50 ms budget', () => {
        const engine = createEngine(3500, 30)
        loadSampleLarge(engine)

        const plan = {
            type: 'query',
            groupBy: ['Region'],
            aggregates: [{ fn: 'sum', column: 'Total', as: 'Total Sales' }],
            sort: [{ column: 'Total Sales', dir: 'desc' }]
        }

        // Warm up
        executeQuery(engine, plan)

        const start = performance.now()
        const res = executeQuery(engine, plan)
        const duration = performance.now() - start

        expect(res.rowCount).toBe(5)
        expect(duration).toBeLessThan(50) // Budget: < 50 ms
    })

    it('executes two-level group-by over 100,000 generated rows in under 500 ms budget', () => {
        const engine = createEngine(100005, 10)
        engine.setCell(0, 0, 'Region')
        engine.setCell(0, 1, 'Category')
        engine.setCell(0, 2, 'Amount')

        const regions = ['North', 'South', 'East', 'West', 'Central']
        const categories = ['Electronics', 'Furniture', 'Accessories', 'Software']

        // Generate 100,000 data rows using insertValues in batches
        const BATCH_SIZE = 10000
        for (let b = 0; b < 10; b++) {
            const batch = []
            for (let i = 0; i < BATCH_SIZE; i++) {
                const reg = regions[(b * BATCH_SIZE + i) % regions.length]
                const cat = categories[(b * BATCH_SIZE + i) % categories.length]
                const amt = ((i % 100) + 1) * 10
                batch.push([reg, cat, amt])
            }
            engine.insertValues(1 + b * BATCH_SIZE, 0, batch)
        }

        const plan = {
            type: 'query',
            groupBy: ['Region', 'Category'],
            aggregates: [
                { fn: 'sum', column: 'Amount', as: 'Total Amount' },
                { fn: 'avg', column: 'Amount', as: 'Avg Amount' }
            ],
            sort: [{ column: 'Region', dir: 'asc' }]
        }

        const start = performance.now()
        const res = executeQuery(engine, plan)
        const duration = performance.now() - start

        expect(res.rowCount).toBe(20) // 5 regions * 4 categories
        expect(duration).toBeLessThan(500) // Budget: < 500 ms
    })
})
