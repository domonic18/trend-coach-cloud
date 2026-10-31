ALTER TABLE users ADD COLUMN username text;
ALTER TABLE users ADD COLUMN role text NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'operator', 'admin'));
ALTER TABLE users ADD COLUMN password_hash text;
ALTER TABLE users ADD COLUMN password_updated_at timestamptz;
ALTER TABLE users ADD CONSTRAINT users_username_format CHECK (
  username IS NULL OR username ~ '^[a-z][a-z0-9._-]{2,31}$'
);
CREATE UNIQUE INDEX users_username_key ON users (username);
CREATE INDEX users_role_status_idx ON users (role, status);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_idx ON sessions (user_id, expires_at);

CREATE TABLE invite_codes (
  code_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_by text REFERENCES users (user_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX invite_codes_user_idx ON invite_codes (user_id, expires_at) WHERE consumed_at IS NULL;
