import { z } from 'zod'
import { saleDraftSchema, type SaleDraftV1 } from '../contracts'

/**
 * Agent 1 (hybrid search) emits a `SaleProposal`. Process 2 accepts it and converts it to
 * sale-draft/1 so the decision rule stays the same. Agent 1's own `draft`, prices, totals and
 * stock figures are informational: process 2 recomputes everything.
 */
const confidence = z.enum(['high', 'medium', 'low'])
const id = z.string().trim().min(1).max(64)
export const saleProposalSchema = z.object({
  intent: z.enum(['sale', 'cancel', 'unsupported']).optional(),
  confidence,
  customer_id: id.nullable(),
  payment_method: z.string().trim().min(1).max(60).nullable(),
  items: z.array(z.object({
    query: z.string().max(500).default(''),
    product_id: id.nullable(),
    qty: z.number().nullable(),
    unit_name: z.string().trim().min(1).max(60).nullable(),
    price_unit: z.number().nullable(),
    confidence,
    reasons: z.array(z.string().max(300)).max(10).default([]),
    alternatives: z.array(z.object({ product_id: id }).passthrough()).max(8).default([])
  }).passthrough()).max(20),
  doubts: z.array(z.string().max(300)).max(10).default([])
}).passthrough()
export type SaleProposal = z.infer<typeof saleProposalSchema>

export const proposalToDraft = (proposal: SaleProposal, sourceText = ''): SaleDraftV1 => saleDraftSchema.parse({
  version: 'sale-draft/1',
  intent: proposal.intent || 'sale',
  items: proposal.items.map(item => ({
    product_id: item.product_id,
    candidates: item.alternatives.map(a => a.product_id).filter(alt => alt !== item.product_id).slice(0, 8),
    quantity: item.qty,
    unit: item.unit_name,
    price_unit: item.price_unit,
    confidence: item.confidence,
    // On a "high" line the reasons explain the match; on medium/low they are the doubts.
    doubts: item.confidence === 'high' ? [] : item.reasons.map(note => ({ code: 'other', note })),
    query: item.query
  })),
  payment_method: proposal.payment_method,
  customer_id: proposal.customer_id,
  doubts: [
    ...proposal.doubts.map(note => ({ code: 'other' as const, note })),
    ...(proposal.confidence === 'high' ? [] : [{ code: 'other' as const, note: `Seguridad general ${proposal.confidence === 'medium' ? 'media' : 'baja'} del agente 1` }])
  ],
  source_text: sourceText.slice(0, 5000)
})

/**
 * Accepts sale-draft/1, a SaleProposal, or `{ proposal: SaleProposal }` (the shape of agent 1's prepare()).
 * Anything else fails and the order stays "por confirmar" with reason invalid_draft.
 */
export const parseAgentDraft = (raw: unknown, sourceText = ''): { success: true; data: SaleDraftV1 } | { success: false } => {
  const direct = saleDraftSchema.safeParse(raw)
  if (direct.success) return direct
  const candidate = raw && typeof raw === 'object' && 'proposal' in raw ? (raw as any).proposal : raw
  const proposal = saleProposalSchema.safeParse(candidate)
  if (!proposal.success) return { success: false }
  try {
    return { success: true, data: proposalToDraft(proposal.data, sourceText) }
  } catch {
    return { success: false }
  }
}
