-- M8 图示任务：illustrate 以课程为单位，不绑定 asset；并给用量事件补 course_id 用于单课预算。

ALTER TABLE pipeline_jobs ALTER COLUMN asset_id DROP NOT NULL;

-- 单课同时只允许一个进行中的图示任务；NULL asset_id 不会命中旧的 (asset_id, kind) 唯一索引。
CREATE UNIQUE INDEX pipeline_jobs_illustrate_active_idx
  ON pipeline_jobs (course_id) WHERE kind = 'illustrate' AND status IN ('queued', 'running');

ALTER TABLE ai_usage_events
  ADD COLUMN course_id text REFERENCES courses (course_id) ON DELETE SET NULL;

CREATE INDEX ai_usage_course_idx ON ai_usage_events (course_id, created_at DESC);
