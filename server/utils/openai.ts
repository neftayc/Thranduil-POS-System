import OpenAI from 'openai'

export const getOpenAIClient = () => {
  const config = useRuntimeConfig()
  const apiKey = String(config.openaiApiKey || '').trim()
  if (!apiKey) {
    throw createError({
      statusCode: 500,
      statusMessage: 'Falta OPENAI_API_KEY en las variables de entorno'
    })
  }
  return new OpenAI({ apiKey })
}
