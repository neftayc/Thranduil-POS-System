import { createError, defineEventHandler, getQuery } from 'h3'

import { getExecutiveInvestmentReport } from '../../modules/reports/app/getExecutiveInvestmentReport'
import { requireAccessToken } from '../../utils/auth'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DEFAULT_START_DATE = '2026-03-09'

const todayDateKey = () => {
  const peruOffsetMs = 5 * 60 * 60 * 1000
  const date = new Date(Date.now() - peruOffsetMs)
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const parseDate = (value: string) => {
  const [year, month, day] = value.split('-').map((part) => Number(part))
  return new Date(Date.UTC(year, month - 1, day))
}

export default defineEventHandler(async (event) => {
  const accessToken = await requireAccessToken(event)
  const query = getQuery(event)
  const startDate = String(query?.startDate || DEFAULT_START_DATE).trim()
  const endDate = String(query?.endDate || todayDateKey()).trim()

  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Rango invalido. Usa startDate y endDate con formato YYYY-MM-DD.'
    })
  }

  if (parseDate(startDate).getTime() > parseDate(endDate).getTime()) {
    throw createError({
      statusCode: 400,
      statusMessage: 'La fecha inicial no puede ser mayor que la fecha final.'
    })
  }

  try {
    return await getExecutiveInvestmentReport(accessToken, { startDate, endDate })
  } catch (err: any) {
    if (err?.statusCode) throw err
    throw createError({
      statusCode: 500,
      statusMessage: err?.message || 'No se pudo construir el reporte ejecutivo.'
    })
  }
})
