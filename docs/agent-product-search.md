# Búsqueda híbrida de productos (agente 1)

Objetivo: que un pedido dicho como lo dice un vendedor («vender cuaderno markin
cuadriculado 100 a4») encuentre el producto correcto, y que el sistema sepa cuándo
está **seguro** (registra sin preguntar) y cuándo no (queda por confirmar).

## Flujo

1. **Interpretación (OpenAI, `POS_AGENT_MODEL`)**: separa por artículo `query`,
   `product`, `brand`, `attributes`, `quantity`, `unit`, y la forma de pago.
   `100 hojas` nunca es la cantidad.
2. **Recuperación (candidatos, hasta 40)** — RPC `search_products_hybrid`:
   - texto: `pg_trgm` + `unaccent`, palabras con **OR** (no AND) y similitud de
     palabra, sobre `product_search_index.search_text`;
   - vectores: `pgvector` (coseno) con embeddings de OpenAI
     (`POS_AGENT_EMBEDDING_MODEL`, por defecto `text-embedding-3-small`, 1536 dim);
   - fusión con RRF (k = 60). Se complementa con una pasada léxica en memoria
     (tolera errores de tipeo como «grnade», «pqueño», «shurtaple»).
3. **Decisión (código, `server/modules/agent/app/productSearch.ts`)**: puntúa cada
   candidato con señales exactas:
   - números y medidas: hojas (h, hojas, f, folios), g, ml, cm, mm, piezas, `x12`;
     un número distinto es **conflicto** (50 h ≠ 100 h);
   - rayado: `#`/cuadriculado, rayado, triple renglón, `1x1`/`2x2`;
   - tamaño: A4≈grande, A5≈pequeño (conflicto si se contradicen; si el nombre no lo
     dice queda «no confirmado»);
   - marca: si se pide una marca conocida y el producto es de otra, conflicto;
   - cobertura de las palabras del pedido (con sinónimos del rubro: tajador =
     sacapuntas, bond = boom, crayolas = crayones…).
   - `high` solo si hay **un único** candidato sin conflictos, que cubre todas las
     palabras, sin medidas faltantes y sin empate con otro. Un nombre exacto no desempata:
     si otro producto activo también coincide con lo pedido («diccionario bruno», «papel
     lustre»), la línea es `medium` con el nombre exacto preseleccionado. A4 frente a
     «grande» es compatible pero queda «no confirmado»; si hay empate o duda,
     `medium` con el mejor preseleccionado y las alternativas; si nada es
     compatible, `low` y se dice que no se encontró.
4. **Precio y stock en vivo**: `resolve_sale_item_pricing` y `product_catalog`.
   Precio S/ 0, presentación sin precio o stock insuficiente bajan la línea a `medium`.
5. **Borrador para el proceso 2** (`app/draftBuilder.ts`, `buildDraft(messages, previous)`):
   sale-draft/1 con `product_id` (solo de candidatos reales), `candidates`, `quantity`,
   `unit` pedida, `price_unit` visto, `confidence` y dudas codificadas. En una
   aclaración, el intérprete solo puede elegir IDs de los candidatos del borrador previo.
   El proceso 2 vuelve a verificar todo y decide registrar o dejar por confirmar.

Preguntas de catálogo (`intent: catalog_query`): `makeCatalogAnswerer` responde con
precio y stock en vivo. `buildDraft` las devuelve como `{ kind: 'catalog_answer' }` solo
con `answerCatalogQuestions: true`; si no, como `intent: 'unsupported'`. El proceso 2
las atiende sin vender ni reservar (ver yachay-agent-api.md).

## Índice y sinónimos (`supabase/migrations/20261110_product_hybrid_search.sql`)

- `product_search_index`: `document` = «nombre. Marca: … Categoría: … También:
  sinónimos» (**sin precio ni stock**), `search_text` normalizado, `embedding`.
- Triggers en `products`, `product_categories` y `product_search_synonyms` mantienen
  el texto al crear/editar y marcan el vector como pendiente.
- Vectores: `npm run index:products` (pendientes) o `node scripts/index-product-search.mjs --all`
  (todos, p. ej. al cambiar de modelo). Ambos ESCRIBEN en la base: solo con
  permiso del usuario. Calcular los pendientes en segundo plano durante las búsquedas
  (máx. 200 por minuto) está **apagado por defecto**; se enciende con
  `POS_AGENT_SEARCH_AUTOINDEX=1` y nunca corre con `POS_AGENT_DRY_RUN=1`. Sin esa
  variable, buscar es de solo lectura.
- `product_search_synonyms` (`phrase` → `product_id`, `source` = `manual` |
  `sale_review` | `import`): la etapa 2 la alimentará al validar ventas por
  confirmar. Una frase aprendida que coincide con el pedido decide por sí sola.
- Si la migración no está aplicada, el agente usa la búsqueda léxica en memoria
  (sin vectores) con la misma lógica de decisión.

## Medición

```bash
node scripts/eval/baseline-search.mjs                       # búsqueda anterior (AND con ilike)
node scripts/eval/hybrid-search.mjs                         # nueva, solo texto
node scripts/eval/hybrid-search.mjs --vectors               # nueva, con vectores (usa OpenAI)
node scripts/eval/hybrid-search.mjs tests/fixtures/agent-search-holdout.json
```

Casos en `tests/fixtures/agent-search-cases.json` (37) y
`agent-search-holdout.json` (28), sobre una instantánea del catálogo real
(`catalog-snapshot.json`: nombre, marca, categoría y SKU; sin precios ni stock).
