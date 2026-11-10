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

export type Instruction = z.infer<typeof instructionSchema>
export type Interpretation = z.infer<typeof interpretationSchema>
export type AgentResponse = {
  status: 'completed' | 'requires_confirmation' | 'needs_clarification' | 'rejected' | 'pending'
  operation_id: string
  message: string
  result?: Record<string, unknown>
}
export type Product = { id: string; name: string; sku: string; brand: string | null; unit: string; stock: number }
export type DraftItem = {
  product_id: string; name: string; qty: number; unit_name: string; price_unit: number; factor: number; total: number
}
export type SaleDraft = {
  customer_id: string | null; payment_method: string; items: DraftItem[]; total: number; currency: string
}
export type Operation = {
  id: string
  state: 'preparing' | 'clarification' | 'confirmation' | 'executing' | 'completed' | 'cancelled'
  messages: string[]
  interpretation?: Interpretation
  candidates: Product[]
  draft?: SaleDraft
  response?: AgentResponse
  expires_at: number
}
export type RequestRecord = { fingerprint: string; operation_id: string; response?: AgentResponse }

export interface AgentStore {
  getRequest(id: string): Promise<RequestRecord | null>
  saveRequest(id: string, value: RequestRecord): Promise<void>
  getOperation(id: string): Promise<Operation | null>
  saveOperation(value: Operation): Promise<void>
  exclusive<T>(work: () => Promise<T>): Promise<T>
}
export class AgentBusyError extends Error {}
export class AgentConflictError extends Error {}
export interface SalesAgentDependencies {
  store: AgentStore
  interpret(messages: string[], previous: Operation): Promise<Interpretation>
  prepare(input: Interpretation, previousCandidates: Product[]): Promise<{
    draft?: SaleDraft; question?: string; candidates: Product[]
  }>
  execute(draft: SaleDraft, beforeCommit: () => Promise<void>): Promise<{ saleId: string; total: number }>
}

export class SaleNotCommittedError extends Error {}
