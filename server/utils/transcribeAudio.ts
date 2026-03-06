import { getOpenAIClient } from './openai'
import FormData from 'form-data'

export async function transcribeAudio(audioBuffer: Buffer, filename: string = 'audio.ogg'): Promise<string> {
  const openai = getOpenAIClient()
  
  // Create a proper File/Blob object from buffer for the openai SDK, or use raw fetch
  // Since we are using openai sdk, it supports readStreams or we can use form-data manually
  
  const formData = new FormData()
  formData.append('file', audioBuffer, {
    filename,
    contentType: 'audio/ogg' // WhatsApp usually sends Ogg/Opus
  })
  formData.append('model', 'whisper-1')
  formData.append('language', 'es')

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      ...formData.getHeaders()
    },
    body: formData as any
  })

  if (!res.ok) {
    const err = await res.text()
    console.error('Audio transcription error:', err)
    throw new Error('No se pudo transcribir el audio')
  }

  const json = await res.json()
  return json.text
}
