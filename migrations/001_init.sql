CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE courses (
  course_id text PRIMARY KEY CHECK (course_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chapters (
  course_id text NOT NULL REFERENCES courses (course_id) ON DELETE CASCADE,
  chapter_id text NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (course_id, chapter_id)
);

CREATE TABLE knowledge_points (
  knowledge_point_id text PRIMARY KEY,
  course_id text NOT NULL,
  chapter_id text NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (course_id, chapter_id) REFERENCES chapters (course_id, chapter_id) ON DELETE CASCADE
);

CREATE TABLE segments (
  segment_id text PRIMARY KEY CHECK (segment_id ~ '^seg-[A-Za-z0-9._-]{1,76}$'),
  course_id text NOT NULL,
  chapter_id text NOT NULL,
  knowledge_point_id text NOT NULL REFERENCES knowledge_points (knowledge_point_id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  start_sec integer NOT NULL CHECK (start_sec >= 0),
  end_sec integer NOT NULL,
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 4000),
  embedding halfvec(1024),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (start_sec < end_sec),
  FOREIGN KEY (course_id, chapter_id) REFERENCES chapters (course_id, chapter_id) ON DELETE CASCADE
);

CREATE INDEX segments_status_course_idx ON segments (status, course_id);
CREATE INDEX segments_title_trgm_idx ON segments USING gin (title gin_trgm_ops);
CREATE INDEX segments_text_trgm_idx ON segments USING gin (text gin_trgm_ops);
CREATE INDEX segments_embedding_idx ON segments USING hnsw (embedding halfvec_cosine_ops);

CREATE TABLE media_assets (
  asset_id text PRIMARY KEY,
  course_id text NOT NULL REFERENCES courses (course_id) ON DELETE CASCADE,
  hls_path text NOT NULL UNIQUE,
  encryption text NOT NULL DEFAULT 'aes-128' CHECK (encryption IN ('aes-128', 'private', 'none')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  user_id text PRIMARY KEY,
  display_name text CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  events_consent boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz
);

CREATE TABLE devices (
  device_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  first_authorized_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tokens (
  token_hash text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('access', 'refresh')),
  device_id text NOT NULL REFERENCES devices (device_id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  rotated_from text REFERENCES tokens (token_hash),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tokens_device_idx ON tokens (device_id, kind);

CREATE TABLE device_codes (
  device_code_hash text PRIMARY KEY,
  user_code text NOT NULL UNIQUE,
  device_id text NOT NULL,
  user_id text REFERENCES users (user_id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX device_codes_expiry_idx ON device_codes (expires_at);

CREATE TABLE playback_sessions (
  session_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES devices (device_id) ON DELETE CASCADE,
  segment_id text NOT NULL REFERENCES segments (segment_id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX playback_sessions_device_idx ON playback_sessions (device_id, expires_at);

CREATE TABLE events (
  event_id text PRIMARY KEY CHECK (char_length(event_id) BETWEEN 8 AND 64),
  event_name text NOT NULL,
  user_id text NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  device_id_hash text NOT NULL,
  props jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX events_user_idx ON events (user_id, received_at DESC);
