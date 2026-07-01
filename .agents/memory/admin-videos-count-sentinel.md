---
name: Admin videos list total=-1 sentinel
description: Why the admin Videos header can show a negative count, and the rule to prevent it.
---

# Admin videos list `total = -1` sentinel

The `GET /admin/videos` list endpoint returns `total: -1` (and `totalPages: -1`)
as a **sentinel** whenever it runs in keyset/cursor mode (it deliberately skips
the `COUNT(*)` query for performance on deep pages).

**The trap:** cursor mode is enabled for the default `newest` (and `oldest`)
sort. Because the offset-fallback only engages on `page > 1`, **page 1 of the
default sort always entered cursor mode → COUNT skipped → `total: -1`**. The
admin Videos page header rendered that raw as "-1 locally uploaded videos".

**Rule / decision:**
- Server: run `COUNT(*)` on **page 1** even in cursor mode (page 1 applies no
  cursor filter and offset 0, so `COUNT(*)` equals the true library total; it is
  cheap and client-cached). Only skip COUNT on deep cursor pages (`page > 1`).
- Client: **never render `total` when it is negative.** Any UI count-render site
  must treat `total < 0` as "unknown" and fall back (e.g. loaded rows length).

**Why:** the -1 is an intentional server sentinel, not a bug — but every
consumer must interpret it. New count/pagination UI that reads `total` directly
will re-introduce the negative-count display on deep cursor pages.
