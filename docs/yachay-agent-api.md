# API de ventas para Yachay Connector

La aplicación Nuxt expone HTTP al conector Python. El servidor MCP vive en
`integrations/yachay-connector`; Nuxt no requiere otro servidor MCP.

## Configuración local

El POS se inicia como siempre, en `http://127.0.0.1:3000`.
Configura en `.env`:

```dotenv
POS_AGENT_TOKEN=<secreto independiente de al menos 32 caracteres>
POS_AGENT_MODEL=gpt-4o-mini
POS_AGENT_STORAGE_DIR=.data/agent
```

También utiliza `OPENAI_API_KEY` y las credenciales Supabase ya existentes.
`POS_AGENT_TOKEN` es la credencial **conector -> POS** y debe coincidir en ambos
procesos. No es una clave de Supabase, una sesión de vendedor ni la clave MCP
`YACHAY_MCP_KEY`. Nunca enviar secretos al modelo o al contexto público.

El intérprete usa el SDK OpenAI instalado, con `chat.completions.parse` y
`zodResponseFormat`, siguiendo la [documentación oficial de salida estructurada](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=chat).
El modelo extrae datos; el backend consulta productos, valida cantidades y calcula
los precios mediante `resolve_sale_item_pricing`. Los nombres y opciones vienen
del catálogo real. El modelo solo puede seleccionar IDs previamente ofrecidos.

## Autorización y alcance actual

Ambas rutas requieren `Authorization: Bearer <POS_AGENT_TOKEN>` y no publican
claves en su respuesta. Una credencial ausente o incorrecta devuelve HTTP 401;
sin configuración del servicio se devuelve 503.

La identificación individual por conversación se implementará después. Por ahora
la API prepara ventas y, solo si se configura explícitamente
`POS_AGENT_SELLER_ACCESS_TOKEN` con una sesión **vigente de un usuario existente**,
puede registrarlas tras confirmar. Antes de ejecutar verifica el usuario con
Supabase Auth y su rol `owner`, `manager` o `cashier`. No se crean vendedores ni se
suplantan usuarios con la clave de servicio. Una sesión vencida o ausente rechaza
la ejecución sin enviar una venta. El contexto informa `execution_configured`
(presencia de la configuración, no garantía de que la sesión siga vigente).

## GET /api/agent/context

Devuelve `system_id: "pos"`, `version: "1.0"` y `context`, compatible con
`select_system("pos")`: descripción, instrucciones, capacidades, idioma y moneda.
Es un resumen sin catálogo completo ni datos de autenticación.

## POST /api/agent/instructions

Requiere `Content-Type: application/json`. Cuerpo máximo 16.000 bytes,
texto máximo 2.500 caracteres, protocolo `yachay-agent/1`.

```json
{
  "protocol": "yachay-agent/1",
  "type": "instruction",
  "request_id": "8cb47727-c3a8-4a68-8610-b383398bd53f",
  "input": { "text": "vende 2 cuadernos A4 de 100 hojas cuadriculados, pago efectivo", "locale": "es-PE" }
}
```

Para contestar una pregunta o confirmar se usa el `operation_id` devuelto por el
POS y un `request_id` nuevo:

```json
{
  "protocol": "yachay-agent/1",
  "type": "follow_up",
  "request_id": "50621fd7-c523-45cf-ae16-af2f34df7459",
  "operation_id": "8cb47727-c3a8-4a68-8610-b383398bd53f",
  "input": { "text": "sí, confirmo", "locale": "es-PE" }
}
```

Los identificadores son UUID. Las respuestas utilizan los estados del conector:

| Estado | Significado |
| --- | --- |
| `needs_clarification` | Faltan cantidades, producto exacto, presentación, forma de pago o stock suficiente. |
| `requires_confirmation` | `result.draft` incluye productos, cantidades, precios, forma de pago y total. |
| `completed` | Se registró la venta; `result.reference` contiene su identificador. |
| `rejected` | Cancelación, petición no soportada, borrador vencido o ejecución no autorizada. Leer `message`. |
| `pending` | Trabajo concurrente o resultado de ejecución indeterminado; no afirmar éxito. |

Una petición inicial siempre prepara; nunca registra una venta. Se admite hasta
20 líneas. La cantidad omitida se pregunta; `100 hojas` no se toma como cantidad.
Si se omite presentación se usa la unidad base; sin cliente específico se prepara
venta al público con `customer_id: null`. La forma de pago se pide si falta.
Varias coincidencias requieren elegir un producto. Cada cambio del borrador
requiere otra confirmación. Precio y stock se consultan nuevamente al confirmar.

## Reintentos y estado local

Reintentar **el mismo mensaje** exige el mismo UUID y contenido. Se conserva su
respuesta; cambiar contenido con ese UUID devuelve HTTP 409. Cada aclaración o
confirmación usa un UUID nuevo, asociado al mismo `operation_id`.

La interpretación puede superar los 12 segundos del timeout del conector. La API
devuelve `pending` a los 8 segundos si sigue trabajando en la instancia local;
reintenta el mismo UUID para obtener su respuesta almacenada al finalizar.
Si Yachay pierde una respuesta de red, también debe conservar el mismo UUID.

Los borradores vencen a la hora, y los resultados de peticiones se conservan.
El almacenamiento en `.data/agent` es privado, local y para una sola instalación.
Un bloqueo exclusivo impide ejecuciones concurrentes. La marca `executing` se
guarda antes de llamar a la RPC; un timeout posterior se considera indeterminado
y nunca provoca una segunda llamada automática.

Si el proceso muere puede quedar `processing.lock`: primero revisar el UUID y
las ventas existentes. No borrar registros de ejecución ni cambiar el request_id
para forzar un reintento, porque la primera venta podría haberse registrado.
Tras conciliar, el operador puede resolver el bloqueo. Una implementación con
varias réplicas o Vercel necesita sustituir este almacenamiento por persistencia
transaccional compartida; no usar un directorio efímero ni desplegar así.

## Validación

```bash
node --test tests/agent.test.mjs
node scripts/check-agent.mjs
# Consulta OpenAI y Supabase; solo prepara, nunca confirma una venta:
node scripts/check-agent.mjs --prepare
```

Las pruebas automatizadas de ejecución utilizan dobles del repositorio, sin
registrar ventas reales. El smoke test verifica credencial, contrato y contexto;
`--prepare` añade interpretación real, reintento idéntico y conflicto de UUID.

## Agente 1: búsqueda de productos y propuesta de venta

El preparador (`prepare()`) busca cada artículo con **búsqueda híbrida** y decide
con atributos exactos; el detalle está en [agent-product-search.md](agent-product-search.md).
Además de `draft` (solo cuando todo es seguro) devuelve `proposal`, que viaja en
`result.proposal` de las respuestas `completed` y `pending_review`:

| Campo | Contenido |
| --- | --- |
| `confidence` | `high` (se puede registrar), `medium` (producto probable con dudas → por confirmar) o `low` (sin producto o faltan datos). |
| `items[]` | `product_id`, `name`, `sku`, `brand`, `qty`, `unit_name`, `factor`, `price_unit`, `total`, `stock_available` (stock − reservado), `confidence`, `match_score`, `reasons[]` y `alternatives[]` (≤ 5 candidatos reales). |
| `payment_method`, `customer_id`, `total`, `currency` | Datos resueltos o `null`. |
| `doubts[]` | Motivos de duda en español. |

Los IDs solo provienen de candidatos reales del catálogo; precio
(`resolve_sale_item_pricing`) y stock se leen en vivo y nunca se guardan en el índice.

Las preguntas de catálogo («¿tenemos cuadernos Marking cuadriculados?», «¿cuánto
cuesta…?», «¿cuántos quedan?») usan `intent: catalog_query` y responden
`completed` con `result.kind = "catalog_answer"` y `result.answers[]`, sin vender
ni reservar. Los reportes con cálculos («¿cuánto vendimos hoy?») aún no están
soportados (segunda etapa).
