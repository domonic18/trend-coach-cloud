#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=${ENV_FILE:-.env.prod}
COMPOSE_FILE=${COMPOSE_FILE:-docker-compose.prod.yml}
BACKUP_DIR=${BACKUP_DIR:-backups}
RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-14}

if [[ ! -f "$ENV_FILE" ]]; then
  echo "缺少 $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

mkdir -p "$BACKUP_DIR"
umask 077

stamp=$(date -u +%Y%m%dT%H%M%SZ)
out="$BACKUP_DIR/trend-coach-$stamp.sql.gz"
tmp="$out.tmp"
trap 'rm -f "$tmp"' EXIT

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T db \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --clean --if-exists \
  | gzip > "$tmp"

mv "$tmp" "$out"
trap - EXIT

find "$BACKUP_DIR" -type f -name 'trend-coach-*.sql.gz' -mtime +"$RETENTION_DAYS" -delete

echo "备份完成：$out"
