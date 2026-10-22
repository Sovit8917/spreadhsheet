// ─────────────────────────────────────────────────────────────
//  LLM provider abstraction.
//
//  The app never talks to a model directly — it talks to a
//  `provider`. A provider is any object with:
//
//      complete({ system, user, history }) => Promise<{ text, provider }>
//
//  `text` is the raw model output. You are expected to extract and
//  validate JSON from it yourself: models wrap JSON in prose, in code
//  fences, or return something that is not JSON at all.
//
//  Two providers ship with the repo:
//    • mock  — deterministic, offline, answers the prompts listed in
//              fixtures/ai-eval/*.json. Used by graders. The default.
//    • http  — YOURS. Call any LLM API you like (Anthropic, OpenAI,
//              Gemini, Ollama, …) with plain fetch(). Read the endpoint,
//              key and model from the VITE_AI_* env vars (.env.example).
//
//  Do not hard-code a vendor anywhere else: everything outside this
//  file must behave identically with either provider.
// ─────────────────────────────────────────────────────────────
import { createMockProvider } from './mockProvider.js'

/**
 * @typedef {{ role: 'user' | 'assistant', content: string }} ChatTurn
 * @typedef {{ system: string, user: string, history?: ChatTurn[] }} CompletionRequest
 * @typedef {{ text: string, provider: string }} CompletionResponse
 * @typedef {{ name: string, complete: (req: CompletionRequest) => Promise<CompletionResponse> }} Provider
 */

const env = (typeof import.meta !== 'undefined' && import.meta.env) || {}

/** @returns {Provider} */
export function createHttpProvider(config = {}) {
    const endpoint = config.endpoint ?? env.VITE_AI_ENDPOINT
    const apiKey = config.apiKey ?? env.VITE_AI_API_KEY
    const model = config.model ?? env.VITE_AI_MODEL ?? 'gpt-4o-mini'

    return {
        name: 'http',
        async complete(request) {
            if (!endpoint) {
                throw new Error('VITE_AI_ENDPOINT is not configured in .env.local')
            }

            const messages = []
            if (request.system) {
                messages.push({ role: 'system', content: request.system })
            }
            if (Array.isArray(request.history)) {
                for (const turn of request.history) {
                    messages.push({ role: turn.role, content: turn.content })
                }
            }
            if (request.user) {
                messages.push({ role: 'user', content: request.user })
            }

            let response
            try {
                const headers = {
                    'Content-Type': 'application/json'
                }
                if (apiKey) {
                    headers['Authorization'] = `Bearer ${apiKey}`
                    headers['x-api-key'] = apiKey
                }

                response = await fetch(endpoint, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        model,
                        messages,
                        temperature: 0
                    })
                })
            } catch (netErr) {
                throw new Error(`Network failure connecting to AI endpoint: ${netErr.message}`)
            }

            if (!response.ok) {
                let errorBody = ''
                try {
                    errorBody = await response.text()
                } catch {
                    errorBody = response.statusText
                }

                if (response.status === 401 || response.status === 403) {
                    throw new Error(`AI Authentication failure (${response.status}): Check API key. ${errorBody}`)
                }
                if (response.status === 429) {
                    throw new Error(`AI Rate limit exceeded (${response.status}): ${errorBody}`)
                }
                throw new Error(`AI Provider error (${response.status}): ${errorBody}`)
            }

            const data = await response.json()
            // Support OpenAI format (choices[0].message.content) or direct Anthropic/custom format
            const content = data.choices?.[0]?.message?.content ??
                            data.content?.[0]?.text ??
                            data.response ??
                            data.text ??
                            ''

            return {
                text: content,
                provider: 'http'
            }
        },
    }
}

/**
 * Pick a provider from VITE_AI_PROVIDER. Unknown values fall back to mock
 * so the app always boots.
 * @returns {Provider}
 */
export function createProvider(kind = env.VITE_AI_PROVIDER || 'mock') {
    if (kind === 'http') return createHttpProvider()
    return createMockProvider()
}
