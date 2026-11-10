import { defineEventHandler, getHeader } from 'h3'
import { isDryRun, requireAgentCredential, requireSeller, SELLER_SESSION_HEADER } from '../../utils/agent'

export default defineEventHandler(async (event) => {
  requireAgentCredential(event)
  // With a seller session the context confirms who is selling; an invalid session is a 403.
  const seller = getHeader(event, SELLER_SESSION_HEADER) ? await requireSeller(event) : null
  const config = useRuntimeConfig(event)
  return {
    system_id: 'pos',
    version: '2.0',
    context: {
      description: 'THRANDUIL, POS de papelería. El agente interno interpreta pedidos, consulta productos y registra ventas con precios y existencias reales a nombre del vendedor identificado.',
      instructions: [
        'Cada vendedor se identifica con su propio usuario del POS en la página de vinculación; nunca pidas ni escribas contraseñas en el chat.',
        'Envía el pedido completo literalmente: productos, cantidades, presentación y forma de pago. El POS busca los productos y calcula los precios; no inventes productos, cantidades, precios ni stock.',
        'Si el pedido es inequívoco, el POS registra la venta de inmediato y responde completed con su referencia. No hay paso de confirmación.',
        'Si el POS no puede decidir (varias coincidencias, falta cantidad o forma de pago, stock insuficiente), guarda una venta por confirmar y responde pending_review con su referencia y lo pendiente. Esa venta NO está registrada: se valida después en el POS y su stock queda reservado.',
        'Para completar o anular una venta por confirmar desde el chat, envía el dato literal con respond_to_system usando su operation_id y un request_id nuevo; «cancelar» la anula.',
        'Comunica siempre las alertas de stock bajo o agotado que devuelva el POS.',
        'Usa un UUID nuevo por mensaje. En un reintento reutiliza exactamente el mismo request_id y contenido. pending no significa venta realizada.',
        'Solo completed con referencia acredita una venta registrada. Conserva la referencia que devuelve el POS.',
        'Un completed con result.kind = "catalog_answer" solo responde una consulta del catálogo (existencia, precio o stock): NO es una venta.',
        'Si no se indica un cliente específico, se registra una venta al público sin cliente asociado.'
      ],
      capabilities: ['register_sale', 'pending_review_sale', 'cancel_sale', 'stock_alerts'],
      locale: 'es-PE',
      currency: 'PEN',
      identification: 'required',
      seller: seller ? { name: seller.name, role: seller.role } : null,
      execution_configured: String(config.posAgentSessionKey || '').length >= 32,
      interpretation_configured: Boolean(config.openaiApiKey),
      dry_run: isDryRun(config.posAgentDryRun),
      review_ttl_hours: Number(config.posAgentReviewTtlHours || 48)
    }
  }
})
