-- P1: identity (spec §3.1, §4). Timestamps are UTC ISO-8601 text ('…+00:00').

CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 40),
    locale TEXT NOT NULL DEFAULT 'de' CHECK (locale IN ('de', 'en')),
    is_instance_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_instance_admin IN (0, 1)),
    availability_updated_at TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    user_agent TEXT
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE login_tokens (
    id INTEGER PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('login', 'join')),
    display_name TEXT,
    locale TEXT NOT NULL CHECK (locale IN ('de', 'en')),
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE rate_events (
    key TEXT NOT NULL,
    at TEXT NOT NULL
);
CREATE INDEX rate_events_key_at ON rate_events (key, at);
