-- 门户账号与 AI 运营：会话来源、用量账本、运行链路、任务级模型绑定与健康。
-- 学员门户与后台共用 sessions，但 scope 记录来源；学员只允许门户接口。

ALTER TABLE sessions ADD COLUMN scope text NOT NULL DEFAULT 'console'
  CHECK (scope IN ('console', 'portal'));
CREATE INDEX sessions_scope_idx ON sessions (scope, user_id, expires_at);

-- 价格用于后台估算成本；未配置时按“未知”展示，不做猜测。
ALTER TABLE llm_configs
  ADD COLUMN input_price_micros_per_1k integer
    CHECK (input_price_micros_per_1k IS NULL OR input_price_micros_per_1k >= 0),
  ADD COLUMN output_price_micros_per_1k integer
    CHECK (output_price_micros_per_1k IS NULL OR output_price_micros_per_1k >= 0);

CREATE TABLE ai_runs (
  run_id uuid PRIMARY KEY,
  task_key text NOT NULL CHECK (char_length(task_key) BETWEEN 1 AND 64),
  source text NOT NULL CHECK (source IN ('pipeline', 'admin')),
  source_id text CHECK (source_id IS NULL OR char_length(source_id) <= 200),
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  primary_config_id text REFERENCES llm_configs (config_id) ON DELETE SET NULL,
  fallback_used boolean NOT NULL DEFAULT false,
  step_seq integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error_code text CHECK (error_code IS NULL OR char_length(error_code) <= 64),
  summary jsonb
);

CREATE INDEX ai_runs_started_idx ON ai_runs (started_at DESC);
CREATE INDEX ai_runs_task_idx ON ai_runs (task_key, started_at DESC);

CREATE TABLE ai_usage_events (
  usage_id bigserial PRIMARY KEY,
  run_id uuid REFERENCES ai_runs (run_id) ON DELETE SET NULL,
  task_key text NOT NULL CHECK (char_length(task_key) BETWEEN 1 AND 64),
  provider text CHECK (provider IS NULL OR char_length(provider) <= 32),
  model text CHECK (model IS NULL OR char_length(model) <= 200),
  config_id text REFERENCES llm_configs (config_id) ON DELETE SET NULL,
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cached_tokens integer NOT NULL DEFAULT 0 CHECK (cached_tokens >= 0),
  audio_seconds numeric(10, 3) NOT NULL DEFAULT 0 CHECK (audio_seconds >= 0),
  characters integer NOT NULL DEFAULT 0 CHECK (characters >= 0),
  latency_ms integer NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  status text NOT NULL CHECK (status IN ('success', 'error', 'fallback')),
  error_code text CHECK (error_code IS NULL OR char_length(error_code) <= 64),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_usage_created_idx ON ai_usage_events (created_at DESC);
CREATE INDEX ai_usage_task_idx ON ai_usage_events (task_key, created_at DESC);
CREATE INDEX ai_usage_config_idx ON ai_usage_events (config_id, created_at DESC);

CREATE TABLE ai_run_steps (
  step_id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES ai_runs (run_id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq >= 0),
  task_key text NOT NULL CHECK (char_length(task_key) BETWEEN 1 AND 64),
  config_id text REFERENCES llm_configs (config_id) ON DELETE SET NULL,
  provider text CHECK (provider IS NULL OR char_length(provider) <= 32),
  model text CHECK (model IS NULL OR char_length(model) <= 200),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  status text NOT NULL CHECK (status IN ('success', 'error')),
  latency_ms integer NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  usage_id bigint REFERENCES ai_usage_events (usage_id) ON DELETE SET NULL,
  error_code text CHECK (error_code IS NULL OR char_length(error_code) <= 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);

CREATE TABLE llm_task_bindings (
  task_key text PRIMARY KEY CHECK (char_length(task_key) BETWEEN 1 AND 64),
  primary_config_id text NOT NULL REFERENCES llm_configs (config_id) ON DELETE CASCADE,
  fallback_config_id text REFERENCES llm_configs (config_id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (fallback_config_id IS NULL OR fallback_config_id <> primary_config_id)
);

CREATE TABLE llm_config_health (
  config_id text PRIMARY KEY REFERENCES llm_configs (config_id) ON DELETE CASCADE,
  consecutive_failures integer NOT NULL DEFAULT 0,
  cooldown_until timestamptz,
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  last_failure_at timestamptz,
  last_success_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
