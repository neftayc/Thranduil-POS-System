import OpenAI from 'openai'
import { zodResponseFormat } from 'openai/helpers/zod'
import type { z } from 'zod'
import { selectorModelSchema, type SelectorModel, type SelectorUsage } from '../app/salesSelector'
import { reviewerModelSchema, type ReviewerModel } from '../app/salesReviewer'

/** Reasoning models (gpt-5*, o*) take `reasoning_effort` and no temperature. */
const isReasoning = (model: string) => /^(gpt-5|gpt-6|o\d)/.test(model)

/**
 * OpenAI adapter of the sales selector (POS_AGENT_SELECTOR_MODEL). The system message is the fixed
 * prefix (rules + examples + catalog) so OpenAI's automatic prompt caching applies to it; the
 * operation goes in the user message. Structured outputs enforce the JSON schema.
 */
type ModelOptions = { reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'none'; timeoutMs?: number }
const makeJsonModel = <S extends z.ZodTypeAny>(apiKey: string, model: string, schema: S, name: string, cacheKey: string, options: ModelOptions = {}) => {
  const client = new OpenAI({ apiKey, timeout: options.timeoutMs ?? 60_000, maxRetries: 0 })
  return async (system: string, user: string): Promise<{ output: z.infer<S>; usage: SelectorUsage }> => {
    const started = Date.now()
    const completion = await client.chat.completions.parse({
      model,
      store: false,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: zodResponseFormat(schema, name),
      max_completion_tokens: isReasoning(model) ? 8000 : 3000,
      // Same key for every request of the selector → better prompt-cache hits on the fixed prefix.
      prompt_cache_key: cacheKey,
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

export const makeOpenAISelectorModel = (apiKey: string, model: string, options: ModelOptions = {}): SelectorModel =>
  makeJsonModel(apiKey, model, selectorModelSchema, 'sale_consolidated', 'pos-sales-selector', options)

/** The reviewer (second pass): same model family, its own fixed prefix (rules + catalog) and cache key. */
export const makeOpenAIReviewerModel = (apiKey: string, model: string, options: ModelOptions = {}): ReviewerModel =>
  makeJsonModel(apiKey, model, reviewerModelSchema, 'sale_review', 'pos-sales-reviewer', options)
