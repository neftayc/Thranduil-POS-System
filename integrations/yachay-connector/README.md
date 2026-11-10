# Yachay Connector v2 — Selección de sistema y contexto preparado

> Integración con este POS: consulta [LOCAL.md](LOCAL.md) para iniciar, validar y conocer los límites actuales. `systems.json` de esta copia apunta al POS real en el puerto 3000; el puerto 9100 descrito más abajo pertenece a la demo original del paquete.

Conector MCP genérico para Claude (móvil o web). **No contiene lógica de POS, PMS, catálogos, pagos ni SQL**.

## Qué hace

1. `list_systems`: muestra sistemas habilitados.
2. `select_system(system_id)`: si el sistema no exige identificación, recupera `GET /api/agent/context` y devuelve contexto y `selection_token`. Si la exige (`identification_url`), devuelve `requires_identification` con el enlace y el código **del propio sistema**.
3. `check_identification(selection_token)`: consulta si el vendedor aprobó el código; al aprobarse devuelve el `selection_token` definitivo, el vendedor y el contexto.
4. `get_system_context(selection_token)`: vuelve a pedir el contexto al sistema elegido.
5. `send_instruction(selection_token, instruction, request_id)`: transmite literalmente instrucciones al endpoint especializado del sistema.
6. `respond_to_system(selection_token, operation_id, answer, request_id)`: devuelve aclaraciones al sistema.

El `selection_token` es un token **cifrado** (AES-256-GCM) sin base de datos: contiene el sistema elegido, su estado (`open`, `pending`, `active`) y, si corresponde, la referencia opaca de la sesión del vendedor emitida por ese sistema. El conector nunca ve contraseñas: cada sistema identifica a sus vendedores y valida rol y vigencia en cada llamada. Seleccionar otro sistema obtiene otro token y otra identificación.

## Diagrama

```text
Claude Mobile / Claude web (voz)
    | MCP Streamable HTTP público con HTTPS y control de acceso
Yachay Connector
    | list_systems -> select_system -> devuelve contexto
    | send_instruction (texto sin interpretación)
    v
Sistema especializado (POS, PMS...)
    | GET /api/agent/context
    | POST /api/agent/instructions
    v
Agente del sistema y su lógica comercial (FUERA de este repo)
    | response (completed, pending_review, needs_clarification, requires_confirmation, rejected, pending)
    v
Claude comunica el resultado
```

## Instalación local de desarrollo

Requiere Python >=3.11 y conexión a Internet para descargar dependencias (no se incluyen en este paquete).

```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\\Scripts\\activate
pip install -e '.[test]'
cp .env.example .env
# Genera 3 secretos distintos: python -c 'import secrets; print(secrets.token_urlsafe(48))'
# Actualiza .env con YACHAY_SIGNING_KEY y POS_AGENT_TOKEN (YACHAY_MCP_KEY es opcional, solo desarrollo)
set -a; source .env; set +a  # En Windows, cargar variables desde el entorno en lugar de source
```

Terminal 1 — simular un agente POS sin acceder a base de datos alguna:

```bash
pip install -r demo/requirements.txt
uvicorn demo.mock_system:app --host 127.0.0.1 --port 9100
```

Terminal 2 — servidor MCP:

```bash
uvicorn yachay_connector.server:app --host 127.0.0.1 --port 8000
```

Endpoint MCP local: `http://127.0.0.1:8000/mcp`. Solo si defines `YACHAY_MCP_KEY` hace falta el header `x-yachay-connector-key`: es una **opción de desarrollo**, no autenticación por vendedor.

Pruebas:

```bash
pytest -q
```

## Registro de sistemas (`systems.json`)

Cada sistema tiene `id`, `name`, `aliases`, `enabled`, `context_url`, `instruction_url` y `service_token_env`. Las URLs de destinos remotos requieren HTTPS; HTTP se admite solo en loopback para la demo. El modelo no puede introducir endpoints arbitrarios. Las credenciales de conexión salen de variables de entorno del servidor, jamás del contexto del modelo.

El POS de ejemplo apunta a `127.0.0.1:9100` y **es una simulación**. Para conectar un POS real, el propio POS debe exponer el contrato descrito a continuación y el operador deberá actualizar las URLs y credenciales.

## Contrato mínimo que debe implementar CADA sistema

### `GET /api/agent/context`

Request: `Authorization: Bearer <token-del-sistema>` enviado por el conector y, tras identificar al vendedor, `X-Yachay-Session: <referencia opaca>`.

Response HTTP 200:

```json
{
  "system_id": "pos",
  "version": "1.0",
  "context": {
    "description": "POS de la librería. El agente interno interpreta órdenes.",
    "instructions": [
      "Envía la instrucción completa al agente POS.",
      "No inventes precios, productos, stock ni resultados.",
      "Si el POS requiere confirmación, pregunta al vendedor y transmite su respuesta."
    ],
    "capabilities": ["sales", "inventory", "reports"],
    "locale": "es-PE"
  }
}
```

El contexto preparado debe ser **resumen corto** (límite 16 KB), sin inventario completo ni secretos. Es contenido del sistema conectado que Claude recibe mediante una herramienta; **no cambia las instrucciones de sistema internas de Claude** ni debe poder sobrepasar políticas de seguridad.

### `POST /api/agent/instructions`

Una nueva instrucción:

```json
{
  "protocol": "yachay-agent/1",
  "type": "instruction",
  "request_id": "b5732f02-19ea-4b63-8ca3-4ed1904bfb13",
  "input": {"text": "vende un cuaderno amarillo A4 de 100 hojas", "locale": "es-PE"}
}
```

Respuesta para aclaración/confirmación:

```json
{
  "protocol": "yachay-agent/1",
  "type": "follow_up",
  "request_id": "eb82eb33-f7b8-4dd5-acfa-a04c21a13db4",
  "operation_id": "op-pos-123",
  "input": {"text": "sí, confirmo", "locale": "es-PE"}
}
```

Posibles respuestas del sistema:

```json
{"status":"requires_confirmation", "operation_id":"op-pos-123", "message":"¿Confirmas esta operación?"}
```

```json
{"status":"completed", "operation_id":"op-pos-123", "message":"Operación registrada", "result":{"reference":"sale-123"}}
```

Estados admitidos: `completed`, `pending_review`, `requires_confirmation`, `needs_clarification`, `rejected`, `pending`. Para `pending_review`, `requires_confirmation` y `needs_clarification`, `operation_id` es obligatorio. Una respuesta HTTP 403 del sistema (vendedor no identificado, sesión vencida o revocada, usuario sin rol) se transmite como error con el mensaje del sistema.

### Identificación del vendedor (`yachay-identification/1`, opcional por sistema)

Si `systems.json` define `identification_url`, el conector llama `POST identification_url` con `{"protocol":"yachay-identification/1","action":"start"}` y espera `requires_identification`, `identification_id` (opaco), `user_code`, `verification_url` (mismo origen que `identification_url`) y `expires_in` (60–900 s). Luego `{"action":"status","identification_id":...}` devuelve `pending`, `denied`, `expired` o `approved` con `session` (opaca), `seller` (`name`, `role`) y `expires_at`. Desde ese momento envía `X-Yachay-Session` en contexto e instrucciones. Implementación de referencia: `docs/yachay-agent-api.md` del POS. El conector transmite el resultado **sin comprobar ni ejecutar la operación comercial**. El sistema debe validar identidad, permisos, reglas y precios, y **garantizar idempotencia por `request_id`** (reintentos con igual UUID nunca duplican una venta). Si hay timeout, la ejecución queda indeterminada: no afirmar éxito.

## Instrucciones para Claude

Estas instrucciones base ya están incluidas en la descripción del servidor MCP; también puedes usarlas como instrucciones de proyecto:

> Cuando el usuario diga «vamos a vender», llama a `list_systems` y luego `select_system("pos")`. Si devuelve `requires_identification`, muestra el enlace y el código y pide al vendedor aprobarlo en la página del POS; nunca pidas su contraseña. Cuando diga «listo», llama a `check_identification`. Conserva el `selection_token` definitivo durante esta conversación. Para cada pedido, llama a `send_instruction` con el texto completo y un UUID nuevo. `completed` = venta registrada (da la referencia); `pending_review` = venta por confirmar, NO registrada (da la referencia y lo pendiente). Comunica las alertas de stock. Nunca declares una venta completada si el sistema no respondió `completed`.

## Integración Claude Mobile

Claude Mobile utiliza conectores MCP **remotos**, configurados en `claude.ai` → Customize → Connectors → Add custom connector. El endpoint debe estar accesible por **HTTPS público**; `localhost` no funciona en Claude Mobile. Eso es la fase 2: hoy el servidor solo arranca en modo local.

La identidad de cada vendedor ya no depende del acceso al conector: la establece cada sistema (enlace + código) y la valida en cada llamada. Aun así, la exposición remota necesitará su propio control de acceso al endpoint MCP; la clave `YACHAY_MCP_KEY` es solo de desarrollo y no debe usarse para eso.

Documentación de referencia:
- MCP Python SDK v2: https://py.sdk.modelcontextprotocol.io/
- Claude conectores: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp

## Fuera de alcance / estado de validación

- No hay aplicación Android nativa ni servicio de escucha local.
- No hay lógica comercial ni modificación al POS.
- No existe contrato `/api/agent/*` verificado en el POS real: debe implementarse dentro de ese sistema.
- Testeado: `pytest` para router, contratos, identificación del vendedor, tokens y transporte MCP (34 pruebas).
- **Pendiente:** HTTPS público y control de acceso remoto (fase 2), prueba con Claude web/celular.
