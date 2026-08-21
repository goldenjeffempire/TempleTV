---
name: Broadcast daemon leadership through transaction poolers
description: Pooler-safe singleton leadership and controlled migration away from leaked session advisory locks.
---

## Rule

When PostgreSQL is reached through a transaction pooler, daemon leadership must use a dedicated checked-out client, an open transaction, and `pg_try_advisory_xact_lock`. Keep the transaction active with an exact-key heartbeat and release ownership with `ROLLBACK`.

**Why:** A session-level advisory lock can remain attached to a pooled PostgreSQL backend after the application client disconnects. That backend may later serve unrelated API queries while still blocking every replacement daemon, leaving the broadcast process unready indefinitely.

**How to apply:**
- Pin one pooler backend by keeping the leadership transaction open for the daemon lifetime.
- Heartbeat the exact bigint lock identity (`classid`, `objid`, `objsubid = 1`) before starting workers; terminate the daemon if ownership or the lock connection is lost.
- On shutdown or startup failure, roll back before releasing the client.
- During migration from a leaked session lock, never issue a generic unlock. Quiesce the old daemon, identify the backend holding the exact key, and recycle only that backend if it is still present.
- DB-backed leader epochs remain optional defense-in-depth for mathematically strict write fencing.