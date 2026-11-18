/**
 * Learned examples for the sales selector (in-context learning). For now a fixed file; later they
 * come from the seller's corrections (venta por confirmar resolved in the POS).
 *
 * They must NOT repeat the benchmark dictations (tests/fixtures/golden-dictados.json), or the
 * benchmark would measure memory instead of judgement. Products are written by their exact
 * catalog name; an example whose product no longer exists is skipped.
 */
export type SelectorExample = {
  text: string
  lines: Array<{ phrase: string; product: string | null; quantity: number | null; confidence: 'alta' | 'baja'; note?: string }>
}

export const SELECTOR_EXAMPLES: SelectorExample[] = [
  {
    text: 'tres cartulinas negras y un cuaderno layconsa teens cuadriculado, con yape',
    lines: [
      { phrase: 'tres cartulinas negras', product: 'Cartulina Negra', quantity: 3, confidence: 'alta' },
      { phrase: 'un cuaderno layconsa teens cuadriculado', product: 'cuaderno layconsa teens # 100 h', quantity: 1, confidence: 'alta', note: '«cuadriculado» = «#»; es el único teens cuadriculado' }
    ]
  },
  {
    text: 'dos gomas en barra faber de 40',
    lines: [
      { phrase: 'dos gomas en barra faber de 40', product: 'Goma en barra 40Gr', quantity: 2, confidence: 'alta', note: '«de 40» es la medida (40 g), no la cantidad' }
    ]
  },
  {
    text: 'un compás layconsa... dos compases layconsa, y una caja de crayones jumbo de colores',
    lines: [
      { phrase: 'dos compases layconsa', product: 'Compas', quantity: 2, confidence: 'alta', note: '«...» es un «perdón» de la voz: la segunda mención corrige la cantidad; una sola línea' },
      { phrase: 'una caja de crayones jumbo de colores', product: 'Crayones Jumbo', quantity: 1, confidence: 'alta', note: '«de colores» es redundante (los crayones ya son de colores)' }
    ]
  },
  {
    text: '2 cartulinas negras, ...4 folders manila A4 y 6 folders de manila. 3 lapiceros pilot azul',
    lines: [
      { phrase: '2 cartulinas negras', product: 'Cartulina Negra', quantity: 2, confidence: 'alta' },
      { phrase: '6 folders de manila', product: 'Folder Manila A4', quantity: 6, confidence: 'alta', note: '«...» marca una corrección dictada por voz: «4 folders manila A4 y 6 folders de manila» es UN artículo corregido a 6 (la segunda mención, más genérica, es el mismo folder), no dos' },
      { phrase: '3 lapiceros pilot azul', product: 'Lapicero pilot azul', quantity: 3, confidence: 'alta' }
    ]
  },
  {
    text: '3 correctores en cinta, no, mejor correctores de 9 ml',
    lines: [
      { phrase: '3 correctores en cinta, no, mejor correctores de 9 ml', product: 'Corrector 9ML', quantity: 3, confidence: 'alta', note: '«no, mejor» corrige el producto y conserva la cantidad dicha antes' }
    ]
  },
  {
    text: 'un cuaderno rayado',
    lines: [
      { phrase: 'un cuaderno rayado', product: null, quantity: 1, confidence: 'baja', note: 'hay cuadernos rayados de varias marcas: preguntar cuál, con opciones' }
    ]
  }
]
