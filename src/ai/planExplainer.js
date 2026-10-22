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

/**
 * Formats a style summary chunk (e.g. "bold, grey")
 * @param {object} s
 * @returns {string}
 */
function describeStyle(s) {
    if (!s) return ''
    const traits = []
    if (s.bold) traits.push('bold')
    if (s.italic) traits.push('italic')
    if (s.underline) traits.push('underline')
    if (s.bg) {
        if (s.bg === 'white') traits.push('white background')
        else if (s.bg === '#f0f0f0') traits.push('grey background')
        else if (s.bg === '#cce5ff') traits.push('blue background')
        else if (s.bg === '#ffff99') traits.push('yellow background')
        else traits.push(`background ${s.bg}`)
    }
    if (s.color) traits.push(`text ${s.color}`)
    if (s.align) traits.push(`${s.align}-aligned`)
    if (s.fontSize) traits.push(`font size ${s.fontSize}`)
    if (s.numberFormat && s.numberFormat !== 'general') traits.push(`${s.numberFormat} format`)
    return traits.join(', ')
}

/**
 * Generates a concise, plain-English preview description of a format_sheet action.
 * Example requirement:
 * "header: bold, grey; 4 columns: number formats; freeze 1 row; totals row: bold"
 *
 * @param {object} action
 * @returns {string}
 */
export function summarizeFormatPlan(action) {
    if (!action) return ''
    if (action.type !== 'format_sheet') return `Action: ${action.type}`

    const parts = []

    if (action.clearFormatting) {
        parts.push('clear existing formatting')
    }

    if (action.headerStyle) {
        const desc = describeStyle(action.headerStyle)
        parts.push(`header: ${desc || 'styled'}`)
    }

    if (action.bodyStyle) {
        const desc = describeStyle(action.bodyStyle)
        parts.push(`body: ${desc || 'styled'}`)
    }

    if (Array.isArray(action.columns) && action.columns.length > 0) {
        const numFormats = action.columns.filter(c => c.style?.numberFormat)
        const alignments = action.columns.filter(c => c.style?.align)
        if (numFormats.length > 0 && alignments.length > 0) {
            parts.push(`${action.columns.length} columns: formats & alignments`)
        } else if (numFormats.length > 0) {
            parts.push(`${numFormats.length} columns: number formats`)
        } else if (alignments.length > 0) {
            parts.push(`${alignments.length} columns: aligned`)
        } else {
            parts.push(`${action.columns.length} columns formatted`)
        }
    }

    if (action.totalsStyle) {
        const desc = describeStyle(action.totalsStyle)
        parts.push(`totals row: ${desc || 'styled'}`)
    }

    if (action.freezeRows !== undefined && action.freezeRows !== null) {
        if (action.freezeRows === 0) {
            parts.push('unfreeze rows')
        } else {
            parts.push(`freeze ${action.freezeRows} row${action.freezeRows > 1 ? 's' : ''}`)
        }
    }

    if (Array.isArray(action.columnWidths) && action.columnWidths.length > 0) {
        parts.push(`resize ${action.columnWidths.length} column${action.columnWidths.length > 1 ? 's' : ''}`)
    }

    if (action.autoFitColumns) {
        parts.push('auto-fit column widths')
    }

    return parts.join('; ')
}

