import { createError, defineEventHandler, getQuery } from 'h3'

import { getProductProfitability } from '../../modules/reports/app/getProductProfitability'
import type { ProductProfitabilityPeriodCode } from '../../modules/reports/ports'
import { makeSupabaseReportsRepository } from '../../modules/reports/infra/supabaseReportsRepository'
import { requireAccessToken } from '../../utils/auth'

const VALID_PERIODS = new Set<ProductProfitabilityPeriodCode>([
  'recovery_2025_to_2026_03_08',
  'standard_from_2026_03_09'
])

const LEGACY_PERIOD_ALIASES: Record<string, ProductProfitabilityPeriodCode> = {
  recovery_2025_to_2026_02_28: 'recovery_2025_to_2026_03_08',
  standard_from_2026_03_01: 'standard_from_2026_03_09'
}

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const repo = makeSupabaseReportsRepository(accessToken)
  const query = getQuery(event)
  const rawPeriod = String(query?.period || '').trim()

  const periodCode =
    rawPeriod && VALID_PERIODS.has(rawPeriod as ProductProfitabilityPeriodCode)
      ? (rawPeriod as ProductProfitabilityPeriodCode)
      : rawPeriod && LEGACY_PERIOD_ALIASES[rawPeriod]
        ? LEGACY_PERIOD_ALIASES[rawPeriod]
        : undefined

  if (rawPeriod && !periodCode) {
      throw createError({
      statusCode: 400,
      statusMessage: 'Periodo inválido. Usa recovery_2025_to_2026_03_08 o standard_from_2026_03_09.'
    })
  }

  try {
    return await getProductProfitability(repo, { period_code: periodCode })
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({ statusCode: 500, statusMessage: err?.message || 'Error inesperado' })
  }
})
