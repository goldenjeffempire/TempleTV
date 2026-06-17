---
name: moov tail-scan false-positive CORRUPT_SOURCE
description: detectMdatWithoutMoov + premature bail caused ALL moov-absent videos to permanently fail before remux ran; full pipeline fix applied.
---

# moov-absent premature-terminal and remux bypass

## The rules

1. **`detectMdatWithoutMoov` must never be a bail-out gate** — it is diagnostic only. Always fall through to `remuxForFaststart` regardless of what it returns.

2. **`probeUploadedContainerValidity`** must return `unrecoverable: false` for `kind: "moov_absent"`. Only `kind: "preflight_failed"` (non-video file type) is truly unrecoverable at that stage.

3. **`remuxForFaststart` now has 5 strategies** — S1–S4 unchanged; S5 adds `-analyzeduration 500M -probesize 500M` extended probe for large/late moov atoms.

4. **When faststart throws `CORRUPT_UPLOAD`**, the finalize handler must NOT set `skipTranscodeEnqueue = true`. Reset `transcodingStatus = "none"`, deactivate broadcast queue, and let the HLS transcoder attempt independently with a fresh download.

**Why:** Four independent premature-termination points caused ALL moov-absent videos to permanently fail:
- (A) `probeUploadedContainerValidity` returned `unrecoverable: true` → finalize bailed before faststart ran
- (B) `faststart.service.ts` bailed on `mdatNoMoov` before calling `remuxForFaststart`
- (C) `runTranscode` in `transcoder.service.ts` bailed on `mdatNoMoov` before calling `remuxForFaststart`
- (D) Finalize handler set `skipTranscodeEnqueue = true` on `CORRUPT_UPLOAD`, blocking the HLS transcoder

**How to apply:** Never add new early-bail paths in the moov-detection flow. The contract is: detect → log → attempt → fail only when exhausted.

## Retry guard (unchanged)
`retryJob` and `retryAllFailed` allow CORRUPT_SOURCE when `objectPath IS NOT NULL`. Existing failed production videos can be recovered by clicking "Retry Transcoding" — they now run all 5 remux strategies.

## S5 extended probe
`-analyzeduration 500M -probesize 500M` allows ffmpeg to scan up to 500 MB into the file to find the moov atom. Covers long H.264 sermon recordings where the moov is 1–5 MiB in size and positioned beyond the default 5 MB probesize window.
