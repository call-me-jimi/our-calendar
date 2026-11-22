import sqlite3
from pathlib import Path

import pytest

from ourcalendar.db import MIGRATIONS_DIR, connect, migrate, open_db


def write(d: Path, name: str, sql: str) -> None:
    (d / name).write_text(sql)


def test_applies_in_order_and_is_idempotent(tmp_path: Path) -> None:
    mig = tmp_path / "mig"
    mig.mkdir()
    write(mig, "002_b.sql", "INSERT INTO t (x) VALUES ('two');")
    write(mig, "001_a.sql", "CREATE TABLE t (x TEXT);\nINSERT INTO t (x) VALUES ('one');")
    conn = connect(tmp_path / "app.db")

    assert migrate(conn, mig) == [1, 2]
    assert migrate(conn, mig) == []
    assert [r[0] for r in conn.execute("SELECT x FROM t ORDER BY rowid")] == ["one", "two"]


def test_failed_migration_rolls_back(tmp_path: Path) -> None:
    mig = tmp_path / "mig"
    mig.mkdir()
    write(mig, "001_a.sql", "CREATE TABLE t (x TEXT);\nINSERT INTO nope VALUES (1);")
    conn = connect(tmp_path / "app.db")

    with pytest.raises(sqlite3.OperationalError):
        migrate(conn, mig)
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "t" not in tables
    assert conn.execute("SELECT count(*) FROM schema_version").fetchone()[0] == 0


def test_rejects_bad_file_name(tmp_path: Path) -> None:
    mig = tmp_path / "mig"
    mig.mkdir()
    write(mig, "1_a.sql", "SELECT 1;")
    with pytest.raises(ValueError, match="bad migration file name"):
        migrate(connect(tmp_path / "app.db"), mig)


def test_real_migrations_apply_to_empty_db(tmp_path: Path) -> None:
    conn = connect(tmp_path / "app.db")
    migrate(conn, MIGRATIONS_DIR)
    assert migrate(conn, MIGRATIONS_DIR) == []


def test_pragmas(tmp_path: Path) -> None:
    conn = open_db(tmp_path / "sub" / "app.db")
    assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
