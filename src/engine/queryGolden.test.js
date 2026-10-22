import { describe, it, expect } from 'vitest'
import { createEngine } from './core.js'
import { executeQuery } from './queryExecutor.js'
import { parseAndValidateAction } from '../ai/validator.js'
import { loadSampleLarge } from '../fixtures/loadSample.js'
import queriesData from '../../fixtures/ai-eval/queries.json'

describe('AI Query Golden Evaluation', () => {
    // Set up engine with sales-large.tsv
    const engine = createEngine(3500, 30)
    loadSampleLarge(engine)

    for (const testCase of queriesData.cases) {
        it(`evaluates ${testCase.id}: "${testCase.prompt}"`, () => {
            const plan = testCase.plan

            // 1. Validator test if plan is non-query
            if (plan.type !== 'query') {
                const validation = parseAndValidateAction(JSON.stringify(plan))
                expect(validation.ok).toBe(false)
                expect(validation.error).toBe(testCase.expect.error)
                return
            }

            // 2. Query execution test
            const result = executeQuery(engine, plan)

            // If an error is expected
            if (testCase.expect.error) {
                expect(result.error).toBe(testCase.expect.error)
                if (testCase.expect.detail) {
                    expect(result.detail).toBe(testCase.expect.detail)
                }
                return
            }

            // Normal successful execution: check columns
            expect(result.columns).toEqual(testCase.expect.columns)
            expect(result.rowCount).toBe(testCase.expect.rowCount)
            expect(result.truncated).toBe(testCase.expect.truncated)

            // Check preview or exact rows
            const expectedRows = testCase.expect.rows ?? testCase.expect.rowsPreview
            expect(expectedRows).toBeDefined()

            for (let r = 0; r < expectedRows.length; r++) {
                const expRow = expectedRows[r]
                const actRow = result.rows[r]
                expect(actRow).toBeDefined()

                for (let c = 0; c < expRow.length; c++) {
                    const expVal = expRow[c]
                    const actVal = actRow[c]

                    if (typeof expVal === 'number') {
                        expect(actVal).toBeCloseTo(expVal, 2)
                    } else {
                        expect(actVal).toBe(expVal)
                    }
                }
            }
        })
    }
})
