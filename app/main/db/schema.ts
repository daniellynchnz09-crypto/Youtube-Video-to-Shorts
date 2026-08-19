export const SCHEMA_VERSION = 1

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clips (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  start_time REAL NOT NULL,
  end_time REAL NOT NULL,
  words_json TEXT NOT NULL,
  render_status TEXT NOT NULL,
  review_status TEXT NOT NULL,
  file_path TEXT,
  thumbnail_path TEXT
);

CREATE TABLE IF NOT EXISTS dictionary_terms (
  id TEXT PRIMARY KEY,
  misheard TEXT NOT NULL,
  correct TEXT NOT NULL,
  context_notes TEXT
);
`
