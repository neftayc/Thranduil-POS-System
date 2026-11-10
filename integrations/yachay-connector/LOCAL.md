# Conector MCP local

El conector está integrado con el POS Nuxt de este repositorio. No contiene interpretación ni ejecución de ventas ni contraseñas: remite instrucciones al agente del POS y transporta la sesión del vendedor que emite el propio POS.

- POS: `http://127.0.0.1:3000`
- Endpoint MCP: `http://127.0.0.1:8000/mcp`
- Sistema habilitado: `pos` (requiere identificación del vendedor: `identification_url` en `systems.json`)
- Credencial hacia el POS: `POS_AGENT_TOKEN`, igual al valor del `.env` raíz. Autentica al **servicio**, no al vendedor.
- Identidad del vendedor: la establece el POS en `/vincular` (enlace + código). El conector la guarda cifrada dentro del `selection_token` y la reenvía en `X-Yachay-Session`.

## Modo local de desarrollo (único modo de esta fase)

`YACHAY_MODE=local` (valor por defecto) exige escuchar en `127.0.0.1`/`localhost`; cualquier otro modo o host se rechaza al iniciar. El acceso remoto HTTPS (Claude web y celular) es la fase 2 y **no** debe reutilizar la clave de desarrollo.

`YACHAY_MCP_KEY` es **opcional y solo de desarrollo**: si se define (mínimo 32 caracteres), el endpoint exige el header `x-yachay-connector-key`. No identifica vendedores ni sustituye la vinculación.

Variables del `.env` de esta carpeta: `YACHAY_SIGNING_KEY` (obligatoria, cifra los `selection_token`), `POS_AGENT_TOKEN`, y opcionalmente `YACHAY_MCP_KEY`, `YACHAY_HOST`, `YACHAY_PORT`, `YACHAY_SYSTEMS`. En el POS hace falta además `POS_AGENT_SESSION_KEY` (ver `docs/yachay-agent-api.md`).

## Iniciar

Desde esta carpeta, con Python 3.11 o superior:

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock.txt
.venv/bin/python -m pip install --no-deps -e .
.venv/bin/python scripts/run_local.py
```

`scripts/run_local.py` carga `.env` sin imprimir secretos. No se crea túnel ni despliegue público.

## Proceso del vendedor

1. El propietario da de alta al vendedor en el POS (*Usuarios*, rol `cashier`).
2. En Claude (Claude Code o Desktop en este equipo) está agregado el MCP `http://127.0.0.1:8000/mcp`.
3. El vendedor dice «vamos a vender». Claude llama `list_systems` y `select_system("pos")` y muestra un enlace (`http://127.0.0.1:3000/vincular`) y un código como `7RX-PXP9`.
4. El vendedor abre el enlace, escribe el código, su correo y su contraseña **del POS** y aprueba. Nunca escribe la contraseña en el chat.
5. Dice «listo»; Claude llama `check_identification` y responde «Sesión activa como Ana Pérez (cashier)».
6. Dicta el pedido. Claude lo envía literal con `send_instruction` y un UUID nuevo.
7. El POS responde `completed` + referencia (venta registrada a su nombre) o `pending_review` + referencia (venta por confirmar, no registrada, stock reservado). Si hay stock bajo o agotado, Claude lo avisa.

## Validar

```bash
.venv/bin/python -m pytest -q
.venv/bin/python scripts/smoke_mcp.py
.venv/bin/python scripts/smoke_mcp.py --wait-identification --check-relay
```

La prueba predeterminada verifica: handshake MCP, las seis herramientas, que `select_system` pida identificación, que una instrucción sin vendedor se rechace y que `check_identification` quede pendiente. `--wait-identification` muestra enlace y código y espera a que un vendedor lo apruebe; `--check-relay` consulta una operación inexistente. **Ninguna opción envía pedidos**: con un vendedor identificado el POS registraría la venta directamente.

## Flujo del cliente MCP

1. `list_systems` enumera el POS.
2. `select_system("pos")` → `requires_identification` con `verification_url`, `user_code` y un `selection_token` provisional.
3. `check_identification(token)` → `pending_identification` mientras no se apruebe; luego `selected` con el `selection_token` definitivo, `seller` y `prepared_context`.
4. `send_instruction(token, texto, request_id)` con un UUID nuevo por pedido.
5. Si el POS responde `pending` o hay timeout, repetir **la misma llamada con el mismo UUID y el mismo texto**.
6. Para completar o anular una venta por confirmar: `respond_to_system(token, operation_id, texto, request_id_nuevo)`.
7. Una venta está registrada únicamente si el POS devuelve `completed` con referencia.

Un token provisional, sin vendedor, firmado con otra clave o vencido se rechaza antes de llamar al POS. Una sesión revocada, vencida, de un usuario desactivado o sin rol la rechaza el POS (HTTP 403) y el conector transmite su mensaje en español, sin datos sensibles. Una operación creada por otro vendedor también se rechaza.

## Límites actuales

- Solo local: Claude web/celular necesita la fase 2 (HTTPS público). El enlace `/vincular` usará entonces `POS_AGENT_PUBLIC_URL`.
- La validación en lote de ventas por confirmar y los avisos programados son la etapa 2.
- Sesiones y operaciones se guardan en archivos locales del POS: una sola instancia.

Versiones probadas: Python 3.12, MCP SDK 2.3.0, `cryptography` 50. Documentación del SDK: [montaje ASGI](https://py.sdk.modelcontextprotocol.io/run/asgi/) y [MCPServer](https://py.sdk.modelcontextprotocol.io/api/mcp/server/mcpserver/server/).
