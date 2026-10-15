---
name: MP4 memory pressure controls
description: Storage memory limits and watchdog relief must target the active MP4 pipeline.
---

Memory relief must control the active storage-read path, not assume that retained HLS compatibility exports do useful work.

**Why:** Investigation of production memory alerts found the watchdog's HLS admission function was a no-op after the switch to MP4. Clean startup and successful dynamic imports did not mean load shedding happened.

**How to apply:** Trace relief controls through their implementations when removing or changing a media pipeline. Prefer temporary, automatically expiring admission pauses with retryable responses; preserve heartbeat and metadata probes. Do not change the deliberate no-auto-restart policy without discussing broadcast continuity.

Bound transferred database bytes, not merely the number of fetched rows.

**Why:** A single permanent media chunk can be much larger than a requested range. Fetching the whole BYTEA and taking a Buffer subarray retains the full allocation and adds PostgreSQL decoding overhead.

**How to apply:** Apply SQL-level slicing to both complete and range reads. Test tiny probes, boundary-crossing seeks, truncated data, slow simultaneous consumers, and cancelled reads. Isolated database tests do not establish whole-API stability on the production host.
