import crypto from 'crypto'
import { getOpenAIClient } from './openai'
import { z } from 'zod'

/* Definition of draft cart types */
export type ProductOption = {
  product_id: string
  sku: string
  name: string
  unit: string
  sale_price: number
  stock_on_hand: number
  score: number
}

export type MatchedLine = {
  requested_item: string
  requested_qty: number
  raw: string
  best_match: ProductOption | null
  alternatives: ProductOption[]
  stock_status: 'ok' | 'low' | 'no_match'
}

type CandidateRow = {
  id: string
  sku: string
  name: string
  unit: string
  sale_price: number
  stock_on_hand: number
  similarity: number
}

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

const SYSTEM_PROMPT = `Asistente OCR para listas de útiles escolares en Perú.
Extrae todos los ítems y devuelve SOLO este JSON:
[{"qty":3,"item":"cuadernos rayados A4","raw":"3 Cds. rayados A4","marcado":"falta"}]

Reglas:
- Normaliza: Cd./Cds.=cuaderno/s, Lp.=lapicero, Tp.=tajador, Lb.=libro, Res.=resaltador
- Si cantidad no está clara, usa 1
- Separa sub-ítems en entradas individuales
- Imagen sin lista de útiles → []
- CRÍTICO: Si el ítem tiene marcas hechas a mano (como "Falta", un check "✓", un aspa "X", subrayado, o texto añadido a mano), agrega la propiedad "marcado" indicando el estado sugerido (ej. "falta", "comprar", "ya_tiene"). Si no tiene marcas, omite la propiedad "marcado".`

function deterministicStringify(obj: any): string {
  if (Array.isArray(obj)) {
    return '[' + obj.map(deterministicStringify).join(',') + ']'
  }
  if (obj !== null && typeof obj === 'object') {
    const keys = Object.keys(obj).sort()
    return '{' + keys.map(k => JSON.stringify(k) + ':' + deterministicStringify(obj[k])).join(',') + '}'
  }
  return JSON.stringify(obj)
}

/* AI Structured Output Schema */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const CartModificationSchema = z.object({
  operations: z.array(z.object({
    type: z.enum(['REMOVE', 'UPDATE_QTY', 'REPLACE_BRAND', 'ADD']),
    index: z.number().nullable().describe('Index of the item in the cart to modify (0-based)'),
    qty: z.number().nullable().describe('New quantity for UPDATE_QTY or ADD'),
    instruction: z.string().nullable().describe('Search instruction for REPLACE_BRAND (e.g. "Gomas Artesco") or ADD (e.g. "2 lápices 2B")')
  }))
})

// === Core Logic Extract ===

export const analyzeImageCore = async (filePartData: Buffer, mimeType: string, supabase: any): Promise<{ items: any[], usage: any }> => {
  // Validate file type
  if (!ALLOWED_TYPES.includes(mimeType)) {
    throw new Error(`Tipo de archivo no permitido: ${mimeType}`)
  }

  // Validate file size
  if (filePartData.length > MAX_FILE_SIZE) {
    throw new Error('La imagen no puede superar 5MB.')
  }

  // --- Nivel 1: Caché por Hash MD5 ---
  const imageHash = crypto.createHash('md5').update(filePartData).digest('hex')

  const { data: cached } = await supabase
    .from('image_cache')
    .select('response_json')
    .eq('hash', imageHash)
    .single()

  if (cached && cached.response_json) {
    return { 
      items: cached.response_json, 
      usage: { cached: true, estimated_cost_usd: 0 } 
    }
  }

  // --- No hay caché, llamar a OpenAI ---
  const base64Data = filePartData.toString('base64')
  const openai = getOpenAIClient()

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',  
    max_tokens: 1000,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${base64Data}`,
              detail: 'low' 
            }
          },
          { type: 'text', text: 'Extrae los ítems de esta lista de útiles escolares.' }
        ]
      }
    ]
  })

  const rawText = response.choices[0]?.message?.content?.trim() || '[]'

  let items: Array<{ qty: number; item: string; raw: string; marcado?: string }> = []
  try {
    const cleaned = rawText.replace(/^\s*```[a-z]*\n?/i, '').replace(/\n?```\s*$/i, '').trim()
    items = JSON.parse(cleaned)
    if (!Array.isArray(items)) items = []
  } catch {
    items = []
  }

  // Guardar en caché asíncronamente (sin bloquear la request)
  if (items.length > 0) {
    supabase.from('image_cache').insert({
      hash: imageHash,
      response_json: items
    }).then(({ error }: { error: any }) => {
      if (error) console.error('Error saving image cache:', error.message)
    })
  }

  const usage = response.usage ? {
    prompt_tokens: response.usage.prompt_tokens,
    completion_tokens: response.usage.completion_tokens,
    total_tokens: response.usage.total_tokens,
    estimated_cost_usd: +(
      (response.usage.prompt_tokens * 0.00000015 +
       response.usage.completion_tokens * 0.0000006)
    .toFixed(6))
  } : null

  return { items, usage }
}

export const matchProductsCore = async (itemsList: Array<{ qty: number; item: string; raw?: string }>, supabase: any): Promise<{ matched: MatchedLine[], usage: any }> => {
  if (!itemsList || !Array.isArray(itemsList) || itemsList.length === 0) {
    throw new Error('Se requiere un array de items')
  }

  const payloadHash = crypto.createHash('sha256').update(deterministicStringify(itemsList)).digest('hex')

  const { data: cached } = await supabase
    .from('match_cache')
    .select('response_json')
    .eq('hash', payloadHash)
    .single()

  if (cached && cached.response_json) {
    const matchedItems = cached.response_json as MatchedLine[]
    const productIds = new Set<string>()
    
    matchedItems.forEach(m => {
      if (m.best_match) productIds.add(m.best_match.product_id)
      m.alternatives.forEach(alt => productIds.add(alt.product_id))
    })

    if (productIds.size > 0) {
      const { data: latestProducts } = await supabase
        .from('products')
        .select('id, sale_price, stock_on_hand')
        .in('id', Array.from(productIds))
      
      if (latestProducts && latestProducts.length > 0) {
        const prodMap = new Map((latestProducts as any[]).map(p => [p.id, p]))
        
        matchedItems.forEach(m => {
          if (m.best_match) {
            const live = prodMap.get(m.best_match.product_id)
            if (live) {
              m.best_match.sale_price = live.sale_price
              m.best_match.stock_on_hand = live.stock_on_hand
            }
            const stockOk = Number(m.best_match.stock_on_hand) >= m.requested_qty
            m.stock_status = stockOk ? 'ok' : 'low'
          }
          
          m.alternatives.forEach(alt => {
            const live = prodMap.get(alt.product_id)
            if (live) {
              alt.sale_price = live.sale_price
              alt.stock_on_hand = live.stock_on_hand
            }
          })
        })
      }
    }

    return { 
      matched: matchedItems,
      usage: { cached: true, estimated_cost_usd: 0 }
    }
  }

  const openai = getOpenAIClient()

  const queries = itemsList.map(it => it.item)
  const embedRes = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: queries
  })
  const embedUsage = embedRes.usage?.total_tokens ?? 0
  const queryEmbeddings = embedRes.data.map(d => d.embedding)

  let candidatesPerItem: CandidateRow[][] = await Promise.all(
    queryEmbeddings.map(embedding =>
      supabase
        .rpc('match_products', { query_embedding: embedding, match_threshold: 0.2, match_count: 5 })
        .then(({ data, error }: { data: any, error: any }) => {
          if (error) throw new Error(error.message)
          return (data || []) as CandidateRow[]
        })
    )
  )

  const retryIndices = candidatesPerItem
    .map((c, i) => (c.length === 0 ? i : -1))
    .filter(i => i !== -1)

  if (retryIndices.length > 0) {
    const retryResults = await Promise.all(
      retryIndices.map(idx =>
        supabase
          .rpc('match_products', { query_embedding: queryEmbeddings[idx], match_threshold: 0.05, match_count: 8 })
          .then(({ data, error }: { data: any, error: any }) => {
            if (error) throw new Error(error.message)
            return (data || []) as CandidateRow[]
          })
      )
    )
    retryIndices.forEach((itemIdx, retryPos) => {
      candidatesPerItem[itemIdx] = retryResults[retryPos]
    })
  }

  const idxToId = new Map<string, string>()
  const itemsText = itemsList.map((it, i) => {
    const candidates = candidatesPerItem[i]
    if (!candidates.length) return `${i}:"${it.item}" sin candidatos`
    const cStr = candidates.map((c, j) => {
      const key = `c${i}_${j}`
      idxToId.set(key, c.id)
      return `  ${key}:"${c.name}" ${c.unit} S/${c.sale_price}`
    }).join('\n')
    return `${i}:"${it.item}"\n${cStr}`
  }).join('\n')

  const prompt = `Papelería peruana. Candidatos pre-filtrados por similitud vectorial:
${itemsText}
Elige el mejor match por ítem (y hasta 1 alternativa). Usa las claves cortas (cX_Y).
JSON:
[{"item_index":0,"matches":[{"product_id":"c0_0"}]}]
Sin texto extra.`

  const gptRes = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 1200,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }]
  })

  const rawText = gptRes.choices[0]?.message?.content?.trim() || '[]'
  let parsedMatches: any[] = []
  try {
    const cl = rawText.replace(/^\s*```[a-z]*\n?/i, '').replace(/\n?```\s*$/i, '').trim()
    parsedMatches = JSON.parse(cl)
    if (!Array.isArray(parsedMatches)) parsedMatches = []
  } catch (err) {
    console.error('Error parseando matches:', err)
  }

  const results: MatchedLine[] = itemsList.map((it, i) => {
    const reqQty = Number(it.qty) || 1
    const line: MatchedLine = {
      requested_item: it.item,
      requested_qty: reqQty,
      raw: it.raw || '',
      best_match: null,
      alternatives: [],
      stock_status: 'no_match'
    }

    const aiSel = parsedMatches.find(m => Number(m.item_index) === i)
    if (aiSel && aiSel.matches && aiSel.matches.length > 0) {
      const cands = candidatesPerItem[i]
      aiSel.matches.forEach((sel: any, selIdx: number) => {
        let realId = sel.product_id
        if (realId.startsWith('c')) {
          realId = idxToId.get(realId) || sel.product_id
        }
        
        const dbCandidate = cands.find(c => String(c.id) === String(realId))
        if (dbCandidate) {
          const opt: ProductOption = {
            product_id: dbCandidate.id,
            sku: dbCandidate.sku,
            name: dbCandidate.name,
            unit: dbCandidate.unit,
            sale_price: Number(dbCandidate.sale_price),
            stock_on_hand: Number(dbCandidate.stock_on_hand) || 0,
            score: dbCandidate.similarity
          }

          if (selIdx === 0) {
            line.best_match = opt
            line.stock_status = opt.stock_on_hand >= reqQty ? 'ok' : 'low'
          } else if (line.alternatives.length < 1) {
            line.alternatives.push(opt)
          }
        }
      })
    }
    return line
  })

  supabase.from('match_cache').insert({
    hash: payloadHash,
    response_json: results
  }).then(({ error }: { error: any }) => {
    if (error) console.error('Error saving match cache:', error.message)
  })

  const compTokens = gptRes.usage?.completion_tokens ?? 0
  const prmTokens = gptRes.usage?.prompt_tokens ?? 0
  const cost = (embedUsage * 0.00000002) + (prmTokens * 0.00000015) + (compTokens * 0.0000006)

  return {
    matched: results,
    usage: {
      embed_tokens: embedUsage,
      prompt_tokens: prmTokens,
      completion_tokens: compTokens,
      estimated_cost_usd: +(cost.toFixed(6))
    }
  }
}

export const modifyCartCore = async (cart: MatchedLine[], message: string, supabase: any): Promise<{ cart: MatchedLine[] }> => {
  const openai = getOpenAIClient()

  const cartSummaryForPrompt = cart.map((item, idx) => 
    `${idx}: [qty: ${item.requested_qty}] ${item.requested_item} (Match: ${item.best_match?.name || 'Ninguno'})`
  ).join('\n')

  const prompt = `El cliente solicita cambios a su pedido de papelería en base a este mensaje de texto (o transcripción de voz).
Mensaje: "${message}"

Carrito Actual:
${cartSummaryForPrompt}

Devuelve una lista de operaciones exactas a realizar en el carrito para satisfacer el requerimiento.
Opciones:
- REMOVE: Si el cliente quiere quitar un producto. Provee el 'index'.
- UPDATE_QTY: Si quiere cambiar la cantidad de un ítem. Provee 'index' y 'qty'.
- REPLACE_BRAND o REPLACE_ITEM: Si quiere una marca diferente o cambiar el producto. Provee 'index', 'qty' nuevo (o el que tenía) y un 'instruction' claro de búsqueda.
- ADD: Si quiere agregar un producto nuevo. Provee 'qty' y 'instruction' con el nombre del producto.
CRÍTICO: Usa siempre las llaves exactas 'type', 'index', 'qty', e 'instruction'. No inventes nuevas llaves.`

  const gptRes = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Eres el cajero de una papelería. Modificas pedidos. Responde siempre en formato JSON puro.' },
      { role: 'user', content: prompt }
    ],
    response_format: { type: 'json_object' }
  })

  const rawText = gptRes.choices[0]?.message?.content?.trim() || '{"operations":[]}'
  let modifications: any = { operations: [] }
  try {
    const cleaned = rawText.replace(/^\s*```[a-z]*\n?/i, '').replace(/\n?```\s*$/i, '').trim()
    modifications = JSON.parse(cleaned)
  } catch (err) {
    console.error('Error parsing cart modifications:', err)
  }
  
  if (!modifications.operations) modifications.operations = []

  console.log('Cart Modifications for message:', message, modifications)
  
  let updatedCart = [...cart]
  const newItemsToSearch: Array<{ insertIndex: number, qty: number, query: string }> = []

  // Apply explicit operations
  for (const op of modifications.operations) {
    const type = op.type || op.operation
    const index = (op.index !== undefined && op.index !== null) ? Number(op.index) : null
    const qty = (op.qty !== undefined && op.qty !== null) ? Number(op.qty) : (op.quantity !== undefined ? Number(op.quantity) : null)
    const instruction = op.instruction || op.item || op.product || op.query

    if (type === 'REMOVE' && index !== null) {
       if (updatedCart[index]) {
         updatedCart[index] = { ...updatedCart[index], requested_qty: 0 } 
       }
    } 
    else if (type === 'UPDATE_QTY' && index !== null && qty !== null) {
      if (updatedCart[index]) {
        const item = updatedCart[index]
        item.requested_qty = qty
        if (item.best_match) {
           item.stock_status = Number(item.best_match.stock_on_hand) >= qty ? 'ok' : 'low'
        }
      }
    }
    else if ((type === 'REPLACE_BRAND' || type === 'REPLACE_ITEM' || type === 'REPLACE') && index !== null && instruction && qty !== null) {
      newItemsToSearch.push({ insertIndex: index, qty: qty, query: instruction })
    }
    else if ((type === 'ADD' || type === 'INSERT') && instruction && qty !== null) {
      newItemsToSearch.push({ insertIndex: updatedCart.length, qty: qty, query: instruction })
    }
  }

  // RAG for ADD/REPLACE
  if (newItemsToSearch.length > 0) {
    const queries = newItemsToSearch.map(it => it.query)
    const embedRes = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: queries
    })
    
    // b. Retrieve similarity
    const candidatesPerItem = await Promise.all(
      embedRes.data.map(embedding =>
        supabase.rpc('match_products', { query_embedding: embedding.embedding, match_threshold: 0.1, match_count: 5 })
          .then((res: any) => res.data || [])
      )
    )

    const idxToId = new Map<string, string>()

    const itemsText = newItemsToSearch.map((it, i) => {
      const candidates = candidatesPerItem[i] || []
      const cStr = candidates.map((c: any, j: number) => {
        const key = `c${i}_${j}`
        idxToId.set(key, c.id)
        return `  ${key}:"${c.name}" S/${c.sale_price}`
      }).join('\n')
      return `${i}:"${it.query}"\n${cStr}`
    }).join('\n')

    console.log('New items search text:', itemsText)

    const reSelectPrompt = `Selecciona el mejor match para cada item basandote en los candidatos (usa la clave corta cX_Y):\n${itemsText}\nOutput JSON: [{"item_index":0,"matches":[{"product_id":"c0_0"}]}]`
    
    const llmMatches = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [{ role: 'user', content: reSelectPrompt }]
    })

    const rawReMatch = llmMatches.choices[0]?.message?.content?.trim() || '[]'
    console.log('LLM Match Selection response:', rawReMatch)
    
    let finalMatches: any[] = []
    try {
      const cleaned = rawReMatch.replace(/^\s*```[a-z]*\n?/i, '').replace(/\n?```\s*$/i, '').trim()
      finalMatches = JSON.parse(cleaned)
    } catch (e) {
      console.error('Error parsing final matches selection:', e)
    }

    // Integrate matches back into the cart sequence
    for (let i = 0; i < newItemsToSearch.length; i++) {
        const searchCtx = newItemsToSearch[i]
        const cands = candidatesPerItem[i]
        const matchData = finalMatches.find(x => x.item_index === i)
        
        let bestProd: ProductOption | null = null
        if (matchData && matchData.matches && matchData.matches[0]) {
           const rawId = matchData.matches[0].product_id
           const realId = idxToId.get(rawId) || rawId
           const cand = cands.find((c: any) => String(c.id) === String(realId))
           if (cand) {
               bestProd = {
                 product_id: cand.id,
                 sku: cand.sku,
                 name: cand.name,
                 unit: cand.unit,
                 sale_price: Number(cand.sale_price),
                 stock_on_hand: Number(cand.stock_on_hand),
                 score: cand.similarity
               }
           }
        }
        
        const newLine: MatchedLine = {
            requested_item: searchCtx.query,
            requested_qty: searchCtx.qty,
            raw: searchCtx.query,
            best_match: bestProd,
            alternatives: [],
            stock_status: bestProd && bestProd.stock_on_hand >= searchCtx.qty ? 'ok' : 'low'
        }

        if (searchCtx.insertIndex >= cart.length) {
            updatedCart.push(newLine)
        } else {
            updatedCart[searchCtx.insertIndex] = newLine
        }
    }
    console.log('Cart after integration:', updatedCart.length, 'items')
  }

  // Final cleanup of 0-qty lines
  const finalCart = updatedCart.filter(item => item.requested_qty > 0)
  console.log('Final Cart (filtered):', finalCart.length, 'items')
  
  return { cart: finalCart }
}

export const createSalesOrderFromWhatsApp = async (phoneNumber: string, cart: MatchedLine[], supabase: any, preferences?: any): Promise<string> => {
  // 1. Generate Order Code (replicate the SQL logic: PED-YYYYMMDD-HHMMSS-RAND)
  const now = new Date()
  const dateStr = now.toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const rand = Math.random().toString(16).slice(2, 6).toUpperCase()
  const orderCode = `WS-${dateStr}-${rand}`

  let noteText = `WhatsApp: ${phoneNumber}`
  if (preferences) {
    if (preferences.lining) noteText += `\n- Cuadernos Forrados: ${preferences.lining === 'Si' ? 'Sí' : 'No'}`
    if (preferences.liningColor) noteText += ` (Color: ${preferences.liningColor})`
    if (preferences.box) noteText += `\n- Caja Forrada: ${preferences.box === 'Si' ? 'Sí' : 'No'}`
    if (preferences.boxColor) noteText += ` (Color: ${preferences.boxColor})`
  }

  // 2. Insert Header
  const { data: order, error: orderErr } = await supabase
    .from('sales_orders')
    .insert({
      order_code: orderCode,
      status: 'open',
      notes: noteText,
      total: cart.reduce((sum, it) => sum + (it.requested_qty * (it.best_match?.sale_price || 0)), 0),
      payment_method: 'efectivo'
    })
    .select()
    .single()

  if (orderErr) throw new Error(`Error creating sales order: ${orderErr.message}`)
  const orderId = order.id

  // 3. Insert Items
  const itemsToInsert = cart
    .filter(it => it.best_match)
    .map(it => ({
      order_id: orderId,
      product_id: it.best_match?.product_id,
      unit_name: it.best_match?.unit || 'unidad',
      qty_uom: it.requested_qty,
      factor_to_base: 1, // Simplifying, as WhatsApp usually deals with base units or the matched one
      auto_price_unit: it.best_match?.sale_price || 0,
      price_unit_uom: it.best_match?.sale_price || 0,
      pricing_source: 'whatsapp',
      total: it.requested_qty * (it.best_match?.sale_price || 0)
    }))

  if (itemsToInsert.length > 0) {
    const { error: itemsErr } = await supabase
      .from('sales_order_items')
      .insert(itemsToInsert)
    
    if (itemsErr) {
      console.error('Error inserting order items:', itemsErr)
      // We don't throw to avoid breaking the confirm flow if items partially fail? 
      // Actually yes, better throw.
      throw new Error(`Error creating order items: ${itemsErr.message}`)
    }
  }

  // 4. Update session
  await supabase
    .from('whatsapp_sessions')
    .update({ current_order_id: orderId })
    .eq('phone_number', phoneNumber)

  return orderCode
}
