# Design notes

## Challenges

- **Challenge 1: Range selection and fill handle.** Implemented. Engine: `src/engine/core.js`, `refs.js`, `fill.js` (all pure, no React/DOM). UI: `src/App.jsx`, `src/App.css`. Tests: `src/engine/fill.test.js` (40 tests). Benchmark: `bench/fill.bench.mjs`.
- Challenges 2-5: not started in this change.

## Data model changes

- **Style store moved into the engine.** `styles: Map<cellKey, frozen style>` next to `cells`. Previously styles lived in React state (`cellStyles`), so undo could not restore them and they did not move on row/column insert. A cell with no entry uses the exported `DEFAULT_STYLE`. Stored styles are fully resolved and frozen (interned), so snapshots and fills share references instead of copying.
- **One write path.** Every value/style write goes through `commitChanges`, which builds a single `{type:'batch', changes:[{key,r,c,oldRaw,newRaw,oldStyle,newStyle}]}` undo entry and does one recalculation. `setCell` is now a one-change batch.
- **Snapshots** for structural undo are now `{cells, styles}` (styles move/undo with rows and columns).
- **Absolute references** (`$A$1`, `$A1`, `A$1`) are parsed everywhere (tokenizer, dependency extraction, structural shift, fill).
- Dependency graph now tracks **every cell inside a range**, not only its two endpoints.

## Engine API

Methods added to the object returned by `createEngine`. A range is `{r1,c1,r2,c2}` (0-based, inclusive).

- `setCells(changes, {keepNoOps?}) -> {changed}`: batch write. `changes` = `[{r,c,raw?,style?}]`; `raw`/`style` undefined = untouched, `style: null` clears, object replaces. Grows the grid if needed. No-op cells are skipped (an all-no-op batch makes no undo entry). **One undo reverts the whole batch.**
- `getStyle(r,c) -> style`: resolved style (`DEFAULT_STYLE` if none). Read-only.
- `setStyleRange(range, patch) -> {changed}`: merges `patch` into the style of every cell in the range. **One undo reverts all of it.**
- `clearRange(range, {styles?}) -> {changed}`: clears values (and styles when `styles:true`). Walks the smaller of range area / sparse store, so a whole-column clear is cheap. Clearing an already-empty range creates no undo entry. **One undo restores values (and styles).**
- `fillRange(source, target) -> {changed}`: the fill handle. `source` = seed range, `target` = whole rectangle after the drag.
  - target extends the source down / up / right / left: each column (vertical) or row (horizontal) of the source is filled independently from its own seeds.
  - target lies inside the source: **shrink**, i.e. source cells outside the target are cleared (value and style).
  - extending along two axes at once throws `RangeError` and changes nothing.
  - Seed styles are inherited cyclically. A fill always produces an undo entry even if it rewrote identical values. **One undo reverts the fill (values, styles, shrink-clears).**
- `getUsedRange() -> range | null`: bounding box of cells that have a value (used by Ctrl+A). Read-only.
- `insertRow/deleteRow/insertColumn/deleteColumn(index)`: unchanged signatures; now also move styles and rewrite references through `shiftReferencesForStructure`. **One undo reverts the structural edit** (cells, styles, formulas, dimensions).
- `setCell`, `undo`, `redo`, `canUndo`, `canRedo`, `ensureCapacity`, `getCell`: unchanged signatures.

Pure helpers (not on the engine object):

- `refs.js`: `shiftFormula(formula, dRow, dCol)` (relative parts move, `$` parts stay; off-sheet -> `#REF!`), `shiftReferencesForStructure(formula, axis, index, delta)` (insert/delete; pinned refs move too; ranges grow/shrink; reference to a deleted line -> `#REF!`), `extractCellReferences` (ranges expanded, `$` stripped), coordinate helpers.
- `fill.js`: `buildFillValues(seeds, count, {axis, sign})`, `parseDate`, `formatDate`.

### Fill rules (`fill.js`)

Applied per seed column/row, in this order:

1. Any formula seed: references shift by the distance between the seed and the target (cyclic over multiple seeds).
2. All seeds numeric: step = last seed minus the one before; one seed (or step 0) = copy.
3. All seeds dates (`2024-01-15`, `1/15/2024` month-first, `15 Jan 2024`): step in days = last delta; **one date seed steps +1 day**. Each filled cell takes the format of the seed it cycles from (so mixed seed formats are preserved).
4. All seeds weekday/month names (short or long): cycle by the last delta (one seed = +1), case preserved (`MON`, `mon`, `Mon`).
5. Text ending in a number with a common prefix (`Item 1`, `Q4`, `2024-W01`, `ORD-1001`): step = last delta (one seed = +1), zero padding preserved. Formatted numbers (`$1,200.00`, `10%`) are copied, not incremented.
6. Anything else: seeds repeat as a cycle.

Decisions where the spec is open: step is the **last delta**, not a regression; one date seed increments (spreadsheet convention) while one plain number copies (as the spec states); drag-back shrink clears values and styles; Ctrl+A selects the used range of **values** and includes the totals row; Delete clears values only, the toolbar "Clear selection" clears values + styles.

## Undo semantics

One `Ctrl+Z` (or the Undo button) reverts:

- **Fill**: the whole fill, including the cells a shrink cleared; values and styles.
- **Delete / Backspace on a selection**: the whole clear.
- **Formatting (bold, colour, size, ... on a selection)**: the whole selection's style change. (A colour picker emits one change per `input` event, so dragging inside it creates several steps.)
- **Clear selection / Clear all** buttons: the whole clear.
- **Insert/delete row/column**: the structural edit with formulas, styles and sheet size.
- **Load sample**: the whole load (one batch, not one entry per cell).
- **Cell edit**: one cell.

## Defects found in the existing code

- **`core.js` `parseTokensToAST`, ranges.** `=SUM(A1:A2)` returned `#PARSE!`; the starter test already failed. The `:` token was handled when only the first cell was on the output queue. Fix: merge `cell : cell` into one range token before the shunting-yard pass.
- **`core.js` `tokenize`, absolute refs.** `$A$1` threw `#PARSE!`. Fix: accept `$` before column/row.
- **`core.js` `shiftCellReferences`, absolute refs on insert.** The regex skipped any `$` form, so `=$G$2` stayed `$G$2` after inserting above row 2 (should be `$G$3`). The spec's `L33` case only passed by coincidence. Fix: one shift routine that understands `$` and ranges (`refs.js`).
- **`core.js` delete.** A reference to the deleted row slid to the row above instead of `#REF!`, and ranges did not shrink. Fix: `shiftReferencesForStructure`.
- **`core.js` dependencies.** Only range endpoints were tracked, so editing `A2` did not dirty `=SUM(A1:A3)`. Also `removeAllDependencies` deleted the edges of everything that read the edited cell; the bug was hidden because every edit bumps `_generation` and invalidates the whole cache. Fix: expand ranges; remove only the cell's own outgoing edges.
- **`core.js` numeric coercion.** `parseFloat` made `2024-01-03` evaluate to `2024` and `1/8/2024` to `1` (dates displayed as numbers). Fix: whole-string numeric test.
- **`core.js` recalculation cost.** Cells stayed in `dirtyCells` until the end of `recalculate`, so a dependency chain re-evaluated every upstream cell for every downstream cell (O(n^2)); `sorted.includes` in the fallback loop was O(n^2); `getAllDependentsRecursive` was recursive and copied sets per level; `hasCycle` walked the entire dependency chain for every write (5,000-row chain took 2.8 s). Fix: delete from `dirtyCells` as each cell is computed, Set lookup, iterative dependents walk, `hasCycle` checks dependents instead of dependencies, undo applies a batch in reverse (clearing a chain bottom-up measured 1.59 s top-down vs 6 ms).
- **`App.jsx`.** Every click entered edit mode, styles lived outside undo, "Clear all" pushed one undo entry per cell, formula-bar typing stole focus into the cell input, `Escape` could be followed by a blur-commit. Fix: selection model separate from editing, engine-owned styles and batch clears, an editing ref that makes cancel/commit idempotent.
- **`loadSample.js`.** One `setCell` (one undo entry) per cell, ~330 entries for the small sample, overflowing the 100-entry history. Fix: one `setCells` batch.

## Measurements

Fill, 5,000 cells (budget < 200 ms). `npm run bench`: bundles the engine with Vite (minified, as in the production build), then times `fillRange` in Node v22.22.2, linux x64, 5 discarded warm-up runs + 25 timed runs per scenario, median reported.

| Scenario (5,000 cells) | fill median | fill max | read all back | undo |
|---|---|---|---|---|
| numbers `1,2` down | 5.4 ms | 39.1 ms | 1.6 ms | 2.8 ms |
| text `ORD-1001,1002` down | 6.1 ms | 13.8 ms | 1.3 ms | 2.8 ms |
| ISO dates down | 7.5 ms | 28.3 ms | 1.9 ms | 3.7 ms |
| formulas `=G*H`, `=$G$1*H` (2 cols x 2,500 rows) | 31.5 ms | 56.5 ms | 1.7 ms | 8.3 ms |
| chain `=A1+1` (worst case) | 21.7 ms | 40.3 ms | 1.5 ms | 6.7 ms |
| styled seeds | 6.5 ms | 26.0 ms | 1.5 ms | 3.2 ms |

Slowest median 31.5 ms. Fill time includes the single recalculation. Caveats: this measures the engine in Node, not the browser; I had no browser in my environment, so the React render after a fill (re-render of the 50x50 table, ~2,500 `getCell` calls) is **not** measured. Loading `sales-large.tsv` (2,992 rows x 10) takes ~147 ms in the same Node setup (one batch).

Verification: `npm test` 44 passed, `npm run lint` clean, `npm run build` passes. The UI flows (drag select, Shift+click/arrows, Ctrl+A, header select, Enter/F2/typing/double-click, Delete, fill-handle drag incl. shrink-back preview, undo, whole-selection formatting, the `L33` insert case) were exercised with a throwaway jsdom + Testing Library script that is not committed, to avoid adding test-only dependencies. They were not exercised in a real browser.

## Trade-offs and what you would do next

- Fill extends along one axis per drag (the dominant one); diagonal drags choose the larger distance.
- The step is the last delta; Excel fits a linear trend over all seeds. For `1, 2, 4` this gives `6, 8`, not a trend.
- `d/m/yyyy` dates are not recognised (ambiguous with `m/d/yyyy`; month-first is assumed).
- The grid still renders every cell (Challenge 3 replaces it); selection updates re-render the table during a drag.
- Copy/paste of ranges, Ctrl+Home/End and Page Up/Down are not part of this task and not implemented.
- Range dependency expansion makes a `SUM` over 100,000 rows add 100,000 edges; Challenge 3 should switch to range-aware dependencies.
- Fix wanted: `evaluateAST` aggregates silently treat non-numeric text as 0.

## Use of AI tools

Claude and Google Antigravity were used as development assistants to get implementation suggestions, understand the existing codebase, troubleshoot bugs, analyze error messages, and explore possible solutions.

AI assistance was used to identify edge cases, improve code quality, suggest test scenarios, and resolve development issues. Suggested solutions were reviewed and tested during development.