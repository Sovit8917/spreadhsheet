// ─────────────────────────────────────────────────────────────
//  Pure fill-series logic. No React, no DOM, no engine state.
//
//  buildFillValues(seeds, count, { axis, sign }) takes the raw contents of the
//  seed cells IN FILL ORDER (the seed nearest the target is last) and returns
//  the raw contents for the next `count` cells, plus which seed each one
//  inherits its style from.
// ─────────────────────────────────────────────────────────────

import { shiftFormula } from './refs.js'

const NUMBER_RE = /^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?\s*$/
// "$1,200.00", "10%", "1,234": formatted numbers are copied, never incremented.
const FORMATTED_NUMBER_RE = /^[-+]?\s*[$€£¥]?\s*[-+]?[\d,]*\.?\d+\s*%?$/
const TEXT_NUMBER_RE = /^(.*?)(\d+)$/

const MONTHS_SHORT = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MONTHS_LONG = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const DAYS_SHORT = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const DAYS_LONG = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
// Short lists first: a lone "May" continues as "Jun".
const NAME_LISTS = [MONTHS_SHORT, DAYS_SHORT, MONTHS_LONG, DAYS_LONG]

const MS_PER_DAY = 86400000

function isFormula(raw) {
    return typeof raw === 'string' && raw.startsWith('=')
}

export function isNumericString(raw) {
    return typeof raw === 'string' && NUMBER_RE.test(raw)
}

function formatNumber(x) {
    if (Number.isInteger(x)) return String(x)
    return String(+x.toFixed(10))
}

function mod(a, n) {
    return ((a % n) + n) % n
}

function titleCase(word) {
    return word.charAt(0).toUpperCase() + word.slice(1)
}

function detectCase(text) {
    if (text === text.toUpperCase()) return 'upper'
    if (text === text.toLowerCase()) return 'lower'
    return 'title'
}

function applyCase(word, mode) {
    if (mode === 'upper') return word.toUpperCase()
    if (mode === 'lower') return word.toLowerCase()
    return titleCase(word)
}

// ── Dates ──

function toDays(y, m, d) {
    // m is 1-based. Returns null for impossible dates such as 2024-02-31.
    const ms = Date.UTC(y, m - 1, d)
    const dt = new Date(ms)
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
    return Math.round(ms / MS_PER_DAY)
}

/** Parses 2024-01-15, 1/15/2024 (month first) and 15 Jan 2024. */
export function parseDate(text) {
    if (typeof text !== 'string') return null
    const s = text.trim()
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
    if (m) {
        const days = toDays(+m[1], +m[2], +m[3])
        if (days === null) return null
        return { days, fmt: { kind: 'iso', pad: m[2].length === 2 || m[3].length === 2 } }
    }
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s)
    if (m) {
        const days = toDays(+m[3], +m[1], +m[2])
        if (days === null) return null
        const pad = (m[1].length === 2 && m[1][0] === '0') || (m[2].length === 2 && m[2][0] === '0')
        return { days, fmt: { kind: 'us', pad } }
    }
    m = /^(\d{1,2}) ([A-Za-z]{3,9}) (\d{4})$/.exec(s)
    if (m) {
        const lower = m[2].toLowerCase()
        let month = MONTHS_LONG.indexOf(lower)
        let long = true
        if (month < 0) {
            month = MONTHS_SHORT.indexOf(lower)
            long = false
        }
        if (month < 0) return null
        const days = toDays(+m[3], month + 1, +m[1])
        if (days === null) return null
        return { days, fmt: { kind: 'dmy', long, pad: m[1].length === 2 && m[1][0] === '0', caseMode: detectCase(m[2]) } }
    }
    return null
}

export function formatDate(days, fmt) {
    const dt = new Date(days * MS_PER_DAY)
    const y = dt.getUTCFullYear()
    const mo = dt.getUTCMonth() + 1
    const d = dt.getUTCDate()
    const two = (n) => String(n).padStart(2, '0')
    if (fmt.kind === 'iso') return `${y}-${fmt.pad ? two(mo) : mo}-${fmt.pad ? two(d) : d}`
    if (fmt.kind === 'us') return `${fmt.pad ? two(mo) : mo}/${fmt.pad ? two(d) : d}/${y}`
    const name = applyCase((fmt.long ? MONTHS_LONG : MONTHS_SHORT)[mo - 1], fmt.caseMode)
    return `${fmt.pad ? two(d) : d} ${name} ${y}`
}

// ── Series builders. Each returns an array of `count` raw strings or null. ──

function cycleCopy(seeds, count) {
    const out = new Array(count)
    for (let k = 1; k <= count; k++) out[k - 1] = seeds[(k - 1) % seeds.length]
    return out
}

function formulaSeries(seeds, count, axis, sign) {
    const n = seeds.length
    const out = new Array(count)
    for (let k = 1; k <= count; k++) {
        const j = (k - 1) % n
        const steps = (k - j + n - 1) * sign
        out[k - 1] = shiftFormula(seeds[j], axis === 'row' ? steps : 0, axis === 'col' ? steps : 0)
    }
    return out
}

function numberSeries(seeds, count) {
    if (!seeds.every(isNumericString)) return null
    // zero-padded digits ("001") are handled by the text+number rule instead
    if (seeds.some((s) => /^\s*[-+]?0\d/.test(s))) return null
    const nums = seeds.map(Number)
    const n = nums.length
    const step = n >= 2 ? nums[n - 1] - nums[n - 2] : 0
    if (step === 0) return cycleCopy(seeds, count)
    const out = new Array(count)
    for (let k = 1; k <= count; k++) out[k - 1] = formatNumber(nums[n - 1] + step * k)
    return out
}

function dateSeries(seeds, count) {
    const parsed = seeds.map(parseDate)
    if (parsed.some((p) => p === null)) return null
    const n = parsed.length
    const step = n >= 2 ? parsed[n - 1].days - parsed[n - 2].days : 1
    const out = new Array(count)
    for (let k = 1; k <= count; k++) {
        out[k - 1] = formatDate(parsed[n - 1].days + step * k, parsed[(k - 1) % n].fmt)
    }
    return out
}

function nameSeries(seeds, count) {
    const lowered = seeds.map((s) => s.trim().toLowerCase())
    const list = NAME_LISTS.find((l) => lowered.every((s) => l.includes(s)))
    if (!list) return null
    const idx = lowered.map((s) => list.indexOf(s))
    const n = idx.length
    const step = n >= 2 ? mod(idx[n - 1] - idx[n - 2], list.length) : 1
    if (step === 0) return cycleCopy(seeds, count)
    const modes = seeds.map((s) => detectCase(s.trim()))
    const out = new Array(count)
    for (let k = 1; k <= count; k++) {
        out[k - 1] = applyCase(list[mod(idx[n - 1] + step * k, list.length)], modes[(k - 1) % n])
    }
    return out
}

function textNumberSeries(seeds, count) {
    if (seeds.some((s) => FORMATTED_NUMBER_RE.test(s) && !/^\s*[-+]?0\d/.test(s))) return null
    const parts = seeds.map((s) => TEXT_NUMBER_RE.exec(s))
    if (parts.some((p) => p === null)) return null
    const prefix = parts[0][1]
    if (parts.some((p) => p[1] !== prefix)) return null
    const nums = parts.map((p) => parseInt(p[2], 10))
    const n = nums.length
    // keep zero padding: "01" -> "02", "007" -> "008"
    let width = 0
    for (const p of parts) {
        if (p[2].length > 1 && p[2][0] === '0') width = Math.max(width, p[2].length)
    }
    let step = n >= 2 ? nums[n - 1] - nums[n - 2] : 1
    // a lone bare number ("001") is a copy; "Item 1" is a series
    if (n === 1 && prefix === '') step = 0
    if (step === 0) return cycleCopy(seeds, count)
    const out = new Array(count)
    for (let k = 1; k <= count; k++) {
        const value = nums[n - 1] + step * k
        const digits = value < 0 ? '-' + String(-value).padStart(width, '0') : String(value).padStart(width, '0')
        out[k - 1] = prefix + digits
    }
    return out
}

/**
 * @param seeds  raw strings of the seed cells in fill order (nearest-to-target last)
 * @param count  number of cells to produce
 * @param opts   { axis: 'row' | 'col', sign: 1 | -1 }
 *               axis: the direction of fill; sign: +1 for down/right, -1 for up/left
 *               (only used to shift formula references)
 * @returns      array of `count` raw strings; entry k is derived from the
 *               seed at index k % seeds.length for style inheritance.
 */
export function buildFillValues(seeds, count, { axis = 'row', sign = 1 } = {}) {
    if (count <= 0 || seeds.length === 0) return []
    if (seeds.every((s) => s === '' || s === undefined)) return new Array(count).fill('')
    if (seeds.some(isFormula)) return formulaSeries(seeds, count, axis, sign)
    // empty seeds mixed with content: no series, plain cycle
    if (seeds.some((s) => s === '')) return cycleCopy(seeds, count)
    return (
        numberSeries(seeds, count) ||
        dateSeries(seeds, count) ||
        nameSeries(seeds, count) ||
        textNumberSeries(seeds, count) ||
        cycleCopy(seeds, count)
    )
}
