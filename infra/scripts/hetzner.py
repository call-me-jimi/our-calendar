"""The production server on Hetzner Cloud (P7, docs/runbooks/server.md): `make server-create`.

Creates the Cloud Firewall and the server from infra/server/cloud-init.yaml, waits for
cloud-init, then prints the address, the sslip.io domain and the ssh command. Safe to
rerun: an existing server is left alone, and the firewall's rules are set back to the
ones below if they differ.

Needs, on this laptop:
  .local/secrets/hcloud_token   a Read & Write API token of the Hetzner project
  LOGIN_KEY                     your SSH public key, default ~/.ssh/id_rsa.pub or
                                ~/.ssh/id_ed25519.pub, whichever exists
  SERVER_TYPE, LOCATION         optional overrides of the defaults below
"""

import ipaddress
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
SECRETS = ROOT / ".local" / "secrets"
API = "https://api.hetzner.cloud/v1"
SERVER = "wannpassts-prod"
FIREWALL = "wannpassts"
# The smallest shared x86 type (the laptop builds amd64 images). Checked against the API
# before anything is created: a type Hetzner retired fails with cheaper alternatives.
SERVER_TYPE = "cx23"
# Nuremberg; the Storage Box is in Falkenstein, so the backups sit in another data centre.
LOCATION = "nbg1"
IMAGE = "ubuntu-26.04"
_ANY = ["0.0.0.0/0", "::/0"]
# Inbound only. Docker's published ports bypass ufw, so this is the firewall that counts.
FIREWALL_RULES: list[dict[str, Any]] = [
    {"direction": "in", "protocol": "tcp", "port": "22", "source_ips": _ANY},
    {"direction": "in", "protocol": "tcp", "port": "80", "source_ips": _ANY},
    {"direction": "in", "protocol": "tcp", "port": "443", "source_ips": _ANY},
    {"direction": "in", "protocol": "udp", "port": "443", "source_ips": _ANY},  # HTTP/3
    {"direction": "in", "protocol": "icmp", "source_ips": _ANY},
]


def sslip_domain(ipv4: str) -> str:
    """The name that resolves to `ipv4` without any DNS of our own, e.g.
    203-0-113-10.sslip.io."""
    return str(ipaddress.IPv4Address(ipv4)).replace(".", "-") + ".sslip.io"


def _rule(r: dict[str, Any]) -> tuple[str, str, str, tuple[str, ...]]:
    return r["direction"], r["protocol"], r.get("port") or "", tuple(sorted(r["source_ips"]))


def rules_differ(live: list[dict[str, Any]], wanted: list[dict[str, Any]]) -> bool:
    """Whether the firewall's rules are other than `wanted`, ignoring order and the
    fields the API adds (description, destination_ips)."""
    return sorted(map(_rule, live)) != sorted(map(_rule, wanted))


def _monthly(t: dict[str, Any], location: str) -> float:
    for p in t.get("prices", []):
        if p["location"] == location:
            return float(p["price_monthly"]["gross"])
    return float("inf")


def _current_in(t: dict[str, Any], location: str) -> bool:
    """Offered in `location` and not deprecated (globally or for that location)."""
    if t.get("deprecated") or t.get("deprecation"):
        return False
    if _monthly(t, location) == float("inf"):
        return False
    for loc in t.get("locations") or []:
        if loc.get("name") == location and loc.get("deprecation"):
            return False
    return True


def cheap_alternatives(types: list[dict[str, Any]], location: str, n: int = 5) -> list[str]:
    """The `n` cheapest current shared x86 types in `location`, one line each."""
    fits = [
        t
        for t in types
        if t.get("cpu_type") == "shared"
        and t.get("architecture") == "x86"
        and _current_in(t, location)
    ]
    fits.sort(key=lambda t: _monthly(t, location))
    return [
        f"{t['name']:<8} {t['cores']} vCPU  {t['memory']:g} GB RAM  {t['disk']} GB disk  "
        f"€{_monthly(t, location):.2f}/month"
        for t in fits[:n]
    ]


def server_type_problem(types: list[dict[str, Any]], name: str, location: str) -> str | None:
    """None if `name` is a current x86 type in `location`, else what's wrong and what to
    pick instead."""
    found = next((t for t in types if t["name"] == name), None)
    if found is None:
        why = f"Hetzner has no server type {name!r}"
    elif not _current_in(found, location):
        why = f"server type {name!r} is deprecated or not offered in {location}"
    elif found.get("architecture") != "x86":
        why = f"server type {name!r} isn't x86, and the laptop builds amd64 images"
    else:
        return None
    lines = cheap_alternatives(types, location)
    if not lines:
        return f"{why}, and no shared x86 type is offered in {location}: try LOCATION=fsn1"
    listing = "\n".join("  " + line for line in lines)
    return f"{why}. Cheapest shared x86 types in {location}:\n{listing}\n" + (
        "Rerun with SERVER_TYPE=<name> (and update SERVER_TYPE in infra/scripts/hetzner.py)."
    )


class Hetzner:
    def __init__(self, token: str) -> None:
        self.token = token

    def call(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        req = urllib.request.Request(  # noqa: S310 (a fixed https URL)
            API + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            sys.exit(f"Hetzner API {method} {path}: {e.code} {e.read().decode(errors='replace')}")

    def find(self, path: str, key: str, name: str) -> dict[str, Any] | None:
        items: list[dict[str, Any]] = self.call("GET", f"{path}?name={name}")[key]
        return items[0] if items else None


def cloud_init(key_file: Path) -> str:
    """infra/server/cloud-init.yaml with the SSH public key in `key_file` filled in."""
    key = key_file.read_text().strip()
    return (
        (ROOT / "infra/server/cloud-init.yaml")
        .read_text()
        .replace("      - SSH_PUBLIC_KEY", f"      - {key}")
    )


def ensure(
    hetzner: Hetzner, key_file: Path, server_type: str = SERVER_TYPE, location: str = LOCATION
) -> tuple[dict[str, Any], bool]:
    """The firewall with FIREWALL_RULES, and the server behind it. Returns the server and
    whether it was created just now."""
    server = hetzner.find("/servers", "servers", SERVER)
    if server is None:
        types = hetzner.call("GET", "/server_types?per_page=50")["server_types"]
        problem = server_type_problem(types, server_type, location)
        if problem:
            sys.exit(problem)

    firewall = hetzner.find("/firewalls", "firewalls", FIREWALL)
    if firewall is None:
        firewall = hetzner.call("POST", "/firewalls", {"name": FIREWALL, "rules": FIREWALL_RULES})[
            "firewall"
        ]
        print(f"created firewall {FIREWALL}")
    elif rules_differ(firewall["rules"], FIREWALL_RULES):
        hetzner.call(
            "POST", f"/firewalls/{firewall['id']}/actions/set_rules", {"rules": FIREWALL_RULES}
        )
        print(f"reset the rules of firewall {FIREWALL}")

    if server is not None:
        return server, False
    server = hetzner.call(
        "POST",
        "/servers",
        {
            "name": SERVER,
            "server_type": server_type,
            "location": location,
            "image": IMAGE,
            "user_data": cloud_init(key_file),
            "firewalls": [{"firewall": firewall["id"]}],
            "public_net": {"enable_ipv4": True, "enable_ipv6": True},
            "labels": {"app": "wannpassts"},
        },
    )["server"]
    print(f"created server {SERVER} ({server_type} in {location})")
    return server, True


def wait_for_cloud_init(ip: str) -> None:
    with tempfile.NamedTemporaryFile(prefix="server-known-hosts-") as known_hosts:
        ssh = [
            "ssh",
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=10",
            "-o", f"UserKnownHostsFile={known_hosts.name}",
            "-o", "StrictHostKeyChecking=accept-new",
            f"deploy@{ip}",
            "cloud-init status --wait; docker compose version",
        ]  # fmt: skip
        for _ in range(60):
            r = subprocess.run(ssh, capture_output=True, text=True, check=False)  # noqa: S603
            if r.returncode == 0:
                print(r.stdout.strip())
                return
            time.sleep(10)
    sys.exit(f"deploy@{ip} never came up; look at the server's console in Hetzner")


def login_key() -> Path:
    if os.environ.get("LOGIN_KEY"):
        return Path(os.environ["LOGIN_KEY"]).expanduser()
    for name in ("id_rsa.pub", "id_ed25519.pub"):
        path = Path("~/.ssh", name).expanduser()
        if path.exists():
            return path
    sys.exit("no ~/.ssh/id_rsa.pub or ~/.ssh/id_ed25519.pub: set LOGIN_KEY=<your .pub file>")


def main() -> int:
    token_file = SECRETS / "hcloud_token"
    if not token_file.exists():
        sys.exit(f"no {token_file}: docs/runbooks/server.md, step 1, shows how to make one")
    key_file = login_key()
    server_type = os.environ.get("SERVER_TYPE") or SERVER_TYPE
    location = os.environ.get("LOCATION") or LOCATION
    hetzner = Hetzner(token_file.read_text().strip())
    server, created = ensure(hetzner, key_file, server_type, location)
    ipv4 = server["public_net"]["ipv4"]["ip"]
    if created:
        print(f"waiting for cloud-init on {ipv4} (a few minutes)")
        wait_for_cloud_init(ipv4)
    else:
        print(f"{SERVER} already exists, left as it is. To rebuild, delete it in the console.")
    print(f"""
Server   {SERVER}, IPv4 {ipv4}
Domain   {sslip_domain(ipv4)}   (make server-init writes it to the server's .env)
SSH      ssh deploy@{ipv4}

Next: put DEPLOY_HOST=deploy@{ipv4} in this laptop's .env, then `make server-init`.""")
    return 0


if __name__ == "__main__":
    sys.exit(main())
