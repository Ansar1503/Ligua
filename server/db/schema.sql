-- PostgreSQL schema. The application also initializes this schema on startup.
CREATE TABLE IF NOT EXISTS transcriptions (
  id BIGSERIAL PRIMARY KEY,
  title VARCHAR(160) NOT NULL,
  content TEXT NOT NULL,
  language VARCHAR(40) NOT NULL DEFAULT 'auto',
  duration_seconds NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  word_count INTEGER NOT NULL DEFAULT 0 CHECK (word_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_transcriptions_created_at ON transcriptions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transcriptions_title ON transcriptions (title);
