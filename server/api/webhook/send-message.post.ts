export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  
  if (!body.to || !body.text) {
    throw createError({ statusCode: 400, statusMessage: 'to and text are required' })
  }

  const { to, text, mediaId } = body
  // Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/messages/text-messages
  
  const token = process.env.WHATSAPP_API_TOKEN
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID // e.g., '10123456789'

  if (!token || !phoneNumberId) {
    console.error('WhatsApp credentials are not configured')
    return { success: false, error: 'Credenciales no configuradas' }
  }

  try {
    const res = await fetch(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: body.mediaId ? 'image' : 'text',
        ...(body.mediaId ? {
          image: {
            id: body.mediaId,
            caption: text
          }
        } : {
          text: {
            preview_url: false,
            body: text
          }
        })
      })
    })

    if (!res.ok) {
      const errorText = await res.text()
      console.error('Error sending WhatsApp message:', errorText)
      return { success: false, error: errorText }
    }

    return { success: true }
  } catch (error: any) {
    console.error('Meta API Error:', error)
    return { success: false, error: error.message }
  }
})
