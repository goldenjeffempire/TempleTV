---
name: Node startup profiling
description: Interpreting worker-thread profiles and hidden telemetry registration costs during API startup.
---

Do not infer the application's startup CPU usage from a single worker-heavy
Node profile. Preserve distinct per-thread output and inspect the main thread
as well as workers.

**Why:** A fixed profile filename was overwritten by an idle ESM worker's
profile, hiding the main thread's actual startup work and initially misleading
the diagnosis.

**How to apply:** Use distinct/generated filenames whenever profiling a process
with loader or logging workers. Establish which thread a profile represents
before optimizing from it.

Duplicate telemetry globals can be costly even without visible error messages.
Preserve crash reporting while eliminating competing tracing ownership.

**Why:** Profiling showed global-registration diagnostic stack construction
triggering expensive decoding of the large API bundle's source map. Treating
quiet logs as proof that telemetry initialization was harmless missed this.

**How to apply:** When changing observability bootstrap or upgrading its SDKs,
check provider ownership and actual startup work rather than disabling
observability to make the process appear faster.

Use file-based entrypoints for diagnostics that import logging/worker
infrastructure rather than invoking Node with `--input-type=module`.

**Why:** Worker threads inherit Node execution flags. The current logging
worker starts from a file, for which Node rejects the inherited `--input-type`
flag even when the parent legitimately received its script on standard input.

**How to apply:** Run the diagnostic from an `.mjs` file with the appropriate
loader; do not mistake this launcher failure for an application/database fault.
