-- Access (#86): the deployment's keys, dashboard accounts and their passkeys, one-time values.

-- API keys (value: the secret's SHA-256) and events signing secrets (value: sealed).
CREATE TABLE keys (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,          -- api | events
  name           TEXT NOT NULL,
  value          TEXT NOT NULL,
  previous       TEXT,                   -- the value before the last roll
  previous_until INTEGER,                -- valid until then
  created_at     INTEGER NOT NULL,
  rolled_at      INTEGER,
  revoked_at     INTEGER,
  last_used_at   INTEGER
) WITHOUT ROWID;

CREATE TABLE accounts (
  username   TEXT PRIMARY KEY,
  password   TEXT,                       -- PBKDF2 hash, or null: passkeys only
  sessions   INTEGER NOT NULL DEFAULT 0, -- bumped to sign out everywhere
  created_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE passkeys (
  id           TEXT PRIMARY KEY,         -- WebAuthn credential id, base64url
  username     TEXT NOT NULL,
  public_key   TEXT NOT NULL,            -- SPKI DER, base64url
  alg          INTEGER NOT NULL,
  counter      INTEGER NOT NULL,
  name         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
) WITHOUT ROWID;

CREATE INDEX passkeys_username ON passkeys (username, created_at);

CREATE TABLE nonces (
  nonce      TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX nonces_expiry ON nonces (expires_at);
