---
name: Broadcast daemon leadership through transaction poolers
description: Pooler-safe singleton leadership and controlled migration away from leaked session advisory locks.
---

## Rule

When PostgreSQL is reached through a transaction pooler, daemon leadership must use a dedicated checked-out client, an open transaction, and `pg_try_advisory_xact_lock`. Keep the transaction active with an exact-key heartbeat. On normal shutdown attempt a bounded rollback, then destroy the dedicated connection; on failure destroy it rather than returning an uncertain transaction to the pool.

**Why:** A session-level advisory lock can remain attached to a pooled PostgreSQL backend after the application client disconnects. That backend may later serve unrelated API queries while still blocking every replacement daemon, leaving the broadcast process unready indefinitely.

**How to apply:**
- Pin one pooler backend by keeping the leadership transaction open for the daemon lifetime.
- Heartbeat the exact bigint lock identity (`classid`, `objid`, `objsubid = 1`) before starting workers; terminate the daemon if ownership or the lock connection is lost.
- Bound both server execution and client/network waits. A startup-wide deadline is needed even when the process has already opened a health socket.
- A rollback must not become an unbounded wait during connection failure. Close the owned client; never release it into the pool with an uncertain open transaction.
- During migration from a leaked session lock, never issue a generic unlock. Quiesce the old daemon, identify the backend holding the exact key, and recycle only that backend if it is still present.
- DB-backed leader epochs remain optional defense-in-depth for mathematically strict write fencing.

## Do not confuse an invisible leader with a stale lock

A lock owner can keep sending valid heartbeats even when the replacement service
is Live but unready and no second service appears in the current Render list.

**Why:** Service-list visibility and process readiness do not establish whether a
database lock has been abandoned. Terminating a still-active owner can create
competing timelines or interrupt a legitimate broadcaster.

**How to apply:** Read the exact lock's activity twice across a heartbeat
interval, without changing sessions. Identify the owning runtime before any
controlled handoff. Mark leadership transactions with service identity so future
diagnosis does not rely on a generic API application name.

Render can have separate services with the same display name, both receiving
deployments from the same repository.

**Why:** A replacement daemon remained blocked while another same-named service
held leadership, and the API was configured to contact the blocked replacement.

**How to apply:** Compare Render service IDs in GitHub deployment-status links,
the lock owner's service identity, and the API's configured internal destination.
Before changing the destination, verify the intended leader's readiness from the
API service's private network. Do not treat a successful deployment as readiness.