CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE external_identities (
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    PRIMARY KEY(issuer, subject)
);
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    credential_hash BYTEA UNIQUE NOT NULL CHECK(octet_length(credential_hash) = 32),
    account_id TEXT NOT NULL REFERENCES accounts(id),
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    CHECK(expires_at = created_at + interval '720 hours')
);
CREATE TABLE registered_servers (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES accounts(id),
    name TEXT NOT NULL,
    region TEXT NOT NULL,
    origin TEXT NOT NULL,
    candidate_origin TEXT NOT NULL DEFAULT '',
    public_key TEXT NOT NULL DEFAULT '',
    revision BIGINT NOT NULL DEFAULT 1,
    applied_revision BIGINT NOT NULL DEFAULT 0,
    operation_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','active','removed')),
    last_seen_at TIMESTAMPTZ,
    last_verified_at TIMESTAMPTZ,
    last_error TEXT NOT NULL DEFAULT '',
    compatible BOOLEAN NOT NULL DEFAULT FALSE,
    verified_contract TEXT NOT NULL DEFAULT '',
    transfer_to TEXT REFERENCES accounts(id),
    transfer_expires_at TIMESTAMPTZ,
    transfer_accepted BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE UNIQUE INDEX server_origin ON registered_servers(origin) WHERE status <> 'removed';
CREATE UNIQUE INDEX server_candidate_origin ON registered_servers(candidate_origin) WHERE candidate_origin <> '' AND status <> 'removed';
CREATE TABLE pairing_codes (
    credential_hash BYTEA PRIMARY KEY CHECK(octet_length(credential_hash)=32),
    server_id TEXT NOT NULL REFERENCES registered_servers(id),
    expires_at TIMESTAMPTZ NOT NULL,
    claimed_key TEXT NOT NULL DEFAULT '',
    nonce_key TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX one_pairing_code ON pairing_codes(server_id);
CREATE TABLE registry_nonces (
    nonce TEXT PRIMARY KEY,
    public_key TEXT NOT NULL,
    server_id TEXT NOT NULL REFERENCES registered_servers(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK(purpose IN ('claim','heartbeat','ack','publication')),
    request_id TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    UNIQUE(public_key,request_id)
);
CREATE INDEX registry_nonces_server ON registry_nonces(server_id);
CREATE INDEX registry_nonces_expiry ON registry_nonces(expires_at);
CREATE INDEX registry_nonces_live_server ON registry_nonces(server_id) WHERE consumed_at IS NULL;
CREATE INDEX registry_nonces_live_key ON registry_nonces(public_key) WHERE consumed_at IS NULL;
CREATE TABLE registry_events (
    id BIGSERIAL PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES registered_servers(id),
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    revision BIGINT NOT NULL
);
CREATE TABLE oidc_flows (
    state_hash BYTEA PRIMARY KEY CHECK(octet_length(state_hash)=32),
    browser_hash BYTEA NOT NULL CHECK(octet_length(browser_hash)=32),
    verifier TEXT NOT NULL,
    nonce TEXT NOT NULL,
    return_path TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX oidc_flows_expiry ON oidc_flows(expires_at);
CREATE INDEX sessions_account ON sessions(account_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);
