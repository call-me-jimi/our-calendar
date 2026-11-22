"""SQLite connection and plain-SQL migrations (spec §4).

Migrations are files `NNN_name.sql` in `migrations/`, applied in order, each in its own
transaction, and recorded in `schema_version`.

Each request opens its own connection (cheap for SQLite); transactions are explicit.
"""

import re
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).parent / "migrations"
_NAME = re.compile(r"^(\d{3})_[a-z0-9_]+\.sql$")


def connect(path: Path) -> sqlite3.Connection:
    # Autocommit mode: transactions are explicit (see `transaction`).
    conn = sqlite3.connect(path, autocommit=True, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def open_db(path: Path) -> sqlite3.Connection:
    """Create the file if needed, switch it to WAL (persistent) and migrate."""
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = connect(path)
    conn.execute("PRAGMA journal_mode=WAL")
    migrate(conn)
    return conn


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[None]:
    # IMMEDIATE takes the write lock up front, so read-then-write can't interleave.
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")


def migrate(conn: sqlite3.Connection, migrations_dir: Path = MIGRATIONS_DIR) -> list[int]:
    """Apply pending migrations; return the versions applied."""
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_version ("
        " version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))"
    )
    done = {row[0] for row in conn.execute("SELECT version FROM schema_version")}
    files: list[tuple[int, Path]] = []
    for f in migrations_dir.glob("*.sql"):
        m = _NAME.match(f.name)
        if not m:
            raise ValueError(f"bad migration file name: {f.name}")
        files.append((int(m.group(1)), f))
    files.sort()
    versions = [v for v, _ in files]
    if len(versions) != len(set(versions)):
        raise ValueError("duplicate migration version")

    applied: list[int] = []
    for version, f in files:
        if version in done:
            continue
        with transaction(conn):
            for statement in _statements(f.read_text()):
                conn.execute(statement)
            conn.execute("INSERT INTO schema_version (version) VALUES (?)", (version,))
        applied.append(version)
    return applied


def _statements(sql: str) -> list[str]:
    """Split a script into statements (executescript would commit implicitly)."""
    out: list[str] = []
    buf = ""
    for line in sql.splitlines(keepends=True):
        buf += line
        if sqlite3.complete_statement(buf):
            if buf.strip():
                out.append(buf)
            buf = ""
    if buf.strip():
        out.append(buf)
    return out
