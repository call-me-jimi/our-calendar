-- P2: groups, memberships, invite links (spec §3.2, §3.3, §4).

CREATE TABLE groups (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    -- Holiday regions shown in this group, comma-separated (spec §3.8).
    regions TEXT NOT NULL DEFAULT 'DE-BE,DE-BB',
    created_at TEXT NOT NULL
);

CREATE TABLE memberships (
    group_id INTEGER NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('member', 'admin')),
    joined_at TEXT NOT NULL,
    PRIMARY KEY (group_id, user_id)
);
CREATE INDEX memberships_user ON memberships (user_id);

CREATE TABLE invites (
    id INTEGER PRIMARY KEY,
    group_id INTEGER NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    use_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX invites_group ON invites (group_id);

ALTER TABLE login_tokens ADD COLUMN invite_id INTEGER REFERENCES invites (id) ON DELETE CASCADE;
