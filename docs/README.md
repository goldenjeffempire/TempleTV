# Documentation

- **[architecture.md](architecture.md)** — layering, request lifecycle,
  the trust layer, what's deliberately not built yet.
- **[er-diagram.md](er-diagram.md)** — every table, every relationship,
  and the reasoning behind the schema decisions that aren't obvious from
  the diagram alone (the polymorphic `Verification` association, shared
  `Document` entities, etc.).
- **[sequence-diagrams.md](sequence-diagrams.md)** — three request flows
  chosen to each surface a different architectural concern: JWT auth +
  permission checks, assembling a response that spans the trust layer
  without an N+1, and why two different "search" endpoints exist.
- **[deployment-guide.md](deployment-guide.md)** — running the Docker
  Compose stack, and an honest list of what's *not* handled yet before
  this could take real production traffic (secrets management, TLS,
  migration automation, log shipping).
- **[developer-guide.md](developer-guide.md)** — directory map, how to add
  a read/write endpoint, the async lazy-loading trap that's caused more
  real bugs in this codebase than anything else, testing conventions.
- **[coding-standards.md](coding-standards.md)** — conventions the linter
  can't enforce: response envelope shape, the repository boundary, no
  invented data ever, `passive_deletes`, why `assert` isn't error handling.

For the project's actual milestone-by-milestone history — what shipped
when, and every real bug caught before being called done — see the
`git log` on `master`; each milestone's commit message is written as a
standalone record of what was verified and what wasn't, not just a
summary of the diff.
