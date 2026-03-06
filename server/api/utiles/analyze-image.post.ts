import { requireAccessToken } from '../../utils/auth'
import { getSupabaseUserClient } from '../../utils/supabase'
import { analyzeImageCore } from '../../utils/aiLogic'

export default defineEventHandler(async (event) => {
  let token = ''
  
  const authHeader = getRequestHeader(event, 'authorization') || ''
  const internalToken = getRequestHeader(event, 'x-webhook-token') || ''
  
  if (internalToken) {
     token = internalToken
  } else if (authHeader.startsWith('Bearer ')) {
     token = authHeader.replace('Bearer ', '')
  } else {
     token = await requireAccessToken(event)
  }

  let filePartData: Buffer | null = null
  let mimeType = 'image/jpeg'

  const contentType = getRequestHeader(event, 'content-type') || ''
  
  if (contentType.includes('application/json')) {
    const body = await readBody(event)
    if (!body || !body.image) {
      throw createError({ statusCode: 400, statusMessage: 'No se procesó la imagen json' })
    }
    const matches = body.image.match(/^data:([A-Za-z-+\\/]+);base64,(.+)$/)
    if (matches && matches.length === 3) {
      mimeType = matches[1]
      filePartData = Buffer.from(matches[2], 'base64')
    } else {
      filePartData = Buffer.from(body.image, 'base64')
    }
  } else {
    const parts = await readMultipartFormData(event)
    if (!parts || parts.length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'No se recibió ningún archivo multipart' })
    }

    const filePart = parts.find((p: any) => p.name === 'image' || p.type?.startsWith('image/'))
    if (!filePart || !filePart.data) {
      throw createError({ statusCode: 400, statusMessage: 'No se encontró la imagen en el formulario' })
    }
    filePartData = filePart.data
    mimeType = filePart.type || 'image/jpeg'
  }
  
  if (!filePartData) throw createError({ statusCode: 400, statusMessage: 'Fallo procesando los datos de imagen' })

  const supabase = getSupabaseUserClient(token)

  try {
     return await analyzeImageCore(filePartData, mimeType, supabase)
  } catch (err: any) {
     throw createError({ statusCode: err.statusCode || 400, statusMessage: err.message })
  }
})
