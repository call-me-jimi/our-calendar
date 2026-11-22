-- P5: holidays, group events and iCal feed tokens (spec §3.8–3.10, §4).

CREATE TABLE holidays (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('public', 'school')),
    subdivision TEXT NOT NULL,  -- 'DE' for nationwide, else e.g. 'DE-BE'
    start_day TEXT NOT NULL,
    end_day TEXT NOT NULL CHECK (end_day >= start_day),
    name_de TEXT NOT NULL,
    name_en TEXT NOT NULL,
    source_id TEXT,
    UNIQUE (kind, subdivision, start_day, name_de)
);
CREATE INDEX holidays_range ON holidays (start_day, end_day);

CREATE TABLE holiday_syncs (
    id INTEGER PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    ok INTEGER NOT NULL DEFAULT 0,
    message TEXT
);

CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    group_id INTEGER NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
    start_day TEXT NOT NULL,
    end_day TEXT NOT NULL CHECK (end_day >= start_day),
    time_place TEXT CHECK (time_place IS NULL OR length(time_place) BETWEEN 1 AND 120),
    note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
    created_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
    updated_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX events_group_start ON events (group_id, start_day);

CREATE TABLE feed_tokens (
    token_hash TEXT PRIMARY KEY,  -- sha256 of the token in the URL
    group_id INTEGER NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    UNIQUE (group_id, user_id)
);
