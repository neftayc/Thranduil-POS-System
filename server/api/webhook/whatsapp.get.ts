export default defineEventHandler((event) => {
  const query = getQuery(event)
  
  // Meta APIs always send these three query parameters for webhook verification
  const mode = query['hub.mode']
  const token = query['hub.verify_token']
  const challenge = query['hub.challenge']

  // El Verify Token es una contraseña que tú inventas y la pones aquí y en Meta.
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || 'papeleria_kuska_token_2026'

  if (mode && token) {
    if (mode === 'subscribe' && token === verifyToken) {
      console.log('WEBHOOK_VERIFIED')
      return challenge // Return the challenge token from the request
    } else {
      throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
    }
  }

  throw createError({ statusCode: 400, statusMessage: 'Bad Request' })
})
