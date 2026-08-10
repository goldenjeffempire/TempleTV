# syntax=docker/dockerfile:1.7

# ---- Base ----
FROM python:3.13-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# ---- Dependencies ----
FROM base AS deps

# Only pyproject.toml is present at this point — deliberately. We install
# *third-party* dependencies parsed straight out of it, without asking
# setuptools to build our own project as a package (that would require the
# app source to already exist, and would install a stub of it into
# site-packages that could later shadow the real source copied below).
# This keeps the dependency layer cacheable across app-code-only changes,
# and pyproject.toml remains the single source of truth for the dependency
# list — nothing is duplicated here.
COPY pyproject.toml ./
RUN pip install --upgrade pip \
    && python -c "\
import tomllib; \
d = tomllib.load(open('pyproject.toml', 'rb'))['project']; \
deps = d['dependencies'] + d['optional-dependencies']['dev']; \
print('\n'.join(deps))" > /tmp/requirements.txt \
    && pip install -r /tmp/requirements.txt

# ---- Runtime ----
FROM deps AS runtime

COPY apps/api/app ./app
COPY alembic ./alembic
COPY alembic.ini ./alembic.ini
COPY scripts ./scripts

RUN useradd --create-home --uid 1000 appuser \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8000/v1/health || exit 1

# `python -m uvicorn` (not the bare `uvicorn` console script) guarantees the
# working directory is on sys.path, so `app` always resolves to the source
# copied above rather than anything installed in site-packages.
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
