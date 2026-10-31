CREATE TABLE articles (
  knowledge_point_id text PRIMARY KEY REFERENCES knowledge_points (knowledge_point_id) ON DELETE CASCADE,
  markdown text NOT NULL CHECK (char_length(markdown) BETWEEN 1 AND 20000),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  published_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'published' OR published_at IS NOT NULL)
);

CREATE INDEX articles_published_idx ON articles (status, published_at DESC);

CREATE TABLE learning_progress (
  user_id text NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  knowledge_point_id text NOT NULL REFERENCES knowledge_points (knowledge_point_id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES devices (device_id) ON DELETE CASCADE,
  watched_sec integer NOT NULL DEFAULT 0 CHECK (watched_sec BETWEEN 0 AND 86400),
  completed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, knowledge_point_id)
);

CREATE INDEX learning_progress_point_idx ON learning_progress (knowledge_point_id);
