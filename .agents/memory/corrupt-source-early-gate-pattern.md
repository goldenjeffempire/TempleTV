---
name: CORRUPT_SOURCE early-gate distinction pattern
description: probeUploadedContainerValidity return type, unrecoverable vs. soft-fail, transcodingErrorMessage surfacing in admin-broadcast
---

## The rule

`probeUploadedContainerValidity` returns `{ valid, unrecoverable?, kind?, error? }`. Early gates ONLY hard-fail (mark `CORRUPT_SOURCE`, skip faststart) when `unrecoverable === true`. Soft-fails (`valid: false, unrecoverable: false`) fall through to faststart's remux strategies.

**Why:** The old gate returned only `{ valid: boolean }` and hard-failed on ANY container issue, blocking recoverable files (mild damage, unusual moov location, fMP4 structure) from reaching faststart's 4 remux strategies. Files with a truly absent moov (confirmed by `detectMdatWithoutMoov`) are genuinely unrecoverable; all other Stage 1 failures may be fixable.

**How to apply:**

- Stage 0 (preflight/magic-bytes) → `unrecoverable: true, kind: "preflight_failed"` — wrong file type can never be remuxed
- Stage 1 structural failure → call `detectMdatWithoutMoov`:
  - `true` → `unrecoverable: true, kind: "moov_absent"` — codec config (SPS/PPS in avcC) is gone
  - `false` → `unrecoverable: false, kind: "structure_invalid"` — faststart remux may recover
- Stage 2 frame-decode failure → `unrecoverable: false, kind: "frame_decode_failed"` — transcoder's `-err_detect ignore_err` may still extract content

**`transcodingErrorMessage` surfacing gap:** `admin-broadcast.routes.ts` originally only fetched `transcodingError` from the *transcoding_jobs* table. For early-gate CORRUPT_SOURCE (no job ever runs), the field was `null`. Fix: also select `videosTable.transcodingErrorMessage` in the `vids` query and pre-populate `hlsMap` entries with it; the jobs-table join then overwrites it only when a job exists.

**Strategy 4 in `remuxForFaststart`:** fMP4 output (`-movflags frag_keyframe+default_base_moof`) added after Strategy 3. Handles action cameras and recording apps that produce moof+mdat-only fMP4 with a minimal/non-standard global moov that Strategies 1–3 reject before reaching the muxer.

**UI tooltip:** `broadcast-v2.tsx` `terminalTitle` for `CORRUPT_SOURCE` now shows `item.transcodingError` (now populated from `managed_videos.transcodingErrorMessage`) when available, so operators see the specific reason instead of a hardcoded moov-absent message for all error kinds.
