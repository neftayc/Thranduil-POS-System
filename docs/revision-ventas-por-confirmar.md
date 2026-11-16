# Ventas por confirmar: guía de revisión

Pantalla **/ventas-por-confirmar** (menú «Ventas por confirmar»). Solo para **propietario y encargado**
(rol en Supabase Auth, RPC `user_role`).

## Qué muestra
Las ventas que el agente de voz dejó **por confirmar** (`state: "review"`). Por defecto se ven las que
aún no vencen (`POS_AGENT_REVIEW_TTL_HOURS`, 48 h por defecto); el filtro muestra también las vencidas.
La más antigua sale primero. Para cada una:
vendedor, hora, cuánto falta para que venza, lo que dictó, los motivos en lenguaje claro y sus líneas
(producto, cantidad, presentación, precio dictado y de lista, opciones que propuso el agente).
Mientras espera, su stock queda reservado.

## Cómo resolver una venta
1. **Producto**: toca una de las opciones o busca otro producto. Puedes quitar líneas o agregar otras.
2. **Cantidad y presentación**: corrígelas si hace falta.
3. **Precio**: vacío = precio de lista. Si el vendedor dictó otro precio, ya viene puesto
   (opción A: se aprueba a ese precio y se guardan los dos, lista y vendido).
4. **Forma de pago**: efectivo si el vendedor no dijo otra.
5. **Verificar**: el POS revisa con datos actuales que el producto esté activo, la presentación, el
   precio oficial, el stock (descontando lo reservado por otras ventas por confirmar) y el pago.
   Muestra el total y avisa si un precio queda bajo costo.
6. **Aprobar y registrar**: se registra con `create_sale` (el mismo camino que usa el agente). Se
   activa solo después de verificar, y vuelve a pedir verificación si cambias algo.
7. **Anular**: no se registra nada, se libera la reserva y el archivo queda para auditoría.

El vendedor que pregunte por esa venta en Claude recibe lo que decidió el revisor.

## Garantías
- **Una sola venta por operación**: aprobar dos veces devuelve el mismo resultado.
- Si el vendedor corrigió la venta después de que la abriste, la pantalla pide **recargar**.
- Si el POS rechaza la venta, no se registró nada y sigue por confirmar con su reserva.
- Si se pierde la respuesta del POS, la venta queda **pendiente de conciliación**. Revisa el historial
  de ventas y **no la apruebes de nuevo**.
- **A nombre de quién** (decisión del dueño, 16 nov 2026): la venta aprobada queda a nombre del
  **vendedor** que la dictó (`sales.sold_by`), y se guarda **quién la aprobó** (`sales.approved_by`).
  `created_by` sigue siendo quien la registró (el revisor). Requiere la migración
  `supabase/migrations/20261116_sales_attribution.sql` (rollback en `supabase/rollbacks/`). Mientras no
  esté aplicada, la venta se registra igual, pero a nombre del revisor, y queda un aviso en el log del
  servidor. Los reportes por vendedor deben leer `coalesce(sold_by, created_by)`.
- **Simulación** (`POS_AGENT_DRY_RUN=1`): lee las ventas de `.data/agent/dry-run`. Aprobar solo muestra
  lo que se registraría (`would_be: "completed"`) y nunca llama a `create_sale`.

## Ventas vencidas
Decisión del dueño (16 nov 2026): van en la **misma lista**, con el filtro **Pendientes** (por defecto),
**Vencidas** o **Todas**, y cada una lleva la insignia **Vencida**. Al vencer pierden su reserva de stock,
pero el archivo se conserva. Por eso, al **verificar o aprobar** una vencida:
- **Stock**: se vuelve a revisar con lo disponible hoy. Si ya no alcanza, se muestra y no se registra.
- **Precio de lista**: si cambió desde el dictado, se muestra («cambió de S/ X a S/ Y») y no se registra
  hasta que el revisor marca «Acepto estos cambios». Ese aviso vale solo para esos cambios exactos.
- **Anular**, la idempotencia y la simulación funcionan igual que en una pendiente.

## API (todas exigen rol propietario o encargado)
| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/agent/review?filter=pending\|expired\|all` | `{ dry_run, filter, ttl_hours, payment_methods, cases[] }` (cada caso con `expired`) |
| POST | `/api/agent/review/:id/preview` | `{ lines, payment_method }` → verificación sin registrar |
| POST | `/api/agent/review/:id/approve` | `{ version, lines, payment_method, note?, accept_changes? }` → registra (o simula) |
| POST | `/api/agent/review/:id/annul` | `{ version, note? }` → anula y libera la reserva |

`lines[]` = `{ product_id, quantity, unit, price_unit }` (`price_unit: null` = lista).
Respuestas de error: 404 no existe; 409 ya resuelta, cambió, el vendedor la está editando o
pendiente de conciliación (`data.pending`); 422 no pasó la verificación (`data.errors[]`; en vencidas, `data.changes[]` y `data.changes_token`, que se
reenvía como `accept_changes` para aceptar esos cambios). `preview` devuelve también `changes` y `changes_token`.
La lógica está en `server/modules/agent/app/reviewDesk.ts` y los tests en `tests/reviewDesk.test.mjs`.
