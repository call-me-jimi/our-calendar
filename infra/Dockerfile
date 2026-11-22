# One image: node builds the SPA, python serves it and the API (spec §6.1).

FROM node:24-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.13-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.9.5 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY backend/src ./src
RUN uv sync --frozen --no-dev --no-editable

FROM python:3.13-slim
RUN useradd --system --uid 10001 --home-dir /app app \
    && mkdir -p /data && chown app /data
COPY --from=build /app/.venv /app/.venv
COPY --from=web /web/dist /app/static
ENV PATH=/app/.venv/bin:$PATH \
    DATA_DIR=/data \
    STATIC_DIR=/app/static \
    PYTHONUNBUFFERED=1
USER app
WORKDIR /app
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health')"]
# One worker on purpose: the holiday scheduler runs in-process (spec §6.1).
CMD ["uvicorn", "ourcalendar.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", \
     "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "*"]
