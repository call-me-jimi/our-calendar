-- P3: availability per user and day (spec §3.4, §4). `free` = no row.
-- Range reads go memberships -> (user_id, day) primary key, so no extra index is needed.

CREATE TABLE day_marks (
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    day TEXT NOT NULL,  -- 'YYYY-MM-DD'
    state TEXT NOT NULL CHECK (state IN ('busy', 'maybe')),
    note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 80),
    set_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, day)
);
