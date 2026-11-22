"""Settings, read once from the environment."""

import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    base_url: str
    static_dir: Path | None = None
    # No SMTP host: "link mode", no mail at all (spec §3.1): joining signs in directly and
    # sign-in links are handed out by admins. See `mail_enabled`.
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_user: str | None = None
    smtp_password: str | None = None
    smtp_starttls: bool = True
    mail_from: str = "Wann passt's? <noreply@wann.localhost>"
    # Magic-link emails per client IP and hour (spec §3.1). Raised only for local e2e runs.
    link_limit_per_ip: int = 20
    # Holiday sync at startup and daily at 04:00 Berlin (spec §3.8). Off unless the env turns it on,
    # so tests never reach the network; `load_settings` defaults it to on.
    holiday_sync: bool = False
    # Who runs this instance, named on the privacy page (spec §3.15). None: not named.
    operator_name: str | None = None

    @property
    def mail_enabled(self) -> bool:
        return self.smtp_host is not None

    @property
    def db_path(self) -> Path:
        return self.data_dir / "app.db"

    @property
    def origin(self) -> str:
        """scheme://host[:port] of BASE_URL: what the browser sends as `Origin`."""
        parts = urlsplit(self.base_url)
        return f"{parts.scheme}://{parts.netloc}"


def load_settings() -> Settings:
    env = os.environ
    static = env.get("STATIC_DIR")
    password = env.get("SMTP_PASSWORD")
    if not password and env.get("SMTP_PASSWORD_FILE"):
        password = Path(env["SMTP_PASSWORD_FILE"]).read_text().strip()
    return Settings(
        data_dir=Path(env.get("DATA_DIR", "data")),
        base_url=env.get("BASE_URL", "https://wann.localhost:8444").rstrip("/"),
        static_dir=Path(static) if static else None,
        smtp_host=env.get("SMTP_HOST") or None,
        smtp_port=int(env.get("SMTP_PORT", "587")),
        smtp_user=env.get("SMTP_USER") or None,
        smtp_password=password or None,
        smtp_starttls=env.get("SMTP_STARTTLS", "true").lower() == "true",
        mail_from=env.get("MAIL_FROM", Settings.mail_from),
        link_limit_per_ip=int(env.get("LINK_LIMIT_PER_IP", str(Settings.link_limit_per_ip))),
        holiday_sync=env.get("HOLIDAY_SYNC", "true").lower() == "true",
        operator_name=env.get("OPERATOR_NAME", "").strip() or None,
    )
