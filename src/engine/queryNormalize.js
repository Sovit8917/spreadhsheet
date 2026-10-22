// ─────────────────────────────────────────────────────────────
//  Normalisation helpers according to AI_CONTRACT.md §3.2
// ─────────────────────────────────────────────────────────────

/**
 * Text key norm(v): String(v).trim().toLowerCase().
 * Used for eq/neq/contains/startsWith/endsWith, group-by keys and countDistinct.
 */
export function norm(v) {
    if (v === null || v === undefined) return ''
    return String(v).trim().toLowerCase()
}

/**
 * Number toNum(v): trim; note a trailing %; strip $ , % and whitespace;
 * the remainder must match ^-?\d+(\.\d+)?$, otherwise it is not a number (null);
 * a trailing % divides by 100.
 * So $1,200.00 -> 1200, 10% -> 0.1, 0.1 -> 0.1, $ 49.99 -> 49.99, N/A -> null, n/a -> null, '' -> null.
 */
export function toNum(v) {
    if (v === null || v === undefined) return null
    const s = String(v).trim()
    if (!s) return null
    const hasTrailingPercent = s.endsWith('%')
    // Strip $, ,, %, and whitespace
    const stripped = s.replace(/[\$,%\s]/g, '')
    if (!/^-?\d+(\.\d+)?$/.test(stripped)) {
        return null
    }
    const num = parseFloat(stripped)
    if (isNaN(num)) return null
    return hasTrailingPercent ? num / 100 : num
}

const MONTH_NAMES = {
    jan: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12
}

/**
 * Date toDate(v): accepts YYYY-M-D, M/D/YYYY, D Mon YYYY (English month, three or more letters);
 * returns the ISO day YYYY-MM-DD or null.
 * Comparisons are on that string.
 */
export function toDate(v) {
    if (v === null || v === undefined) return null
    const s = String(v).trim()
    if (!s) return null

    // Pattern 1: YYYY-M-D or YYYY-MM-DD
    const mIso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
    if (mIso) {
        const y = parseInt(mIso[1], 10)
        const m = parseInt(mIso[2], 10)
        const d = parseInt(mIso[3], 10)
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
            return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
        }
    }

    // Pattern 2: M/D/YYYY or MM/DD/YYYY
    const mSlash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
    if (mSlash) {
        const m = parseInt(mSlash[1], 10)
        const d = parseInt(mSlash[2], 10)
        const y = parseInt(mSlash[3], 10)
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
            return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
        }
    }

    // Pattern 3: D Mon YYYY (e.g. 15 Jan 2024, 21 Jul 2024)
    const mMon = s.match(/^(\d{1,2})\s+([a-zA-Z]{3,})\s+(\d{4})$/)
    if (mMon) {
        const d = parseInt(mMon[1], 10)
        const monStr = mMon[2].toLowerCase()
        const y = parseInt(mMon[3], 10)
        const m = MONTH_NAMES[monStr]
        if (m && d >= 1 && d <= 31) {
            return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
        }
    }

    return null
}
