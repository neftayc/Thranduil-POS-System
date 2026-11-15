import { z } from 'zod'
import type { DraftDoubt } from '../contracts'

/**
 * Agent 1 internal types (interpretation + proposal). The contract with process 2 is
 * sale-draft/1 (`saleDraftSchema` in contracts.ts, owned by process 2); `toSaleDraft()` in
 * draftBuilder.ts converts the proposal into it.
 */

// catalog_query = a question about the catalog ("¿tenemos cuadernos Marking?", "¿cuánto cuesta…?").
export const orderIntentSchema = z.enum(['sale', 'cancel', 'unsupported', 'catalog_query'])
export const orderInterpretationSchema = z.object({
  intent: orderIntentSchema,
  items: z.array(z.object({
    query: z.string(),
    sku: z.string().nullable(),
    quantity: z.number().nullable(),
    unit: z.string().nullable(),
    /** Unit price the seller dictated, or null (process 2 checks it against the seller's text). */
    price: z.number().nullable().optional(),
    product_id: z.string().nullable(),
    // What the order says, separated (optional for callers that do not provide it).
    product: z.string().nullable().optional(),
    brand: z.string().nullable().optional(),
    attributes: z.array(z.string()).optional()
  })),
  payment_method: z.string().nullable(),
  customer_query: z.string().nullable(),
  question: z.string().nullable()
})
export type OrderInterpretation = z.infer<typeof orderInterpretationSchema>

export type Confidence = 'high' | 'medium' | 'low'
export type ProposalAlternative = { product_id: string; name: string; sku: string | null; brand: string | null; score: number }
export type ProposalItem = {
  line: number
  query: string
  product_id: string | null
  name: string | null
  sku: string | null
  brand: string | null
  qty: number | null
  /** Presentation as requested (null = base unit), what process 2 must price. */
  unit: string | null
  unit_name: string | null
  factor: number | null
  price_unit: number | null
  /** Unit price the seller dictated (from the interpretation), or null. */
  price_said?: number | null
  total: number | null
  /** stock_on_hand − units reserved by other ventas por confirmar (base unit). */
  stock_available: number | null
  confidence: Confidence
  match_score: number
  /** Why this product (explanation of the match). */
  reasons: string[]
  /** Coded doubts of this line (empty when confidence is high). */
  doubts: DraftDoubt[]
  alternatives: ProposalAlternative[]
}
export type SaleProposal = {
  confidence: Confidence
  customer_id: string | null
  payment_method: string | null
  items: ProposalItem[]
  total: number | null
  currency: 'PEN'
  /** Human-readable doubts (all of them, for the seller). */
  doubts: string[]
  /** Coded order-level doubts (payment, customer, interpreter question). */
  order_doubts: DraftDoubt[]
}
