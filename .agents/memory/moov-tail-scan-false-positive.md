---
name: moov tail-scan false-positive CORRUPT_SOURCE
description: detectMdatWithoutMoov 64 KiB tail scan misses large moov atoms at EOF, causing false CORRUPT_SOURCE on long sermon recordings.
---

# moov tail-scan false-positive CORRUPT_SOURCE

## The rule
`detectMdatWithoutMoov` must use a full-file ffprobe probe for the moov check, NOT a fixed-size tail byte-scan.

**Why:** H.264 sermon recordings (30+ min) with B-frames have moov atoms of 1–5 MiB (ctts + stsz sample tables). The moov box HEADER (which contains the "moov" type bytes) is at the START of the atom, so for a 2 MiB moov at EOF the header is 2 MiB from the end — far outside a 64 KiB tail window. This caused three production videos to receive false `CORRUPT_SOURCE` classifications and become stuck.

**How to apply:** The front scan (64 KiB, box-boundary parser) still correctly handles moov-at-front and confirms mdat presence. When mdat is found but moov is not at front, use `ffprobe -v error -show_entries stream=codec_type -of csv=p=0 <file>` (no -read_intervals) for the full-container check. Only return true (unrecoverable) when ffprobe exits non-zero AND stderr matches `/moov atom not found|Invalid data found|no streams were found/i`. All other outcomes (streams found, exit 0 no streams, process error) return false so remux can try.

## Retry guard change
`retryJob` and `retryAllFailed` were updated to allow CORRUPT_SOURCE jobs when `objectPath IS NOT NULL` (source still in storage). Only SOURCE_MISSING and CORRUPT_SOURCE-with-no-objectPath are permanently excluded. This unblocks false-positive CORRUPT_SOURCE videos after the detection fix is deployed.
