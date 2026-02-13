#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT=""
WIPE_VOLUMES="true"
DRY_RUN="false"

usage() {
  cat <<USAGE
Usage:
  $(basename "$0") --project-root <path> [--wipe-volumes|--keep-volumes] [--dry-run]

Options:
  --project-root <path>  NanoClaw project root (required)
  --wipe-volumes         Remove Docker volumes matching ^nanoclaw (default)
  --keep-volumes         Keep Docker volumes
  --dry-run              Print actions without executing destructive steps
USAGE
}

remove_file() {
  local file="$1"
  if [ "$DRY_RUN" = "true" ]; then
    printf '[dry-run] rm -f %s\n' "$file"
  else
    rm -f "$file"
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project-root)
      PROJECT_ROOT="${2:-}"
      shift 2
      ;;
    --wipe-volumes)
      WIPE_VOLUMES="true"
      shift
      ;;
    --keep-volumes)
      WIPE_VOLUMES="false"
      shift
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [ -z "$PROJECT_ROOT" ]; then
  echo "Missing required --project-root" >&2
  usage
  exit 1
fi

PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"

if [ ! -f "$PROJECT_ROOT/src/config.ts" ] || [ ! -d "$PROJECT_ROOT/store" ]; then
  echo "Not a NanoClaw project root: $PROJECT_ROOT" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required but not found in PATH" >&2
  exit 1
fi

DB_FILES=(
  "$PROJECT_ROOT/store/messages.db"
  "$PROJECT_ROOT/store/messages.db-wal"
  "$PROJECT_ROOT/store/messages.db-shm"
)

printf 'Project root: %s\n' "$PROJECT_ROOT"
printf 'Wipe volumes: %s\n' "$WIPE_VOLUMES"
printf 'Dry run: %s\n\n' "$DRY_RUN"

printf 'Before reset (DB):\n'
ls -lh "$PROJECT_ROOT"/store/messages.db* 2>/dev/null || echo 'No DB files found.'

echo
printf 'Before reset (containers):\n'
docker ps -a --format '{{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Status}}' | rg -i 'nanoclaw|cua|agent' || echo 'No matching containers'

echo
printf 'Before reset (volumes):\n'
docker volume ls --format '{{.Name}}' | rg -i '^nanoclaw' || echo 'No matching volumes'

ids_by_name="$(docker ps -aq --filter name=nanoclaw || true)"
ids_by_label="$(docker ps -aq --filter label=com.nanoclaw.role=agent || true)"
ids_by_image="$(docker ps -aq --filter ancestor=nanoclaw-agent:latest || true)"

all_ids="$(printf '%s\n%s\n%s\n' "$ids_by_name" "$ids_by_label" "$ids_by_image" | rg -v '^$' | sort -u || true)"

if [ -n "$all_ids" ]; then
  echo
  printf 'Removing containers:\n%s\n' "$all_ids"
  if [ "$DRY_RUN" = "true" ]; then
    echo "$all_ids" | while IFS= read -r cid; do
      [ -n "$cid" ] && printf '[dry-run] docker rm -f %s\n' "$cid"
    done
  else
    echo "$all_ids" | xargs docker rm -f >/dev/null
  fi
else
  echo
  echo 'No NanoClaw containers to remove.'
fi

echo
printf 'Removing DB files:\n'
for file in "${DB_FILES[@]}"; do
  printf '  %s\n' "$file"
  remove_file "$file"
done

if [ "$WIPE_VOLUMES" = "true" ]; then
  volumes="$(docker volume ls --format '{{.Name}}' | rg -i '^nanoclaw' || true)"
  if [ -n "$volumes" ]; then
    echo
    printf 'Removing volumes:\n%s\n' "$volumes"
    if [ "$DRY_RUN" = "true" ]; then
      echo "$volumes" | while IFS= read -r vol; do
        [ -n "$vol" ] && printf '[dry-run] docker volume rm %s\n' "$vol"
      done
    else
      echo "$volumes" | xargs -n1 docker volume rm >/dev/null
    fi
  else
    echo
    echo 'No NanoClaw volumes to remove.'
  fi
fi

echo
printf 'After reset (DB):\n'
ls -lh "$PROJECT_ROOT"/store/messages.db* 2>/dev/null || echo 'DB files removed (or did not exist).'

echo
printf 'After reset (containers):\n'
docker ps -a --format '{{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Status}}' | rg -i 'nanoclaw|cua|agent' || echo 'No matching containers'

echo
printf 'After reset (volumes):\n'
docker volume ls --format '{{.Name}}' | rg -i '^nanoclaw' || echo 'No matching volumes'

echo
printf 'Reset complete.\n'
