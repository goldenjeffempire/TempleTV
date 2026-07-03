---
name: Dead stub worker detection pattern
description: How to spot a scheduled/wired worker whose implementation is a permanent no-op stub, using Temple TV's storage-reconciliation as the concrete example.
---

## The pattern

A worker/service can be fully wired into the scheduler, admin manual-trigger endpoints, and health/stats dashboards, while its actual implementation body is a permanent no-op left over from a prior architecture migration (e.g. old HLS/S3 pipeline code stubbed out during the MP4-only cutover, but never replaced with the new-pipeline-native equivalent).

Symptoms that indicate this:
- The worker's registration comment/log message describes real behavior ("reconciles X against Y and runs recovery for gaps") but the function body is `logger.info("... disabled ...")` or always returns a hardcoded `{ok:false}`/zeroed stats object.
- Admin dashboard stats for that subsystem are always zero/default, never reflecting real state.
- No errors ever appear in logs for that worker — silence is not proof of health; it can mean the code never actually runs the operation it claims to.

## Why it matters

**Why:** These stubs pass builds and boot logs silently (no exceptions — the no-op path is "successful" by definition), so they don't surface as crashes. They're only caught by tracing what a scheduled worker/manual admin action *actually does* line by line, not by watching for errors.

## How to apply

When investigating "is this reconciliation/recovery/self-healing system actually working," don't stop at confirming it's *scheduled* — read the full function body it calls and confirm it performs real DB/storage operations, not a stub. After fixing, verify end-to-end via the manual admin trigger endpoint (if one exists) and confirm a real "pass complete" log line with non-fake stats, not just a clean boot.
