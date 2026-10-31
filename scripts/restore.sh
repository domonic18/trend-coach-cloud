#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ $# -ne 1 ]]; then
  echo "用法：scripts/restore.sh <backup.sql.gz>" >&2
  exit 1
fi

if [[ ${RESTORE_CONFIRM:-} != yes ]]; then
  echo "恢复会覆盖现有数据。确认后以 RESTORE_CONFIRM=yes 重跑。" >&2
  exit 1
fi

backup=$1
if [[ ! -f "$backup" ]]; then
  echo "备份文件不存在：$backup" >&2
  exit 1
fi

ENV_FILE=${ENV_FILE:-.env.prod}
COMPOSE_FILE=${COMPOSE_FILE:-docker-compose.prod.yml}

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# 先停业务进程，避免恢复期间继续写入。
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" stop app

gunzip -c "$backup" | docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T db \
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" start app

echo "恢复完成：$backup"
