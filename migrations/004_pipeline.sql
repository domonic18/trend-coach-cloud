ALTER TABLE media_assets ALTER COLUMN hls_path DROP NOT NULL;
ALTER TABLE media_assets ADD COLUMN title text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 200);
ALTER TABLE media_assets ADD COLUMN status text NOT NULL DEFAULT 'ready'
  CHECK (status IN ('awaiting_upload', 'uploaded', 'processing', 'ready', 'failed', 'archived'));
ALTER TABLE media_assets ADD COLUMN source_rel_path text;
ALTER TABLE media_assets ADD COLUMN source_size_bytes bigint CHECK (source_size_bytes IS NULL OR source_size_bytes >= 0);
ALTER TABLE media_assets ADD COLUMN source_sha256 text CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE media_assets ADD COLUMN duration_ms bigint CHECK (duration_ms IS NULL OR duration_ms >= 0);
ALTER TABLE media_assets ADD COLUMN error_code text CHECK (error_code IS NULL OR char_length(error_code) <= 64);
ALTER TABLE media_assets ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX media_assets_course_status_idx ON media_assets (course_id, status, created_at DESC);

CREATE TABLE pipeline_jobs (
  job_id text PRIMARY KEY CHECK (job_id ~ '^job_[0-9a-f]{16}$'),
  asset_id text NOT NULL REFERENCES media_assets (asset_id) ON DELETE CASCADE,
  course_id text NOT NULL REFERENCES courses (course_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('ingest', 'generate')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  stage text NOT NULL DEFAULT 'queued'
    CHECK (stage IN ('queued', 'probe', 'transcode', 'transcribe', 'structure', 'generate', 'finalize', 'done')),
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  heartbeat_at timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false,
  error_code text CHECK (error_code IS NULL OR char_length(error_code) <= 64),
  options jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(options) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE UNIQUE INDEX pipeline_jobs_active_idx
  ON pipeline_jobs (asset_id, kind) WHERE status IN ('queued', 'running');
CREATE INDEX pipeline_jobs_claim_idx ON pipeline_jobs (status, run_after, created_at);
CREATE INDEX pipeline_jobs_asset_idx ON pipeline_jobs (asset_id, created_at DESC);

CREATE TABLE media_transcripts (
  transcript_id text PRIMARY KEY CHECK (transcript_id ~ '^tr_[0-9a-f]{16}$'),
  asset_id text NOT NULL UNIQUE REFERENCES media_assets (asset_id) ON DELETE CASCADE,
  job_id text REFERENCES pipeline_jobs (job_id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  language text NOT NULL DEFAULT 'auto' CHECK (language IN ('zh', 'en', 'auto')),
  model text NOT NULL,
  duration_ms bigint CHECK (duration_ms IS NULL OR duration_ms >= 0),
  chunk_count integer NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  segment_count integer NOT NULL DEFAULT 0 CHECK (segment_count >= 0),
  error_code text CHECK (error_code IS NULL OR char_length(error_code) <= 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE transcript_chunks (
  chunk_id text PRIMARY KEY CHECK (chunk_id ~ '^chunk_[0-9a-f]{16}$'),
  transcript_id text NOT NULL REFERENCES media_transcripts (transcript_id) ON DELETE CASCADE,
  idx integer NOT NULL CHECK (idx >= 0),
  start_ms bigint NOT NULL CHECK (start_ms >= 0),
  end_ms bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  sentences jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sentences) = 'array'),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  error_code text CHECK (error_code IS NULL OR char_length(error_code) <= 64),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transcript_id, idx),
  UNIQUE (transcript_id, start_ms, end_ms),
  CHECK (start_ms < end_ms)
);

CREATE TABLE transcript_segments (
  transcript_id text NOT NULL REFERENCES media_transcripts (transcript_id) ON DELETE CASCADE,
  idx integer NOT NULL CHECK (idx >= 0),
  start_ms bigint NOT NULL CHECK (start_ms >= 0),
  end_ms bigint NOT NULL,
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 4000),
  PRIMARY KEY (transcript_id, idx),
  CHECK (start_ms < end_ms)
);

CREATE INDEX transcript_segments_start_idx ON transcript_segments (transcript_id, start_ms);

CREATE TABLE content_generations (
  generation_id text PRIMARY KEY CHECK (generation_id ~ '^gen_[0-9a-f]{16}$'),
  asset_id text NOT NULL REFERENCES media_assets (asset_id) ON DELETE CASCADE,
  transcript_id text NOT NULL REFERENCES media_transcripts (transcript_id) ON DELETE CASCADE,
  course_id text NOT NULL REFERENCES courses (course_id) ON DELETE CASCADE,
  job_id text REFERENCES pipeline_jobs (job_id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'applied', 'discarded', 'failed')),
  prompt_version text NOT NULL CHECK (char_length(prompt_version) BETWEEN 1 AND 32),
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 200),
  chapters integer NOT NULL DEFAULT 0 CHECK (chapters >= 0),
  knowledge_points integer NOT NULL DEFAULT 0 CHECK (knowledge_points >= 0),
  segments integer NOT NULL DEFAULT 0 CHECK (segments >= 0),
  needs_review integer NOT NULL DEFAULT 0 CHECK (needs_review >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  applied_content jsonb CHECK (applied_content IS NULL OR jsonb_typeof(applied_content) = 'object'),
  error_code text CHECK (error_code IS NULL OR char_length(error_code) <= 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz
);

CREATE UNIQUE INDEX content_generations_active_idx
  ON content_generations (asset_id) WHERE status = 'draft';
CREATE INDEX content_generations_course_idx ON content_generations (course_id, created_at DESC);
