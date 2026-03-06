import { createError } from 'h3'

import type {
  ApplyInventoryAdjustmentInput,
  ApplyInventoryAdjustmentResult,
  CloseInventorySessionInput,
  CloseInventorySessionResult,
  InventoryPageResult,
  InventoryRepository,
  StartInventorySessionResult
} from '../ports'
import { getSupabaseUserClient } from '../../../utils/supabase'

const toInt = (value: any) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return 0
  return Math.max(0, Math.trunc(num))
}

const toSignedInt = (value: any) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return 0
  return Math.trunc(num)
}

const toNumber = (value: any) => {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

const generateSessionCode = () => {
  const now = new Date()
  const pad2 = (n: number) => String(n).padStart(2, '0')
  const datePart = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`
  const timePart = `${pad2(now.getHours())}${pad2(now.getMinutes())}`
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `CNT-${datePart}-${timePart}-${rand}`
}

export const makeSupabaseInventoryRepository = (accessToken: string): InventoryRepository => {
  const supabase = getSupabaseUserClient(accessToken)

  return {
    async getPage(): Promise<InventoryPageResult> {
      const [productsRes, sessionRes] = await Promise.all([
        supabase
          .from('product_catalog')
          .select('id, sku, name, brand, unit, stock_on_hand, min_stock, avg_cost, sale_price, active')
          .order('name'),
        supabase
          .from('inventory_count_sessions')
          .select('*')
          .eq('status', 'open')
          .order('opened_at', { ascending: false })
          .limit(1)
      ])

      if (productsRes.error) throw createError({ statusCode: 500, statusMessage: productsRes.error.message })
      if (sessionRes.error) throw createError({ statusCode: 500, statusMessage: sessionRes.error.message })

      const session = sessionRes.data?.[0] || null
      let sessionItems: any[] = []
      if (session?.id) {
        const { data, error } = await supabase
          .from('inventory_count_items')
          .select('id, session_id, product_id, stock_system, counted, non_sellable, stock_final, delta_qty, avg_cost, reason, reconfirmed, applied, applied_at, updated_at')
          .eq('session_id', session.id)
          .order('updated_at', { ascending: false })

        if (error) throw createError({ statusCode: 500, statusMessage: error.message })
        sessionItems = data || []
      }

      return {
        products: productsRes.data || [],
        session,
        sessionItems
      }
    },

    async startSession(input: { userId: string; notes: string | null }): Promise<StartInventorySessionResult> {
      const notes = String(input?.notes || '').trim()

      // Prevent multiple open sessions.
      const { data: openSessions, error: openError } = await supabase
        .from('inventory_count_sessions')
        .select('id, code')
        .eq('status', 'open')
        .order('opened_at', { ascending: false })
        .limit(1)

      if (openError) throw createError({ statusCode: 500, statusMessage: openError.message })
      if (openSessions?.length) {
        return { session: openSessions[0] as any, alreadyOpen: true }
      }

      const payload = {
        code: generateSessionCode(),
        status: 'open',
        notes: notes || null,
        created_by: input.userId
      }

      const { data, error } = await supabase
        .from('inventory_count_sessions')
        .insert(payload)
        .select('*')
        .single()

      if (error) throw createError({ statusCode: 500, statusMessage: error.message })

      return { session: data as any, alreadyOpen: false }
    },

    async applyAdjustment(input: ApplyInventoryAdjustmentInput & { userId: string }): Promise<ApplyInventoryAdjustmentResult> {
      const sessionId = String(input?.session_id || '').trim()
      const productId = String(input?.product_id || '').trim()
      const reason = String(input?.reason || '').trim()

      if (!sessionId || !productId) {
        throw createError({ statusCode: 400, statusMessage: 'Datos inválidos' })
      }
      if (!reason) {
        throw createError({ statusCode: 400, statusMessage: 'Motivo obligatorio' })
      }

      const { data: session, error: sessionError } = await supabase
        .from('inventory_count_sessions')
        .select('id, status')
        .eq('id', sessionId)
        .single()

      if (sessionError) throw createError({ statusCode: 500, statusMessage: sessionError.message })
      if (!session || (session as any).status !== 'open') {
        throw createError({ statusCode: 400, statusMessage: 'Sesión no disponible' })
      }

      const { data: product, error: productError } = await supabase
        .from('product_catalog')
        .select('id, stock_on_hand, avg_cost, min_stock, active')
        .eq('id', productId)
        .single()

      if (productError) throw createError({ statusCode: 500, statusMessage: productError.message })
      if (!product?.id) {
        throw createError({ statusCode: 404, statusMessage: 'Producto no encontrado' })
      }

      const currentSystemStock = toInt(product.stock_on_hand)
      const newStock = toInt(input?.stock_final)
      const nonSellable = toInt(input?.non_sellable)
      const delta = toSignedInt(newStock - currentSystemStock)
      const nextActive = typeof (input as any)?.active === 'boolean' ? (input as any).active : null
      const activeChange = typeof nextActive === 'boolean' && nextActive !== ((product as any).active !== false)

      if (delta === 0 && !activeChange) {
        return { ok: true, changed: false }
      }

      const now = new Date().toISOString()
      const avgCost = toNumber(product.avg_cost)
      const minStock = toNumber(product.min_stock)

      const { error: balanceError } = await supabase
        .from('inventory_balances')
        .upsert(
          {
            product_id: productId,
            stock_on_hand: newStock,
            avg_cost: avgCost,
            min_stock: minStock,
            updated_at: now
          },
          { onConflict: 'product_id' }
        )

      if (balanceError) throw createError({ statusCode: 500, statusMessage: balanceError.message })

      const productUpdate: Record<string, any> = {
        stock_on_hand: newStock,
        updated_at: now
      }
      if (typeof nextActive === 'boolean') {
        productUpdate.active = nextActive
      }

      const { error: updateProductError } = await supabase
        .from('products')
        .update(productUpdate)
        .eq('id', productId)

      if (updateProductError) throw createError({ statusCode: 500, statusMessage: updateProductError.message })

      if (delta !== 0 || activeChange) {
        const { error: movementError } = await supabase.from('stock_movements').insert({
          product_id: productId,
          movement_type: 'adjust',
          qty: delta,
          cost_unit: avgCost,
          ref_table: 'inventory_count',
          ref_id: sessionId,
          created_by: input.userId
        })

        if (movementError) throw createError({ statusCode: 500, statusMessage: movementError.message })
      }

      const payload = {
        session_id: sessionId,
        product_id: productId,
        stock_system: currentSystemStock,
        counted: newStock,
        non_sellable: nonSellable,
        stock_final: newStock,
        delta_qty: delta,
        avg_cost: avgCost,
        reason,
        reconfirmed: (input as any)?.reconfirmed === true,
        applied: true,
        applied_at: now,
        applied_by: input.userId,
        updated_at: now
      }

      const { data: item, error: itemError } = await supabase
        .from('inventory_count_items')
        .upsert(payload, { onConflict: 'session_id,product_id' })
        .select('id, session_id, product_id, stock_system, counted, non_sellable, stock_final, delta_qty, avg_cost, reason, reconfirmed, applied, applied_at, updated_at')
        .single()

      if (itemError) throw createError({ statusCode: 500, statusMessage: itemError.message })

      return { ok: true, changed: true, item: item as any }
    },

    async closeSession(input: CloseInventorySessionInput & { userId: string }): Promise<CloseInventorySessionResult> {
      const sessionId = String(input?.session_id || '').trim()
      if (!sessionId) {
        throw createError({ statusCode: 400, statusMessage: 'Sesión inválida' })
      }

      const now = new Date().toISOString()
      const { error } = await supabase
        .from('inventory_count_sessions')
        .update({
          status: 'closed',
          closed_at: now,
          closed_by: input.userId,
          notes: String(input?.notes || '').trim() || null,
          updated_at: now
        })
        .eq('id', sessionId)
        .eq('status', 'open')

      if (error) throw createError({ statusCode: 500, statusMessage: error.message })

      return { ok: true, closedAt: now }
    }
  }
}
