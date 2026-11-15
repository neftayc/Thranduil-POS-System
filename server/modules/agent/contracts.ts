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

// ---------------------------------------------------------------------------
// Contract between AGENT 1 (AI: interprets + searches) and PROCESS 2 (deterministic:
// validates + registers). Agent 1 only proposes; process 2 trusts nothing it sends.
// ---------------------------------------------------------------------------

export const DRAFT_DOUBTS = [
  'ambiguous_product', 'product_not_found', 'missing_quantity', 'unit_unclear',
  'missing_payment', 'customer_ambiguous', 'other'
] as const
export const DOUBT_NOTE_MAX = 1000
const doubtSchema = z.object({ code: z.enum(DRAFT_DOUBTS), note: z.string().trim().max(DOUBT_NOTE_MAX).optional() }).strict()

export const saleDraftSchema = z.object({
  version: z.literal('sale-draft/1'),
  intent: z.enum(['sale', 'cancel', 'unsupported']).default('sale'),
  items: z.array(z.object({
    product_id: z.string().trim().min(1).max(64).nullable(),
    candidates: z.array(z.string().trim().min(1).max(64)).max(8).default([]),
    quantity: z.number().nullable(),
    unit: z.string().trim().min(1).max(60).nullable(),
    price_unit: z.number().nullable(),
    /** Unit price the SELLER dictated ("a 3 soles"), or null. Only counts if it is in the seller's text. */
    price_said: z.number().positive().max(1000000).nullable().default(null),
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

// ---------------------------------------------------------------------------
// Plan in 3 steps (owner, 2026-11-15): with POS_AGENT_SELECTOR=llm the SELECTOR agent (step 2)
// delivers the consolidated sale and the simplified REGISTRAR (step 3) validates only what is needed
// to register it: product id, presentation, quantity, official price, stock, payment and that each
// phrase is in the dictation. It does not re-interpret the text.
// ---------------------------------------------------------------------------
const id64 = z.string().trim().min(1).max(64)
export const saleConsolidatedSchema = z.object({
  contract: z.literal('sale-consolidated/1'),
  lines: z.array(z.object({
    /** Literal fragment of the dictation this line comes from (anti-hallucination guard). */
    phrase: z.string().trim().min(1).max(500),
    product_id: id64.nullable(),
    quantity: z.number().nullable(),
    unit: z.string().trim().min(1).max(60).nullable(),
    price_said: z.number().positive().max(1000000).nullable(),
    confidence: z.enum(['alta', 'baja']),
    reason: z.string().max(1000).default(''),
    question: z.string().trim().max(500).nullable().default(null),
    options: z.array(id64).max(10).default([])
  }).strict()).min(1).max(20),
  payment_method: z.string().trim().max(60).default('efectivo'),
  /** Literal fragment where the seller said the payment; null when none was said (efectivo). */
  payment_phrase: z.string().trim().max(200).nullable().default(null),
  questions: z.array(z.string().trim().min(1).max(500)).max(10).default([])
}).strict()
export type SaleConsolidated = z.infer<typeof saleConsolidatedSchema>
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
  'pos_rejected',         // create_sale answered with an error: nothing was registered
  'price_override_not_allowed', // NOT USED since 2026-11-15 (kept for old records)
  'unit_unclear',         // the presentation (caja, docena…) the AI proposed was not said by the seller
  'phrase_not_in_order',  // (retired) literal-phrase guard of the registrar; kept so stored operations still parse
  'selector_question',    // (registrar) the selector asks the seller something (low confidence, no product, question)
  'price_modified',       // dictated price ≠ list price: always por confirmar; a reviewer approves it at that price
  'price_unverified'      // the draft carries a dictated price that the seller's text does not contain
] as const
export type ReviewReasonCode = typeof REVIEW_REASONS[number]
export type ReviewReason = { code: ReviewReasonCode; line?: number; message: string; detail?: Record<string, unknown> }

export type Instruction = z.infer<typeof instructionSchema>
export type AgentResponse = {
  status: 'completed' | 'pending_review' | 'rejected' | 'pending'
  operation_id: string
  message: string
  result?: Record<string, unknown>
}
export type Product = { id: string; name: string; sku: string; brand: string | null; unit: string; stock: number; /** avg cost per base unit, when known */ avg_cost?: number | null }
export type StockLevel = { id: string; name: string; unit: string; stock: number; min_stock: number }
export type StockAlert = { product_id: string; name: string; unit: string; available: number; min_stock: number; level: 'low' | 'out' }
export type Reservation = { product_id: string; qty: number }
/** A line verified by process 2 (official price, base-unit factor). */
export type DraftItem = {
  product_id: string; name: string; qty: number; unit_name: string; price_unit: number; factor: number; total: number
  /** The seller did not say a quantity: 1 by default. */
  quantity_defaulted?: boolean
  /** List price when the seller dictated a different price (price_unit = dictated price). */
  list_price?: number
  /** Reason for a price ≠ list price (what a reviewer would send as manual_discount_reason). */
  manual_reason?: string
}
/** What is sent to create_sale. Only built when every check passed. */
export type SaleDraft = {
  customer_id: string | null; payment_method: string; items: DraftItem[]; total: number; currency: string
}
/** unit_cost is present only for roles that may see costs (owner/manager). */
export type PriceReviewItem = { product_id: string; name: string; qty: number; unit_name: string; list_price: number; price_unit: number; below_cost: boolean }
export type PriceReview = { status: 'pending' | 'approved' | 'adjusted'; sale_reference: string | null; seller_id: string; created_at: string; items: PriceReviewItem[] }
export type PriceAlert = { product_id: string; name: string; price_unit: number; unit_cost?: number; level: 'below_cost' }
/** Informational notes for the seller (quantity defaulted, price changed) and price alerts. Never block. */
export type DecisionNotes = { notes: string[]; price_alerts: PriceAlert[]; /** efectivo taken by default (no payment said) */ payment_defaulted?: boolean }
export type DraftDecision =
  | ({ kind: 'direct'; sale: SaleDraft; items: DraftItem[] } & DecisionNotes)
  | ({ kind: 'review'; reasons: ReviewReason[]; items: DraftItem[]; reservations: Reservation[] } & DecisionNotes)
/** Who is selling: the role decides whether a dictated price may differ from the list price. */
export type ValidationContext = { role?: string | null }

export type Operation = {
  id: string
  // review = "venta por confirmar": saved for later validation in the POS, reserves stock.
  // simulated = dry-run: would have been registered directly; nothing was sent to create_sale.
  // answered = only answered a catalog question (no sale, no reservation).
  state: 'preparing' | 'review' | 'executing' | 'completed' | 'cancelled' | 'simulated' | 'answered'
  seller_id: string
  messages: string[]
  /** Last draft received from agent 1 (kept for the batch-validation screen and audit). */
  proposal?: SaleDraftV1
  /** Sale actually sent (or to be sent) to create_sale. */
  draft?: SaleDraft
  reasons?: ReviewReason[]
  /**
   * "Venta por confirmar" with a dictated price ≠ list price (NOT registered): what the reviewer
   * needs to approve it at that price later (list and dictated price per line).
   */
  price_review?: PriceReview
  /** Last consolidated sale from the selector agent (POS_AGENT_SELECTOR=llm). */
  consolidated?: SaleConsolidated
  /** A request is being prepared for this operation (agent 1 runs outside the lock). */
  inflight?: { request_id: string; started_at: number }
  /** create_sale was dispatched; `settled` once the outcome (receipt, rejection or indeterminate) was recorded. */
  execution?: { request_id: string; started_at: number; settled: boolean }
  response?: AgentResponse
  reservations?: Reservation[]
  expires_at: number
}
/** Agent 1's answer to a catalog question: informational, never a sale. */
export const catalogAnswerSchema = z.object({
  kind: z.literal('catalog_answer'),
  message: z.string().trim().min(1).transform(value => value.slice(0, 4000)),
  result: z.record(z.string(), z.unknown()).default({})
})
export type RequestRecord = { fingerprint: string; operation_id: string; seller_id: string; response?: AgentResponse; /** when it was claimed (ms) */ claimed_at?: number }

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
export type AgentSeller = { id: string; role?: string | null }
export interface SalesAgentDependencies {
  store: AgentStore
  /**
   * AGENT 1 (AI): turns the conversation into a draft with product IDs (sale-draft/1 or SaleProposal),
   * or into a CatalogAnswer for questions such as «¿tenemos cuadernos Marking?».
   */
  buildDraft(messages: string[], previous: SaleDraftV1 | SaleConsolidated | null): Promise<unknown>
  /** Step 3 (POS_AGENT_SELECTOR=llm): validates a sale-consolidated/1 from the selector agent. */
  registrar?(consolidated: SaleConsolidated, dictation: string, reserved: Map<string, number>, context?: ValidationContext): Promise<DraftDecision>
  /** PROCESS 2 (deterministic): re-verifies the draft and decides direct vs review. */
  validate(draft: SaleDraftV1, reserved: Map<string, number>, context?: ValidationContext): Promise<DraftDecision>
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
/**
 * create_sale answered with an error (rolled back): nothing was registered; the order stays "por confirmar".
 * Its message is ONLY the database error code (e.g. P0001): the detail is logged on the server.
 */
export class SaleRejectedByPosError extends Error {}
