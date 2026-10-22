// Fill benchmark. Usage:   npm run bench
// Bundles + minifies the engine with the same toolchain as the production build
// (Vite/Rollup, minify on), then times fillRange in Node. Reports the median of
// RUNS runs after WARMUP discarded runs.
import { build } from 'vite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const WARMUP = 5
const RUNS = 25
const BUDGET_MS = 200

const dir = mkdtempSync(join(tmpdir(), 'fillbench-'))
const out = join(dir, 'engine.mjs')
await build({
    configFile: false,
    logLevel: 'silent',
    build: {
        lib: { entry: 'src/engine/core.js', formats: ['es'], fileName: () => 'engine.mjs' },
        outDir: dir,
        minify: true,
        emptyOutDir: false,
    },
})
const { createEngine } = await import(pathToFileURL(out).href)

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

const scenarios = [
    {
        name: 'numbers 1,2 -> 5,000 cells down',
        setup(e) { e.setCell(0, 0, '1'); e.setCell(1, 0, '2') },
        fill: (e) => e.fillRange({ r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 0, c1: 0, r2: 5001, c2: 0 }),
    },
    {
        name: 'text ORD-1001,1002 -> 5,000 cells down',
        setup(e) { e.setCell(0, 0, 'ORD-1001'); e.setCell(1, 0, 'ORD-1002') },
        fill: (e) => e.fillRange({ r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 0, c1: 0, r2: 5001, c2: 0 }),
    },
    {
        name: 'dates (ISO) -> 5,000 cells down',
        setup(e) { e.setCell(0, 0, '2024-01-03'); e.setCell(1, 0, '2024-01-05') },
        fill: (e) => e.fillRange({ r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 0, c1: 0, r2: 5001, c2: 0 }),
    },
    {
        name: 'formulas =G*H and =$G$1*H, 2 cols x 2,500 rows = 5,000 cells',
        setup(e) {
            for (let r = 0; r < 2500; r++) { e.setCell(r, 6, String(r % 40 + 1)); e.setCell(r, 7, String(r % 7 + 1)) }
            e.setCell(0, 10, '=G1*H1'); e.setCell(0, 11, '=$G$1*H1')
        },
        fill: (e) => e.fillRange({ r1: 0, c1: 10, r2: 0, c2: 11 }, { r1: 0, c1: 10, r2: 2499, c2: 11 }),
    },
    {
        name: 'dependency chain =A1+1, 5,000 cells down (worst case for recalculation)',
        setup(e) { e.setCell(0, 0, '1'); e.setCell(1, 0, '=A1+1') },
        fill: (e) => e.fillRange({ r1: 1, c1: 0, r2: 1, c2: 0 }, { r1: 1, c1: 0, r2: 5000, c2: 0 }),
    },
    {
        name: 'styled seeds, 5,000 cells down',
        setup(e) {
            e.setCell(0, 0, '1'); e.setCell(1, 0, '2')
            e.setStyleRange({ r1: 0, c1: 0, r2: 0, c2: 0 }, { bold: true, bg: '#ffff99' })
        },
        fill: (e) => e.fillRange({ r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 0, c1: 0, r2: 5001, c2: 0 }),
    },
]

console.log(`node ${process.version}, ${process.platform}/${process.arch}, ${WARMUP} warm-up + ${RUNS} timed runs, budget ${BUDGET_MS} ms\n`)
const rows = []
let worst = 0
for (const sc of scenarios) {
    const fillTimes = []
    const readTimes = []
    const undoTimes = []
    for (let i = 0; i < WARMUP + RUNS; i++) {
        const e = createEngine(6000, 20)
        sc.setup(e)
        const t0 = performance.now()
        sc.fill(e)
        const t1 = performance.now()
        // what the UI does next: read every filled cell back
        let sink = 0
        for (let r = 0; r < 5002; r++) sink += String(e.getCell(r, 0).computed).length
        const t2 = performance.now()
        e.undo()
        const t3 = performance.now()
        if (sink < 0) console.log(sink)
        if (i >= WARMUP) { fillTimes.push(t1 - t0); readTimes.push(t2 - t1); undoTimes.push(t3 - t2) }
    }
    const m = median(fillTimes)
    worst = Math.max(worst, m)
    rows.push({ scenario: sc.name, 'fill median ms': +m.toFixed(1), 'fill max ms': +Math.max(...fillTimes).toFixed(1), 'read-back ms': +median(readTimes).toFixed(1), 'undo ms': +median(undoTimes).toFixed(1) })
}
console.table(rows)
console.log(worst < BUDGET_MS ? `PASS: slowest median ${worst.toFixed(1)} ms < ${BUDGET_MS} ms` : `FAIL: slowest median ${worst.toFixed(1)} ms >= ${BUDGET_MS} ms`)
process.exit(worst < BUDGET_MS ? 0 : 1)
