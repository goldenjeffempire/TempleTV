# Sequence Diagrams

Three flows chosen because each exercises a different architectural
concern that isn't obvious from reading a single file in isolation.

## 1. Register → login → authenticated write

Shows the JWT issuance/verification path and where `require_permission`
actually sits in the request lifecycle relative to authentication.

```mermaid
sequenceDiagram
    participant C as Client
    participant API as FastAPI app
    participant RL as Redis (rate limit)
    participant DB as PostgreSQL

    C->>API: POST /v1/auth/register {email, password}
    API->>DB: SELECT user WHERE email = ?
    DB-->>API: (none)
    API->>API: hash_password() [bcrypt]
    API->>DB: INSERT user
    API->>DB: INSERT audit_log (user.registered)
    API-->>C: 201 {id, email, ...}

    C->>API: POST /v1/auth/login {username, password}
    API->>RL: INCR login:{ip}
    RL-->>API: count (under limit)
    API->>DB: SELECT user WHERE email = ? (+ roles, + permissions)
    DB-->>API: user row
    API->>API: verify_password() [bcrypt]
    API->>API: create_access_token() + create_refresh_token() [JWT]
    API->>DB: INSERT audit_log (user.login)
    API-->>C: 200 {access_token, refresh_token}

    C->>API: POST /v1/services (Authorization: Bearer ...)
    API->>API: decode_token() → user_id
    API->>DB: SELECT user WHERE id = ? (+ roles, + permissions — eager-loaded)
    DB-->>API: user row
    API->>API: require_permission("knowledge:write"): user.is_superuser OR "knowledge:write" in held codes
    alt permission denied
        API-->>C: 403 PERMISSION_DENIED
    else permission granted
        API->>DB: SELECT service WHERE slug = ? (uniqueness pre-check)
        API->>DB: INSERT service
        API->>DB: INSERT audit_log (service.created)
        API->>DB: SELECT service WHERE slug = ? (re-fetch, fully eager-loaded)
        API-->>C: 201 {id, slug, ...}
    end
```

**Why the re-fetch after insert, instead of returning the object just
created:** the freshly-inserted `Service` object doesn't have its
`agency`/`law` relationships loaded — touching them to build the response
would trigger an async lazy-load, which raises (`MissingGreenlet`) rather
than quietly working the way it might under the sync ORM. Re-fetching
through the same fully-eager-loaded query every other read uses is simpler
than maintaining a second, partial loading path just for the
just-created case.

## 2. `GET /v1/services/{slug}` — assembling the trust layer

Shows why this endpoint issues more than one query despite returning a
single JSON object, and why that's not an N+1 problem.

```mermaid
sequenceDiagram
    participant C as Client
    participant API as FastAPI app
    participant DB as PostgreSQL

    C->>API: GET /v1/services/ng-business-name-registration
    API->>DB: SELECT service + agency + offices + law\n+ requirements + fees + service_documents + documents\n(one query, selectinload chains)
    DB-->>API: fully-populated Service object graph

    Note over API: Verification is a polymorphic association,<br/>not a real ORM relationship — can't be<br/>selectinload'd as part of the query above.

    API->>DB: SELECT verifications WHERE entity_type='requirement'\nAND entity_id IN (...) — one batch query for ALL requirements
    DB-->>API: verifications for every requirement, in one round trip
    API->>DB: SELECT verifications WHERE entity_type='fee'\nAND entity_id IN (...) — one batch query for ALL fees
    DB-->>API: verifications for every fee, in one round trip

    API->>API: assemble ServiceDetailOut, attaching each\nrequirement's/fee's verifications from the batch results
    API-->>C: 200 {..., requirements: [...], fees: [...], documents: [...]}
```

Three or four queries total, regardless of how many requirements or fees
the service has — the two verification lookups are batched (`entity_id IN
(...)`) rather than issued once per requirement/per fee in a loop, which
is the actual N+1 pattern this design avoids.

## 3. Full-text search — why two endpoints exist for "search"

```mermaid
sequenceDiagram
    participant C as Client
    participant API as FastAPI app
    participant DB as PostgreSQL

    rect rgb(245, 245, 245)
    Note over C,DB: POST /v1/query — plain substring match
    C->>API: POST /v1/query {"query": "business"}
    API->>DB: SELECT * FROM services WHERE name ILIKE '%business%'\nOR description ILIKE '%business%' OR category ILIKE '%business%'
    DB-->>API: matches, arbitrary order
    API-->>C: 200 {data: [...]}
    end

    rect rgb(245, 245, 245)
    Note over C,DB: GET /v1/search — relevance-ranked full-text
    C->>API: GET /v1/search?q=register+a+business
    API->>DB: SELECT *, ts_rank(search_vector, tsquery) AS rank\nFROM services WHERE search_vector @@ websearch_to_tsquery('english', ?)\nORDER BY rank DESC
    Note over DB: search_vector is a GENERATED ALWAYS AS ... STORED\ncolumn — Postgres kept it in sync automatically\non every INSERT/UPDATE, no app code involved.
    DB-->>API: matches, ranked by relevance, stemmed\n("register" also matches "registration")
    API-->>C: 200 {data: [...]}
    end
```
