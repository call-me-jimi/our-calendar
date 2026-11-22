"""hetzner.py: `make server-create` makes what's missing, never a second server, and refuses
a server type Hetzner no longer offers."""

import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import hetzner

LIVE_RULES: list[dict[str, Any]] = [  # as the API returns them: extra fields, its own order
    {"description": None, "direction": "in", "port": p, "protocol": proto,
     "destination_ips": [], "source_ips": ["::/0", "0.0.0.0/0"]}
    for proto, p in [("icmp", None), ("tcp", "22"), ("tcp", "80"), ("tcp", "443"),
                     ("udp", "443")]
]  # fmt: skip


def stype(name: str, gross: str, location: str = "nbg1", **extra: Any) -> dict[str, Any]:
    t: dict[str, Any] = {
        "name": name, "cores": 2, "memory": 4.0, "disk": 40, "cpu_type": "shared",
        "architecture": "x86", "deprecation": None,
        "prices": [{"location": location, "price_monthly": {"net": "0", "gross": gross}}],
    }  # fmt: skip
    t.update(extra)
    return t


TYPES = [
    stype("cx23", "4.15"),
    stype("cpx22", "9.00"),
    stype("cax11", "4.50", architecture="arm"),
    stype("ccx13", "15.00", cpu_type="dedicated"),
    stype("cx22", "4.00", deprecation={"announced": "2025-10-01"}),
    stype("cx33", "6.50", location="hel1"),
]


class FakeHetzner(hetzner.Hetzner):
    def __init__(self, firewalls: list[dict[str, Any]], servers: list[dict[str, Any]]) -> None:
        super().__init__("token")
        self.firewalls, self.servers = firewalls, servers
        self.writes: list[tuple[str, dict[str, Any] | None]] = []

    def call(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        if method == "GET":
            if path.startswith("/server_types"):
                return {"server_types": TYPES}
            if path.startswith("/firewalls"):
                return {"firewalls": self.firewalls}
            return {"servers": self.servers}
        self.writes.append((path, body))
        if path == "/firewalls":
            return {"firewall": {"id": 7, **(body or {})}}
        return {"server": {"id": 9, **(body or {})}}


def key(tmp_path: Path) -> Path:
    (tmp_path / "id.pub").write_text("ssh-ed25519 AAAA me@laptop\n")
    return tmp_path / "id.pub"


def test_sslip_domain_spells_the_address() -> None:
    assert hetzner.sslip_domain("203.0.113.10") == "203-0-113-10.sslip.io"
    with pytest.raises(ValueError):
        hetzner.sslip_domain("2a01:4f8::1")


def test_rules_compare_without_order_or_extra_fields() -> None:
    assert not hetzner.rules_differ(LIVE_RULES, hetzner.FIREWALL_RULES)
    assert hetzner.rules_differ(LIVE_RULES[1:], hetzner.FIREWALL_RULES)
    extra = {"direction": "in", "protocol": "tcp", "port": "8080", "source_ips": ["0.0.0.0/0"]}
    opened: list[dict[str, Any]] = [*LIVE_RULES, extra]
    assert hetzner.rules_differ(opened, hetzner.FIREWALL_RULES)


def test_a_current_x86_type_is_fine() -> None:
    assert hetzner.server_type_problem(TYPES, "cx23", "nbg1") is None


@pytest.mark.parametrize(
    ("name", "why"),
    [
        ("cx11", "no server type 'cx11'"),
        ("cx22", "deprecated or not offered in nbg1"),
        ("cx33", "deprecated or not offered in nbg1"),
        ("cax11", "isn't x86"),
    ],
)
def test_other_types_fail_with_the_cheapest_current_shared_x86_ones(name: str, why: str) -> None:
    problem = hetzner.server_type_problem(TYPES, name, "nbg1") or ""
    assert why in problem
    listed = [line.split()[0] for line in problem.splitlines()[1:] if line.startswith("  ")]
    assert listed == ["cx23", "cpx22"]


def test_from_nothing_it_creates_the_firewall_then_the_server_behind_it(tmp_path: Path) -> None:
    fake = FakeHetzner(firewalls=[], servers=[])
    _, created = hetzner.ensure(fake, key(tmp_path))
    assert created
    assert [path for path, _ in fake.writes] == ["/firewalls", "/servers"]
    body = fake.writes[1][1] or {}
    assert body["name"] == "wannpassts-prod" and body["firewalls"] == [{"firewall": 7}]
    assert body["server_type"] == hetzner.SERVER_TYPE and body["location"] == "nbg1"
    assert "      - ssh-ed25519 AAAA me@laptop\n" in body["user_data"]
    assert "SSH_PUBLIC_KEY" not in body["user_data"].split("users:")[1]


def test_a_retired_type_stops_before_anything_is_created(tmp_path: Path) -> None:
    fake = FakeHetzner(firewalls=[], servers=[])
    with pytest.raises(SystemExit, match="cx23"):
        hetzner.ensure(fake, key(tmp_path), server_type="cx22")
    assert fake.writes == []


def test_an_existing_server_and_firewall_are_left_alone(tmp_path: Path) -> None:
    fake = FakeHetzner(firewalls=[{"id": 7, "rules": LIVE_RULES}],
                       servers=[{"id": 1, "name": "wannpassts-prod"}])  # fmt: skip
    server, created = hetzner.ensure(fake, key(tmp_path))
    assert not created and server["id"] == 1
    assert fake.writes == []


def test_a_firewall_changed_in_the_console_gets_its_rules_back(tmp_path: Path) -> None:
    fake = FakeHetzner(firewalls=[{"id": 7, "rules": LIVE_RULES[:1]}],
                       servers=[{"id": 1, "name": "wannpassts-prod"}])  # fmt: skip
    hetzner.ensure(fake, key(tmp_path))
    assert fake.writes == [("/firewalls/7/actions/set_rules", {"rules": hetzner.FIREWALL_RULES})]
