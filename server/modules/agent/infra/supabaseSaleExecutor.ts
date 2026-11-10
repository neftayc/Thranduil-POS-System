import { getSupabaseAnonClient, getSupabaseUserClient } from '../../../utils/supabase'
import { makeSupabaseSalesRepository } from '../../sales/infra/supabaseSalesRepository'
import { SaleNotCommittedError, type SaleDraft } from '../contracts'

export const makeSupabaseSaleExecutor = (getToken: () => string) => async (draft: SaleDraft, beforeCommit: () => Promise<void>) => {
  const token = getToken().trim()
  if (!token) throw new SaleNotCommittedError('La venta está preparada, pero falta configurar un vendedor autorizado (POS_AGENT_SELLER_ACCESS_TOKEN). La identificación por conversación se implementará después. No se registró una venta.')
  const { data, error } = await getSupabaseAnonClient().auth.getUser(token)
  if (error || !data.user) throw new SaleNotCommittedError('La sesión del vendedor no es válida o venció. Actualiza la sesión autorizada. No se registró una venta.')
  const { data: role, error: roleError } = await getSupabaseUserClient(token).rpc('user_role')
  if (roleError || !['owner', 'manager', 'cashier'].includes(String(role))) throw new SaleNotCommittedError('El usuario configurado no tiene un rol de vendedor válido. No se registró una venta.')
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
