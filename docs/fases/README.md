# Plan de fases: refactorización a plataforma multi-negocio

Este plan detalla las fases de la sección 14 de [`../arquitectura.md`](../arquitectura.md). La arquitectura (decisiones D1–D63) manda: si una fase contradice el documento de arquitectura, se corrige la fase o se registra una decisión nueva allí.

## Fases

| Fase | Documento | Detalle | Estado |
|---|---|---|---|
| 0 | [Seguridad urgente](fase-0-seguridad.md) | Completo (archivo por archivo) | Por validar al iniciar |
| 1 | [Cimientos](fase-1-cimientos.md) | Completo | Por validar al iniciar |
| 2 | [Multi-negocio](fase-2-multi-negocio.md) | Completo (tablas, datos, RLS) | Por validar al iniciar |
| 3 | [Catálogo](fase-3-catalogo.md) | Por caso de uso + modelo de dominio | Por validar al iniciar |
| 4 | [Precios e impuestos](fase-4-precios.md) | Por caso de uso + modelo de dominio | Por validar al iniciar |
| 5 | [Compras e inventario](fase-5-compras-inventario.md) | Por caso de uso + modelo de dominio | Por validar al iniciar |
| 6 | [Ventas y caja](fase-6-ventas-caja.md) | Por caso de uso + modelo de dominio | Por validar al iniciar |
| 7 | [Reportes](fase-7-reportes.md) | Por reporte | Por validar al iniciar |
| 8 | [Módulos](fase-8-modulos.md) | Por módulo | Por validar al iniciar |
| 9 | [Frontend](fase-9-frontend.md) | Por página | Por validar al iniciar (puede avanzar en paralelo desde la Fase 1) |

**Estados posibles:** Por validar al iniciar → Validada → En curso → Terminada.

## Regla: validación al iniciar cada fase

Los documentos se escribieron el 2026-11-18, antes de implementar nada. Lo que se aprenda en cada fase puede cambiar las siguientes. Por eso **ninguna fase empieza sin pasar por esta validación**:

1. **Revisar el cierre de la fase anterior:** qué cambió respecto al plan, qué quedó pendiente, qué se aprendió. Está en la sección «Registro de cambios» de su documento.
2. **Contrastar con el código real.** Los archivos, funciones y líneas citados pueden haber cambiado; se actualizan las referencias.
3. **Contrastar con la arquitectura.** ¿Alguna decisión D1–D63 ya no aplica, o hace falta una nueva? Si es así, se registra primero en `arquitectura.md`.
4. **Revisar los requisitos previos** de la fase: ¿están todos cumplidos?
5. **Ajustar el detalle.** Tareas, orden, criterios de terminado y riesgos. Las Fases 3 a 9 se llevan en este paso al nivel archivo por archivo.
6. **Anotar los cambios** en «Registro de cambios» con su fecha y pasar el estado a **Validada**.

Al terminar una fase se completa su «Registro de cambios» con lo que efectivamente se hizo y se pasa el estado a **Terminada**.

## Estructura de cada documento de fase

1. **Objetivo y alcance:** qué entra y qué no.
2. **Requisitos previos.**
3. **Modelo de dominio** (solo en las Fases 3 a 6): entidades, reglas (invariantes) y eventos del contexto.
4. **Tareas en orden.** Cada tarea tiene el tamaño de un encargo para un agente de IA, sus archivos y su criterio de terminado.
5. **Cómo verificar:** comandos y tests.
6. **Cómo volver atrás.**
7. **Riesgos.**
8. **Registro de cambios.**

Una fase puede agregar secciones propias cuando las necesita (concurrencia, migración de datos, dependencias, decisiones pendientes). En ese caso la numeración cambia, pero **Registro de cambios** va siempre al final.

## Decisiones aún abiertas (se cierran en la validación de inicio de su fase)

| Fase | # | Pregunta | Propuesta del documento |
|---|---|---|---|
| 5 | DP5-3 | ¿Qué hacer con lo «no vendible» del conteo? | Salida de ajuste con motivo «no vendible» |
| 5 | DP5-4 | ¿«Devolución a proveedor» entra en la fase? | No; caso de uso futuro de compras |
| 6 | DP6-5 | ¿Vencen las reservas de un pedido? | Sí, configurable (48 h por defecto) |
| 6 | DP6-6 | ¿El código de pedido pasa a serie correlativa? | Sí (`P001-000123`), por D42 |
| 6 | DP6-7 | ¿El ejecutor del agente se mueve a su capa en la Fase 6? | No, en la Fase 8 |
| 6 | DP6-8 | ¿Venta con varias formas de pago? | Modelo y API sí; interfaz en la Fase 9 |

## Hallazgos del detalle de fases (2026-11-18)

Al detallar las fases contra el código aparecieron problemas que la auditoría no registraba:
- **Seguridad:** S11 (bypass de token en `utiles/*`) y S12 (acciones de escritura sin validación de rol). Ambos se corrigen en la Fase 0.
- **Datos:**
  - los pedidos cobrados no consumen FIFO (`pay_sales_order`);
  - corregir una compra no ajusta stock ni costo (su trigger fue eliminado);
  - el conteo trunca a enteros y pierde las ventas simultáneas;
  - `upsert_product_catalog` fija stock y costo sin movimiento;
  - la pestaña «Reportes» del POS calcula sobre las últimas 50 ventas.

  Cada uno queda resuelto en su fase (5, 6 o 7).

## Convenciones

- **Una tarea = un PR** a `main`, con CI en verde y `/code-review` cuando toca `domain/`, RLS o migraciones.
- **Migraciones en producción:** `pnpm db:backup` antes, siempre (D44). Se publican con el flujo existente (`pnpm db:release`: migraciones primero, luego `main` → Vercel).
- **Código en inglés, documentos en español** (D35). Los nombres de casos de uso siguen el glosario de `arquitectura.md` §18.1.
- Las referencias `archivo:línea` corresponden al estado del repositorio al 2026-11-18 y se revalidan al iniciar cada fase.
