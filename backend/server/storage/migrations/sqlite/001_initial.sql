CREATE TABLE rooms (
    id TEXT PRIMARY KEY,
    configuration TEXT NOT NULL CHECK(json_valid(configuration)),
    actor TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE roles (
    account_id TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK(role IN ('admin', 'moderator', 'player')),
    actor TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE sanctions (
    id TEXT PRIMARY KEY,
    identity_kind TEXT NOT NULL CHECK(identity_kind IN ('account', 'guest')),
    identity_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at INTEGER,
    revoked_by TEXT,
    revocation_reason TEXT,
    CHECK(expires_at IS NULL OR expires_at > created_at)
);
CREATE INDEX sanctions_target ON sanctions(identity_kind, identity_id);
CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    target TEXT NOT NULL,
    action TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    details TEXT NOT NULL CHECK(json_valid(details))
);
CREATE INDEX events_expiry ON events(created_at);
CREATE TABLE association (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    central TEXT NOT NULL,
    private_key BLOB NOT NULL,
    pending_key BLOB,
    pairing_code TEXT NOT NULL DEFAULT '',
    last_pairing_hash TEXT NOT NULL DEFAULT '',
    server_id TEXT NOT NULL DEFAULT '',
    owner_id TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 0,
    descriptor TEXT NOT NULL DEFAULT '{}',
    removed INTEGER NOT NULL DEFAULT 0
);
