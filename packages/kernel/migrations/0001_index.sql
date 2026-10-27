-- The connection index (#26): a copy for listing, search and lookup by external id.
-- The ConnectionDO is the source of truth; nothing secret is copied here.

CREATE TABLE connections (
  def        TEXT NOT NULL,
  id         TEXT NOT NULL,
  state      TEXT NOT NULL,              -- pending | active | reauth_required | revoked
  reason     TEXT,
  external   TEXT NOT NULL DEFAULT '{}', -- JSON object; the same pairs as connection_external
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version    INTEGER NOT NULL,           -- the DO's store version; an older write never wins
  PRIMARY KEY (def, id)
) WITHOUT ROWID;

CREATE INDEX connections_state ON connections (state, def, id);

-- External ids (Slack teamId, GitHub id, Google sub), one row per pair: webhooks look up by these.
CREATE TABLE connection_external (
  def   TEXT NOT NULL,
  key   TEXT NOT NULL,
  value TEXT NOT NULL,
  id    TEXT NOT NULL,
  PRIMARY KEY (def, key, value, id)
) WITHOUT ROWID;

CREATE INDEX connection_external_conn ON connection_external (def, id);
