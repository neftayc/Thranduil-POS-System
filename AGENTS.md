# Guía de trabajo

Trabaja en la tarea solicitada. Contrasta las afirmaciones con el código y las migraciones de la rama. Pregunta antes de iniciar cualquier cambio grande.

## Desarrollo del refactor

- Consulta la [arquitectura](docs/arquitectura.md) para el stack, los límites de cada contexto y la matriz de permisos. El [plan de fases](docs/fases/README.md) indica por dónde empezar y qué debe comprobar cada entrega.
- Abre el documento de la fase correspondiente. Si encuentras una diferencia con el código, indica la versión y la evidencia y actualiza la tarea según su alcance. Un cambio de arquitectura requiere acordarlo con el equipo y registrar la decisión.
- Entrega una tarea por PR. Usa inglés en el código y español en los documentos y la interfaz (D35). Valida con los comandos disponibles en la rama.
- El servidor verifica la identidad y autoriza cada operación. Conserva el aislamiento por negocio y comprueba los consumidores antes de retirar una ruta, una RPC o una vista.

## Comprobación local

- `pnpm db:start` inicia Supabase local. `pnpm db:reset --empty` reconstruye y borra la base **local** desde las migraciones. El seed sintético del plan se incorpora en F1.
- `pnpm build` compila la aplicación y `pnpm test:agent` ejecuta la suite actual del agente. F1 incorpora Vitest y Playwright.
- Para publicar una migración, sigue el [procedimiento del repositorio](README.md). D44 requiere un respaldo verificado antes del cambio de producción. Mantén las credenciales fuera de Git.
