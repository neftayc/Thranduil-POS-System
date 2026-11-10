# API de ventas para Yachay Connector

La aplicación Nuxt expone HTTP al conector Python. El servidor MCP vive en
`integrations/yachay-connector`; Nuxt no requiere otro servidor MCP.

## Proceso del vendedor

1. **Alta en el POS.** El propietario crea al vendedor en *Usuarios* con rol
   `cashier` (o `manager`/`owner`). Ese es el único usuario que usará.
2. **Agregar el conector en Claude.** Hoy, en modo local: Claude Code o Claude
   Desktop en el mismo equipo, con el MCP `http://127.0.0.1:8000/mcp` (ver
   `integrations/yachay-connector/LOCAL.md`). Claude web/celular requiere la fase 2
   (HTTPS público).
3. **«Vamos a vender».** Claude llama `list_systems` y `select_system("pos")`.
   El POS responde con un enlace propio (`/vincular`) y un código corto, por
   ejemplo `7RX-PXP9`, válido 10 minutos.
4. **Iniciar sesión en el POS.** El vendedor abre el enlace, escribe el código, su
   correo y su contraseña **en la página del POS** (nunca en el chat) y aprueba.
5. Le dice a Claude «listo»; Claude llama `check_identification` y recibe
   «Sesión activa como Ana Pérez (cashier)». La sesión dura hasta las 23:59 (hora de
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
POS_AGENT_PUBLIC_URL=            # origen público del enlace /vincular (fase 2)
POS_AGENT_REVIEW_TTL_HOURS=48    # vigencia de la reserva de una venta por confirmar
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
  sea `owner`, `manager` o `cashier`. Se repite justo antes de registrar.
- La RPC `create_sale` se llama con el token del vendedor: `sales.created_by` es
  ese vendedor.
- Una operación pertenece al vendedor que la creó: otro vendedor recibe 403
  («Esta operación pertenece a otro vendedor.»).
- El código admite 5 intentos fallidos y luego se anula; `/vincular` limita a 10
  intentos por IP cada 10 minutos. La referencia de sesión se entrega una sola vez.

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
→ `pending` | `denied` | `expired` | `{ "status": "approved", "session": "<opaco>", "seller": { "name": "Ana Pérez", "role": "cashier" }, "expires_at": 1762920000 }`

El conector exige que `verification_url` tenga el mismo origen que su
`identification_url` configurada.

## POST /api/agent/identification/approve

Usado por la página pública `/vincular`: `{ "user_code", "email", "password" }`
(JSON). Devuelve el nombre, el rol y el vencimiento; 400 con mensaje en español si
el código venció, la contraseña es incorrecta o el usuario no tiene rol válido.

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
    "confidence": "high",           // high | medium | low
    "doubts": [{ "code": "ambiguous_product", "note": "…" }],
    "query": "2 cuadernos A4"
  }],
  "payment_method": "efectivo | null", // código o etiqueta; null = no se dijo
  "customer_id": "uuid | null",
  "doubts": [],                     // dudas generales
  "source_text": "pedido original"
}
```

Códigos de duda: `ambiguous_product`, `product_not_found`, `missing_quantity`,
`unit_unclear`, `missing_payment`, `customer_ambiguous`, `other`. Un borrador
con campos desconocidos o fuera de rango no se acepta (`invalid_draft`).

Mientras no llegue la búsqueda híbrida, el agente 1 provisional es el intérprete
OpenAI con búsqueda por texto (`legacyDraftBuilder.ts`).

### Regla de decisión (fija y auditable)

Se registra **directo** a nombre del vendedor identificado solo si:

- hay al menos una línea y **cada** línea tiene `product_id` de un producto que
  existe y está activo, seguridad `high`, ninguna duda y una cantidad válida;
- el precio oficial se resuelve con `resolve_sale_item_pricing` (con el cliente,
  si lo hay) y coincide con `price_unit` del borrador (tolerancia S/ 0.005). Si el
  borrador no trae precio, se usa el oficial. **Siempre** se envía el oficial;
- el stock alcanza: `disponible = stock_on_hand − reservas de otras ventas por
  confirmar vigentes`, sumando las líneas repetidas en unidad base;
- la forma de pago existe y está activa en `payment_method_catalog`, y el cliente
  (si se indicó) existe;
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
| `missing_payment` | Falta la forma de pago (no se asume efectivo). |
| `invalid_payment` | La forma de pago no existe en el POS. |
| `invalid_customer` | El cliente indicado no existe. |
| `pos_rejected` | `create_sale` respondió con error: no se registró nada. |

### Reservas de ventas por confirmar

- Se reserva por producto `mín(lo pedido, lo disponible)`; una línea sin producto
  resuelto no reserva. La reserva **no** descuenta el inventario.
- Se libera al completarse, al anularse («cancelar») o al vencer: 48 h
  (`POS_AGENT_REVIEW_TTL_HOURS`). Una reserva vencida deja de contar de inmediato y
  un seguimiento posterior responde que la venta venció.
- Se guardan en `.data/agent` junto con el borrador original y los motivos, para
  la futura pantalla de validación por lote.

### Respuestas

- `completed`: `result.reference` (id de la venta), `total`, `currency`, `items`
  (precio oficial), `alerts`.
- `pending_review`: `result.reference` (id de la operación), `reasons`
  (`[{ code, line?, message }]`), `pending` (texto), `items`, `reservations`,
  `review_expires_at`, `alerts`.

Alertas: tras `completed` o `pending_review`, para cada producto afectado
`disponible = stock_on_hand − reservas`; `out` si ≤ 0, `low` si ≤ `min_stock`
(de `product_catalog`). Un fallo al calcularlas nunca altera la venta.

## Reintentos y estado local

Reintentar **el mismo mensaje** exige el mismo UUID y contenido. Se conserva su
respuesta; cambiar contenido con ese UUID devuelve 409. La API devuelve `pending`
a los 8 segundos si sigue trabajando; reintenta el mismo UUID.

`.data/agent` es privado, local y para una sola instalación. Un bloqueo
exclusivo impide ejecuciones concurrentes. La marca `executing` se guarda antes de
llamar a `create_sale`. Después de enviarla:

- respuesta con id → `completed`;
- error **con código** de Postgres/PostgREST (p. ej. `P0001` «Stock insuficiente»,
  o el rechazo de precio manual) → la transacción se revirtió: queda por confirmar
  con `pos_rejected`;
- error **sin código** (red, timeout, 502) → **indeterminado**: `pending`, nunca
  éxito y nunca una segunda llamada; reintentar el mismo `request_id` devuelve
  `pending` hasta conciliar. Si el proceso muere puede quedar `processing.lock`: conciliar antes de
borrarlo. Varias réplicas o Vercel necesitan almacenamiento transaccional
compartido (sesiones incluidas); no desplegar así.

## Validación

```bash
pnpm test:agent              # agente + sesiones de vendedor, con dobles; sin ventas reales
node scripts/check-agent.mjs # POS en marcha: credencial, rechazo sin vendedor, inicio de vinculación
```

`check-agent.mjs` nunca envía pedidos: con un vendedor identificado el POS
registraría la venta directamente.
