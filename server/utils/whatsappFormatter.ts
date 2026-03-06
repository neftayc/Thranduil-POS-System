type MatchedLine = any // Assuming type imports

export function formatQuoteToWhatsAppMessage(cart: MatchedLine[]): string {
  if (!cart || cart.length === 0) {
    return 'Tu carrito está vacío 🛒'
  }

  let text = '📝 *Tu Cotización Actualizada:*\n\n'
  let total = 0

  cart.forEach((item, index) => {
    if (item.best_match) {
      const lineTotal = item.requested_qty * item.best_match.sale_price
      total += lineTotal
      
      const stockIcon = item.stock_status === 'ok' ? '✅' : '⚠️'
      text += `${index + 1}. *${item.best_match.name}* ${item.best_match.unit}\n`
      text += `   ${stockIcon} ${item.requested_qty} x S/ ${item.best_match.sale_price.toFixed(2)} = *S/ ${lineTotal.toFixed(2)}*\n`
      
      if (item.stock_status !== 'ok') {
         text += `   _Stock limitado: Solo hay ${item.best_match.stock_on_hand} unidades_\n`
      }
    } else {
      text += `${index + 1}. ❌ No encontramos: "${item.requested_item}"\n`
    }
  })

  text += `\n*Total estimado:* S/ ${total.toFixed(2)}\n\n`
  text += '¿Deseas confirmar tu pedido o cambiar algo?\n'
  text += '_(Ej: Quita el ítem 2, o agrega un lapicero azul)_'

  return text
}

// ─────────────────────────────────────────────
// School List Flow Formatters
// ─────────────────────────────────────────────

export function formatWelcomeWithInstitutions(institutions: { id: string; name: string; short_name: string | null }[]): string {
  let text = '¡Hola! Bienvenido a nuestra Papelería 🎒\n\n'
  text += '¿De qué *institución educativa* es la lista?\n\n'

  institutions.forEach((inst, i) => {
    text += `${i + 1}. ${inst.short_name || inst.name}\n`
  })

  text += '\n*0.* Enviar mi propia lista (foto o texto)\n\n'
  text += '_Responde con el número de tu opción_ 👆'
  return text
}

export function formatGradeList(grades: { name: string; level: string }[]): string {
  let text = '📚 ¿Cuál es el *grado* del alumno?\n\n'
  grades.forEach((g, i) => {
    text += `${i + 1}. ${g.name}\n`
  })
  text += '\n_Responde con el número_ 👆'
  return text
}

export function formatSectionList(sections: { name: string }[]): string {
  let text = '🏫 ¿Cuál es la *sección*?\n\n'
  sections.forEach((s, i) => {
    text += `${i + 1}. Sección ${s.name}\n`
  })
  text += '\n_Responde con el número_ 👆'
  return text
}

export function formatBrandQuestion(): string {
  return (
    '🖊️ ¿Qué *marcas prefieres* para tus útiles?\n\n' +
    'Puedes escribir una o varias marcas separadas por coma.\n' +
    'Ej: _Faber Castell, Layconsa_\n\n' +
    'O escribe *cualquiera* si no tienes preferencia.'
  )
}

export function formatNoListFound(institutionName: string, gradeName: string, sectionName: string): string {
  return (
    `⚠️ Lo sentimos, aún no tenemos la lista de útiles registrada para:\n\n` +
    `🏫 *${institutionName}*\n` +
    `📚 *${gradeName}* – Sección *${sectionName}*\n\n` +
    `Por favor contáctanos directamente o envíanos una foto de tu lista. 📸`
  )
}
