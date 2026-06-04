---
name: SOURCE_MISSING terminal transcode error code
description: A missing source blob is a permanent transcode failure that must be classified terminal like CORRUPT_SOURCE, not left as a generic retryable failure.
---

# SOURCE_MISSING terminal error code

When `storage().getObject()` can't find a blob it throws `Object not found in storage: <key>`. At transcode time this is **permanent** (PG-backed blob store — an absent row means the object is genuinely gone/orphaned/GC'd, not eventual-consistency), so it must be treated as a terminal failure that requires re-upload — exactly parallel to `CORRUPT_SOURCE`.

**Why:** Before this, a missing-source failure matched none of the dispatcher's terminal branches (not corrupt-pattern, not ENOSPC, not connection/storage-error), so it ended as `status='failed'` with `transcodingErrorCode=null` → treated as retryable. Result: `retryAllFailed`/`retryJob` churned it through retry budgets every time, and the validator's UNPLAYABLE_CORRUPT_UPLOAD auto-fix (gated on `CORRUPT_SOURCE || !faststart`) could leave it active in broadcast.

**How to apply:** Any new permanent (non-transient) transcode failure class needs the SAME parallel set of edits CORRUPT_SOURCE / SOURCE_MISSING use. Miss one and you get retry churn or a video stuck in broadcast:
1. Tag the throwing error with a typed `code` (storage getObject) — primary signal.
2. Dispatcher classification: add `isXxx` (typed code OR a specific message regex), include in `isImmediateFail`, EXCLUDE from `isStorageError`, and set `transcodingErrorCode`.
3. `retryAllFailed` (SQL `NOT IN`) and `retryJob` (inArray guard) exclusion.
4. `auto-enqueue.service.ts`: SQL pre-filter `NOT IN` + `isPlayableForBroadcast()` early-return false.
5. `queue-integrity-validator.ts`: UNPLAYABLE_CORRUPT_UPLOAD detection + auto-fix deactivation filter. The reverse pass keys on `validator_deactivated_reason='corrupt_upload'` + `hls_master_url IS NOT NULL`, so a later re-upload that produces HLS auto-re-activates — no extra change needed.
6. `admin-videos` reset-for-reupload route: accept the new code.

**Important boundary:** only LOCAL storage misses are terminal. Remote prod-sync source downloads fail with a DIFFERENT message (`remote source download failed — <status>`) and must stay retryable — upstream may be briefly down. The `/object not found in storage/i` regex deliberately does not match the remote message.

**Honest limit:** classification only makes the system HANDLE these videos cleanly (no churn, clean deactivation, clear "re-upload required" messaging, re-uploadable via reset route). It cannot resurrect a video whose source blob is gone — that needs a fresh re-upload or deletion (a data action, not a code fix).
