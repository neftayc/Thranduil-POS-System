# Agente selector de ventas (paso 2)

Un solo agente de razonamiento recibe el dictado literal y entrega el **consolidado de la venta** (`sale-consolidated/1`), que usa el registrador (paso 3, Proceso 2). Reemplaza la cadena de intérprete, búsqueda, reglas y selector cuando se activa el interruptor.

## Interruptor

| Variable | Valor | Efecto |
|---|---|---|
| `POS_AGENT_SELECTOR` | `legacy` (por defecto) | El sistema actual, sin cambios |
| `POS_AGENT_SELECTOR` | `llm` | El selector nuevo (lo conecta el registrador del paso 3) |
| `POS_AGENT_SELECTOR_MODEL` | `gpt-5.4-mini` (por defecto) | Modelo del selector, elegido con el benchmark |

## Entrada (en este orden, para la caché de prompts)

1. **Prefijo fijo**, idéntico entre ventas mientras el catálogo no cambie:
   - reglas del negocio;
   - ejemplos aprendidos (`app/selectorExamples.ts`);
   - formas de pago activas;
   - **catálogo completo agrupado por tipo**, una línea por producto: `p17 | nombre | marca | presentaciones con precio | tramos | stock disponible`.

   Son unos 12.400 tokens con los 424 productos. El modelo ve referencias cortas (`p17`), nunca uuids.
2. **Parte variable:** los mensajes de la operación (dictado y aclaraciones) y el consolidado previo.

El catálogo se lee **solo leyendo** (`infra/supabaseSelectorCatalog.ts`) y se guarda en memoria:
- se vuelve a leer cuando cambia el `updated_at` más reciente de los productos, y al menos cada 2 minutos por el stock;
- el stock descuenta las reservas vigentes;
- la versión es un hash del contenido, así el prefijo solo cambia cuando cambia algo visible.

## Reglas del negocio (en el prompt)

- La cantidad va antes del producto. Sin número, o con «un/una», es 1. Un número después del nombre es descripción (060, 123, «de 250», «100 hojas»).
- Sin pago → efectivo.
- Errores de dictado: margen o marking → Markin; iconza o icona → Layconsa; de cartel → Castell; para pisar → pizarra; 0.60 o «cero sesenta» → 060.
- El precio dictado sirve de pista.
- Entre productos compatibles gana el que no agrega atributos no dichos.
- «Cuadriculado» = «#», y un A4 dicho no descarta.
- Las negaciones excluyen.
- Una aclaración corrige; no agrega líneas.

## Verificación determinista (la IA interpreta, las reglas verifican)

`toConsolidated()` aplica estas reglas a la respuesta del modelo:
- **Referencias:** las referencias se convierten en ids reales. Una referencia inventada se vuelve pregunta.
- **Confianza alta:** exige un producto real.
- **Confianza baja:** lleva una pregunta y opciones reales.
- **Cantidad:** sin cantidad, es 1.
- **Pago:** un pago dicho que no existe se vuelve pregunta.

Además, `contradictions()` revisa cada línea «alta»; si encuentra uno de estos problemas, la baja a pregunta con opciones:
- **Contradicción exacta:** otro número o medida, otro rayado o tamaño, otro tipo u otra marca.
- **Contradicción de palabra:** se dijo una palabra que el producto no tiene pero que distingue a otro producto del mismo tipo («Trilux», «blancas», «en barra»). La excepción es una aclaración posterior que nombra al producto («vamos a vender el W47»).
- **Empate:** otro producto encaja igual de bien. Se salva el único que no agrega nada no dicho (marca incluida) o el único con el precio dictado.

## Benchmark

Los archivos del benchmark:
- `node scripts/selector-catalog-snapshot.mjs`: snapshot de solo lectura del catálogo real en `tests/fixtures/selector-catalog.json`.
- `node scripts/selector-benchmark.mjs [--models a,b] [--no-legacy] [--cases D8,D8b] [-v]`: corre el set y guarda el detalle en `.data/selector-benchmark/`.
- `tests/fixtures/golden-dictados.json`: el set, con las propuestas del supervisor. El dueño lo valida.

Resultado del 15 nov 2026 (14 casos, 36 líneas; prompt sin frases del set):

| Sistema | Líneas correctas | Ventas perfectas | Equivocados con «alta» | Latencia mediana | Costo por llamada |
|---|---|---|---|---|---|
| legacy (gpt-4o-mini) | 24/36 | 5/14 | 3 | 6,8 s | no medido |
| gpt-5.4 (3 corridas) | **35–36/36** | **13–14/14** | **0 en las 3** | 6–7 s | US$0,010–0,012 |
| gpt-5.4-mini | 27/36 | 8/14 | 2 | 2,5 s | US$0,0037 |

- El costo usa la caché de prompts: entre el 90 y el 97 % de la entrada ya está en caché. Sin caché, una llamada cuesta unos US$0,037 con gpt-5.4 y unos US$0,011 con mini. Una venta con una aclaración son dos llamadas.
- **Precaución:** el set tiene 14 casos y las reglas se ajustaron mirándolos. Antes de cambiar de sistema hace falta un set de control con variaciones nuevas, que el modelo no haya visto.
