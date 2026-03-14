CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY,
  sort_index INTEGER NOT NULL,
  name TEXT NOT NULL,
  backend_type TEXT NOT NULL CHECK (backend_type IN ('qbit', 'trans')),
  base_url TEXT NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  password TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_servers_sort_index ON servers(sort_index);
