# API de ventas para Yachay Connector

La aplicación Nuxt expone HTTP al conector Python. El servidor MCP vive en
`integrations/yachay-connector`; Nuxt no requiere otro servidor MCP.

## Proceso del vendedor

1. **Alta en el POS.** El propietario crea al vendedor en *Usuarios* con rol
   `cashier` (o `manager`/`owner`). Ese es el único usuario que usará.
2. **Carpeta de vendedores en Claude.** Hoy, en modo local: copia
   `integrations/yachay-connector/workspace-vendedor/` fuera del repositorio
   (por ejemplo `~/Ventas`) y ábrela en Claude Code (app de escritorio). Trae el MCP
   `yachay-pos` (`http://127.0.0.1:8000/mcp`), un `CLAUDE.md` que **abre el sistema
   en cada conversación** y permisos que bloquean terminal, edición y web. Los
   vendedores nunca abren la carpeta del repositorio (código y `.env`). Claude
   web/celular requiere la fase 2 (HTTPS público).
3. **Primer mensaje** («hola», «vamos a vender»). Claude ofrece los sistemas
   (`list_systems`) sin que se lo pidan y, al elegir, llama `select_system("pos")`.
   El POS responde con un enlace propio (`/vincular`) y un código corto, por
   ejemplo `7RX-PXP9`, válido 10 minutos.
4. **Iniciar sesión en el POS.** El vendedor abre el enlace, escribe el código, su
   correo y su contraseña **en la página del POS** (nunca en el chat) y aprueba.
5. **Emparejar con el número.** Al aprobar, la página muestra un número de 3
   dígitos. El vendedor se lo dice a Claude («472»); Claude llama
   `check_identification` con ese número y recibe «Sesión activa como Ana Pérez
   (cashier)». El número solo aparece en la página del vendedor: si un tercero pidió
   el código desde su propio Claude y engañó al vendedor para aprobarlo, no puede
   terminar la vinculación (3 intentos y 5 minutos; si no, se anula y la sesión se
   revoca). La sesión dura hasta las 23:59 (hora de
   Lima) y el propietario puede revocarla en *Usuarios → Sesiones de Claude*.
6. **Dictar el pedido**: «2 cuadernos A4 de 100 hojas cuadriculados Marca A, pago
   efectivo».
7. **Resultado**:
   - Pedido inequívoco → el POS **registra la venta a nombre del vendedor** y
     responde `completed` con `result.reference`. No hay paso de confirmación.
   - No decidible (varias coincidencias, falta cantidad o forma de pago, stock
     insuficiente) → `pending_review`: **venta por confirmar** con su referencia.
     NO está registrada; reserva el stock identificado y se valida después en el
     POS. Desde el chat se puede completar con el dato faltante o anular con
     «cancelar».
   - Si queda stock bajo o agotado, la respuesta trae `result.alerts` y Claude
     lo comunica al momento.

Solo `completed` con referencia acredita una venta registrada.

> Etapa 2 (pendiente): pantalla del POS para validar en lote las ventas por
> confirmar al mediodía y al cierre, y lista de alertas. Etapa 3: avisos por
> WhatsApp o correo.

## Configuración local

El POS se inicia como siempre, en `http://127.0.0.1:3000`. Configura en `.env`:

```dotenv
POS_AGENT_TOKEN=<secreto independiente de al menos 32 caracteres>
POS_AGENT_SESSION_KEY=<otro secreto de al menos 32 caracteres>
POS_AGENT_MODEL=gpt-4o-mini
POS_AGENT_STORAGE_DIR=.data/agent
# Opcionales
POS_AGENT_PUBLIC_URL=            # origen público de /vincular (fase 2); requiere verification_origin en systems.json
POS_AGENT_REVIEW_TTL_HOURS=48    # vigencia de la reserva de una venta por confirmar
POS_AGENT_DRY_RUN=               # 1 = solo validación: nunca registra ventas (apagado por defecto)
POS_AGENT_SEARCH_AUTOINDEX=      # 1 = calcular vectores al buscar (ESCRIBE en la base; apagado; nunca con dry-run)
```

Genera cada secreto con `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.
En `nuxt build` + `node .output/server/index.mjs` las variables se leen en
ejecución con prefijo `NUXT_` (`NUXT_POS_AGENT_TOKEN`, `NUXT_POS_AGENT_SESSION_KEY`, …);
`nuxt dev` las toma del `.env`.

- `POS_AGENT_TOKEN`: credencial **conector → POS** (servicio). Debe coincidir en
  ambos procesos. No identifica a ningún vendedor.
- `POS_AGENT_SESSION_KEY`: cifra (AES-256-GCM) las sesiones Supabase que abre cada
  vendedor en `/vincular`. Cambiarla invalida todas las sesiones vigentes.
- `POS_AGENT_SELLER_ACCESS_TOKEN` **ya no existe**: cada venta se registra con la
  sesión del vendedor que aprobó el código.

También se usan `OPENAI_API_KEY` y las credenciales Supabase existentes. Nunca
enviar secretos al modelo ni al contexto.

> Seguridad: `/login` permite crear cuentas y toda cuenta nueva recibe el rol
> `cashier`. Si el registro público está abierto en Supabase, cualquiera podría
> vincularse como cajero. Cierra el registro (Supabase → Authentication →
> Sign In / Providers) o crea los vendedores solo desde *Usuarios*.

## Identidad del vendedor

- El conector nunca ve contraseñas ni decide quién es el vendedor. Solo guarda,
  dentro de su `selection_token` cifrado, la referencia opaca que emite el POS y la
  envía en `X-Yachay-Session` junto con `Authorization: Bearer <POS_AGENT_TOKEN>`.
- En `/vincular` el POS abre una sesión **propia del vendedor** con
  `signInWithPassword`. Se guardan solo hashes y tokens cifrados en
  `.data/agent/sessions` (archivos 0600). No se usa la clave de servicio para
  actuar como el vendedor; solo para cerrar su sesión al revocarla.
- En **cada** contexto con sesión e instrucción, el POS comprueba que la sesión no
  esté vencida ni revocada, renueva el token si hace falta, y verifica con Supabase
  Auth que el usuario no esté desactivado (`banned_until`) y que su rol (`user_role`)
  sea `owner`, `manager` o `cashier`. Se repite justo antes de registrar. El nombre y
  el **rol que usa el POS salen de ese perfil vigente**, no del momento de aprobar: si
  bajan a un gerente a cajero, desde la siguiente petición opera como cajero.
- La RPC `create_sale` se llama con el token del vendedor: `sales.created_by` es
  ese vendedor.
- Una operación pertenece al vendedor que la creó: otro vendedor recibe 403
  («Esta operación pertenece a otro vendedor.»).
- Límites (solo cuentan los fallos; un acierto nunca bloquea a nadie): 5 fallos por
  código, contados de forma atómica (luego se anula); 5 por correo **desde la misma IP**
  y 30 por IP cada 10 minutos (quien conozca el correo de un vendedor no puede
  bloquearlo desde otra red; el mensaje no revela si el correo existe). Peticiones sin código válido no cuentan. Aprobar un código y entregar la
  sesión son transiciones atómicas: un código crea una sola sesión y se entrega una vez.
- Antiphishing: `/vincular` no acepta el código en la URL (el vendedor lo escribe),
  avisa «Solo aprueba un código que tú mismo pediste en Claude en este momento»,
  muestra la hora en que se pidió el código, y Claude
  muestra el nombre y el rol del vendedor aprobado y pide confirmar que es él o ella.
- Revocar es inmediato en el POS y no lo deshace una renovación de token en curso
  (renovación y revocación comparten un bloqueo y se relee el registro). Luego se
  cierra la sesión en Supabase con un token vigente; si falla, se registra en el log
  (sin secretos) y la respuesta lo indica con `supabase_signed_out: false`.

Errores (español, sin secretos): 401 credencial del conector; 403 vendedor sin
identificar, sesión vencida/revocada, usuario desactivado o sin rol; 503 servicio
sin configurar.

## POST /api/agent/identification (`yachay-identification/1`)

Solo para el conector (`Authorization: Bearer <POS_AGENT_TOKEN>`).

```json
{ "protocol": "yachay-identification/1", "action": "start" }
```
→ `{ "status": "requires_identification", "identification_id": "<opaco>", "user_code": "7RX-PXP9", "verification_url": "http://127.0.0.1:3000/vincular", "expires_in": 600 }`

```json
{ "protocol": "yachay-identification/1", "action": "status", "identification_id": "<opaco>" }
```
→ `pending` | `requires_match` | `denied` | `expired`. Tras aprobar en `/vincular`, se
repite `status` con `"match_code": "472"` (el número que la página mostró al vendedor):
`match_mismatch` (`attempts_left`) o `{ "status": "approved", "session": "<opaco>", "seller": { "name": "Ana Pérez", "role": "cashier" }, "expires_at": 1762920000 }`, entregado una sola vez.

El conector exige que `verification_url` tenga el mismo origen que su
`identification_url` configurada. Si defines `POS_AGENT_PUBLIC_URL` (enlace público,
fase remota), agrega en `systems.json` del conector `"verification_origin":
"https://<tu-dominio>"` con ese mismo origen; si no, el conector rechaza el enlace.

## POST /api/agent/identification/approve

Usado por la página pública `/vincular`: `{ "user_code", "email", "password" }`
(JSON). Devuelve el nombre, el rol y el vencimiento; 400 con mensaje en español si
el código venció, la contraseña es incorrecta o el usuario no tiene rol válido.

## POST /api/agent/identification/lookup

Pública, para `/vincular`: `{ "user_code" }` → `{ "requested_at", "expires_at" }` de
un código pendiente (400 si no existe o venció; cuenta como fallo por IP).

## GET /api/agent/sessions y POST /api/agent/sessions/revoke

Con la sesión normal del POS, rol `owner` o `manager`. Lista las sesiones de
Claude y revoca una (`{ "id": "<uuid>" }`); la revocación es inmediata.

## GET /api/agent/context

Devuelve `system_id: "pos"`, `version: "2.0"` y `context` (descripción,
instrucciones, capacidades, `identification: "required"`, `seller` si llega una
sesión válida, `execution_configured`, `review_ttl_hours`). Sin catálogo ni datos
de autenticación.

## POST /api/agent/instructions

Requiere `X-Yachay-Session` válida, `Content-Type: application/json`, cuerpo
máximo 16.000 bytes, texto máximo 2.500 caracteres, protocolo `yachay-agent/1`.

```json
{
  "protocol": "yachay-agent/1",
  "type": "instruction",
  "request_id": "8cb47727-c3a8-4a68-8610-b383398bd53f",
  "input": { "text": "vende 2 cuadernos A4 de 100 hojas cuadriculados, pago efectivo", "locale": "es-PE" }
}
```

Para completar o anular una venta por confirmar se usa su `operation_id` y un
`request_id` nuevo:

```json
{
  "protocol": "yachay-agent/1",
  "type": "follow_up",
  "request_id": "50621fd7-c523-45cf-ae16-af2f34df7459",
  "operation_id": "8cb47727-c3a8-4a68-8610-b383398bd53f",
  "input": { "text": "el de Marca A", "locale": "es-PE" }
}
```

| Estado | Significado |
| --- | --- |
| `completed` | Venta registrada a nombre del vendedor; `result.reference`, `total`, `items`, `alerts`. |
| `pending_review` | Venta por confirmar, NO registrada. `result.reference`, `reasons` (códigos), `pending` (texto), `items`, `reservations`, `review_expires_at`, `alerts`. |
| `rejected` | Cancelación, petición no soportada, venta por confirmar vencida o vendedor no autorizado al registrar. Leer `message`. |
| `pending` | Trabajo concurrente o resultado indeterminado; reintentar el mismo `request_id`, no afirmar éxito. |

Reglas generales: hasta 20 líneas; la cantidad no se inventa (`100 hojas` no es
cantidad); sin presentación se usa la unidad base; sin cliente es venta al público.

## Agente 1 y proceso 2

Cada mensaje pasa por dos procesos separados:

1. **Agente 1 (IA)**: interpreta el pedido, busca productos y entrega un borrador
   `sale-draft/1` con IDs. Solo propone.
2. **Proceso 2 (código determinista, sin IA)**: vuelve a verificar todo contra el
   POS y decide si registra directo o deja la venta por confirmar
   (`server/modules/agent/app/validateDraft.ts` y `salesAgent.ts`).

### Contrato `sale-draft/1`

```jsonc
{
  "version": "sale-draft/1",
  "intent": "sale",                 // sale | cancel | unsupported
  "items": [{                       // 0..20 líneas
    "product_id": "uuid | null",    // null si no hubo un candidato único
    "candidates": ["uuid"],         // alternativas (máx. 8)
    "quantity": 2,                  // null si el pedido no dice cuántas
    "unit": "docena | null",        // null = unidad base
    "price_unit": 5.0,              // precio que vio el agente 1 (solo para comparar)
    "price_said": null,             // precio unitario que DICTÓ el vendedor («a 4 soles»), o null
    "confidence": "high",           // high | medium | low
    "doubts": [{ "code": "ambiguous_product", "note": "…" }],
    "query": "2 cuadernos A4"
  }],
  "payment_method": "efectivo | null", // propuesta del agente 1; el proceso 2 decide con el texto (null = efectivo)
  "customer_id": "uuid | null",
  "doubts": [],                     // dudas generales
  "source_text": "pedido original"
}
```

Códigos de duda: `ambiguous_product`, `product_not_found`, `missing_quantity`,
`unit_unclear`, `missing_payment`, `customer_ambiguous`, `other`. Un borrador
con campos desconocidos o fuera de rango no se acepta (`invalid_draft`).

También se acepta el `SaleProposal` de la búsqueda híbrida (directo o como
`{ proposal }`, `app/proposalAdapter.ts`): `qty` → `quantity`, `unit_name` →
`unit`, `alternatives` → `candidates`; las `doubts` pasan a ser dudas generales
(se recortan a 1000 caracteres), los `reasons` de cada línea solo explican la
coincidencia y no son dudas, y una seguridad general distinta de `high` sin otras
dudas agrega una. Su `draft`, `total`,
`factor` y `stock_available` se ignoran: el proceso 2 los recalcula.

El agente 1 es `makeHybridDraftBuilder` (`app/draftBuilder.ts`): intérprete OpenAI
(`infra/openaiOrderInterpreter.ts`) + búsqueda híbrida (vectores + texto) con decisión
por atributos exactos, y emite directamente sale-draft/1 con dudas codificadas
(`ambiguous_product`, `product_not_found`, `missing_quantity`, `unit_unclear`,
`missing_payment`, `customer_ambiguous`, `other`). Detalle y medición en
[agent-product-search.md](agent-product-search.md).

### Preguntas de catálogo

Si `buildDraft` devuelve `{ kind: 'catalog_answer', message, result }` («¿tenemos
cuadernos Marking?», «¿cuánto cuesta?», «¿cuántos quedan?»), el proceso 2 responde
`completed` con `result.kind = "catalog_answer"` y `result.reference = null`: es solo
información, **no** una venta, y no reserva nada. Una operación nueva queda en estado
`answered`. Si la pregunta llega como `follow_up` de una venta por confirmar, se
responde sin modificar esa venta (mensajes, motivos, reservas y vencimiento). En
dry-run lleva la marca de simulación. Se activa con `answerCatalogQuestions: true`
en `server/utils/agent.ts`.

### Paso 3: registrador simplificado (`POS_AGENT_SELECTOR=llm`)

Plan en 3 pasos (dueño, 2026-11-15): con `POS_AGENT_SELECTOR=llm` el **agente selector** (paso 2,
`salesSelector.ts`, Agente 1) entrega el **consolidado** y el **registrador** (`app/registrar.ts`)
valida solo lo necesario para registrar. Con `legacy` (por defecto) todo sigue como antes. El
interruptor se evalúa en tiempo de ejecución (`POS_AGENT_SELECTOR`, `NUXT_POS_AGENT_SELECTOR` o
`runtimeConfig`) y se registra en el log al arrancar. Mientras el selector no esté conectado en
`server/utils/agent.ts`, `llm` usa el camino actual y lo avisa en el log.

```jsonc
{ "contract": "sale-consolidated/1",
  "lines": [{ "phrase": "dos cuadernos markin", "product_id": "uuid | null", "quantity": 2,
              "unit": "docena | null", "price_said": null, "confidence": "alta | baja",
              "reason": "…", "question": null, "options": ["uuid"] }],
  "payment_method": "efectivo", "payment_phrase": null, "questions": [] }
```

Valida **solo**: (1) `product_id` existe y está activo, y la presentación es válida para él (se
puede cotizar); (2) la cantidad del selector, **tal cual**: presente, > 0 y entera en presentaciones
por unidad (la docena admite 0,5); si falta o es imposible → `missing_quantity`. La regla «la cantidad
va primero» la aplica el paso 2; (3) precio **oficial** (`resolve_sale_item_pricing`): `price_said` distinto →
`price_modified` (por confirmar, opción A); oficial 0 → `price_unavailable`; (4) stock disponible
(menos reservas) y forma de pago activa: efectivo por defecto; otra solo si su `payment_phrase` está
en el dictado (si no, `missing_payment`); (5) la `phrase` **no** tiene que ser literal del dictado
(el dictado por voz deja puntuación y autocorrecciones; el selector solo usa ids reales del catálogo,
que se verifican en (1)); (6) `confidence: "baja"`, `product_id` nulo o `question` →
`selector_question`, con la pregunta y sus `options` (id y nombre) para el vendedor
(`result.reasons[].question/options`); las `questions` generales también. Id inexistente →
`product_inactive`. Todo bien → `create_sale` (dry-run respetado); si no → por confirmar con reserva
(el producto dudoso no se reserva). **No** reinterpreta el texto (atribución de cantidades, docenas,
pagos negados…): eso queda para `legacy`. Se conservan idempotencia, dry-run, reservas, revisión de
precios, bloqueo en 3 fases e «indeterminado nunca se reintenta». En un seguimiento, el selector
recibe el consolidado previo como `previous`.

### Regla de decisión (fija y auditable)

Se registra **directo** a nombre del vendedor identificado solo si:

- hay al menos una línea y **cada** línea tiene `product_id` de un producto que
  existe y está activo, seguridad `high`, ninguna duda y una cantidad válida;
- **por línea**: en pedidos de varias líneas, cada cantidad se atribuye a la línea cuyas palabras
  la siguen («2 lapiceros y 3 cuadernos») y cada monto a la línea que lo precede («un lapicero a 1 sol
  y un cuaderno a 5 soles»); cada número se usa una sola vez y uno que no se puede atribuir deja la
  línea sin cantidad en revisión. «pagó con 50», «paga con», «vuelto de», «billete de» son montos;
- **presentación**: una distinta de la unidad base (caja, docena, paquete, ciento, millar…) solo vale
  si el vendedor la dijo; si no, `unit_unclear` (con `ungrounded`). «una docena» es 1 si se vende por
  docena y 12 si se vende por unidad («media docena»: 0.5 o 6), nunca 12 docenas; en presentaciones
  por unidad no se aceptan cantidades no enteras (`missing_quantity`);
- **cantidad**: la que escribió el vendedor; **si no dijo cantidad, es 1** (aviso «no se
  indicó cantidad, se toma 1»; `items[].quantity_defaulted`). También es 1 si el modelo
  tomó un número de la descripción («cuaderno 100 hojas a4» → 1). Las cantidades en palabras
  cuentan («dos», «tres», «quince», «veinticinco», «treinta y cinco», «cien», «una docena»,
  «media docena» = 6 unidades, o 0.5 si la presentación es docena). Si la IA deja la cantidad
  al inicio de la descripción («dos cuadernos markin…») se separa de ella; en un pedido de
  **una línea**, si la IA no puso cantidad y el vendedor escribió exactamente una, se toma esa
  («dos cuadernos» → 2). Va a revisión
  (`missing_quantity`) si el modelo propone una cantidad que el vendedor no escribió, o si
  el vendedor escribió una cantidad (distinta de 1) que ninguna línea recoge (por ejemplo,
  el modelo la perdió): nunca se vende 1 en silencio en ese caso;
- **precio**: el oficial de `resolve_sale_item_pricing` (con el cliente, si lo hay), que
  debe coincidir con `price_unit` del borrador (tolerancia S/ 0.005); si no, `price_changed`. Un precio
  oficial de S/ 0 es `price_unavailable` (lo decide el proceso 2, sin depender de la duda del agente 1).
  Si el borrador no trae precio, se usa el oficial;
- **precio dictado** (`price_said`): solo cuenta si el vendedor lo **escribió** como monto
  («a 4 soles», «s/ 4.50», «4 soles», «$4» —el dictado escribe «un sol» como «$1»—, o el total:
  «2 por 9 soles» → 4.50 c/u). Si no aparece: `price_unverified`. Igual al de lista: no cambia
  nada. **Distinto al de lista** (decisión del dueño, 2026-11-15, opción A): para **todos los
  roles**, owner incluido, la venta **no se registra**: queda **por confirmar** (`price_modified`,
  «Precio dictado S/ Y distinto al de lista S/ X: queda por confirmar; el revisor la aprueba»),
  con su stock reservado como cualquier venta por confirmar. Un revisor (owner/manager, que ya
  tiene precio manual en `create_sale`) la aprueba luego a ese precio: **no hace falta migración**.
  La operación guarda por línea el precio dictado (`items[].price_unit`), el de lista
  (`items[].list_price`) y el motivo (`manual_reason`, «Precio dictado por vendedor (lista S/ X)»),
  y en `operation.price_review` (`status: "pending"`, vendedor, líneas con lista, dictado y si
  queda bajo costo). `result.price_review: "pending"`. `listPendingPriceReviews(store)`
  (`app/priceReview.ts`) lista las vigentes para la futura pantalla de revisión (etapa 2).
  `price_override_not_allowed` ya no se usa.
  Si el precio dictado queda **bajo el costo** (`avg_cost` de `product_catalog` × factor de la
  presentación), además hay una alerta (`result.price_alerts`, `level: "below_cost"`). El costo
  solo se muestra a owner/manager («Alerta de precio: … bajo su costo S/ Z»); a otro rol, sin
  `unit_cost`: «Alerta: precio bajo para …». Sin costo conocido no hay alerta;
- el stock alcanza: `disponible = stock_on_hand − reservas de otras ventas por
  confirmar vigentes`, sumando las líneas repetidas en unidad base;
- la cantidad **la escribió el vendedor**: el proceso 2 la contrasta con los mensajes reales de la
  conversación (nunca con un texto del agente), como número o palabra («dos», «una docena»,
  «media docena»), sin contar los números que describen el producto («100 hojas», «30 cm», «a4»)
  ni los montos («a 3 soles»). Si no, `missing_quantity` con `detail.ungrounded`;
- **forma de pago** (decisión del dueño, 2026-11-16: «por defecto va a ser efectivo; si el vendedor
  te dice pago por transferencia, ahí recién registres eso»). La decide solo el texto del vendedor:
  · **no dijo ninguna** → **efectivo**, venta directa; `result.payment_defaulted: true` y el aviso
    «Pago: efectivo (por defecto).». Ya no es motivo de revisión (tampoco la duda «falta la forma de
    pago» del agente 1);
  · dijo una (código, etiqueta o alias: `efectivo`, `al contado`, `yapeo`, `plin`, `visa`,
    `transferencia`, `depósito`…) **sin negación** en su frase → esa. «yape no, efectivo», «no es
    yape», «sin tarjeta»: esa forma no cuenta;
  · la IA propone una que el vendedor **no dijo** → se ignora y se usa efectivo (nunca se registra
    Yape o transferencia sin que se haya dicho);
  · dijo una que el POS no tiene activa (`payment_method_catalog`) → `invalid_payment`; dijo varias
    distintas («mitad yape y mitad efectivo») → `missing_payment`: ambas por confirmar;
- el cliente (si se indicó) existe;
- el agente 1 no reportó dudas generales.

Si no, se guarda **por confirmar** con uno o más motivos codificados:

| Código | Motivo |
| --- | --- |
| `invalid_draft` | Borrador fuera de contrato o sin líneas. |
| `agent_doubt` | El agente 1 reportó una duda (general o de una línea). |
| `low_confidence` | Una línea no tiene seguridad `high`. |
| `product_unresolved` | Una línea no tiene `product_id` (varias opciones o no encontrado). |
| `product_inactive` | El `product_id` no existe o está inactivo. |
| `missing_quantity` | Falta la cantidad o no es válida. |
| `price_unavailable` | No hay precio para esa presentación. |
| `price_changed` | El precio oficial difiere del que vio el agente 1 (se muestran ambos). |
| `insufficient_stock` | No alcanza el stock disponible. |
| `missing_payment` | Se dijeron varias formas de pago distintas, o no hay «efectivo» activo para usarlo por defecto. (Sin forma de pago dicha ya NO es motivo: efectivo.) |
| `invalid_payment` | La forma de pago que dijo el vendedor no existe o no está activa en el POS. |
| `invalid_customer` | El cliente indicado no existe. |
| `pos_rejected` | `create_sale` respondió con error: no se registró nada. |
| `unit_unclear` | La presentación (caja, docena…) que propuso la IA no la dijo el vendedor. |
| `phrase_not_in_order` | (retirado) Antigua guardia de frase literal del paso 3; ya no se emite. |
| `selector_question` | (paso 3) El selector pregunta (confianza baja, sin producto o pregunta): `question` y `options` para el vendedor. |
| `price_modified` | Precio dictado (escrito por el vendedor) distinto al de lista: por confirmar para todos los roles; un revisor la aprueba a ese precio. |
| `price_override_not_allowed` | **Sin uso desde 2026-11-15**. Se conserva para registros antiguos. |
| `price_unverified` | El borrador trae un precio dictado que no aparece en el texto del vendedor (posible invención del modelo). |

### Reservas de ventas por confirmar

- Se reserva por producto `mín(lo pedido, lo disponible)`. No reservan: una línea sin
  producto resuelto, ni una línea cuyo producto solo fue propuesto por el agente 1
  (duda `ambiguous_product` o `product_not_found`), porque nadie lo eligió. La reserva **no** descuenta el inventario.
- Se libera al completarse, al anularse («cancelar») o al vencer: 48 h
  (`POS_AGENT_REVIEW_TTL_HOURS`). Una reserva vencida deja de contar de inmediato y
  un seguimiento posterior responde que la venta venció.
- Se guardan en `.data/agent` junto con el borrador original y los motivos, para
  la futura pantalla de validación por lote.

### Respuestas

- `completed`: `result.reference` (id de la venta), `total`, `currency`, `items`
  (precio de lista; `quantity_defaulted` si se tomó 1), `alerts`, `notes` (cantidad por defecto) y
  `price_alerts`.
- `pending_review`: `result.reference` (id de la operación), `reasons`
  (`[{ code, line?, message, doubt?, ungrounded? }]`: `doubt` es el código de duda del
  agente 1, p. ej. `ambiguous_product`; `ungrounded` indica que el vendedor no escribió
  la cantidad, la forma de pago o el precio), `pending` (texto), `items`, `reservations`,
  `review_expires_at`, `alerts`, `notes`, `price_alerts`, `price_review` (`"pending"` si hay
  precio dictado distinto al de lista; `items[].list_price` y `items[].price_unit` = dictado).

Alertas: tras `completed` o `pending_review`, para cada producto afectado
`disponible = stock_on_hand − reservas`; `out` si ≤ 0, `low` si ≤ `min_stock`
(de `product_catalog`). Un fallo al calcularlas nunca altera la venta.

## Modo de solo validación (`POS_AGENT_DRY_RUN=1`)

Sirve para probar con lecturas reales sin registrar ventas. Está apagado por defecto.
Se evalúa **en tiempo de ejecución** y basta con que una fuente lo pida:
`POS_AGENT_DRY_RUN=1|true`, `NUXT_POS_AGENT_DRY_RUN` o el valor compilado en
`runtimeConfig` (así funciona también con `node .output/server/index.mjs`). Al arrancar,
el servidor escribe en el log el modo («SOLO VALIDACIÓN» o «REAL») y si el indexado de
búsqueda está encendido. `GET /api/agent/context` lo indica en `dry_run`.

- Hace todas las lecturas reales (producto activo, `resolve_sale_item_pricing`,
  stock, forma de pago, cliente) y aplica la misma regla de decisión, motivos y alertas.
- **Nunca llama a `create_sale`**: el orquestador no ejecuta y, como segunda barrera,
  el ejecutor cableado lanza un error.
- Usa un almacén aparte, `.data/agent/dry-run`: la idempotencia por `request_id`
  funciona igual y las reservas son simuladas (solo afectan a otros pedidos en
  dry-run, nunca a los reales).
- Toda respuesta trae `result.dry_run: true` y el mensaje empieza con
  «SIMULACIÓN (dry-run), NO se registró ninguna venta.»
- `result.would_be: "completed"` → con datos reales se habría registrado directo.
  Se responde con `status: "rejected"` (estado terminal), **nunca `completed`**, porque
  el conector solo admite los estados conocidos y `completed` acredita una venta.
  Las alertas se calculan como si la venta hubiera ocurrido.
- `result.would_be: "pending_review"` → se responde `pending_review` con sus motivos,
  y se pueden probar aclaraciones, «cancelar» y el vencimiento.

## Reintentos y estado local

Reintentar **el mismo mensaje** exige el mismo UUID y contenido. Se conserva su
respuesta; cambiar contenido con ese UUID devuelve 409. La API devuelve `pending`
a los 8 segundos si sigue trabajando; reintenta el mismo UUID.

Una aclaración «no» suelta ya no anula la venta por confirmar; para anularla: «cancelar» o «anular».

**Bloqueo.** Cada mensaje pasa en tres fases: (1) bajo el bloqueo, breve: releer la operación,
respuestas inmediatas (terminada, vencida, «cancelar») y reclamar el `request_id` (`claimed_at`,
`operation.inflight`); (2) **sin bloqueo**: el agente 1 arma el borrador (OpenAI, solo lectura), así un
vendedor no espera al otro; (3) bajo el bloqueo: releer, validar, reservar y ejecutar. Otro mensaje de
la misma operación mientras se prepara recibe `pending` (reintentar con su mismo `request_id`). Un
reclamo sin respuesta de más de 2 minutos y sin `create_sale` enviado (proceso interrumpido) responde
`rejected` («se interrumpió el proceso; no se registró»), nunca un `pending` eterno; si `create_sale`
se envió (`executing`, `operation.execution` sin cerrar) sigue `pending` y nunca se reintenta.
`processing.lock` guarda el pid: si ese proceso ya no existe y no hay ningún `create_sale` sin cerrar,
el siguiente mensaje lo recupera; si lo hay, queda ocupado para conciliación manual.

`.data/agent` es privado, local y para una sola instalación. Un bloqueo
exclusivo impide ejecuciones concurrentes. La marca `executing` se guarda antes de
llamar a `create_sale`. Después de enviarla:

- respuesta con id → `completed`;
- error **con código** de Postgres/PostgREST (p. ej. `P0001` «Stock insuficiente»,
  o el rechazo de precio manual) → la transacción se revirtió: queda por confirmar
  con `pos_rejected`. Al chat solo llega el código; el detalle va al log del servidor;
- error **sin código** (red, 502) o sin respuesta en 20 s (timeout de `create_sale`)
  → **indeterminado**: `pending`, nunca éxito y nunca una segunda llamada; reintentar el
  mismo `request_id` devuelve `pending` hasta conciliar. El timeout libera el bloqueo. Si el proceso muere con un `create_sale` sin cerrar, `processing.lock` no
se recupera solo: conciliar esa venta antes de borrarlo. Varias réplicas o Vercel necesitan almacenamiento transaccional
compartido (sesiones incluidas); no desplegar así.

## Validación

```bash
node scripts/agent-dry-run-e2e.mjs  # dry-run de punta a punta con mocks (sin base ni OpenAI)
pnpm test:agent              # agente + sesiones de vendedor, con dobles; sin ventas reales
node scripts/check-agent.mjs # POS en marcha: credencial, rechazo sin vendedor, inicio de vinculación
```

`check-agent.mjs` nunca envía pedidos: con un vendedor identificado el POS
registraría la venta directamente.
