"""FastAPI app: the JSON API under /api and the built SPA for everything else."""

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from wannpassts import auth, events, feed, groups, holidays, join, marks, signin_links
from wannpassts.config import Settings, load_settings
from wannpassts.db import open_db
from wannpassts.deps import Db
from wannpassts.mail import Mailer, make_mailer

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def create_app(settings: Settings | None = None, mailer: Mailer | None = None) -> FastAPI:
    settings = settings or load_settings()
    logging.basicConfig(level=logging.INFO)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        open_db(settings.db_path).close()
        # One uvicorn worker, so one scheduler (spec §3.8).
        sync = None
        if settings.holiday_sync:
            sync = asyncio.create_task(holidays.run_daily(settings.db_path))
        yield
        if sync is not None:
            sync.cancel()
            with suppress(asyncio.CancelledError):
                await sync

    app = FastAPI(title="Wann passt's?", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.settings = settings
    app.state.mailer = mailer or make_mailer(settings)

    # Errors are `{"error": "<code>"}` (spec §5).
    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = exc.detail if isinstance(exc.detail, str) else "error"
        if exc.status_code == 404 and code == "Not Found":
            code = "not_found"
        return JSONResponse({"error": code}, status_code=exc.status_code, headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse({"error": "invalid_input"}, status_code=422)

    # CSRF: a state-changing API request must come from our own pages (spec §6.2).
    @app.middleware("http")
    async def origin_check(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        if (
            request.method not in SAFE_METHODS
            and request.url.path.startswith("/api/")
            and request.headers.get("origin") != settings.origin
        ):
            return JSONResponse({"error": "bad_origin"}, status_code=403)
        return await call_next(request)

    @app.get("/api/health")
    def health(conn: Db) -> dict[str, bool]:
        conn.execute("SELECT 1")
        return {"ok": True}

    # Public facts the pages need before sign-in: without mail, sign-in and joining work by link
    # (spec §3.1, §3.2).
    @app.get("/api/info")
    def info() -> dict[str, bool | str | None]:
        return {"mail_enabled": settings.mail_enabled, "operator_name": settings.operator_name}

    app.include_router(auth.router)
    app.include_router(groups.router)
    app.include_router(join.router)
    app.include_router(signin_links.router)
    app.include_router(marks.router)
    app.include_router(holidays.router)
    app.include_router(events.router)
    app.include_router(feed.router)

    # Fallbacks last: routes match in registration order, so routers go above this line.
    @app.api_route("/api/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    def api_not_found(rest: str) -> JSONResponse:
        return JSONResponse({"error": "not_found"}, status_code=404)

    if settings.static_dir is not None:
        _mount_spa(app, settings.static_dir)

    return app


def _mount_spa(app: FastAPI, static_dir: Path) -> None:
    root = static_dir.resolve()
    index = root / "index.html"

    @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def spa(path: str) -> FileResponse:
        candidate = (root / path).resolve()
        if path and candidate.is_file() and candidate.is_relative_to(root):
            # Vite fingerprints everything under assets/, so it can be cached for good.
            immutable = candidate.is_relative_to(root / "assets")
            cache = "public, max-age=31536000, immutable" if immutable else "no-cache"
            return FileResponse(candidate, headers={"Cache-Control": cache})
        if not index.is_file():
            raise HTTPException(status_code=404)
        return FileResponse(index, headers={"Cache-Control": "no-cache"})
