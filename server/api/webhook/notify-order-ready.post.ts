import { defineEventHandler, createError, readMultipartFormData } from 'h3'
import { getSupabaseAdminClient } from '../../utils/supabase'
import { uploadWhatsAppMedia } from '../../utils/whatsappMedia'

export default defineEventHandler(async (event) => {
  const formData = await readMultipartFormData(event)
  if (!formData) {
    throw createError({ statusCode: 400, statusMessage: 'No form data received' })
  }

  const orderIdField = formData.find(f => f.name === 'orderId')
  const imageField = formData.find(f => f.name === 'image')

  if (!orderIdField || !imageField || !imageField.data) {
    throw createError({ statusCode: 400, statusMessage: 'orderId and image are required' })
  }

  const orderId = orderIdField.data.toString()
  const imageBuffer = imageField.data
  const mimeType = imageField.type || 'image/jpeg'

  const supabase = getSupabaseAdminClient()

  // 1. Get order details to find phone number
  const { data: order, error: orderErr } = await supabase
    .from('sales_orders')
    .select('notes, order_code')
    .eq('id', orderId)
    .single()

  if (orderErr || !order) {
    throw createError({ statusCode: 404, statusMessage: 'Order not found' })
  }

  // Extract phone number from notes "WhatsApp: {phoneNumber}"
  const phoneMatch = order.notes?.match(/WhatsApp:\s*(\+?\d+)/)
  if (!phoneMatch) {
    throw createError({ statusCode: 400, statusMessage: 'No WhatsApp phone number found in order notes' })
  }
  const phoneNumber = phoneMatch[1]

  try {
    // 2. Upload image to WhatsApp
    const mediaId = await uploadWhatsAppMedia(imageBuffer, mimeType)

    // 3. Send WhatsApp message with image
    const token = process.env.WHATSAPP_API_TOKEN
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID

    const text = `🎨 ¡Tu pedido ya está listo! ✨\nCódigo: *${order.order_code}*\n\nPuedes pasar a recogerlo. ¡Te esperamos!`

    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phoneNumber,
        type: 'image',
        image: {
          id: mediaId,
          caption: text
        }
      })
    })

    if (!res.ok) {
      const errorText = await res.text()
      console.error('Error sending WhatsApp notification:', errorText)
      throw new Error(`WhatsApp API Error: ${errorText}`)
    }

    return { success: true }
  } catch (err: any) {
    console.error('Notify Order Ready Error:', err)
    throw createError({ statusCode: 500, statusMessage: err.message || 'Internal server error' })
  }
})
