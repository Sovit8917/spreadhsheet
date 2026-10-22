import { useState, useRef, useEffect, useCallback } from 'react'
import './AskDataPanel.css'
import { createProvider } from '../ai/provider.js'
import { buildSheetContext } from '../ai/contextBuilder.js'
import { parseAndValidateAction } from '../ai/validator.js'
import { executeQuery } from '../engine/queryExecutor.js'
import { summarizePlan, summarizeFormatPlan } from '../ai/planExplainer.js'
import { applyFormatSheet } from '../engine/formatApplier.js'

export default function AskDataPanel({
    isOpen,
    onClose,
    engine,
    selectedCell,
    forceRerender
}) {
    const [prompt, setPrompt] = useState('')
    const [loading, setLoading] = useState(false)
    const [history, setHistory] = useState([])
    const [provider] = useState(() => createProvider())
    const [showPlanMap, setShowPlanMap] = useState({})

    const inputRef = useRef(null)
    const contentRef = useRef(null)

    // Focus input when panel opens
    useEffect(() => {
        if (isOpen && inputRef.current) {
            setTimeout(() => inputRef.current?.focus(), 50)
        }
    }, [isOpen])

    // Scroll to bottom on new items
    useEffect(() => {
        if (contentRef.current) {
            contentRef.current.scrollTop = contentRef.current.scrollHeight
        }
    }, [history, loading])

    const toggleShowPlan = useCallback((idx) => {
        setShowPlanMap(prev => ({ ...prev, [idx]: !prev[idx] }))
    }, [])

    const handleRunQuery = useCallback(async (userPrompt) => {
        const trimmed = (userPrompt || prompt).trim()
        if (!trimmed || loading) return

        setLoading(true)
        setPrompt('')

        const selStr = selectedCell ? `R${selectedCell.r + 1}C${selectedCell.c + 1}` : 'A1'
        const context = buildSheetContext(engine, selStr)

        const systemPrompt = `You are an AI spreadsheet assistant for "Ask your data" and "Format with AI".
Analyze the user's natural language request about the spreadsheet data and return a single JSON action object following the contract in AI_CONTRACT.md.
Rules:
1. Return ONLY a single JSON object. No explanation, no conversational filler, no code fences.
2. The JSON action must have "type": "query" | "format_sheet" | "clarify".
3. For "query", allowed fields are:
   - "type": "query"
   - "excludeTotalsRow": boolean (default true)
   - "filters": array of { "column": string, "op": "eq"|"neq"|"gt"|"gte"|"lt"|"lte"|"contains"|"startsWith"|"endsWith"|"isEmpty"|"notEmpty", "value": string|number|null }
   - "groupBy": array of string (column names)
   - "aggregates": array of { "fn": "sum"|"avg"|"count"|"countDistinct"|"min"|"max", "column": string, "as"?: string }
   - "columns": array of string
   - "sort": array of { "column": string, "dir": "asc"|"desc" }
   - "limit": integer (clamped to 500)
4. For "format_sheet", allowed fields are:
   - "type": "format_sheet"
   - "clearFormatting": boolean
   - "headerStyle": { "bold"?: boolean, "italic"?: boolean, "underline"?: boolean, "bg"?: string, "color"?: string, "align"?: "left"|"center"|"right", "fontSize"?: integer, "numberFormat"?: "general"|"number"|"currency"|"percent"|"date" }
   - "bodyStyle": style object
   - "totalsStyle": style object
   - "columns": array of { "col": integer, "style": style object }
   - "freezeRows": integer | null
   - "columnWidths": array of { "col": integer, "width": integer }
   - "autoFitColumns": boolean
5. Use verbatim column names from the sheet context.
6. If the request cannot be answered or is ambiguous, use "type": "clarify" with "question".`

        const userTurn = `Sheet Context:
${JSON.stringify(context, null, 2)}

User Question: ${trimmed}`

        const turnRecord = {
            id: Date.now(),
            prompt: trimmed,
            plan: null,
            rawText: '',
            summary: '',
            result: null,
            clarify: null,
            error: null,
            formatPreview: null,
            formatApplied: false,
            formatDiscarded: false,
            formatResultMsg: null
        }

        try {
            const resp = await provider.complete({
                system: systemPrompt,
                user: userTurn,
                history: []
            })

            turnRecord.rawText = resp.text

            // Validate response
            const validation = parseAndValidateAction(resp.text)
            if (!validation.ok) {
                turnRecord.error = `${validation.error}: ${validation.detail}`
            } else {
                const action = validation.action
                turnRecord.plan = action

                if (action.type === 'clarify') {
                    turnRecord.clarify = action.question
                } else if (action.type === 'query') {
                    turnRecord.summary = summarizePlan(action)
                    const execResult = executeQuery(engine, action)
                    if (execResult.error) {
                        turnRecord.error = `${execResult.error}: ${execResult.detail || ''}`
                    } else {
                        turnRecord.result = execResult
                    }
                } else if (action.type === 'format_sheet') {
                    turnRecord.summary = summarizeFormatPlan(action)
                    turnRecord.formatPreview = action
                } else {
                    turnRecord.error = `Action ${action.type} is not permitted`
                }
            }
        } catch (err) {
            turnRecord.error = `Provider error: ${err.message}`
        } finally {
            setHistory(prev => [...prev, turnRecord])
            setLoading(false)
        }
    }, [prompt, loading, selectedCell, engine, provider])

    // Re-run an existing plan without calling the model
    const handleRerun = useCallback((itemIndex) => {
        const item = history[itemIndex]
        if (!item || !item.plan || item.plan.type !== 'query') return

        const execResult = executeQuery(engine, item.plan)
        setHistory(prev => {
            const copy = [...prev]
            if (execResult.error) {
                copy[itemIndex] = { ...item, error: `${execResult.error}: ${execResult.detail || ''}`, result: null }
            } else {
                copy[itemIndex] = { ...item, result: execResult, error: null }
            }
            return copy
        })
    }, [history, engine])

    // Insert query result into sheet at selected cell with one-step undo
    const handleInsertIntoSheet = useCallback((itemIndex) => {
        const item = history[itemIndex]
        if (!item || !item.result || !item.result.columns) return

        const startR = selectedCell ? selectedCell.r : 0
        const startC = selectedCell ? selectedCell.c : 0

        // Build 2D matrix: [columns, ...rows]
        const matrix = [
            item.result.columns,
            ...item.result.rows
        ]

        engine.insertValues(startR, startC, matrix)
        forceRerender()
    }, [history, selectedCell, engine, forceRerender])

    // Apply format action with one-step undo
    const handleApplyFormat = useCallback((itemIndex) => {
        const item = history[itemIndex]
        if (!item || !item.formatPreview) return

        const res = applyFormatSheet(engine, item.formatPreview)
        setHistory(prev => {
            const copy = [...prev]
            if (!res.ok) {
                copy[itemIndex] = {
                    ...item,
                    error: `${res.result}: ${res.message || 'Format action rejected'}`,
                    formatApplied: false
                }
            } else if (res.result === 'NO_CHANGES') {
                copy[itemIndex] = {
                    ...item,
                    formatResultMsg: 'NO_CHANGES: Action made no changes to the sheet.',
                    formatApplied: true
                }
            } else {
                copy[itemIndex] = {
                    ...item,
                    formatResultMsg: 'Formatting applied successfully (1 undo step).',
                    formatApplied: true
                }
            }
            return copy
        })
        forceRerender()
    }, [history, engine, forceRerender])

    // Discard format preview
    const handleDiscardFormat = useCallback((itemIndex) => {
        setHistory(prev => {
            const copy = [...prev]
            copy[itemIndex] = { ...copy[itemIndex], formatDiscarded: true }
            return copy
        })
    }, [])

    if (!isOpen) return null

    return (
        <aside className="ask-data-panel" aria-label="Ask Your Data Panel">
            <div className="ask-data-header">
                <div className="ask-data-title">
                    <span>✨ Ask Your Data</span>
                    <span className="ask-data-provider-badge">{provider.name}</span>
                </div>
                <button className="ask-data-close-btn" onClick={onClose} title="Close Panel (Ctrl+K or Esc)">✕</button>
            </div>

            <div className="ask-data-content" ref={contentRef}>
                {history.length === 0 && (
                    <div className="ask-data-empty">
                        <h4>Ask questions in natural language</h4>
                        <p>The model translates your question into a deterministic query plan; the engine executes it over computed sheet values.</p>
                        <p style={{ marginTop: '10px', fontWeight: '500' }}>Try sample query prompts:</p>
                        <ul>
                            <li onClick={() => handleRunQuery('What is the total sales by region?')}>"What is the total sales by region?"</li>
                            <li onClick={() => handleRunQuery('Top 3 sales reps by total sales')}>"Top 3 sales reps by total sales"</li>
                            <li onClick={() => handleRunQuery('Total units per category')}>"Total units per category"</li>
                            <li onClick={() => handleRunQuery('Show me orders with a total over 5000')}>"Show me orders with a total over 5000"</li>
                        </ul>
                        <p style={{ marginTop: '10px', fontWeight: '500' }}>Try format prompts (Format with AI):</p>
                        <ul>
                            <li onClick={() => handleRunQuery('Format this as a clean table')}>"Format this as a clean table"</li>
                            <li onClick={() => handleRunQuery('Make the header row bold and blue')}>"Make the header row bold and blue"</li>
                            <li onClick={() => handleRunQuery('Show unit prices and totals as currency with two decimals')}>"Show unit prices and totals as currency with two decimals"</li>
                            <li onClick={() => handleRunQuery('Highlight the totals row in yellow')}>"Highlight the totals row in yellow"</li>
                            <li onClick={() => handleRunQuery('Remove all formatting')}>"Remove all formatting"</li>
                        </ul>
                    </div>
                )}

                {history.map((item, idx) => (
                    <div key={item.id} className="ask-data-turn">
                        <div className="ask-data-user-prompt">
                            <span>💬 {item.prompt}</span>
                        </div>

                        {item.error && (
                            <div className="ask-data-error">
                                ⚠️ {item.error}
                            </div>
                        )}

                        {item.clarify && (
                            <div className="ask-data-clarify">
                                ❓ <strong>Clarification needed:</strong> {item.clarify}
                            </div>
                        )}

                        {item.result && (
                            <div className="ask-data-result-card">
                                {item.summary && (
                                    <div className="ask-data-plan-summary">
                                        📋 {item.summary}
                                    </div>
                                )}

                                <div className="ask-data-meta-row">
                                    <span>
                                        <strong>{item.result.rowCount}</strong> rows
                                        {item.result.truncated && ' (capped at 500)'}
                                    </span>
                                    <button
                                        className="ask-data-toggle-plan"
                                        onClick={() => toggleShowPlan(idx)}
                                    >
                                        {showPlanMap[idx] ? 'Hide raw plan' : 'Show plan JSON'}
                                    </button>
                                </div>

                                {showPlanMap[idx] && item.plan && (
                                    <pre className="ask-data-raw-plan">
                                        {JSON.stringify(item.plan, null, 2)}
                                    </pre>
                                )}

                                <div className="ask-data-table-container">
                                    <table className="ask-data-table">
                                        <thead>
                                            <tr>
                                                {item.result.columns.map((c, i) => (
                                                    <th key={i}>{c}</th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {item.result.rows.map((row, rIdx) => (
                                                <tr key={rIdx}>
                                                    {row.map((val, cIdx) => (
                                                        <td key={cIdx}>{val !== null && val !== undefined ? String(val) : ''}</td>
                                                    ))}
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>

                                <div className="ask-data-actions-row">
                                    <button
                                        className="ask-data-action-btn"
                                        onClick={() => handleRerun(idx)}
                                        title="Re-run query over updated sheet data without calling model"
                                    >
                                        🔄 Re-run
                                    </button>
                                    <button
                                        className="ask-data-action-btn"
                                        onClick={() => handleInsertIntoSheet(idx)}
                                        title="Insert table into sheet at currently selected cell (one undo step)"
                                    >
                                        📥 Insert into sheet
                                    </button>
                                </div>
                            </div>
                        )}

                        {item.formatPreview && (
                            <div className="ask-data-result-card format-card">
                                <div className="format-preview-header">
                                    <strong>🎨 Formatting Preview</strong>
                                </div>
                                <div className="ask-data-plan-summary">
                                    {item.summary}
                                </div>

                                <div className="ask-data-meta-row">
                                    <span>Plan intent</span>
                                    <button
                                        className="ask-data-toggle-plan"
                                        onClick={() => toggleShowPlan(idx)}
                                    >
                                        {showPlanMap[idx] ? 'Hide raw action' : 'Show action JSON'}
                                    </button>
                                </div>

                                {showPlanMap[idx] && item.plan && (
                                    <pre className="ask-data-raw-plan">
                                        {JSON.stringify(item.plan, null, 2)}
                                    </pre>
                                )}

                                {item.formatResultMsg && (
                                    <div className="format-result-badge">
                                        ℹ️ {item.formatResultMsg}
                                    </div>
                                )}

                                {!item.formatApplied && !item.formatDiscarded && (
                                    <div className="ask-data-actions-row">
                                        <button
                                            className="ask-data-action-btn format-apply-btn"
                                            onClick={() => handleApplyFormat(idx)}
                                            title="Apply formatting to sheet (1 undo step)"
                                        >
                                            ✅ Apply
                                        </button>
                                        <button
                                            className="ask-data-action-btn format-discard-btn"
                                            onClick={() => handleDiscardFormat(idx)}
                                            title="Discard format preview"
                                        >
                                            ✕ Discard
                                        </button>
                                    </div>
                                )}

                                {item.formatDiscarded && (
                                    <div className="format-discarded-badge">
                                        Preview discarded.
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                ))}

                {loading && (
                    <div className="ask-data-turn" style={{ opacity: 0.7 }}>
                        <div className="ask-data-plan-summary">
                            ⏳ Translating question & executing plan...
                        </div>
                    </div>
                )}
            </div>

            <div className="ask-data-footer">
                <form
                    className="ask-data-input-row"
                    onSubmit={(e) => {
                        e.preventDefault()
                        handleRunQuery()
                    }}
                >
                    <input
                        ref={inputRef}
                        className="ask-data-input"
                        placeholder="Ask a question or format request (e.g. Format as a clean table)..."
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        disabled={loading}
                    />
                    <button
                        type="submit"
                        className="ask-data-submit-btn"
                        disabled={loading || !prompt.trim()}
                    >
                        Send
                    </button>
                </form>
                <div className="ask-data-shortcut-hint">
                    Press Ctrl+K to toggle panel · Never sends full sheet data
                </div>
            </div>
        </aside>
    )
}
