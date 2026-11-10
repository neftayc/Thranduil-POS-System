import { makeSupabaseSalesRepository } from '../../sales/infra/supabaseSalesRepository'
import { SaleNotCommittedError, type SaleDraft } from '../contracts'

/**
 * Registers the sale AS the identified seller: `authorize` re-validates the seller session
 * (not revoked, user active, valid role) and returns that seller's own access token, so the
 * create_sale RPC records auth.uid() = seller. No service key, no shared seller token.
 */
export const makeSupabaseSaleExecutor = (authorize: () => Promise<string>) => async (draft: SaleDraft, beforeCommit: () => Promise<void>) => {
  let token: string
  try {
    token = await authorize()
  } catch (error) {
    const reason = error instanceof Error && error.message ? error.message : 'La sesión del vendedor no es válida.'
    throw new SaleNotCommittedError(`${reason} No se registró una venta.`)
  }
  await beforeCommit()
  // A transport error after this point is indeterminate. The orchestrator does not retry this RPC.
  const result = await makeSupabaseSalesRepository(token).createSale({
    customer_id: draft.customer_id,
    payment_method: draft.payment_method,
    items: draft.items.map(item => ({ product_id: item.product_id, qty: item.qty, unit_name: item.unit_name, price_unit: item.price_unit }))
  })
  if (!result.saleId) throw new Error('La base de datos no devolvió el identificador de venta')
  return { saleId: String(result.saleId), total: draft.total }
}
