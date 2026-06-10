---
name: ffprobe source validation sprint 86
description: Two new pre-ffprobe validation functions added to the transcoding pipeline; integration points across transcoder.service.ts and faststart.service.ts.
---

## The real production gap

`probeContainerIsValid` reads stream info from the moov atom only — it does NOT touch the mdat payload. A file with valid moov but truncated/bit-corrupted mdat passes the structural probe, enters the HLS encode loop, and fails after 15+ minutes with a decode error. That was the primary failure class.

Secondary gaps: no file-existence guard before ffprobe (zero-byte file = cryptic error vs. clear CORRUPT_SOURCE), no magic-bytes rejection for non-video content (HTML error pages, JSON responses) that slipped the upload MIME gate.

## Two new functions (both in transcoder.service.ts)

### `validateLocalSourceFile(filePath, expectedSizeBytes?)` — exported
- stat check: throws `{ code: "SOURCE_MISSING" }` if file missing/unreadable
- zero-byte guard: throws `{ code: "CORRUPT_SOURCE" }` if size === 0
- min-size guard: throws `{ code: "CORRUPT_SOURCE" }` if size < 1024 bytes
- size cross-check: throws if expectedSizeBytes provided and doesn't match
- magic-bytes: rejects HTML/JSON/ZIP/JPEG/PNG/GIF/PDF/XML/MP3/BMP/WebP with `{ code: "CORRUPT_SOURCE" }`. Unknown MP4 box types (MKV/WebM/TS/AVI) log debug and pass through to ffprobe.

### `probeCanDecodeFirstFrame(inputPath)` — module-private
- `ffmpeg -v error -t 2.0 -i inputPath -vframes 1 -f null -`
- Returns true on exit 0 (frame decoded)
- Returns false on decode error patterns in stderr (explicit corruption signal)
- Fail-open on timeout (30 s) and ffmpeg unavailability (binary missing)
- `mediaCorruptPattern` regex covers: moov atom not found, invalid data found, error decoding, decode_slice_header, no frames decoded, no decodable DTS, Output file is empty, invalid nal unit size, error while decoding MB, bytes read mismatch, corrupted input, End of file

## Integration points

| Callsite | What was added |
|---|---|
| `runTranscode` after download | `validateLocalSourceFile(sourceTempPath)` |
| `runTranscode` after container validation block | `probeCanDecodeFirstFrame(activeSourcePath)` → throws CORRUPT_SOURCE on false |
| `probeUploadedContainerValidity` | 3-stage: Stage 0 validateLocalSourceFile → Stage 1 probeContainerIsValid → Stage 2 probeCanDecodeFirstFrame |
| `probeUploadedDuration` after download | `validateLocalSourceFile(tmpPath)` (non-fatal — inside try/catch returns null) |
| `generateQuickThumbnail` after download | `validateLocalSourceFile(sourceTempPath)` (non-fatal — inside try/catch returns null) |
| `faststart.service.ts` after size checks | `validateLocalSourceFile(inputPath)` — SOURCE_MISSING→DOWNLOAD_TRUNCATED, else CORRUPT_UPLOAD |

## `containerErrorPattern` expansion
Added: `no video stream`, `no streams were found`, `codec not currently supported in container`, `output file is empty`

## Fail-open policy
`probeCanDecodeFirstFrame` always returns true on: timeout, ffmpeg not on PATH, non-zero exit with no known corruption pattern. Only explicit corruption signatures produce false. This ensures no healthy file is permanently rejected by a transient ffmpeg environment issue.

## Edit tool pitfall
When replacing a large function body that contains `} catch` + `} finally` + `}` closing braces, if `new_string` ends before those closing blocks, the tool silently drops them and produces unbalanced braces. Always include the complete catch/finally structure in `new_string`, or use a separate edit to append the missing closing blocks.
