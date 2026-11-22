"""Outgoing email: magic links only (spec §3.1, §3.12)."""

import logging
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Literal, Protocol

from ourcalendar.config import Settings

log = logging.getLogger(__name__)

Locale = Literal["de", "en"]


@dataclass(frozen=True)
class Mail:
    to: str
    subject: str
    text: str


class Mailer(Protocol):
    def send(self, mail: Mail) -> None: ...


class SmtpMailer:
    def __init__(self, settings: Settings) -> None:
        self.s = settings

    def send(self, mail: Mail) -> None:
        msg = EmailMessage()
        msg["From"] = self.s.mail_from
        msg["To"] = mail.to
        msg["Subject"] = mail.subject
        msg.set_content(mail.text)
        assert self.s.smtp_host
        try:
            with smtplib.SMTP(self.s.smtp_host, self.s.smtp_port, timeout=15) as smtp:
                if self.s.smtp_starttls:
                    smtp.starttls()
                if self.s.smtp_user and self.s.smtp_password:
                    smtp.login(self.s.smtp_user, self.s.smtp_password)
                smtp.send_message(msg)
        except (OSError, smtplib.SMTPException):
            # Sent from a background task: nobody waits for it, so log and move on.
            log.exception("sending mail failed")


class LogMailer:
    """No SMTP configured: write the mail to the log instead."""

    def send(self, mail: Mail) -> None:
        log.warning("mail to %s: %s\n%s", mail.to, mail.subject, mail.text)


class MemoryMailer:
    """For tests."""

    def __init__(self) -> None:
        self.sent: list[Mail] = []

    def send(self, mail: Mail) -> None:
        self.sent.append(mail)


def make_mailer(settings: Settings) -> Mailer:
    return SmtpMailer(settings) if settings.smtp_host else LogMailer()


_TEXT: dict[str, dict[str, str]] = {
    "de": {
        "subject": "Dein Anmeldelink für Our Calendar",
        "body": (
            "Hallo {name},\n\n"
            "mit diesem Link meldest du dich bei Our Calendar an:\n\n{link}\n\n"
            "Der Link ist 15 Minuten gültig und funktioniert nur einmal.\n"
            "Wenn du das nicht warst, kannst du diese Mail einfach ignorieren.\n"
        ),
    },
    "en": {
        "subject": "Your sign-in link for Our Calendar",
        "body": (
            "Hi {name},\n\n"
            "use this link to sign in to Our Calendar:\n\n{link}\n\n"
            "The link is valid for 15 minutes and works once.\n"
            "If this wasn't you, just ignore this email.\n"
        ),
    },
}


def magic_link_mail(to: str, name: str, link: str, locale: Locale) -> Mail:
    t = _TEXT[locale]
    return Mail(to=to, subject=t["subject"], text=t["body"].format(name=name, link=link))
