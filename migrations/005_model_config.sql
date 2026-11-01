-- 模型接入配置：管理端维护，密钥加密落库；运行时按当前配置解析，不读环境变量。

CREATE TABLE llm_configs (
  config_id text PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  provider text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 32),
  protocol text NOT NULL DEFAULT 'openai' CHECK (protocol IN ('openai')),
  base_url text NOT NULL CHECK (char_length(base_url) BETWEEN 1 AND 500),
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 200),
  api_key_encrypted text,
  purpose text NOT NULL CHECK (purpose IN ('content', 'embedding')),
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  last_tested_at timestamptz,
  last_test_status text CHECK (last_test_status IN ('success', 'failed')),
  last_test_error text CHECK (last_test_error IS NULL OR char_length(last_test_error) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX llm_configs_default_idx
  ON llm_configs (purpose) WHERE is_default AND is_active;
CREATE INDEX llm_configs_purpose_active_idx ON llm_configs (purpose, is_active);

CREATE TABLE asr_config (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  provider text NOT NULL DEFAULT 'minimax' CHECK (char_length(provider) BETWEEN 1 AND 32),
  protocol text NOT NULL DEFAULT 'minimax' CHECK (protocol IN ('minimax', 'openai')),
  base_url text NOT NULL DEFAULT 'https://api.minimaxi.com'
    CHECK (char_length(base_url) BETWEEN 1 AND 500),
  model text NOT NULL DEFAULT 'asr-1.0' CHECK (char_length(model) BETWEEN 1 AND 200),
  api_key_encrypted text,
  enabled boolean NOT NULL DEFAULT false,
  last_tested_at timestamptz,
  last_test_status text CHECK (last_test_status IN ('success', 'failed')),
  last_test_error text CHECK (last_test_error IS NULL OR char_length(last_test_error) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
