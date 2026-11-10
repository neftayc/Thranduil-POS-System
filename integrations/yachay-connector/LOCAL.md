# Conector MCP local

El conector está integrado con el POS Nuxt de este repositorio. No contiene interpretación ni ejecución de ventas: remite instrucciones al agente del POS.

- POS: `http://127.0.0.1:3000`
- Endpoint MCP: `http://127.0.0.1:8000/mcp`
- Sistema habilitado: `pos`
- Credencial entrante: header `x-yachay-connector-key`, tomado de `YACHAY_MCP_KEY` en el `.env` privado de esta carpeta.
- Credencial hacia el POS: `POS_AGENT_TOKEN`, igual al valor del `.env` raíz. No copiar credenciales a mensajes, capturas ni contexto del modelo.

## Iniciar

Desde esta carpeta, con Python 3.11 o superior:

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock.txt
.venv/bin/python -m pip install --no-deps -e .
.venv/bin/python scripts/run_local.py
```

El entorno virtual y el archivo `.env` ya se prepararon en esta máquina. `scripts/run_local.py` carga ese archivo sin imprimir los secretos. El proceso se limita a loopback; no se ha creado un túnel ni un despliegue público.

## Validar

```bash
.venv/bin/python -m pytest -q
.venv/bin/python scripts/smoke_mcp.py
.venv/bin/python scripts/smoke_mcp.py --check-relay
```

La prueba predeterminada verifica: rechazo sin credencial, handshake MCP, las cinco herramientas, selección del POS y actualización de contexto. `--check-relay` agrega una consulta de seguimiento con una operación inexistente para verificar que el POS la rechace. Ninguna de esas pruebas envía un pedido de venta.

Para comprobar además el intérprete del POS se puede usar `--prepare-instruction 'texto del pedido'`. Esta opción utiliza la IA y consulta el catálogo real, espera el borrador y envía `cancelar`; nunca envía una confirmación. Se necesita una instrucción suficientemente precisa para preparar o aclarar una venta. La salida resume los estados sin imprimir tokens.

## Flujo del cliente MCP

1. `list_systems` enumera el POS.
2. `select_system("pos")` carga `/api/agent/context` y devuelve `selection_token`.
3. `send_instruction(token, texto, request_id)` transmite una orden nueva, con un UUID nuevo.
4. Si el POS responde `pending` o hay timeout, repetir **la misma llamada con el mismo UUID y el mismo texto**. No generar otra orden.
5. Para responder una aclaración, enviar `respond_to_system(token, operation_id, respuesta, request_id_nuevo)`.
6. Comunicar una venta como realizada únicamente si el POS devuelve `completed`.

## Límites actuales

La clave compartida es para una prueba individual. La identificación de vendedores por conversación está pendiente, como se acordó. El POS puede preparar borradores; su ejecutor exige una sesión de vendedor configurada y confirmación explícita. `execution_configured` indica que existe esa configuración; su vigencia y permisos se validan al ejecutar. Este conector no crea esa sesión ni elude la autorización del POS.

La conexión desde Claude móvil/web no se ha probado. Requerirá un endpoint HTTPS público y su configuración de acceso; un MCP en `127.0.0.1` está disponible únicamente en este equipo.

Versiones probadas: Python 3.12, MCP SDK 2.3.0. `requirements.lock.txt` conserva las versiones efectivamente instaladas. Las 17 pruebas originales y las 2 pruebas adicionales del transporte MCP pasan.

Documentación oficial utilizada para verificar el SDK: [montaje ASGI](https://py.sdk.modelcontextprotocol.io/run/asgi/) y [MCPServer](https://py.sdk.modelcontextprotocol.io/api/mcp/server/mcpserver/server/).
