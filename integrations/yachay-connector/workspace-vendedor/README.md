# Carpeta de trabajo de los vendedores (plantilla)

Plantilla para que **cada conversación nueva de Claude Code abra el sistema de ventas**: al primer mensaje, Claude ofrece los sistemas (`list_systems`), guía la elección y la identificación del vendedor (enlace + código) y luego registra pedidos.

## Por qué una carpeta aparte

Si los vendedores abrieran la carpeta del repositorio, Claude tendría acceso al código y a los `.env` con secretos, y las sesiones de desarrollo arrancarían ofreciendo ventas. Esta carpeta solo contiene:

| Archivo | Para qué |
| --- | --- |
| `.mcp.json` | Conector `yachay-pos` en `http://127.0.0.1:8000/mcp`. Sin secretos. |
| `CLAUDE.md` | Instrucciones que Claude carga en cada conversación: abrir el sistema, identificar al vendedor, operar. |
| `.claude/settings.json` | Activa `yachay-pos` sin preguntar, permite sus herramientas, bloquea terminal, edición y web, y añade un recordatorio al inicio de sesión (hook `SessionStart`). |

## Instalación (en el equipo de ventas)

1. Copia esta carpeta **fuera del repositorio**, por ejemplo:

   ```bash
   cp -R integrations/yachay-connector/workspace-vendedor ~/Ventas
   ```

2. Asegura que el POS (`http://127.0.0.1:3000`) y el conector (`scripts/run_local.py`) estén en marcha.
3. En la app de escritorio de Claude (pestaña Code), abre la carpeta `~/Ventas`. La primera vez, Claude puede pedir confiar en la carpeta.
4. Escribe o dicta cualquier mensaje («hola», «vamos a vender»): Claude responde con la lista de sistemas.

Claude no puede hablar antes del primer mensaje: el «arranque automático» ocurre en su primera respuesta. El hook `SessionStart` solo refuerza esa instrucción; `CLAUDE.md` es lo que la define.

## Si el conector usa la clave de desarrollo

Si definiste `YACHAY_MCP_KEY` en el conector, agrega el header leyendo una variable de entorno (nunca el valor en el archivo):

```json
"headers": { "x-yachay-connector-key": "${YACHAY_MCP_KEY}" }
```

y exporta `YACHAY_MCP_KEY` en el entorno desde el que se abre Claude. Para vendedores se recomienda dejarla vacía: la identidad la da el POS, no esta clave.

## Límites

Solo local (mismo equipo que el POS y el conector). Claude web y celular requieren la fase 2 (HTTPS); allí la carpeta se reemplaza por el conector personalizado de claude.ai y unas instrucciones de proyecto con el mismo contenido de `CLAUDE.md`.
