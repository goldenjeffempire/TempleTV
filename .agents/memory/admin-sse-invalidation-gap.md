---
name: Admin broadcast-v2 SSE invalidation must cover all queue-derived panels
description: The broadcast-queue-updated SSE handler must invalidate every query key that reflects queue state, not just the obvious ones.
---

The admin broadcast-v2 page has multiple panels whose `useQuery` keys all derive
from the live queue: `broadcast-queue`, `broadcast-v2-engine-health`,
`broadcast-v2-source-health`, `broadcast-v2-diagnostics`,
`broadcast-v2-queue-sync-status`.

**Rule:** the `broadcast-queue-updated` SSE handler must invalidate the FULL set,
not a subset. Direct mutations (skip/reload/fix) invalidate diagnostics inline,
but server-side auto-fixes (integrity validator, prod-sync, transcoder
completion) only reach the client via the SSE event — so any key omitted from the
SSE handler stays stale until its own poll interval.

**Why:** diagnostics was omitted, so after an operator fixed a corrupt item the
red diagnostics badge stayed visible for up to 15 s (its poll), making a
successful fix look like it failed.

**How to apply:** when adding a new queue-derived admin panel/query key, add it to
the `broadcast-queue-updated` SSE handler invalidation list too, not just to the
mutation's own onSuccess.

Related durable convention (admin destructive actions): one-click destructive
admin actions (delete system-settings key, "Transcode All Unprocessed") must be
gated behind an AlertDialog confirmation — pattern mirrors users.tsx/purge.tsx.
