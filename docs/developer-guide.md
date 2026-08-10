# Developer Guide

## Getting started

See the root `README.md` for the actual run commands (Docker Compose vs.
local). This document is about *how the codebase is organized* and
*how to extend it* once it's running — not how to boot it.

## Directory map, with what actually lives there today

```
apps/api/app/
├── main.py              # App factory: middleware, routers, exception handlers
├── config.py             # The only place that reads environment variables
├── core/
│   ├── security.py       # Password hashing, JWT, API key generation
│   ├── middleware.py      # Request ID, Prometheus metrics, security headers
│   ├── exception_handlers.py  # Every error → ErrorEnvelope
│   ├── logging.py         # Structured JSON logging setup
│   ├── metrics.py          # Prometheus Counter/Histogram definitions
│   └── rate_limit.py        # Redis-backed fixed-window limiter
├── api/
│   ├── deps.py            # FastAPI dependencies: DB session, repos, current user, permissions
│   └── v1/                 # One file per resource; router.py aggregates them
├── db/
│   ├── session.py          # Async engine/session factory, commit/rollback boundary
│   └── models/              # SQLAlchemy models — geography.py, knowledge.py, auth.py
├── repositories/            # All SQLAlchemy queries live here — see docs/architecture.md
└── schemas/                  # Pydantic request/response shapes
```

## Adding a new read endpoint

1. Add a query method to the relevant repository in `repositories/`
   (`KnowledgeRepository` or `AuthRepository`). If it returns ORM objects
   whose relationships the response schema needs, add the matching
   `selectinload(...)` chain — see "The async lazy-load trap" below before
   skipping this.
2. Add a Pydantic output schema to `schemas/` if the shape doesn't already
   exist. `model_config = ConfigDict(from_attributes=True)` if you intend
   to build it via `.model_validate(orm_object)`; otherwise construct it
   explicitly with keyword arguments (see `_to_service_detail` in
   `api/v1/services.py` for why that's sometimes the right call —
   `RequirementOut`/`FeeOut`'s `verifications` field has no matching ORM
   attribute, since `Verification` is a polymorphic association).
3. Add the endpoint function in the relevant `api/v1/*.py` file. Wrap the
   return value in `Envelope[YourSchema]`; pull `metadata`/`request_id`
   the same way every existing endpoint does.
4. Add it to that resource's `router.router.include_router(...)` call in
   `api/v1/router.py` if it's a new file, or it's already covered if
   you're adding to an existing router.
5. Write a test in `tests/api/`. Reuse or extend a fixture in
   `tests/conftest.py` if you need seeded data — `seeded_service` is the
   go-to for anything service-shaped.

## Adding a new write endpoint

Same as above, plus:

1. Add a Pydantic **input** schema (`XCreate`/`XUpdate`) with real
   validation — `Field(min_length=..., pattern=..., gt=...)` etc., not
   just `str`/`float`. See `ServiceCreate`'s `slug` field for an example
   of a regex-validated identifier.
2. Add the write method to the repository. Remember `passive_deletes=True`
   if this is a parent side of a relationship with a `NOT NULL` child FK —
   see `docs/er-diagram.md`'s notes section for why, and Milestone 4's
   commit message for the bug this prevents.
3. If the operation should require a permission, use
   `require_permission("some:code")` as the dependency (see any endpoint
   in `api/v1/services.py` under "Writes" for the pattern) — **not**
   `CurrentUserDep` with a separately-assigned default; mixing an
   `Annotated`-declared dependency with an assigned-default dependency on
   the same parameter is ambiguous about which one FastAPI actually uses.
   Type the parameter as plain `User`.
4. If two concurrent requests could violate a unique constraint (duplicate
   slug, duplicate email), don't rely solely on a pre-check
   ("does this already exist?") — that's a real TOCTOU race. Catch
   `sqlalchemy.exc.IntegrityError` around the insert and translate it to
   the same 409 the pre-check produces. See `create_service`/`register`
   for the pattern.
5. Record an `AuditLog` entry via `AuthRepository.record_audit_event(...)`
   for anything security- or data-integrity-relevant.
6. Write tests covering: success, 401 (no auth), 403 (auth but no
   permission, if applicable), 404 (referenced resource doesn't exist),
   409 (conflict, if applicable), 422 (invalid input).

## The async lazy-load trap

This is the single most common bug this project's milestone-end reviews
have caught (see individual commit messages for real examples). Async
SQLAlchemy has **no implicit lazy-loading fallback** — if an endpoint
touches a relationship attribute that the query which fetched the object
didn't eagerly load, you get `MissingGreenlet` at runtime, not a slow
query. This only surfaces when the code path actually runs, which is
exactly why it's been the hardest bug class to catch by reading code
alone (see the note in the root `README.md` about this codebase's testing
status).

Before writing a response that reads `obj.some_relationship`, check that
the query which fetched `obj` included
`.options(selectinload(Model.some_relationship))` — or its nested form,
`.options(selectinload(Model.a).selectinload(A.b))`, if you're reaching
two levels deep.

## Database migrations

Written by hand in this project so far, not `alembic revision
--autogenerate` — every migration in `alembic/versions/` was checked
column-by-column against the model it corresponds to rather than trusted
blindly. If you do use `--autogenerate`, review the output the same way:
column types, nullability, and `ondelete` behavior are exactly the kind of
thing autogenerate gets subtly wrong.

## Testing conventions

- `tests/unit/` — pure logic, no DB/Redis (e.g. `test_security.py`,
  `test_rate_limit.py` uses Redis directly but no HTTP layer).
- `tests/api/` — full HTTP round-trip via the `client` fixture
  (`httpx.AsyncClient` over `ASGITransport`, no real network).
- `tests/conftest.py`'s `_schema` fixture creates all tables via
  `Base.metadata.create_all()` before every test and truncates every
  table after — not via Alembic, since tests need *a* schema matching
  current models, not a production migration history. It also flushes
  Redis between tests, since httpx's test client reports the same client
  IP for every request and the login/register rate limiters are keyed by
  IP — without this, tests would bleed into each other's rate-limit
  counters.
- Prefer building test data through fixtures/direct ORM inserts
  (`seeded_service`, `registered_user`, `editor_user`) over hitting write
  endpoints to set up state for an unrelated test — keeps tests focused on
  what they're actually verifying.

## Code style

Enforced by `pyproject.toml`'s `[tool.ruff]`/`[tool.black]`/`[tool.mypy]`
config and `.pre-commit-config.yaml` — run `pre-commit install` once per
clone. See `docs/coding-standards.md` for the conventions that tooling
*can't* enforce (response envelope shape, repository pattern, etc.).
