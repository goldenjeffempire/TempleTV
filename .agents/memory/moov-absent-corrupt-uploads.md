---
name: Moov-absent corrupt uploads — diagnosis and transcoder hardening
description: Root cause of "moov atom missing and stream-copy remux failed" transcoding failures; unrecoverable class; code improvements made.
---

## The unrecoverable container class

MP4 files uploaded with container structure `ftyp → free → mdat (no moov)` are **permanently unrecoverable**. This happens when a recording or export is interrupted before the moov atom is written (common in live-record workflows). The H.264 AVCC data inside mdat has **no inline SPS/PPS** — codec parameters live exclusively in the moov's `avcC` box. Without moov, ffmpeg can't decode, copy, or re-encode the file. No remux strategy helps.

**How to confirm:** `ffprobe` reports `moov atom not found`. File hex starts `ftyp … mdat` with no `moov` box in the first 64 KB OR at EOF. First NAL unit in mdat is SEI or IDR with no preceding SPS/PPS.

## What was fixed

- **`detectMdatWithoutMoov(inputPath)`** added to `transcoder.service.ts`: reads first 64 KB, parses top-level MP4 box headers, returns `true` when mdat is present but moov is completely absent. Called in both `runTranscode` (skips all remux, gives clear error) and `faststart.service.ts` (throws `CORRUPT_UPLOAD` immediately).
- **`remuxForFaststart`** upgraded from 1 strategy to 3 sequential strategies: (1) `-c copy -movflags +faststart`, (2) `-fflags +genpts+discardcorrupt -err_detect ignore_err -c copy -movflags +faststart`, (3) same without faststart. Helps mildly-corrupt containers (moov at EOF, DTS gaps) but cannot fix absent moov.
- **Early container gate** added in `chunked-upload.routes.ts` finalize path: `probeUploadedContainerValidity` runs before `runFaststart`. If invalid → immediately sets `transcodingStatus = failed`, skips faststart+transcoder. Closes the `DOWNLOAD_TRUNCATED` bypass where faststart's download truncation (non-fatal) previously let corrupt uploads through to the HLS transcoder.

## Operator action for unrecoverable uploads

Re-upload from the original source file. If the source on the recording device is also corrupt (missing moov), use HandBrake or `ffmpeg -i input -c copy output` locally to verify the file is playable before re-uploading.

**Why:** The stored blob cannot be recovered. The codec configuration is permanently lost.
