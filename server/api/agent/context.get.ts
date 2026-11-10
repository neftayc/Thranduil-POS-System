import { defineEventHandler } from 'h3'
import { requireAgentCredential } from '../../utils/agent'

export default defineEventHandler((event) => {
  requireAgentCredential(event)
  const config = useRuntimeConfig(event)
  return {
    system_id: 'pos',
    version: '1.0',
    context: {
      description: 'THRANDUIL, POS de papelería. El agente interno interpreta pedidos, consulta productos y prepara ventas con precios y existencias reales.',
      instructions: [
        'Envía el pedido completo literalmente. El POS prepara los artículos y calcula los precios; no inventes productos, cantidades, precios ni stock.',
        'Solicita cantidad a vender, atributos del producto y forma de pago. Distingue 100 hojas de 100 cuadernos. Si no se pide otra presentación se usa la unidad base del producto.',
        'Si no se indica un cliente específico, se prepara una venta al público sin cliente asociado.',
        'Comunica las preguntas de needs_clarification y el detalle de requires_confirmation. Envía la respuesta literal mediante respond_to_system con el mismo operation_id y un request_id nuevo.',
        'Toda venta requiere confirmación explícita del borrador. Una modificación genera un borrador nuevo que debe confirmarse de nuevo.',
        'Usa un UUID nuevo por mensaje. En un reintento reutiliza exactamente el mismo request_id y contenido. pending no significa venta realizada.',
        'Solo completed acredita una venta registrada. Conserva la referencia que devuelve el POS.',
        'La identificación por conversación está pendiente. La ejecución requiere una sesión de vendedor preconfigurada en el servidor; la credencial del conector no sustituye al vendedor.'
      ],
      capabilities: ['prepare_sale', 'clarify_sale', 'confirm_sale', 'cancel_sale'],
      locale: 'es-PE',
      currency: 'PEN',
      execution_configured: Boolean(config.posAgentSellerAccessToken),
      interpretation_configured: Boolean(config.openaiApiKey),
      draft_ttl_seconds: 3600
    }
  }
})
