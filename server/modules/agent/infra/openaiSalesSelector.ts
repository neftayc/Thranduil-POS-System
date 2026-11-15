import OpenAI from 'openai'
import { zodResponseFormat } from 'openai/helpers/zod'
import { selectorModelSchema, type SelectorModel } from '../app/salesSelector'

/** Reasoning models (gpt-5*, o*) take `reasoning_effort` and no temperature. */
const isReasoning = (model: string) => /^(gpt-5|gpt-6|o\d)/.test(model)

/**
 * OpenAI adapter of the sales selector (POS_AGENT_SELECTOR_MODEL). The system message is the fixed
 * prefix (rules + examples + catalog) so OpenAI's automatic prompt caching applies to it; the
 * operation goes in the user message. Structured outputs enforce the JSON schema.
 */
export const makeOpenAISelectorModel = (apiKey: string, model: string, options: { reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'none'; timeoutMs?: number } = {}): SelectorModel => {
  const client = new OpenAI({ apiKey, timeout: options.timeoutMs ?? 60_000, maxRetries: 0 })
  return async (system, user) => {
    const started = Date.now()
    const completion = await client.chat.completions.parse({
      model,
      store: false,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: zodResponseFormat(selectorModelSchema, 'sale_consolidated'),
      max_completion_tokens: isReasoning(model) ? 8000 : 3000,
      // Same key for every request of the selector → better prompt-cache hits on the fixed prefix.
      prompt_cache_key: 'pos-sales-selector',
      ...(isReasoning(model) ? { reasoning_effort: options.reasoningEffort ?? 'low' } : { temperature: 0 })
    } as any)
    const message = completion.choices[0]?.message
    if (message?.refusal || !message?.parsed) throw new Error('El selector no devolvió un consolidado válido')
    const usage = completion.usage as any
    return {
      output: message.parsed,
      usage: {
        model,
        input_tokens: Number(usage?.prompt_tokens || 0),
        cached_tokens: Number(usage?.prompt_tokens_details?.cached_tokens || 0),
        output_tokens: Number(usage?.completion_tokens || 0),
        latency_ms: Date.now() - started
      }
    }
  }
}
