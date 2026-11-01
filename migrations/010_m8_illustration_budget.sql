-- 图片预算按生成时单价落库，避免单价调整或配置删除后历史成本漂移。
ALTER TABLE ai_usage_events
  ADD COLUMN cost_micros bigint NOT NULL DEFAULT 0 CHECK (cost_micros >= 0);

-- 关键帧图示需要保留来源时间点，applied 之后仍可重新渲染。
ALTER TABLE figures
  ADD COLUMN source_sec integer CHECK (source_sec IS NULL OR source_sec >= 0);
