// ─────────────────────────────────────────────────────────────
//  Number and Date formatting display according to AI_CONTRACT.md §4
//  Display rules for numberFormat (stored value never changes)
// ─────────────────────────────────────────────────────────────
import { toNum, toDate } from './queryNormalize.js'

/**
 * Formats a numeric value with commas and 2 decimals: e.g. 1200 -> "1,200.00"
 * @param {number} num
 * @returns {string}
 */
export function formatNumberWithDecimals(num) {
    return Number(num).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })
}

/**
 * Returns formatted display text for a given raw/computed value and numberFormat style.
 *
 * Contract §4 table:
 * | format   | '79'     | '$1,200.00' | '0.1'  | '10%'  | 'n/a' | '2024-01-15' / '1/15/2024' / '15 Jan 2024' |
 * | number   | 79.00    | 1,200.00    | 0.10   | 0.10   | n/a   | unchanged                                  |
 * | currency | $79.00   | $1,200.00   | $0.10  | $0.10  | n/a   | unchanged                                  |
 * | percent  | 7900%    | 120000%     | 10%    | 10%    | n/a   | unchanged                                  |
 * | date     | unch.    | unch.       | unch.  | unch.  | n/a   | 2024-01-15                                 |
 *
 * Non-numeric text is left alone.
 * Blank or empty string stays blank.
 *
 * @param {any} val Raw or computed value
 * @param {string} [format] 'general' | 'number' | 'currency' | 'percent' | 'date'
 * @returns {string}
 */
export function formatValueForDisplay(val, format) {
    if (val === null || val === undefined) return ''
    const str = String(val).trim()
    if (!str) return ''
    if (!format || format === 'general') return String(val)

    if (format === 'date') {
        const isoDate = toDate(str)
        if (isoDate !== null) {
            return isoDate
        }
        // Non-date text is left alone
        return String(val)
    }

    // Number formats: check if numeric via toNum
    // Special check: if string is a valid date (like 2024-01-15 or 1/15/2024),
    // date strings should remain unchanged under number/currency/percent formats!
    if (toDate(str) !== null) {
        return String(val)
    }

    const num = toNum(str)
    if (num === null) {
        // Non-numeric text (e.g. 'n/a', 'N/A', 'Laptop Pro') is left alone
        return String(val)
    }

    if (format === 'number') {
        return formatNumberWithDecimals(num)
    }

    if (format === 'currency') {
        return `$${formatNumberWithDecimals(num)}`
    }

    if (format === 'percent') {
        // e.g. 0.1 -> 10%, 10% (num=0.1) -> 10%, 79 -> 7900%
        // Notice round to avoid floating precision glitches like 0.1 * 100 = 10
        const pct = Math.round(num * 10000) / 100
        // If whole percent, format without trailing .00 (e.g. 10%, 7900%, 0%),
        // else with up to 2 decimals
        return Number.isInteger(pct) ? `${pct}%` : `${pct}%`
    }

    return String(val)
}
