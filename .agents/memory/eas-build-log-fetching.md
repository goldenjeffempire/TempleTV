---
name: Fetching full EAS build logs (not just the summary)
description: eas-cli build:view only shows a short status card; the actual phase-by-phase log (needed to diagnose INSTALL_DEPENDENCIES/etc failures) requires downloading and Brotli-decoding the signed logFiles URL.
---

`eas build:view <id> --json` includes a `logFiles: [url]` array. That URL is a GCS v4-signed URL with `X-Goog-Expires=900` (15 min) — fetch it immediately, don't reuse an old one.

The response body is Brotli-compressed (`content-encoding: br`) even though `curl -s` (without `--compressed`) will NOT auto-decompress it — you get raw binary garbage that looks like nothing recognizable (not gzip, not readable text). Decode explicitly:

```js
const zlib = require("node:zlib");
const out = zlib.brotliDecompressSync(rawBytes); // NOT zlib.gunzipSync
```

The decoded body is newline-delimited JSON (bunyan-style), one log event per line, with `phase`, `marker` (`START_PHASE`/`END_PHASE`), `result`, and `err.message`/`err.stack` on failures — grep for `"result":"failed"` or scan for the `err` key to find the actual failure line fast instead of reading the whole thing.

**Why:** wasted several fetch/decode attempts assuming gzip or an expired-URL error before checking the `content-encoding` response header, which gave the answer immediately.

**How to apply:** whenever an EAS build status is `errored` and you need the real cause, get a *fresh* `logFiles[0]` URL, curl it to a file, check `content-encoding` in the response headers, and brotli-decompress if `br`.
