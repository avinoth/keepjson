CREATE TABLE bins (
  id             TEXT PRIMARY KEY,
  content        TEXT    NOT NULL,             -- raw JSON as received
  is_private     INTEGER NOT NULL DEFAULT 0,   -- 0/1
  write_key_hash TEXT    NOT NULL,             -- hex sha-256
  read_key_hash  TEXT,                         -- NULL unless private
  created_at     INTEGER NOT NULL,             -- unix ms
  updated_at     INTEGER NOT NULL,             -- unix ms
  expires_at     INTEGER                       -- unix ms, NULL = never
);
CREATE INDEX bins_expires_at ON bins (expires_at) WHERE expires_at IS NOT NULL;
