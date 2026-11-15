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
    text: 'un cuaderno rayado',
    lines: [
      { phrase: 'un cuaderno rayado', product: null, quantity: 1, confidence: 'baja', note: 'hay cuadernos rayados de varias marcas: preguntar cuál, con opciones' }
    ]
  }
]
