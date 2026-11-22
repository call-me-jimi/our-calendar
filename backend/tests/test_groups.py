import sqlite3
from datetime import timedelta

from fastapi.testclient import TestClient

from tests.conftest import BASE, add_group, add_user, login_as
from wannpassts.security import iso, now


def test_instance_admin_creates_group_and_becomes_its_admin(
    client: TestClient, db: sqlite3.Connection
) -> None:
    ivo = add_user(db, "i@example.com", "Ivo", admin=True)
    login_as(client, db, ivo)

    r = client.post("/api/groups", json={"name": "  Band  "})
    assert r.status_code == 201
    g = r.json()
    assert g["name"] == "Band"
    assert g["regions"] == ["DE-BE", "DE-BB"]
    assert g["role"] == "admin"
    assert g["is_member"] is True
    assert [(m["display_name"], m["role"]) for m in g["members"]] == [("Ivo", "admin")]


def test_list_shows_own_groups_for_members_and_all_for_instance_admin(
    client: TestClient, db: sqlite3.Connection
) -> None:
    anna = add_user(db, "a@example.com", "Anna")
    ivo = add_user(db, "i@example.com", "Ivo", admin=True)
    band = add_group(db, "Band", {anna: "member"})
    add_group(db, "Hiking", {})

    login_as(client, db, anna)
    assert [
        (g["name"], g["role"], g["member_count"]) for g in client.get("/api/groups").json()
    ] == [("Band", "member", 1)]

    login_as(client, db, ivo)
    groups = client.get("/api/groups").json()
    assert [(g["id"] == band, g["name"], g["role"], g["is_member"]) for g in groups] == [
        (True, "Band", "admin", False),
        (False, "Hiking", "admin", False),
    ]


def test_members_sorted_by_name(client: TestClient, db: sqlite3.Connection) -> None:
    zoe = add_user(db, "z@example.com", "zoe")
    ben = add_user(db, "b@example.com", "Ben")
    gid = add_group(db, "Band", {zoe: "admin", ben: "member"})
    login_as(client, db, zoe)
    names = [m["display_name"] for m in client.get(f"/api/groups/{gid}").json()["members"]]
    assert names == ["Ben", "zoe"]


def test_patch_name_and_regions(client: TestClient, db: sqlite3.Connection) -> None:
    ada = add_user(db, "a@example.com", "Ada")
    gid = add_group(db, "Band", {ada: "admin"})
    login_as(client, db, ada)

    r = client.patch(f"/api/groups/{gid}", json={"name": "The Band", "regions": ["DE-BB"]})
    assert r.json()["name"] == "The Band"
    assert r.json()["regions"] == ["DE-BB"]
    r = client.patch(f"/api/groups/{gid}", json={"regions": ["DE-BB", "DE-BE"]})
    assert r.json()["regions"] == ["DE-BE", "DE-BB"]
    assert client.patch(f"/api/groups/{gid}", json={"regions": []}).json()["regions"] == []

    assert client.patch(f"/api/groups/{gid}", json={"regions": ["DE-BY"]}).status_code == 422
    assert client.patch(f"/api/groups/{gid}", json={"name": "  "}).status_code == 422
    assert client.patch(f"/api/groups/{gid}", json={"name": "x" * 61}).status_code == 422


def test_last_admin_can_neither_step_down_nor_leave(
    client: TestClient, db: sqlite3.Connection
) -> None:
    ada = add_user(db, "a@example.com", "Ada")
    mia = add_user(db, "m@example.com", "Mia")
    gid = add_group(db, "Band", {ada: "admin", mia: "member"})
    login_as(client, db, ada)

    r = client.patch(f"/api/groups/{gid}/members/{ada}", json={"role": "member"})
    assert r.status_code == 409
    assert r.json() == {"error": "last_admin"}
    assert client.delete(f"/api/groups/{gid}/members/{ada}").status_code == 409

    assert (
        client.patch(f"/api/groups/{gid}/members/{mia}", json={"role": "admin"}).status_code == 200
    )
    assert client.delete(f"/api/groups/{gid}/members/{ada}").status_code == 204
    assert client.get(f"/api/groups/{gid}").status_code == 404


def test_role_patch_for_non_member_is_404(client: TestClient, db: sqlite3.Connection) -> None:
    ada = add_user(db, "a@example.com", "Ada")
    olga = add_user(db, "o@example.com", "Olga")
    gid = add_group(db, "Band", {ada: "admin"})
    login_as(client, db, ada)
    assert (
        client.patch(f"/api/groups/{gid}/members/{olga}", json={"role": "admin"}).status_code == 404
    )


def test_invites_create_list_revoke(client: TestClient, db: sqlite3.Connection) -> None:
    ada = add_user(db, "a@example.com", "Ada")
    gid = add_group(db, "Band", {ada: "admin"})
    login_as(client, db, ada)

    r = client.post(f"/api/groups/{gid}/invites")
    assert r.status_code == 201
    created = r.json()
    assert created["url"].startswith(f"{BASE}/join/")
    assert created["invite"]["use_count"] == 0
    assert created["invite"]["created_by_name"] == "Ada"
    expires = created["invite"]["expires_at"]
    assert iso(now() + timedelta(days=6)) < expires <= iso(now() + timedelta(days=7))

    second = client.post(f"/api/groups/{gid}/invites").json()["invite"]["id"]
    expired = client.post(f"/api/groups/{gid}/invites").json()["invite"]["id"]
    db.execute("UPDATE invites SET expires_at = ? WHERE id = ?", (iso(now()), expired))

    assert client.delete(f"/api/groups/{gid}/invites/{second}").status_code == 204
    assert client.delete(f"/api/groups/{gid}/invites/{second}").status_code == 404
    listed = client.get(f"/api/groups/{gid}/invites").json()
    assert [i["id"] for i in listed] == [created["invite"]["id"]]
    # The link stays copyable while it's valid; a revoked one forgets its token.
    assert listed[0]["url"] == created["url"] == created["invite"]["url"]
    q = "SELECT token FROM invites WHERE id = ?"
    assert db.execute(q, (second,)).fetchone()[0] is None


def test_invites_from_before_have_no_url(client: TestClient, db: sqlite3.Connection) -> None:
    ada = add_user(db, "a@example.com", "Ada")
    gid = add_group(db, "Band", {ada: "admin"})
    login_as(client, db, ada)
    client.post(f"/api/groups/{gid}/invites")
    db.execute("UPDATE invites SET token = NULL")
    assert client.get(f"/api/groups/{gid}/invites").json()[0]["url"] is None


def test_invite_of_another_group_cannot_be_revoked(
    client: TestClient, db: sqlite3.Connection
) -> None:
    ada = add_user(db, "a@example.com", "Ada")
    band = add_group(db, "Band", {ada: "admin"})
    other = add_group(db, "Other", {ada: "admin"})
    login_as(client, db, ada)
    inv = client.post(f"/api/groups/{other}/invites").json()["invite"]["id"]
    assert client.delete(f"/api/groups/{band}/invites/{inv}").status_code == 404


def test_delete_group_removes_memberships_and_invites(
    client: TestClient, db: sqlite3.Connection
) -> None:
    ivo = add_user(db, "i@example.com", "Ivo", admin=True)
    login_as(client, db, ivo)
    gid = client.post("/api/groups", json={"name": "Band"}).json()["id"]
    client.post(f"/api/groups/{gid}/invites")

    assert client.delete(f"/api/groups/{gid}").status_code == 204
    for table in ("groups", "memberships", "invites"):
        assert db.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == 0  # noqa: S608
    assert client.delete(f"/api/groups/{gid}").status_code == 404
