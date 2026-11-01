#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# 非破坏性恢复演练：把备份导入独立演练库，不停止 app、不触碰业务库。
# 默认取 workspace/backups 下最新的 .sql.gz；DRILL_KEEP=1 保留演练库供排查。

if [[ $# -gt 1 ]]; then
  echo "用法：scripts/restore-drill.sh [backup.sql.gz]" >&2
  exit 1
fi

ENV_FILE=${ENV_FILE:-.env.prod}
COMPOSE_FILE=${COMPOSE_FILE:-docker-compose.prod.yml}
DRILL_DB=${DRILL_DB:-trend_coach_restore_drill}
DRILL_KEEP=${DRILL_KEEP:-0}

if [[ ! "$DRILL_DB" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "DRILL_DB 只允许字母、数字与下划线：$DRILL_DB" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "配置文件不存在：$ENV_FILE" >&2
  exit 1
fi

backup=${1:-}
if [[ -z "$backup" ]]; then
  backup=$(ls -1t workspace/backups/*.sql.gz 2>/dev/null | head -n 1 || true)
fi
if [[ -z "$backup" || ! -f "$backup" ]]; then
  echo "备份文件不存在：${backup:-<未找到 workspace/backups/*.sql.gz>}" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
psql_exec() {
  "${compose[@]}" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" "$@"
}

echo "演练库：${DRILL_DB}；备份：${backup}"
"${compose[@]}" up -d db >/dev/null

ready=0
for _ in $(seq 1 30); do
  if "${compose[@]}" exec -T db pg_isready -U "$POSTGRES_USER" -d postgres >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  echo "数据库未就绪，无法演练" >&2
  exit 1
fi

cleanup() {
  if [[ "$DRILL_KEEP" != 1 ]]; then
    psql_exec -d postgres -c "DROP DATABASE IF EXISTS \"$DRILL_DB\"" >/dev/null 2>&1 || true
    echo "已删除演练库（DRILL_KEEP=1 可保留）"
  else
    echo "保留演练库：${DRILL_DB}"
  fi
}
trap cleanup EXIT

psql_exec -d postgres -c "DROP DATABASE IF EXISTS \"$DRILL_DB\"" >/dev/null
psql_exec -d postgres -c "CREATE DATABASE \"$DRILL_DB\"" >/dev/null

echo "正在导入…"
gunzip -c "$backup" | psql_exec -d "$DRILL_DB" >/dev/null

missing=$(
  psql_exec -d "$DRILL_DB" -Atc "
    SELECT string_agg(name, ', ')
    FROM unnest(ARRAY['schema_migrations','users','courses','chapters','knowledge_points','segments'])
      AS name
    WHERE to_regclass('public.' || name) IS NULL
  "
)
if [[ -n "$missing" ]]; then
  echo "恢复校验失败，缺少核心表：$missing" >&2
  exit 1
fi

migrations=$(psql_exec -d "$DRILL_DB" -Atc "SELECT count(*) FROM schema_migrations")
if [[ "$migrations" -lt 1 ]]; then
  echo "恢复校验失败：schema_migrations 为空" >&2
  exit 1
fi

psql_exec -d "$DRILL_DB" -Atc "
  SELECT format(
    '迁移 %s 条；用户 %s；课程 %s（已发布 %s）；章节 %s；知识点 %s；片段 %s（已发布 %s）',
    (SELECT count(*) FROM schema_migrations),
    (SELECT count(*) FROM users),
    (SELECT count(*) FROM courses),
    (SELECT count(*) FROM courses WHERE status = 'published'),
    (SELECT count(*) FROM chapters),
    (SELECT count(*) FROM knowledge_points),
    (SELECT count(*) FROM segments),
    (SELECT count(*) FROM segments WHERE status = 'published')
  )
"

echo "恢复演练通过：备份可完整导入且核心表可查询。"
