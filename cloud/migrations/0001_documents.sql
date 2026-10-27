-- Drawnix cloud document metadata.
-- Apply only to a dedicated Drawnix D1 database; never to nalan-work or nalan-mindmap.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '未命名画板',
  object_key TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL DEFAULT 1,
  payload_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_owner_updated
  ON documents(owner_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_documents_owner_id
  ON documents(owner_id, id);

-- Identity is derived only from a verified Cloudflare Access JWT at the API.
-- owner_id is never accepted as an authoritative value from the browser.
-- Every read, update, and delete query must include both document id and owner_id.
