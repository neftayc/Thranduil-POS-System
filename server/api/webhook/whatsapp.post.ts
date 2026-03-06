import { defineEventHandler, readBody, getRequestHeader, createError } from 'h3'
import { getSupabaseAdminClient } from '../../utils/supabase'
import { downloadWhatsAppMedia } from '../../utils/whatsappMedia'
import { transcribeAudio } from '../../utils/transcribeAudio'
import {
  formatQuoteToWhatsAppMessage,
  formatWelcomeWithInstitutions,
  formatGradeList,
  formatSectionList,
  formatBrandQuestion,
  formatNoListFound
} from '../../utils/whatsappFormatter'
import { analyzeImageCore, matchProductsCore, modifyCartCore, createSalesOrderFromWhatsApp } from '../../utils/aiLogic'
import {
  getActiveInstitutions,
  getGradesByInstitution,
  getSectionsByGrade,
  getActiveSchoolList,
  getSchoolListItems,
  buildCartFromSchoolList,
  parseBrandPreferences
} from '../../utils/schoolList'

// Utility to fire and forget a fetch request to our own endpoints so we don't block the webhook response
const triggerInternalAppApi = (path: string, body: any, event: any) => {
  const host = getRequestHeader(event, 'host')
  const protocol = process.env.NODE_ENV === 'development' ? 'http' : 'https'
  const url = `${protocol}://${host}${path}`
  
  const authHeader = getRequestHeader(event, 'authorization') || ''
  let token = ''
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.replace('Bearer ', '')
  }
  
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-webhook-token': token
    },
    body: JSON.stringify(body)
  }).catch(err => console.error(`Internal API Error on ${path}:`, err))
}

const sendWhatsAppMsg = async (to: string, text: string, event: any) => {
  triggerInternalAppApi('/api/webhook/send-message', { to, text }, event)
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

const RESET_COMMANDS = ['reiniciar', 'nueva lista', 'cancelar', 'reset', 'borrar']

/**
 * Parse a 1-based index reply from the user (e.g. "2" → index 1).
 * Returns null if the reply is not a valid number or out of range.
 */
const parseMenuChoice = (text: string, maxOptions: number): number | null => {
  const n = parseInt(text.trim(), 10)
  if (isNaN(n) || n < 0 || n > maxOptions) return null
  return n // 0 = "Enviar mi propia lista", 1..N = valid selection (1-based)
}

// ─────────────────────────────────────────────
// Webhook Handler
// ─────────────────────────────────────────────

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const supabase = getSupabaseAdminClient()

  if (body.object !== 'whatsapp_business_account') {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      if (!change.value?.messages?.[0]) continue

      const message = change.value.messages[0]
      const phoneNumber = message.from
      const messageType = message.type

      console.log(`Received message from ${phoneNumber} of type ${messageType}`)

      // ── 1. Get or create session ──────────────────────────────────────────
      let { data: session } = await supabase
        .from('whatsapp_sessions')
        .select('*')
        .eq('phone_number', phoneNumber)
        .single()

      if (!session) {
        const { data: newSession } = await supabase
          .from('whatsapp_sessions')
          .insert({
            phone_number: phoneNumber,
            state: 'SCHOOL_SELECT_INSTITUTION',  // ← New default starting state
            draft_cart: [],
            school_selection: {}
          })
          .select()
          .single()
        session = newSession
      }

      // ── 2. Global Reset ───────────────────────────────────────────────────
      if (messageType === 'text') {
        const userText = message.text.body.toLowerCase().trim()
        if (RESET_COMMANDS.includes(userText)) {
          // On reset, go back to school selection (not WAITING_LIST)
          const institutions = await getActiveInstitutions(supabase)
          await supabase
            .from('whatsapp_sessions')
            .update({
              state: 'SCHOOL_SELECT_INSTITUTION',
              draft_cart: [],
              current_order_id: null,
              school_selection: { institutionOptions: institutions }
            })
            .eq('phone_number', phoneNumber)

          sendWhatsAppMsg(phoneNumber, '🔄 Sesión reiniciada.\n\n' + formatWelcomeWithInstitutions(institutions), event)
          continue
        }
      }

      // ── 3. Route by state ─────────────────────────────────────────────────
      try {
        // ══════════════════════════════════════════════════════════════════
        // STATE: SCHOOL_SELECT_INSTITUTION
        // First message of any kind from the client – show institution list
        // ══════════════════════════════════════════════════════════════════
        if (session.state === 'SCHOOL_SELECT_INSTITUTION') {
          const institutions = await getActiveInstitutions(supabase)

          if (institutions.length === 0) {
            // No institutions configured yet → fall back to classic flow
            await supabase.from('whatsapp_sessions')
              .update({ state: 'WAITING_LIST' })
              .eq('phone_number', phoneNumber)
            sendWhatsAppMsg(phoneNumber, '¡Hola! Bienvenido a nuestra Papelería 🎒.\nPor favor, envíanos una *foto clara* de tu lista de útiles o *escríbenos* los productos que necesitas.', event)
            continue
          }

          if (messageType === 'text') {
            const choice = parseMenuChoice(message.text.body, institutions.length)

            if (choice === null) {
              // First message or invalid – send welcome + institution list
              await supabase.from('whatsapp_sessions')
                .update({ school_selection: { institutionOptions: institutions } })
                .eq('phone_number', phoneNumber)
              sendWhatsAppMsg(phoneNumber, formatWelcomeWithInstitutions(institutions), event)
              continue
            }

            if (choice === 0) {
              // Client wants to send their own list
              await supabase.from('whatsapp_sessions')
                .update({ state: 'WAITING_LIST', school_selection: {} })
                .eq('phone_number', phoneNumber)
              sendWhatsAppMsg(phoneNumber, '📝 ¡Claro! Por favor, envíanos una *foto clara* de tu lista o *escríbenos* los productos que necesitas.', event)
              continue
            }

            // Valid institution selected
            const selected = institutions[choice - 1]
            const grades = await getGradesByInstitution(supabase, selected.id)

            if (grades.length === 0) {
              sendWhatsAppMsg(phoneNumber, `⚠️ ${selected.name} aún no tiene grados registrados. Intenta con otra institución o escribe *0* para enviar tu lista.`, event)
              continue
            }

            await supabase.from('whatsapp_sessions')
              .update({
                state: 'SCHOOL_SELECT_GRADE',
                school_selection: {
                  institutionId: selected.id,
                  institutionName: selected.name,
                  gradeOptions: grades
                }
              })
              .eq('phone_number', phoneNumber)

            sendWhatsAppMsg(phoneNumber, formatGradeList(grades), event)

          } else {
            // Non-text message at start → show institution list
            const institutions2 = await getActiveInstitutions(supabase)
            await supabase.from('whatsapp_sessions')
              .update({ school_selection: { institutionOptions: institutions2 } })
              .eq('phone_number', phoneNumber)
            sendWhatsAppMsg(phoneNumber, formatWelcomeWithInstitutions(institutions2), event)
          }

        // ══════════════════════════════════════════════════════════════════
        // STATE: SCHOOL_SELECT_GRADE
        // ══════════════════════════════════════════════════════════════════
        } else if (session.state === 'SCHOOL_SELECT_GRADE') {
          if (messageType !== 'text') {
            sendWhatsAppMsg(phoneNumber, 'Por favor responde con el *número* del grado.', event)
            continue
          }
          const sel = session.school_selection || {}
          const grades = sel.gradeOptions || []
          const choice = parseMenuChoice(message.text.body, grades.length)

          if (choice === null || choice === 0) {
            sendWhatsAppMsg(phoneNumber, `Por favor responde con un número del 1 al ${grades.length}.`, event)
            continue
          }

          const selectedGrade = grades[choice - 1]
          const sections = await getSectionsByGrade(supabase, selectedGrade.id)

          if (sections.length === 0) {
            sendWhatsAppMsg(phoneNumber, `⚠️ ${selectedGrade.name} aún no tiene secciones registradas.`, event)
            continue
          }

          await supabase.from('whatsapp_sessions')
            .update({
              state: 'SCHOOL_SELECT_SECTION',
              school_selection: {
                ...sel,
                gradeId: selectedGrade.id,
                gradeName: selectedGrade.name,
                gradeOptions: undefined,
                sectionOptions: sections
              }
            })
            .eq('phone_number', phoneNumber)

          sendWhatsAppMsg(phoneNumber, formatSectionList(sections), event)

        // ══════════════════════════════════════════════════════════════════
        // STATE: SCHOOL_SELECT_SECTION
        // ══════════════════════════════════════════════════════════════════
        } else if (session.state === 'SCHOOL_SELECT_SECTION') {
          if (messageType !== 'text') {
            sendWhatsAppMsg(phoneNumber, 'Por favor responde con el *número* de la sección.', event)
            continue
          }
          const sel = session.school_selection || {}
          const sections = sel.sectionOptions || []
          const choice = parseMenuChoice(message.text.body, sections.length)

          if (choice === null || choice === 0) {
            sendWhatsAppMsg(phoneNumber, `Por favor responde con un número del 1 al ${sections.length}.`, event)
            continue
          }

          const selectedSection = sections[choice - 1]

          // Check if there's an active list for this combination
          const list = await getActiveSchoolList(
            supabase,
            sel.institutionId,
            sel.gradeId,
            selectedSection.id
          )

          if (!list) {
            sendWhatsAppMsg(
              phoneNumber,
              formatNoListFound(sel.institutionName, sel.gradeName, selectedSection.name),
              event
            )
            continue
          }

          await supabase.from('whatsapp_sessions')
            .update({
              state: 'SCHOOL_SELECT_BRAND',
              school_selection: {
                ...sel,
                sectionId: selectedSection.id,
                sectionName: selectedSection.name,
                sectionOptions: undefined,
                listId: list.id
              }
            })
            .eq('phone_number', phoneNumber)

          sendWhatsAppMsg(phoneNumber, formatBrandQuestion(), event)

        // ══════════════════════════════════════════════════════════════════
        // STATE: SCHOOL_SELECT_BRAND
        // Client writes their preferred brands → build cart from DB → REVIEWING_QUOTE
        // ══════════════════════════════════════════════════════════════════
        } else if (session.state === 'SCHOOL_SELECT_BRAND') {
          if (messageType !== 'text') {
            sendWhatsAppMsg(phoneNumber, 'Por favor escribe el nombre de tu(s) marca(s) preferida(s).', event)
            continue
          }

          const brandText = message.text.body.trim()
          const brandPreferences = parseBrandPreferences(brandText)
          const sel = session.school_selection || {}

          sendWhatsAppMsg(phoneNumber, '⏳ Un momento, preparando tu lista...', event)

          setTimeout(async () => {
            try {
              const items = await getSchoolListItems(supabase, sel.listId)

              if (items.length === 0) {
                sendWhatsAppMsg(phoneNumber, '⚠️ La lista de esta sección aún no tiene productos registrados. Por favor contáctanos.', event)
                return
              }

              // Build cart purely from DB, no AI
              const cart = buildCartFromSchoolList(items, brandPreferences)

              await supabase.from('whatsapp_sessions')
                .update({
                  state: 'REVIEWING_QUOTE',
                  draft_cart: cart,
                  school_selection: {
                    ...sel,
                    brandPreferences
                  }
                })
                .eq('phone_number', phoneNumber)

              const brandNote = brandPreferences.length > 0
                ? `\n_Marcas preferidas: ${brandPreferences.join(', ')}_\n`
                : '\n_Sin preferencia de marca_\n'

              const quoteText = formatQuoteToWhatsAppMessage(cart)
              sendWhatsAppMsg(phoneNumber, brandNote + '\n' + quoteText, event)

            } catch (err) {
              console.error('Error building school list cart:', err)
              sendWhatsAppMsg(phoneNumber, 'Hubo un error al preparar tu lista. Por favor intenta de nuevo.', event)
            }
          }, 0)

        // ══════════════════════════════════════════════════════════════════
        // STATE: WAITING_LIST  (classic image/text flow — untouched)
        // ══════════════════════════════════════════════════════════════════
        } else if (session.state === 'WAITING_LIST') {
          if (messageType === 'image') {
            const mediaId = message.image.id

            sendWhatsAppMsg(phoneNumber, '📸 ¡Imagen recibida! Analizando tu lista... Dame unos segundos ⏳', event)

            setTimeout(async () => {
              try {
                const buffer = await downloadWhatsAppMedia(mediaId)
                try {
                  const analyzeData: any = await analyzeImageCore(buffer, 'image/jpeg', supabase)
                  const itemsToMatch = analyzeData.items || analyzeData.lista
                  const matchData: any = await matchProductsCore(itemsToMatch, supabase)

                  await supabase.from('whatsapp_sessions')
                    .update({ state: 'REVIEWING_QUOTE', draft_cart: matchData.matched })
                    .eq('phone_number', phoneNumber)

                  const replyText = formatQuoteToWhatsAppMessage(matchData.matched)
                  sendWhatsAppMsg(phoneNumber, replyText, event)

                } catch (err: any) {
                  console.error('Analyze Image or Match Process failed:', err.data || err)
                  throw new Error('Error processing AI logic')
                }
              } catch (err: any) {
                console.error('Background processing error:', err)
                sendWhatsAppMsg(phoneNumber, 'Hubo un error al procesar tu lista. Por favor intenta escribiendo los productos.', event)
              }
            }, 0)

          } else if (messageType === 'text') {
            const userText = message.text.body.toLowerCase()
            if (userText === 'hola' || userText === 'cotizar') {
              sendWhatsAppMsg(phoneNumber, '¡Hola! Bienvenido a nuestra Papelería 🎒.\nPor favor, envíanos una *foto clara* de tu lista de útiles o *escríbenos* los productos que necesitas.', event)
            } else {
              sendWhatsAppMsg(phoneNumber, '📝 Hemos recibido tu texto. Analizando los productos...', event)
            }
          }

        // ══════════════════════════════════════════════════════════════════
        // STATE: REVIEWING_QUOTE  (cart modification via AI — unchanged)
        // ══════════════════════════════════════════════════════════════════
        } else if (session.state === 'REVIEWING_QUOTE') {
          if (messageType === 'text' || messageType === 'audio') {
            sendWhatsAppMsg(phoneNumber, '🤖 Entendido, aplicando tus cambios al carrito...', event)

            setTimeout(async () => {
              try {
                let userInstruction = ''

                if (messageType === 'audio') {
                  const buffer = await downloadWhatsAppMedia(message.audio.id)
                  userInstruction = await transcribeAudio(buffer)
                  console.log('Transcribed Audio:', userInstruction)
                } else {
                  userInstruction = message.text.body
                }

                // Check for confirmation → transition to Preferences
                if (['si', 'ok', 'confirmar', 'listo', 'comprar'].includes(userInstruction.toLowerCase().trim())) {
                  await supabase.from('whatsapp_sessions')
                    .update({ state: 'PREF_LINING', preferences: {} })
                    .eq('phone_number', phoneNumber)

                  sendWhatsAppMsg(phoneNumber, '✅ ¡Genial! Antes de terminar, unas preguntas rápidas:\n\n1. ¿Requiere los *cuadernos forrados*? (Si/No)', event)
                  return
                }

                const modifyData: any = await modifyCartCore(session.draft_cart, userInstruction, supabase)

                await supabase.from('whatsapp_sessions')
                  .update({ draft_cart: modifyData.cart })
                  .eq('phone_number', phoneNumber)

                const replyText = formatQuoteToWhatsAppMessage(modifyData.cart)
                sendWhatsAppMsg(phoneNumber, replyText, event)

              } catch (err) {
                console.error('Modify cart error', err)
                sendWhatsAppMsg(phoneNumber, 'Ups, no pude aplicar el cambio. ¿Puedes intentarlo de nuevo?', event)
              }
            }, 0)
          }

        // ══════════════════════════════════════════════════════════════════
        // Preferences flow (PREF_LINING → PREF_LINING_COLOR → PREF_BOX → PREF_BOX_COLOR → CHECKOUT)
        // Identical to original — zero changes
        // ══════════════════════════════════════════════════════════════════
        } else if (session.state === 'PREF_LINING') {
          if (messageType === 'text') {
            const text = message.text.body.toLowerCase().trim()
            const isSi = text.includes('si')
            const isNo = text.includes('no')

            if (isSi || isNo) {
              const prefs = { ...(session.preferences || {}), lining: isSi ? 'Si' : 'No' }
              if (isSi) {
                await supabase.from('whatsapp_sessions').update({ state: 'PREF_LINING_COLOR', preferences: prefs }).eq('phone_number', phoneNumber)
                sendWhatsAppMsg(phoneNumber, '🎨 ¿De qué *color* desea el forro de los cuadernos?', event)
              } else {
                await supabase.from('whatsapp_sessions').update({ state: 'PREF_BOX', preferences: prefs }).eq('phone_number', phoneNumber)
                sendWhatsAppMsg(phoneNumber, '📦 ¿Requiere una *caja forrada*? (Si/No)', event)
              }
            } else {
              sendWhatsAppMsg(phoneNumber, 'Por favor, responde con *Si* o *No*. ¿Requiere los cuadernos forrados?', event)
            }
          }

        } else if (session.state === 'PREF_LINING_COLOR') {
          if (messageType === 'text') {
            const color = message.text.body.trim()
            const prefs = { ...(session.preferences || {}), liningColor: color }
            await supabase.from('whatsapp_sessions').update({ state: 'PREF_BOX', preferences: prefs }).eq('phone_number', phoneNumber)
            sendWhatsAppMsg(phoneNumber, '📦 Entendido. ¿Requiere una *caja forrada*? (Si/No)', event)
          }

        } else if (session.state === 'PREF_BOX') {
          if (messageType === 'text') {
            const text = message.text.body.toLowerCase().trim()
            const isSi = text.includes('si')
            const isNo = text.includes('no')

            if (isSi || isNo) {
              const prefs = { ...(session.preferences || {}), box: isSi ? 'Si' : 'No' }
              if (isSi) {
                await supabase.from('whatsapp_sessions').update({ state: 'PREF_BOX_COLOR', preferences: prefs }).eq('phone_number', phoneNumber)
                sendWhatsAppMsg(phoneNumber, '🎨 ¿De qué *color* desea la caja forrada?', event)
              } else {
                const sel = session.school_selection || {}
                const orderCode = await createSalesOrderFromWhatsApp(phoneNumber, session.draft_cart, supabase, { ...prefs, ...sel })
                await supabase.from('whatsapp_sessions').update({ state: 'CHECKOUT', preferences: prefs }).eq('phone_number', phoneNumber)
                sendWhatsAppMsg(phoneNumber, `¡Pedido Confirmado! 🎉\nEstamos preparando tu pedido. 📦\nCódigo: *${orderCode}*\n\nNotas adicionales:\n- Cuadernos forrados: ${prefs.lining}\n- Caja forrada: No\n\nPuedes pagar por *Yape* o en tienda. 🏪\nTe avisaremos por aquí cuando esté listo.`, event)
              }
            } else {
              sendWhatsAppMsg(phoneNumber, 'Por favor, responde con *Si* o *No*. ¿Requiere una caja forrada?', event)
            }
          }

        } else if (session.state === 'PREF_BOX_COLOR') {
          if (messageType === 'text') {
            const color = message.text.body.trim()
            const prefs = { ...(session.preferences || {}), boxColor: color }
            const sel = session.school_selection || {}

            const orderCode = await createSalesOrderFromWhatsApp(phoneNumber, session.draft_cart, supabase, { ...prefs, ...sel })
            await supabase.from('whatsapp_sessions').update({ state: 'CHECKOUT', preferences: prefs }).eq('phone_number', phoneNumber)
            sendWhatsAppMsg(phoneNumber, `¡Pedido Confirmado! 🎉\nEstamos preparando tu pedido. 📦\nCódigo: *${orderCode}*\n\nNotas adicionales:\n- Cuadernos forrados: ${prefs.lining}${prefs.liningColor ? ` (${prefs.liningColor})` : ''}\n- Caja forrada: Si (${color})\n\nPuedes pagar por *Yape* o en tienda. 🏪\nTe avisaremos por aquí cuando esté listo.`, event)
          }
        }

      } catch (error) {
        console.error('Error processing WhatsApp message:', error)
      }
    }
  }

  return { status: 'success' }
})
