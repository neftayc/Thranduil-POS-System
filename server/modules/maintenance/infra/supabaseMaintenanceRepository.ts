import { createError } from 'h3'

import type { MaintenanceDataResult, MaintenanceRepository } from '../ports'
import { getSupabaseUserClient } from '../../../utils/supabase'

export const makeSupabaseMaintenanceRepository = (accessToken: string): MaintenanceRepository => {
  const supabase = getSupabaseUserClient(accessToken)

  return {
    async getAll(): Promise<MaintenanceDataResult> {
      const [unitsRes, methodsRes, groupsRes, categoriesRes] = await Promise.all([
        supabase.from('uom_catalog').select('code, label, active').order('label'),
        supabase
          .from('payment_method_catalog')
          .select('code, label, active, sort_order')
          .order('sort_order')
          .order('label'),
        supabase.from('customer_groups').select('code, label, active, sort_order').order('sort_order').order('label'),
        supabase.from('product_categories').select('code, name, active, sort_order').order('sort_order').order('name')
      ])

      if (unitsRes.error) throw createError({ statusCode: 500, statusMessage: unitsRes.error.message })
      if (methodsRes.error) throw createError({ statusCode: 500, statusMessage: methodsRes.error.message })
      if (groupsRes.error) throw createError({ statusCode: 500, statusMessage: groupsRes.error.message })
      if (categoriesRes.error) throw createError({ statusCode: 500, statusMessage: categoriesRes.error.message })

      return {
        units: unitsRes.data || [],
        paymentMethods: methodsRes.data || [],
        customerGroups: groupsRes.data || [],
        categories: categoriesRes.data || []
      }
    },

    async createUnit(input) {
      const code = String(input?.code || '').trim()
      const label = String(input?.label || '').trim()

      if (!code || !label) {
        throw createError({ statusCode: 400, statusMessage: 'Datos inválidos' })
      }

      const { error } = await supabase.from('uom_catalog').insert({ code, label, active: true })
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { ok: true as const }
    },

    async updateUnit(code, input) {
      const unitCode = String(code || '').trim()
      if (!unitCode) {
        throw createError({ statusCode: 400, statusMessage: 'Código inválido' })
      }

      const label = String(input?.label || '').trim()
      const active = (input as any)?.active !== false

      if (!label) {
        throw createError({ statusCode: 400, statusMessage: 'Nombre obligatorio' })
      }
      if (unitCode === 'unidad' && active === false) {
        throw createError({ statusCode: 400, statusMessage: 'La unidad base "unidad" no se puede desactivar.' })
      }

      const { error } = await supabase.from('uom_catalog').update({ label, active }).eq('code', unitCode)
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { ok: true as const }
    },

    async createPaymentMethod(input) {
      const code = String(input?.code || '').trim()
      const label = String(input?.label || '').trim()
      const sortOrder = Number((input as any)?.sort_order || 100)

      if (!code || !label) {
        throw createError({ statusCode: 400, statusMessage: 'Datos inválidos' })
      }

      const { error } = await supabase.from('payment_method_catalog').insert({ code, label, sort_order: sortOrder, active: true })
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { ok: true as const }
    },

    async updatePaymentMethod(code, input) {
      const methodCode = String(code || '').trim()
      if (!methodCode) {
        throw createError({ statusCode: 400, statusMessage: 'Código inválido' })
      }

      const label = String(input?.label || '').trim()
      const active = (input as any)?.active !== false
      const sortOrder = Number((input as any)?.sort_order || 100)

      if (!label) {
        throw createError({ statusCode: 400, statusMessage: 'Nombre obligatorio' })
      }
      if (methodCode === 'efectivo' && active === false) {
        throw createError({ statusCode: 400, statusMessage: 'Debes mantener activo al menos "efectivo".' })
      }

      const { error } = await supabase.from('payment_method_catalog').update({ label, active, sort_order: sortOrder }).eq('code', methodCode)
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { ok: true as const }
    },

    async createCustomerGroup(input) {
      const code = String(input?.code || '').trim()
      const label = String(input?.label || '').trim()
      const sortOrder = Number((input as any)?.sort_order || 100)

      if (!code || !label) {
        throw createError({ statusCode: 400, statusMessage: 'Datos inválidos' })
      }

      const { error } = await supabase.from('customer_groups').insert({ code, label, sort_order: sortOrder, active: true })
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { ok: true as const }
    },

    async updateCustomerGroup(code, input) {
      const groupCode = String(code || '').trim()
      if (!groupCode) {
        throw createError({ statusCode: 400, statusMessage: 'Código inválido' })
      }

      const label = String(input?.label || '').trim()
      const active = (input as any)?.active !== false
      const sortOrder = Number((input as any)?.sort_order || 100)

      if (!label) {
        throw createError({ statusCode: 400, statusMessage: 'Nombre obligatorio' })
      }
      if (groupCode === 'minorista' && active === false) {
        throw createError({ statusCode: 400, statusMessage: 'Debes mantener activo al menos "minorista".' })
      }

      const { error } = await supabase.from('customer_groups').update({ label, active, sort_order: sortOrder }).eq('code', groupCode)
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { ok: true as const }
    },

    async createCategory(input) {
      const code = String(input?.code || '').trim()
      const label = String(input?.label || '').trim()
      const sortOrder = Number((input as any)?.sort_order || 100)

      if (!code || !label) {
        throw createError({ statusCode: 400, statusMessage: 'Datos inválidos' })
      }

      const { error } = await supabase
        .from('product_categories')
        .insert({ code, name: label, sort_order: sortOrder, active: true })
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { ok: true as const }
    },

    async updateCategory(code, input) {
      const categoryCode = String(code || '').trim()
      if (!categoryCode) {
        throw createError({ statusCode: 400, statusMessage: 'Código inválido' })
      }

      const label = String(input?.label || '').trim()
      const active = (input as any)?.active !== false
      const sortOrder = Number((input as any)?.sort_order || 100)

      if (!label) {
        throw createError({ statusCode: 400, statusMessage: 'Nombre obligatorio' })
      }

      const { error } = await supabase
        .from('product_categories')
        .update({ name: label, active, sort_order: sortOrder })
        .eq('code', categoryCode)
      if (error) throw createError({ statusCode: 500, statusMessage: error.message })
      return { ok: true as const }
    }
  }
}
