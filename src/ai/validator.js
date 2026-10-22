import { ACTION_TYPES, FILTER_OPS, AGGREGATE_FNS } from './contract.js'

/**
 * Extracts JSON text from raw model output that may include prose and code fences.
 * Finds the first balanced `{ ... }` block.
 * @param {string} raw
 * @returns {string}
 */
export function extractJsonFromText(raw) {
    if (!raw || typeof raw !== 'string') return ''
    const str = raw.trim()

    // 1. Check if enclosed in markdown code fences ```json ... ``` or ``` ... ```
    const fenceMatch = str.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fenceMatch && fenceMatch[1]) {
        const candidate = fenceMatch[1].trim()
        if (candidate.startsWith('{') && candidate.endsWith('}')) {
            return candidate
        }
    }

    // 2. Scan for first balanced JSON object { ... }
    let startIdx = str.indexOf('{')
    while (startIdx !== -1) {
        let depth = 0
        let inString = false
        let escape = false
        for (let i = startIdx; i < str.length; i++) {
            const ch = str[i]
            if (inString) {
                if (escape) {
                    escape = false
                } else if (ch === '\\') {
                    escape = true
                } else if (ch === '"') {
                    inString = false
                }
            } else {
                if (ch === '"') {
                    inString = true
                } else if (ch === '{') {
                    depth++
                } else if (ch === '}') {
                    depth--
                    if (depth === 0) {
                        return str.slice(startIdx, i + 1)
                    }
                }
            }
        }
        startIdx = str.indexOf('{', startIdx + 1)
    }

    return str
}

/**
 * Parses and validates an action JSON string against AI_CONTRACT.md.
 * Returns { ok: true, action } or { ok: false, error: 'INVALID_RESPONSE' | 'READ_ONLY', detail: string }
 * @param {string} rawText
 * @returns {{ ok: boolean, action?: any, error?: string, detail?: string }}
 */
export function parseAndValidateAction(rawText) {
    const jsonStr = extractJsonFromText(rawText)
    if (!jsonStr) {
        return {
            ok: false,
            error: 'INVALID_RESPONSE',
            detail: 'No JSON object found in response'
        }
    }

    let parsed
    try {
        parsed = JSON.parse(jsonStr)
    } catch (e) {
        return {
            ok: false,
            error: 'INVALID_RESPONSE',
            detail: `JSON parse error: ${e.message}`
        }
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
            ok: false,
            error: 'INVALID_RESPONSE',
            detail: 'Response must be a JSON object'
        }
    }

    // Guardrail: check action type
    const validTypes = Object.values(ACTION_TYPES)
    if (!parsed.type) {
        return {
            ok: false,
            error: 'INVALID_RESPONSE',
            detail: 'Missing action "type" property'
        }
    }

    if (!validTypes.includes(parsed.type)) {
        // Any other type (e.g. mutation) is rejected with READ_ONLY before execution
        return {
            ok: false,
            error: 'READ_ONLY',
            detail: `Action type "${parsed.type}" is not allowed in read-only mode`
        }
    }

    // Validate per action type
    if (parsed.type === ACTION_TYPES.CLARIFY) {
        if (typeof parsed.question !== 'string' || !parsed.question.trim()) {
            return {
                ok: false,
                error: 'INVALID_RESPONSE',
                detail: 'Clarify action must have a non-empty string "question"'
            }
        }
        return { ok: true, action: parsed }
    }

    if (parsed.type === ACTION_TYPES.QUERY) {
        const valRes = validateQueryPlan(parsed)
        if (!valRes.ok) {
            return {
                ok: false,
                error: 'INVALID_RESPONSE',
                detail: valRes.detail
            }
        }
        return { ok: true, action: parsed }
    }

    // Format sheet type (Challenge 5 or future)
    if (parsed.type === ACTION_TYPES.FORMAT_SHEET) {
        return { ok: true, action: parsed }
    }

    return {
        ok: false,
        error: 'INVALID_RESPONSE',
        detail: `Unknown action type: ${parsed.type}`
    }
}

/**
 * Validates QUERY plan against QUERY_PLAN_SCHEMA
 */
function validateQueryPlan(plan) {
    // Additional properties check on root
    const allowedRootProps = new Set([
        'type', 'excludeTotalsRow', 'filters', 'groupBy', 'aggregates', 'columns', 'sort', 'limit'
    ])
    for (const key of Object.keys(plan)) {
        if (!allowedRootProps.has(key)) {
            return { ok: false, detail: `Unexpected property "${key}" in query plan` }
        }
    }

    if (plan.excludeTotalsRow !== undefined && typeof plan.excludeTotalsRow !== 'boolean') {
        return { ok: false, detail: 'excludeTotalsRow must be a boolean' }
    }

    if (plan.filters !== undefined) {
        if (!Array.isArray(plan.filters)) {
            return { ok: false, detail: 'filters must be an array' }
        }
        for (let i = 0; i < plan.filters.length; i++) {
            const f = plan.filters[i]
            if (!f || typeof f !== 'object' || Array.isArray(f)) {
                return { ok: false, detail: `Filter at index ${i} must be an object` }
            }
            if (typeof f.column !== 'string' || !f.column.trim()) {
                return { ok: false, detail: `Filter at index ${i} missing "column"` }
            }
            if (!FILTER_OPS.includes(f.op)) {
                return { ok: false, detail: `Filter at index ${i} has invalid op: "${f.op}"` }
            }
            const allowedFilterProps = new Set(['column', 'op', 'value'])
            for (const key of Object.keys(f)) {
                if (!allowedFilterProps.has(key)) {
                    return { ok: false, detail: `Unexpected property "${key}" in filter at index ${i}` }
                }
            }
        }
    }

    if (plan.groupBy !== undefined) {
        if (!Array.isArray(plan.groupBy)) {
            return { ok: false, detail: 'groupBy must be an array' }
        }
        for (let i = 0; i < plan.groupBy.length; i++) {
            if (typeof plan.groupBy[i] !== 'string') {
                return { ok: false, detail: `groupBy[${i}] must be a string` }
            }
        }
    }

    if (plan.aggregates !== undefined) {
        if (!Array.isArray(plan.aggregates)) {
            return { ok: false, detail: 'aggregates must be an array' }
        }
        for (let i = 0; i < plan.aggregates.length; i++) {
            const agg = plan.aggregates[i]
            if (!agg || typeof agg !== 'object' || Array.isArray(agg)) {
                return { ok: false, detail: `Aggregate at index ${i} must be an object` }
            }
            if (!AGGREGATE_FNS.includes(agg.fn)) {
                return { ok: false, detail: `Aggregate at index ${i} has invalid fn: "${agg.fn}"` }
            }
            if (typeof agg.column !== 'string' || !agg.column.trim()) {
                return { ok: false, detail: `Aggregate at index ${i} missing "column"` }
            }
            if (agg.as !== undefined && typeof agg.as !== 'string') {
                return { ok: false, detail: `Aggregate at index ${i} "as" must be a string` }
            }
            const allowedAggProps = new Set(['fn', 'column', 'as'])
            for (const key of Object.keys(agg)) {
                if (!allowedAggProps.has(key)) {
                    return { ok: false, detail: `Unexpected property "${key}" in aggregate at index ${i}` }
                }
            }
        }
    }

    if (plan.columns !== undefined) {
        if (!Array.isArray(plan.columns)) {
            return { ok: false, detail: 'columns must be an array' }
        }
        for (let i = 0; i < plan.columns.length; i++) {
            if (typeof plan.columns[i] !== 'string') {
                return { ok: false, detail: `columns[${i}] must be a string` }
            }
        }
    }

    if (plan.sort !== undefined) {
        if (!Array.isArray(plan.sort)) {
            return { ok: false, detail: 'sort must be an array' }
        }
        for (let i = 0; i < plan.sort.length; i++) {
            const s = plan.sort[i]
            if (!s || typeof s !== 'object' || Array.isArray(s)) {
                return { ok: false, detail: `Sort entry at index ${i} must be an object` }
            }
            if (typeof s.column !== 'string' || !s.column.trim()) {
                return { ok: false, detail: `Sort entry at index ${i} missing "column"` }
            }
            if (s.dir !== undefined && s.dir !== 'asc' && s.dir !== 'desc') {
                return { ok: false, detail: `Sort entry at index ${i} dir must be "asc" or "desc"` }
            }
            const allowedSortProps = new Set(['column', 'dir'])
            for (const key of Object.keys(s)) {
                if (!allowedSortProps.has(key)) {
                    return { ok: false, detail: `Unexpected property "${key}" in sort entry at index ${i}` }
                }
            }
        }
    }

    if (plan.limit !== undefined) {
        if (!Number.isInteger(plan.limit) || plan.limit < 1) {
            return { ok: false, detail: 'limit must be a positive integer' }
        }
    }

    return { ok: true }
}
