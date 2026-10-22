/**
 * Generates a concise, plain-English summary of a query plan.
 * @param {object} plan
 * @returns {string}
 */
export function summarizePlan(plan) {
    if (!plan) return ''
    if (plan.type === 'clarify') {
        return plan.question || 'Needs clarification'
    }
    if (plan.type !== 'query') {
        return `Action: ${plan.type}`
    }

    const parts = []

    // 1. Aggregates & Grouping or Columns
    if (plan.aggregates && plan.aggregates.length > 0) {
        const aggTexts = plan.aggregates.map(a => {
            const alias = a.as ? ` as "${a.as}"` : ''
            return `${a.fn.toUpperCase()}(${a.column})${alias}`
        })
        parts.push(`Calculate ${aggTexts.join(', ')}`)

        if (plan.groupBy && plan.groupBy.length > 0) {
            parts.push(`grouped by ${plan.groupBy.join(', ')}`)
        }
    } else if (plan.columns && plan.columns.length > 0) {
        parts.push(`Select columns [${plan.columns.join(', ')}]`)
    } else {
        parts.push(`Select all columns`)
    }

    // 2. Filters
    if (plan.filters && plan.filters.length > 0) {
        const filterTexts = plan.filters.map(f => {
            let opStr = f.op
            if (f.op === 'eq') opStr = '='
            else if (f.op === 'neq') opStr = '≠'
            else if (f.op === 'gt') opStr = '>'
            else if (f.op === 'gte') opStr = '≥'
            else if (f.op === 'lt') opStr = '<'
            else if (f.op === 'lte') opStr = '≤'
            else if (f.op === 'isEmpty') return `"${f.column}" is empty`
            else if (f.op === 'notEmpty') return `"${f.column}" is not empty`
            else if (f.op === 'contains') opStr = 'contains'
            else if (f.op === 'startsWith') opStr = 'starts with'
            else if (f.op === 'endsWith') opStr = 'ends with'
            return `"${f.column}" ${opStr} ${JSON.stringify(f.value)}`
        })
        parts.push(`where ${filterTexts.join(' AND ')}`)
    }

    // 3. Sorting
    if (plan.sort && plan.sort.length > 0) {
        const sortTexts = plan.sort.map(s => `"${s.column}" ${s.dir || 'asc'}`)
        parts.push(`sorted by ${sortTexts.join(', ')}`)
    }

    // 4. Limit
    if (plan.limit !== undefined) {
        parts.push(`limited to ${Math.min(plan.limit, 500)} rows`)
    }

    return parts.join(' ')
}
