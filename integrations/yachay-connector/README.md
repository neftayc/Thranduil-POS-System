# Yachay Connector v2 — Selección de sistema y contexto preparado

> Integración con este POS: consulta [LOCAL.md](LOCAL.md) para iniciar, validar y conocer los límites actuales. `systems.json` de esta copia apunta al POS real en el puerto 3000; el puerto 9100 descrito más abajo pertenece a la demo original del paquete.

Conector MCP genérico para Claude (móvil o web). **No contiene lógica de POS, PMS, catálogos, pagos ni SQL**.

## Qué hace

1. `list_systems`: muestra sistemas habilitados.
2. `select_system(system_id)`: recupera `GET /api/agent/context` del sistema y devuelve contexto preparado y `selection_token` temporal.
3. `get_system_context(selection_token)`: vuelve a pedir el contexto al sistema elegido.
4. `send_instruction(selection_token, instruction, request_id)`: transmite literalmente instrucciones al endpoint especializado del sistema.
5. `respond_to_system(selection_token, operation_id, answer, request_id)`: devuelve aclaraciones o confirmaciones al sistema.

La “sesión” es únicamente **el sistema elegido en la conversación**. No es una sesión de autenticación comercial. No se almacena en SQL: se representa mediante un token firmado de selección, que Claude reutiliza dentro de su conversación. Seleccionar otro sistema obtiene otro token y otro contexto. En v2 no hay una orden `end_session`: basta con no enviar el token o seleccionar otro sistema; los tokens vencen por TTL.

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
    | response (completed, needs_clarification, requires_confirmation, rejected, pending)
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
# Actualiza .env con YACHAY_SIGNING_KEY, YACHAY_MCP_KEY, POS_AGENT_TOKEN
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

Endpoint MCP local: `http://127.0.0.1:8000/mcp` (verificar ruta efectiva con el inspector MCP). Es necesario el header `x-yachay-connector-key` con el valor de `YACHAY_MCP_KEY`. Ese header es un **mecanismo temporal de prueba para un único operador**, no autenticación por vendedor.

Pruebas:

```bash
pytest -q
```

## Registro de sistemas (`systems.json`)

Cada sistema tiene `id`, `name`, `aliases`, `enabled`, `context_url`, `instruction_url` y `service_token_env`. Las URLs de destinos remotos requieren HTTPS; HTTP se admite solo en loopback para la demo. El modelo no puede introducir endpoints arbitrarios. Las credenciales de conexión salen de variables de entorno del servidor, jamás del contexto del modelo.

El POS de ejemplo apunta a `127.0.0.1:9100` y **es una simulación**. Para conectar un POS real, el propio POS debe exponer el contrato descrito a continuación y el operador deberá actualizar las URLs y credenciales.

## Contrato mínimo que debe implementar CADA sistema

### `GET /api/agent/context`

Request: `Authorization: Bearer <token-del-sistema>` enviado por el conector.

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

Estados admitidos: `completed`, `requires_confirmation`, `needs_clarification`, `rejected`, `pending`. Para `requires_confirmation` y `needs_clarification`, `operation_id` es obligatorio. El conector transmite el resultado **sin comprobar ni ejecutar la operación comercial**. El sistema debe validar identidad, permisos, reglas y precios, y **garantizar idempotencia por `request_id`** (reintentos con igual UUID nunca duplican una venta). Si hay timeout, la ejecución queda indeterminada: no afirmar éxito.

## Instrucciones para Claude

Estas instrucciones base ya están incluidas en la descripción del servidor MCP; también puedes usarlas como instrucciones de proyecto:

> Cuando el usuario diga «vamos a trabajar en ventas», primero llama a `list_systems` y luego `select_system("pos")`. Lee `prepared_context` y comunica qué sistema quedó activo. Conserva `selection_token` durante esta conversación. Para cada orden posterior, llama a `send_instruction` con el token vigente, el texto completo del usuario y un UUID nuevo por orden. Si el sistema pide aclaración o confirmación, pregunta al usuario y envía su respuesta a `respond_to_system` usando `operation_id` y otro UUID. Nunca declares una venta completada si el sistema no respondió `completed`. Si el usuario cambia explícitamente de sistema, selecciona el nuevo sistema y usa su nuevo contexto; no mezcles contextos.

## Integración Claude Mobile

Claude Mobile utiliza conectores MCP **remotos**, configurados primero en `claude.ai` → Customize → Connectors → Add custom connector. El endpoint debe estar accesible por **HTTPS público** desde Anthropic; `localhost` no funciona en Claude Mobile. Configura la URL de MCP y el header fijo `x-yachay-connector-key` en la opción avanzada **Request headers** para una prueba **individual** (si esa opción está disponible en tu plan/cliente).

**No desplegar para varios vendedores con un secreto compartido.** Antes de producción, reemplazar `ConnectorHeaderGate` por autenticación individual OAuth/OIDC y autorización de cada sistema, y vincular de forma segura cada selección con la identidad del usuario para que un token robado no permita operar como otro. Para un sistema interno con usuarios reales, este cambio es imprescindible.

Documentación de referencia:
- MCP Python SDK v2: https://py.sdk.modelcontextprotocol.io/
- Claude conectores: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp

## Fuera de alcance / estado de validación

- No hay aplicación Android nativa ni servicio de escucha local.
- No hay lógica comercial ni modificación al POS.
- No existe contrato `/api/agent/*` verificado en el POS real: debe implementarse dentro de ese sistema.
- Testeado: `pytest` para router, contratos y errores (17 pruebas).
- **Pendiente:** prueba de arranque y handshake MCP con SDK instalado, prueba end-to-end con Claude Mobile, HTTPS público y autenticación de producción.
