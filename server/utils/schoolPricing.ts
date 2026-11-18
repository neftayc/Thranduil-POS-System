const toNumber = (value: unknown) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const hasOwnValue = (value: unknown) => value !== null && typeof value !== 'undefined'

export const resolveSchoolBrandPricing = (brand: any) => {
  const product = brand?.product || null
  const baseUnit = String(product?.unit || 'unidad').trim() || 'unidad'
  const factorToBase = Math.max(toNumber(brand?.pricing_factor_to_base) || 1, 1)
  const hasExplicitPrice = hasOwnValue(brand?.pricing_price_uom)
  const priceUom = hasExplicitPrice
    ? Math.max(toNumber(brand?.pricing_price_uom), 0)
    : Math.max(toNumber(product?.sale_price), 0)
  const unitName = String(brand?.pricing_unit_name || '').trim() || baseUnit
  const label =
    String(brand?.pricing_label || '').trim() ||
    (unitName === baseUnit ? `Base (${baseUnit})` : `Presentacion (${unitName})`)

  return {
    rule_id: String(brand?.pricing_rule_id || '').trim() || null,
    unit_name: unitName,
    label,
    factor_to_base: factorToBase,
    price_uom: priceUom,
    price_base: factorToBase > 0 ? priceUom / factorToBase : priceUom,
    qty_uom_from_base: (qtyBase: number) =>
      factorToBase > 0 ? toNumber(qtyBase) / factorToBase : toNumber(qtyBase),
    subtotal_from_base: (qtyBase: number) =>
      (factorToBase > 0 ? toNumber(qtyBase) / factorToBase : toNumber(qtyBase)) *
      priceUom,
  }
}

