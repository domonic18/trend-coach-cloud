-- M5.2 随堂测验：每章一份题库，制作阶段一次写入，课堂只读已发布版本。

CREATE TABLE chapter_quizzes (
  course_id text NOT NULL,
  chapter_id text NOT NULL,
  questions jsonb NOT NULL
    CHECK (jsonb_typeof(questions) = 'array'
      AND jsonb_array_length(questions) BETWEEN 1 AND 5),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  published_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (course_id, chapter_id),
  FOREIGN KEY (course_id, chapter_id) REFERENCES chapters (course_id, chapter_id) ON DELETE CASCADE,
  CHECK (status <> 'published' OR published_at IS NOT NULL),
  CHECK (status <> 'published' OR jsonb_array_length(questions) BETWEEN 3 AND 5)
);

CREATE INDEX chapter_quizzes_published_idx ON chapter_quizzes (status, published_at DESC);
