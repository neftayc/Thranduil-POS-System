import { z } from 'zod'

export const instructionSchema = z.object({
  protocol: z.literal('yachay-agent/1'),
  type: z.enum(['instruction', 'follow_up']),
  request_id: z.uuid().transform(value => value.toLowerCase()),
  operation_id: z.uuid().transform(value => value.toLowerCase()).optional(),
  input: z.object({ text: z.string().trim().min(1).max(2500), locale: z.literal('es-PE').optional() }).strict()
}).strict().superRefine((value, ctx) => {
  if ((value.type === 'follow_up') !== Boolean(value.operation_id)) {
    ctx.addIssue({ code: 'custom', message: 'operation_id solo es obligatorio en follow_up', path: ['operation_id'] })
  }
})

/** Interpretation produced by the legacy OpenAI interpreter (used only by the legacy draft builder). */
export const interpretationSchema = z.object({
  intent: z.enum(['sale', 'cancel', 'unsupported']),
  items: z.array(z.object({
    query: z.string(),
    sku: z.string().nullable(),
    quantity: z.number().nullable(),
    unit: z.string().nullable(),
    product_id: z.string().nullable()
  })),
  payment_method: z.string().nullable(),
  customer_query: z.string().nullable(),
  question: z.string().nullable()
})

// ---------------------------------------------------------------------------
// Contract between AGENT 1 (AI: interprets + searches) and PROCESS 2 (deterministic:
// validates + registers). Agent 1 only proposes; process 2 trusts nothing it sends.
// ---------------------------------------------------------------------------

export const DRAFT_DOUBTS = [
  'ambiguous_product', 'product_not_found', 'missing_quantity', 'unit_unclear',
  'missing_payment', 'customer_ambiguous', 'other'
] as const
const doubtSchema = z.object({ code: z.enum(DRAFT_DOUBTS), note: z.string().trim().max(300).optional() }).strict()

export const saleDraftSchema = z.object({
  version: z.literal('sale-draft/1'),
  intent: z.enum(['sale', 'cancel', 'unsupported']).default('sale'),
  items: z.array(z.object({
    product_id: z.string().trim().min(1).max(64).nullable(),
    candidates: z.array(z.string().trim().min(1).max(64)).max(8).default([]),
    quantity: z.number().nullable(),
    unit: z.string().trim().min(1).max(60).nullable(),
    price_unit: z.number().nullable(),
    confidence: z.enum(['high', 'medium', 'low']),
    doubts: z.array(doubtSchema).max(10).default([]),
    query: z.string().max(500).default('')
  }).strict()).max(20),
  payment_method: z.string().trim().min(1).max(60).nullable(),
  customer_id: z.string().trim().min(1).max(64).nullable(),
  doubts: z.array(doubtSchema).max(10).default([]),
  source_text: z.string().max(5000).default('')
}).strict()

export type SaleDraftV1 = z.infer<typeof saleDraftSchema>
export type DraftDoubt = SaleDraftV1['doubts'][number]

/** Fixed, auditable reasons why process 2 did not register a sale directly. */
export const REVIEW_REASONS = [
  'invalid_draft',        // the draft does not respect sale-draft/1 or has no lines
  'agent_doubt',          // agent 1 reported a doubt (see detail.doubt)
  'low_confidence',       // a line is not confidence "high"
  'product_unresolved',   // a line has no product_id (several candidates or not found)
  'product_inactive',     // the product_id does not exist or is inactive
  'missing_quantity',     // quantity missing, not positive or out of range
  'price_unavailable',    // resolve_sale_item_pricing failed for the requested unit
  'price_changed',        // the official price differs from the price agent 1 saw
  'insufficient_stock',   // stock_on_hand − pending reservations < requested
  'missing_payment',      // no payment method (cash is never assumed)
  'invalid_payment',      // payment method not in payment_method_catalog (active)
  'invalid_customer',     // customer_id does not exist
  'pos_rejected'          // create_sale answered with an error: nothing was registered
] as const
export type ReviewReasonCode = typeof REVIEW_REASONS[number]
export type ReviewReason = { code: ReviewReasonCode; line?: number; message: string; detail?: Record<string, unknown> }

export type Instruction = z.infer<typeof instructionSchema>
export type Interpretation = z.infer<typeof interpretationSchema>
export type AgentResponse = {
  status: 'completed' | 'pending_review' | 'rejected' | 'pending'
  operation_id: string
  message: string
  result?: Record<string, unknown>
}
export type Product = { id: string; name: string; sku: string; brand: string | null; unit: string; stock: number }
export type StockLevel = { id: string; name: string; unit: string; stock: number; min_stock: number }
export type StockAlert = { product_id: string; name: string; unit: string; available: number; min_stock: number; level: 'low' | 'out' }
export type Reservation = { product_id: string; qty: number }
/** A line verified by process 2 (official price, base-unit factor). */
export type DraftItem = {
  product_id: string; name: string; qty: number; unit_name: string; price_unit: number; factor: number; total: number
}
/** What is sent to create_sale. Only built when every check passed. */
export type SaleDraft = {
  customer_id: string | null; payment_method: string; items: DraftItem[]; total: number; currency: string
}
export type DraftDecision =
  | { kind: 'direct'; sale: SaleDraft; items: DraftItem[] }
  | { kind: 'review'; reasons: ReviewReason[]; items: DraftItem[]; reservations: Reservation[] }

export type Operation = {
  id: string
  // review = "venta por confirmar": saved for later validation in the POS, reserves stock.
  // simulated = dry-run: would have been registered directly; nothing was sent to create_sale.
  state: 'preparing' | 'review' | 'executing' | 'completed' | 'cancelled' | 'simulated'
  seller_id: string
  messages: string[]
  /** Last draft received from agent 1 (kept for the batch-validation screen and audit). */
  proposal?: SaleDraftV1
  /** Sale actually sent (or to be sent) to create_sale. */
  draft?: SaleDraft
  reasons?: ReviewReason[]
  response?: AgentResponse
  reservations?: Reservation[]
  expires_at: number
}
export type RequestRecord = { fingerprint: string; operation_id: string; seller_id: string; response?: AgentResponse }

export interface AgentStore {
  getRequest(id: string): Promise<RequestRecord | null>
  saveRequest(id: string, value: RequestRecord): Promise<void>
  getOperation(id: string): Promise<Operation | null>
  saveOperation(value: Operation): Promise<void>
  listOperations(): Promise<Operation[]>
  exclusive<T>(work: () => Promise<T>): Promise<T>
}
export class AgentBusyError extends Error {}
export class AgentConflictError extends Error {}
export class AgentForbiddenError extends Error {}
export type AgentSeller = { id: string }
export interface SalesAgentDependencies {
  store: AgentStore
  /** AGENT 1 (AI): turns the conversation into a draft with product IDs. */
  buildDraft(messages: string[], previous: SaleDraftV1 | null): Promise<unknown>
  /** PROCESS 2 (deterministic): re-verifies the draft and decides direct vs review. */
  validate(draft: SaleDraftV1, reserved: Map<string, number>): Promise<DraftDecision>
  execute(draft: SaleDraft, beforeCommit: () => Promise<void>): Promise<{ saleId: string; total: number }>
  stockLevels?(productIds: string[]): Promise<StockLevel[]>
  /** How long a "venta por confirmar" keeps its stock reservation (default 48 h). */
  reviewTtlMs?: number
  now?(): number
  /**
   * Validation-only mode (POS_AGENT_DRY_RUN=1): real reads and the real decision, but execute() is
   * NEVER called. Use it with a separate store: its reservations are simulated.
   */
  dryRun?: boolean
}

/** The sale was certainly NOT registered and should not be retried (e.g. the seller is no longer authorized). */
export class SaleNotCommittedError extends Error {}
/** create_sale answered with an error (rolled back): nothing was registered; the order stays "por confirmar". */
export class SaleRejectedByPosError extends Error {}
