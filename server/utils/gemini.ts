import { GoogleGenerativeAI } from '@google/generative-ai'

export const getGeminiClient = () => {
  const config = useRuntimeConfig()
  const apiKey = String(config.geminiApiKey || '').trim()
  if (!apiKey) {
    throw createError({
      statusCode: 500,
      statusMessage: 'Falta GEMINI_API_KEY en las variables de entorno'
    })
  }
  return new GoogleGenerativeAI(apiKey)
}

export const getGeminiModel = (model = 'gemini-2.0-flash-lite') => {
  const client = getGeminiClient()
  return client.getGenerativeModel({ model })
}
