---
name: Viewer count single source of truth
description: How the dual viewer-counting systems were unified; read before touching viewer counts, ws.gateway.ts, sse.gateway.ts, or viewer-tracking.service.ts.
---

Keep one deduplicated presence authority and one writer to the broadcast
engine's viewer count. Do not introduce a competing raw socket counter.

**Why:** Independent raw transport and heartbeat counters previously raced,
double-counted reconnects, and left the more accurate presence ledger empty.

**How to apply:** Route genuine viewer presence through the tracking service.
Before auto-registering another gateway, check whether that client already
has explicit active-player heartbeats. Mobile intentionally scopes presence
to live playback: catalog navigation, VOD, pause, and background chrome must
not acquire a second viewer session just because broadcast sync stays connected.

A correct server-side count does not guarantee a working mobile badge.
Registration, initial snapshots, live frames, and client state are separate
contracts and must all be connected.

**Why:** The mobile playback transport discarded viewer-count events, omitted
counts from snapshots, and the sync model retained its initial unknown count,
despite the live player already sending presence heartbeats.

**How to apply:** Trace the actual mobile transport, not an older gateway with
similar names. Verify join and leave delivery end to end, including zero and
HTTP/reconnect snapshots, without changing playback position. Keep the mobile
vendored sync implementation aligned with the shared one.
