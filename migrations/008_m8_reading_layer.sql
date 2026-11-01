-- M8 阅读层：章节教材取代知识点文章，新增图示（关键帧/文生图）与图片模型配置。
-- 旧 articles 表保留只读，不再由新管线写入。

CREATE TABLE chapter_articles (
  course_id text NOT NULL,
  chapter_id text NOT NULL,
  markdown text NOT NULL CHECK (char_length(markdown) BETWEEN 1 AND 20000),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  published_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (course_id, chapter_id),
  FOREIGN KEY (course_id, chapter_id) REFERENCES chapters (course_id, chapter_id) ON DELETE CASCADE,
  CHECK (status <> 'published' OR published_at IS NOT NULL)
);

CREATE INDEX chapter_articles_published_idx ON chapter_articles (status, published_at DESC);

CREATE TABLE figures (
  figure_id text PRIMARY KEY CHECK (figure_id ~ '^fig_[A-Za-z0-9._-]{1,60}$'),
  course_id text NOT NULL,
  chapter_id text NOT NULL,
  asset_id text REFERENCES media_assets (asset_id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('keyframe', 'generated')),
  caption text NOT NULL CHECK (char_length(caption) BETWEEN 1 AND 200),
  prompt text CHECK (prompt IS NULL OR char_length(prompt) <= 2000),
  model text CHECK (model IS NULL OR char_length(model) <= 200),
  seed bigint,
  selected_candidate_id text,
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'rendering', 'ready', 'failed', 'published')),
  review_reasons jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(review_reasons) = 'array'),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (course_id, chapter_id) REFERENCES chapters (course_id, chapter_id) ON DELETE CASCADE,
  CHECK (status <> 'published' OR published_at IS NOT NULL),
  CHECK (status <> 'published' OR selected_candidate_id IS NOT NULL)
);

CREATE INDEX figures_chapter_idx ON figures (course_id, chapter_id, created_at);
CREATE INDEX figures_published_idx ON figures (status, published_at DESC);

CREATE TABLE figure_candidates (
  candidate_id text PRIMARY KEY CHECK (candidate_id ~ '^cand_[A-Za-z0-9._-]{1,59}$'),
  figure_id text NOT NULL REFERENCES figures (figure_id) ON DELETE CASCADE,
  rel_path text NOT NULL UNIQUE CHECK (rel_path ~ '^fig_[A-Za-z0-9._-]+/cand_[A-Za-z0-9._-]+\.(jpg|png)$'),
  width integer NOT NULL CHECK (width >= 800),
  height integer NOT NULL CHECK (height >= 800),
  bytes bigint NOT NULL CHECK (bytes > 0 AND bytes <= 8388608),
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  source_sec integer CHECK (source_sec IS NULL OR source_sec >= 0),
  status text NOT NULL DEFAULT 'rendering' CHECK (status IN ('rendering', 'ready', 'failed')),
  error_code text CHECK (error_code IS NULL OR char_length(error_code) <= 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX figure_candidates_figure_idx ON figure_candidates (figure_id, created_at);

ALTER TABLE figures
  ADD CONSTRAINT figures_selected_candidate_fk
  FOREIGN KEY (selected_candidate_id) REFERENCES figure_candidates (candidate_id) ON DELETE SET NULL;

-- 文生图模型用途与单张价格（micros，默认 ¥0.12）。
ALTER TABLE llm_configs DROP CONSTRAINT llm_configs_purpose_check;
ALTER TABLE llm_configs ADD CONSTRAINT llm_configs_purpose_check
  CHECK (purpose IN ('content', 'embedding', 'image'));
ALTER TABLE llm_configs
  ADD COLUMN image_price_micros integer NOT NULL DEFAULT 120000
    CHECK (image_price_micros >= 0);

ALTER TABLE ai_usage_events
  ADD COLUMN images integer NOT NULL DEFAULT 0 CHECK (images >= 0);

-- 图示任务与阶段。
ALTER TABLE pipeline_jobs DROP CONSTRAINT pipeline_jobs_kind_check;
ALTER TABLE pipeline_jobs ADD CONSTRAINT pipeline_jobs_kind_check
  CHECK (kind IN ('ingest', 'generate', 'illustrate'));
ALTER TABLE pipeline_jobs DROP CONSTRAINT pipeline_jobs_stage_check;
ALTER TABLE pipeline_jobs ADD CONSTRAINT pipeline_jobs_stage_check
  CHECK (stage IN ('queued', 'probe', 'transcode', 'transcribe', 'structure', 'generate',
                   'figure_plan', 'figure_render', 'finalize', 'done'));

ALTER TABLE content_generations
  ADD COLUMN chapter_articles integer NOT NULL DEFAULT 0 CHECK (chapter_articles >= 0),
  ADD COLUMN figures integer NOT NULL DEFAULT 0 CHECK (figures >= 0);
