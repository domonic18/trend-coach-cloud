-- 内容 LLM 增加 Anthropic Messages 协议；embedding 仍只走 OpenAI 兼容 /embeddings。

ALTER TABLE llm_configs DROP CONSTRAINT llm_configs_protocol_check;
ALTER TABLE llm_configs ADD CONSTRAINT llm_configs_protocol_check
  CHECK (protocol IN ('openai', 'anthropic'));
