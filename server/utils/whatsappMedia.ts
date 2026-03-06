export async function downloadWhatsAppMedia(mediaId: string): Promise<Buffer> {
  const token = process.env.WHATSAPP_API_TOKEN
  
  if (!token) {
    throw new Error('WHATSAPP_API_TOKEN no está configurado')
  }

  // 1. Get Media URL
  const resUrl = await fetch(`https://graph.facebook.com/v18.0/${mediaId}/`, {
    headers: { 'Authorization': `Bearer ${token}` }
  })
  
  if (!resUrl.ok) {
     throw new Error('No se pudo obtener la URL del media de WhatsApp')
  }

  const mediaData = await resUrl.json()
  const url = mediaData.url

  // 2. Download Media Content using the URL and token
  const resContent = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` }
  })

  if (!resContent.ok) {
    throw new Error('No se pudo descargar el contenido del media')
  }

  const arrayBuffer = await resContent.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

export async function uploadWhatsAppMedia(buffer: Buffer, mimeType: string): Promise<string> {
  const token = process.env.WHATSAPP_API_TOKEN
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID

  if (!token || !phoneNumberId) {
    throw new Error('WhatsApp credentials (token or phone number ID) are not configured')
  }

  const formData = new FormData()
  // Buffer is a Uint8Array, but sometimes types get messy in mixed environments
  const uint8 = new Uint8Array(buffer)
  const blob = new Blob([uint8], { type: mimeType })
  formData.append('file', blob, 'order_photo.jpg')
  formData.append('messaging_product', 'whatsapp')

  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/media`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`
    },
    body: formData
  })

  if (!res.ok) {
    const errorText = await res.text()
    console.error('WhatsApp Upload Error:', errorText)
    throw new Error(`Failed to upload media to WhatsApp: ${errorText}`)
  }

  const data = await res.json()
  return data.id as string
}
