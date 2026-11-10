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

export const interpretationSchema = z.object({
  // catalog_query = a question about the catalog ("¿tenemos cuadernos Marking?", "¿cuánto cuesta…?").
  intent: z.enum(['sale', 'cancel', 'unsupported', 'catalog_query']),
  items: z.array(z.object({
    query: z.string(),
    sku: z.string().nullable(),
    quantity: z.number().nullable(),
    unit: z.string().nullable(),
    product_id: z.string().nullable(),
    // Agent 1: what the order says, separated (optional for callers that do not provide it).
    product: z.string().nullable().optional(),
    brand: z.string().nullable().optional(),
    attributes: z.array(z.string()).optional()
  })),
  payment_method: z.string().nullable(),
  customer_query: z.string().nullable(),
  question: z.string().nullable()
})

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
export type DraftItem = {
  product_id: string; name: string; qty: number; unit_name: string; price_unit: number; factor: number; total: number
}
/**
 * Agent 1 output (contract agreed with process 2). `confidence: 'high'` ⇔ every line has a
 * single product with exact attributes, quantity, live price and stock, and the payment
 * method is known; only then `prepare()` also returns `draft`. Product IDs only ever come
 * from real catalog candidates.
 */
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
  unit_name: string | null
  factor: number | null
  price_unit: number | null
  total: number | null
  /** stock_on_hand − units reserved by other ventas por confirmar (base unit). */
  stock_available: number | null
  confidence: Confidence
  match_score: number
  reasons: string[]
  alternatives: ProposalAlternative[]
}
export type SaleProposal = {
  confidence: Confidence
  customer_id: string | null
  payment_method: string | null
  items: ProposalItem[]
  total: number | null
  currency: 'PEN'
  doubts: string[]
}
export type SaleDraft = {
  customer_id: string | null; payment_method: string; items: DraftItem[]; total: number; currency: string
}
export type Operation = {
  id: string
  // review = "venta por confirmar": saved for later validation in the POS, reserves stock.
  state: 'preparing' | 'review' | 'executing' | 'completed' | 'cancelled'
  seller_id: string
  messages: string[]
  interpretation?: Interpretation
  candidates: Product[]
  draft?: SaleDraft
  response?: AgentResponse
  reservations?: Reservation[]
  question?: string
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
  interpret(messages: string[], previous: Operation): Promise<Interpretation>
  prepare(input: Interpretation, previousCandidates: Product[], reserved: Map<string, number>): Promise<{
    draft?: SaleDraft; question?: string; candidates: Product[]; items?: DraftItem[]; proposal?: SaleProposal
  }>
  /** Answers catalog questions with live data (agent 1). */
  answer?(input: Interpretation): Promise<{ message: string; result: Record<string, unknown> }>
  execute(draft: SaleDraft, beforeCommit: () => Promise<void>): Promise<{ saleId: string; total: number }>
  stockLevels?(productIds: string[]): Promise<StockLevel[]>
  /** How long a "venta por confirmar" keeps its stock reservation (default 48 h). */
  reviewTtlMs?: number
}

export class SaleNotCommittedError extends Error {}
