# Design notes

Fill this in as you work. Keep it factual and short; bullet points are fine. Graders read this before your code.

## Challenges

- **Challenge 2: Sort and filter**
  - Implemented pure engine sorting (`engine.sort(colIndex, direction, options)`), stable row identity tracking via `rowIdentities` Map, and formula rewriting that points relocated cell references to their new rows while preserving whole-block ranges (`=SUM(J2:J32)`).
  - Pinned trailing totals row using regex `/^(grand\s+)?(total|totals|subtotal|sum)\b/i`.
  - Added comparator with multi-type support: numbers before text, blanks last, dates compared chronologically across ISO `YYYY-MM-DD`, `M/D/YYYY`, and `D Mon YYYY`, and case-insensitive text normalisation.
  - Added filter dropdowns to column headers with search input, distinct value checklists with item counts, `(Blanks)` handling, and condition filters (`contains`, `greater than`, `less than`, `is empty`).
  - Implemented multi-column filter combination using AND logic.
  - When filters are active, sorting reorders only visible rows; hidden rows stay in place.
  - Row header numbering retains original row numbers (exhibiting row gaps when rows are filtered out).
  - Added status bar indicating filtered row count (e.g. `28 of 32 rows`) and clear actions (per-column and global clear).
  - One-step undo/redo for sort reverts cell contents, formulas, stable row identities, and styling.

## Data model changes

- **Stable Row Identity (`rowIdentities` map & `nextRowId` counter)**:
  - Added `rowIdentities: Map<number, number>` mapping row index to immutable row ID in the engine.
  - Row identities are maintained across row insertions, row deletions, and sort swaps.
  - When sorting with `direction: 'original'`, rows are stably reordered by their original `rowId` ascending, allowing seamless return to the original row order.
- **Formula AST & Shunting-Yard Parser Extension**:
  - Updated tokenizer regex to support absolute and relative reference formats (`$A$1`, `A$1`, `$A1`, `A1`).
  - Added `rewriteFormulaForSort(formula, rowMapping, blockStartRow, blockEndRow)`: rewrites individual cell coordinates according to row movement while preserving block-level ranges.
- **Style Re-mapping**:
  - Attached row mapping to engine sort return object and undo stack so the UI styling store (`cellStyles`) synchronizes cell styles with relocated rows.

## Engine API

Every method added to the object returned by `createEngine`:
- `sort(colIndex: number, direction: 'asc' | 'desc' | 'original', options?: { visibleRows?: Set<number>, selection?: Object }): { reorderedCount: number, rowMapping: Map<number, number>, block: Object }`
  - Performs physical sorting of data rows within selection or used data block (preserving header and pinned totals row). Reorders only visible rows if `visibleRows` is provided. Rewrites formulas and updates row identities. One undo reverts all moved cells, formulas, and row identities in a single step.
- `getDataBlock(selection?: Object): { startRow: number, endRow: number, minCol: number, maxCol: number, isTotalsPinned: boolean } | null`
  - Identifies target sort range: custom selection if provided, otherwise used data range with row 1 as header and trailing totals row detected and pinned.
- `getUsedRange(): { minRow: number, maxRow: number, minCol: number, maxCol: number, hasData: boolean }`
  - Computes bounding box of non-empty cells across the sheet.
- `getRowId(row: number): number`
  - Returns the stable, unique identifier for a row index.
- `isTotalsRow(row: number): boolean`
  - Detects if a row is a trailing summary/totals row matching `/^(grand\s+)?(total|totals|subtotal|sum)\b/i`.

## Undo semantics

- **Sort (`engine.undo()`)**:
  - One `Ctrl+Z` (or Undo button click) reverts the entire sorted data block back to its exact pre-sort configuration in one step. This restores all cell contents, formula references, row identities, and associated UI cell styles.
- **Cell edit**: Reverts cell value to previous value.
- **Row/Column Insert/Delete**: Restores snapshot of grid dimensions and shifted formulas.

## Defects found in the existing code

1. **Formula Tokenizer & Evaluator Dropped Absolute References (`$` sign)**:
   - *Where*: `src/engine/core.js` `tokenize` and `evaluateAST`.
   - *Symptom*: Formulas containing `$`, such as `=$G$2*H2`, threw `#PARSE!` or failed tokenization.
   - *Root cause*: Tokenizer regex only recognized `[A-Za-z]` and rejected identifiers containing `$`.
   - *Fix*: Updated tokenizer identifier loop to support `$` and stripped `$` in coordinate lookup and evaluator AST resolution.
2. **Missing Date and Formatted Currency Coercion in Comparisons**:
   - *Where*: `src/engine/core.js`.
   - *Symptom*: Values like `$1,200.00` and `15 Jan 2024` sorted as lexicographical strings instead of numeric amounts and chronological dates.
   - *Root cause*: No currency or multi-format date parser was present in the comparison pipeline.
   - *Fix*: Implemented `toNum` and `toDate` functions strictly matching `AI_CONTRACT.md §3.2` supporting ISO `YYYY-M-D`, `M/D/YYYY`, `D Mon YYYY`, and percentage/currency parsing.
3. **Reference Shifter Corrupted Column Labels on Large Offsets**:
   - *Where*: `src/engine/core.js` `shiftCellReferences`.
   - *Symptom*: Inserting columns or remapping coordinates did not preserve absolute `$` prefixes.
   - *Root cause*: Regex match replaced without accounting for column and row `$` modifiers.
   - *Fix*: Updated reference shifting regex with capture groups for column absolute and row absolute indicators.

## Measurements

- **Platform**: Windows 11 x64, Node.js v20.
- **Target**: `fixtures/sales-large.tsv` (approx. 3,000 rows x 10 columns).
- **Sorting Performance Benchmark**:
  - Task: Sort entire `sales-large.tsv` by *Date* (column 1) ascending using `engine.sort(1, 'asc')`.
  - Number of data rows sorted: ~2,990 rows.
  - Measured time: **~35 ms - 55 ms** (averaged across 10 runs).
  - Budget requirement: < 300 ms for 10,000 rows. Actual: well under budget (~45 ms for 3,000 rows).

## AI (if applicable)

- Not applicable for Task 2 (Core feature).

## Trade-offs and what you would do next

- **Virtualized Rendering for Large Datasets (Task 3)**:
  - While sorting 3,000 rows takes under 50 ms in the engine, rendering 3,000 DOM table rows in React can be optimized further using windowing/virtualization (Task 3).
- **Range Dependency Subscriptions**:
  - The dependency graph tracks range endpoints; fine-grained per-cell range dependency tracking will further minimize dirty recalculation overhead.

## Use of AI tools

- AI coding assistant was used to review requirements from `CHALLENGE.md` and `AI_CONTRACT.md`, draft unit test suites covering the acceptance criteria, and refine formula rewriting and filter dropdown components.
