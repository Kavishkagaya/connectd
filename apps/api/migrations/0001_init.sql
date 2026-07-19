-- Global index only: metadata for listing/dashboard queries.
-- Never holds tokens or secrets — those live encrypted in the DOs.

CREATE TABLE connections (
  do_name    TEXT PRIMARY KEY,   -- 'team:provider:tenant', same string fed to idFromName()
  team_id    TEXT NOT NULL,
  provider   TEXT NOT NULL,
  tenant_id  TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active', -- active | revoked | needs_reauth
  scopes     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_connections_team ON connections (team_id);

CREATE TABLE api_keys (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL,
  key_hash    TEXT NOT NULL UNIQUE, -- sha-256 hex of the raw sk_... key, never the raw key
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);

CREATE INDEX idx_api_keys_team ON api_keys (team_id);
