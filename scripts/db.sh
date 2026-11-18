#!/usr/bin/env bash
# Comandos de base de datos: local (Docker) y producción (proyecto vinculado con `supabase link`).
# Uso: pnpm db:<comando>   (ver README, sección «Base de datos y entornos»)
set -euo pipefail

cd "$(dirname "$0")/.."

BACKUP_ROOT="${PAPELERIA_BACKUP_DIR:-$HOME/papeleria-backups}"
PROJECT_ID="$(sed -nE 's/^project_id = "(.*)"/\1/p' supabase/config.toml)"
DB_CONTAINER="supabase_db_${PROJECT_ID}"
MIGRATION_NAME_RE='^[0-9]{14}_[a-z0-9_]+\.sql$'

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

# The CLI prints an update notice on every call; hide it.
sb() { supabase "$@" 2> >(grep -vE 'new version of Supabase CLI|recommend updating' >&2); }

require_docker() {
  docker info >/dev/null 2>&1 || die "Docker no responde. Abre Docker Desktop y vuelve a intentar."
}

require_linked() {
  [ -f supabase/.temp/project-ref ] || die "No hay proyecto de producción vinculado. Ejecuta: supabase link --project-ref <ref>"
}

check_migration_names() {
  local bad=0 f
  for f in supabase/migrations/*.sql; do
    [ -e "$f" ] || continue
    if ! basename "$f" | grep -qE "$MIGRATION_NAME_RE"; then
      warn "Nombre inválido: $f (usa: pnpm db:new nombre_en_minusculas)"
      bad=1
    fi
  done
  [ "$bad" -eq 0 ] || die "Hay migraciones con nombre inválido."
  ok "Nombres de migraciones correctos"
}

# Rows of `migration list` as "local remote" (an empty side prints as "-"). Fails if production is unreachable.
migration_rows() {
  local out
  out="$(supabase migration list --linked 2>/dev/null)" || die "No se pudo leer el historial de migraciones de producción."
  echo "$out" | grep -E '^[[:space:]]*[0-9]*[[:space:]]*\|[[:space:]]*[0-9]*[[:space:]]*\|' \
    | awk -F'|' '{ l=$1; r=$2; gsub(/[[:space:]]/,"",l); gsub(/[[:space:]]/,"",r); print (l==""?"-":l), (r==""?"-":r) }'
}

# Pending (local-only) migration versions against production.
pending_migrations() { migration_rows | awk '$2=="-" { print $1 }'; }

# Remote-only versions mean someone changed production outside the repo.
remote_only_migrations() { migration_rows | awk '$1=="-" { print $2 }'; }

cmd_backup() {
  require_docker; require_linked
  local dir="$BACKUP_ROOT/prod-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$dir"
  say "Respaldando producción en $dir"
  sb db dump --linked --role-only -f "$dir/roles.sql" >/dev/null
  sb db dump --linked -f "$dir/schema.sql" >/dev/null
  sb db dump --linked --data-only --use-copy -f "$dir/data.sql" >/dev/null
  [ -s "$dir/schema.sql" ] && [ -s "$dir/data.sql" ] || die "El respaldo quedó vacío: $dir"
  ok "Respaldo listo ($(du -sh "$dir" | cut -f1))"
  echo "$dir" > "$BACKUP_ROOT/LATEST"
}

load_data_into_local() {
  local data="$1"
  say "Cargando datos de $data en la base local"
  docker cp "$data" "$DB_CONTAINER:/tmp/data.sql"
  docker exec -e PGPASSWORD=postgres "$DB_CONTAINER" psql -h 127.0.0.1 -U supabase_admin -d postgres \
    -v ON_ERROR_STOP=1 --single-transaction -q -c "SET session_replication_role = replica" -f /tmp/data.sql >/dev/null
  docker exec "$DB_CONTAINER" rm -f /tmp/data.sql
  ok "Datos cargados: $(docker exec "$DB_CONTAINER" psql -U postgres -tAc 'select count(*) from public.products') productos, $(docker exec "$DB_CONTAINER" psql -U postgres -tAc 'select count(*) from public.sales') ventas"
}

cmd_start()  { require_docker; sb start | grep -E 'Started|API URL|Studio' || true; ok "Supabase local encendido (panel: http://127.0.0.1:54323)"; }
cmd_stop()   { sb stop >/dev/null; ok "Supabase local apagado (los datos se conservan)"; }
cmd_status() { sb status 2>/dev/null | grep -vE 'key|secret|Key|Secret|JWT' || warn "Supabase local está apagado (pnpm db:start)"; }

cmd_new() {
  local name="${1:-}"
  [ -n "$name" ] || die "Falta el nombre. Ejemplo: pnpm db:new agregar_descuentos"
  echo "$name" | grep -qE '^[a-z0-9_]+$' || die "Usa solo minúsculas, números y _ (ej: agregar_descuentos)"
  sb migration new "$name"
  ok "Escribe el SQL en el archivo de arriba y pruébalo con: pnpm db:reset"
}

# Rebuilds local from migrations; reloads the latest production copy unless --empty.
cmd_reset() {
  require_docker; check_migration_names
  say "Reconstruyendo la base local desde las migraciones"
  sb db reset --local >/dev/null
  ok "Todas las migraciones se aplicaron sin errores"
  if [ "${1:-}" = "--empty" ]; then return; fi
  local latest; latest="$(cat "$BACKUP_ROOT/LATEST" 2>/dev/null || true)"
  if [ -n "$latest" ] && [ -s "$latest/data.sql" ]; then
    load_data_into_local "$latest/data.sql"
  else
    warn "No hay copia de datos de producción; la base local quedó vacía (pnpm db:refresh)"
  fi
}

# Fresh production copy into local: backup → rebuild → load data.
cmd_refresh() {
  cmd_backup
  cmd_reset
}

# CI result for a commit on GitHub: success | pending | failure | none.
ci_state() {
  local sha="$1" runs
  runs="$(gh api "repos/{owner}/{repo}/commits/$sha/check-runs" --jq '[.check_runs[] | .conclusion // "pending"] | join(" ")' 2>/dev/null)" || { echo none; return; }
  [ -n "$runs" ] || { echo none; return; }
  case " $runs " in
    *" failure "*|*" cancelled "*|*" timed_out "*) echo failure ;;
    *" pending "*) echo pending ;;
    *) echo success ;;
  esac
}

confirm() { printf '\n%s ' "$1"; local a; read -r a; [ "$a" = "$2" ]; }

# Release = migrations to production first, then code to main. Vercel auto-deploy is off for now (vercel.json): deploy by hand.
cmd_release() {
  require_docker; require_linked
  say "1/6 Revisando el repositorio"
  local branch; branch="$(git branch --show-current)"
  [ -n "$branch" ] || die "No estás en ninguna rama."
  [ -z "$(git status --porcelain -- supabase/migrations)" ] || die "Hay migraciones sin commitear en supabase/migrations."
  [ -z "$(git status --porcelain --untracked-files=no)" ] || warn "Tienes cambios sin commitear: NO se publican (solo se publica lo commiteado)."
  git fetch -q origin
  git merge-base --is-ancestor origin/main HEAD || die "Tu rama no tiene lo último de main. Ejecuta: git merge origin/main"
  local ahead; ahead="$(git rev-list --count origin/main..HEAD)"
  ok "Rama '$branch' al día con main ($ahead commit(s) nuevos para publicar)"
  check_migration_names

  if [ "$branch" != "main" ] && [ "$ahead" -gt 0 ]; then
    [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$branch" 2>/dev/null)" ] \
      || die "Sube tu rama primero para que GitHub la revise: git push -u origin $branch"
    case "$(ci_state "$(git rev-parse HEAD)")" in
      success) ok "La revisión automática de GitHub pasó" ;;
      pending) die "La revisión automática de GitHub sigue corriendo. Espera a que termine." ;;
      failure) die "La revisión automática de GitHub falló. Corrige antes de publicar." ;;
      none)    warn "No encontré revisión de GitHub para este commit; se probará solo en local." ;;
    esac
  fi

  say "2/6 Comparando con producción"
  local remote_only; remote_only="$(remote_only_migrations)"
  [ -z "$remote_only" ] || die "Producción tiene migraciones que no están en el repo: $remote_only. Revisa antes de seguir."
  local pending; pending="$(pending_migrations)"
  if [ -z "$pending" ]; then ok "Producción ya tiene todas las migraciones"; else
    warn "Migraciones por aplicar en producción:"; echo "$pending" | sed 's/^/      - /'; fi
  [ -n "$pending" ] || [ "$ahead" -gt 0 ] || { ok "No hay nada nuevo que publicar."; return; }

  say "3/6 Probando en local (migraciones, build y tests)"
  cmd_reset --empty
  pnpm -s build >/dev/null && ok "Build correcto"
  pnpm -s test:agent >/dev/null && ok "Tests correctos"

  if [ -n "$pending" ]; then
    say "4/6 Respaldo de producción"
    cmd_backup
    say "5/6 Aplicar migraciones en la BASE DE PRODUCCIÓN"
    sb db push --linked --dry-run || true
    confirm "Escribe produccion para aplicarlas a la base real:" produccion || die "Cancelado. No se tocó producción."
    sb db push --linked
    [ -z "$(pending_migrations)" ] || die "Quedaron migraciones sin aplicar. Revisa el error; respaldo en $(cat "$BACKUP_ROOT/LATEST")."
    ok "Migraciones aplicadas en producción"
  else
    say "4/6 y 5/6 Sin migraciones: no se toca la base"
  fi

  say "6/6 Subir el código a main"
  if [ "$ahead" -eq 0 ]; then ok "El código ya estaba en main; nada que subir."; return; fi
  git log --oneline origin/main..HEAD | sed 's/^/      /'
  if ! confirm "Escribe publicar para subir estos commits a main:" publicar; then
    [ -z "$pending" ] || warn "OJO: la base ya tiene las migraciones nuevas y la app sigue en la versión anterior."
    die "Código sin publicar. Cuando quieras: pnpm db:release"
  fi
  git push origin HEAD:main
  [ "$branch" = "main" ] || git fetch -q origin main:main
  ok "Código en main. El deploy automático de Vercel está apagado: publica la app con  pnpm dlx vercel --prod"
}

case "${1:-}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  status)  cmd_status ;;
  new)     shift; cmd_new "${1:-}" ;;
  reset)   shift; cmd_reset "${1:-}" ;;
  refresh) cmd_refresh ;;
  backup)  cmd_backup ;;
  check)   check_migration_names ;;
  pending)
    require_linked
    p="$(pending_migrations)"; r="$(remote_only_migrations)"
    [ -z "$r" ] || warn "Producción tiene migraciones que no están en el repo: $r"
    if [ -z "$p" ]; then ok "Producción está al día"; else say "Por aplicar en producción:"; echo "$p" | sed 's/^/  - /'; fi ;;
  release) cmd_release ;;
  *) die "Comando desconocido: ${1:-}. Usa: start | stop | status | new <nombre> | reset [--empty] | refresh | backup | check | pending | release" ;;
esac
