---
name: HLS OOM memory math — pg BYTEA hex string V8 heap overhead
description: Root cause and fix for 2GB OOM crash from HLS_MAX_CONCURRENT interaction with pg BYTEA hex strings in V8 heap, plus production memory threshold misconfiguration.
---

## The bug

Production hit "Ran out of memory, used over 2GB" because of three compounding issues.

## Root causes

### 1. pg BYTEA hex string overhead (V8 heap)

The pg driver decodes BYTEA columns via hex at the text-protocol level. For an 8 MiB HLS segment:
- Wire data = 16 MiB hex string → allocated in **V8 heap** (not external)
- Decoded Buffer = 8 MiB → external memory
- Per concurrent request: **16 MiB V8 + 8 MiB external**

With `HLS_MAX_CONCURRENT=30` and `--max-old-space-size=460`:
- 30 × 16 MiB = 480 MiB > 460 MiB V8 heap cap → GC thrashing / OOM

**Fix**: Lower `HLS_MAX_CONCURRENT` default from 30 → 10 in `env.ts`. Override explicitly in the Start API workflow command (`HLS_MAX_CONCURRENT=10`) because Replit env var was set to 30 and would win over the code default.

Safe formula: `N × 16 MiB ≤ 80% of --max-old-space-size`
- 460 MiB heap → max 23, safe 10
- 900 MiB heap → max 45, recommended 20

### 2. Production memory thresholds inverted

`.replit` deployment had:
```
MEMORY_WARN_RSS_MB=1500  MEMORY_RESTART_RSS_MB=600  --max-old-space-size=1280
```

The watchdog uses `Math.max(RESTART, WARN) = 1500 MB` as effective restart point. With V8 cap 1280 MB + external, RSS could reach 1500 MB, then:
- Old process: 1500 MB (draining, ~15–20 s)
- New process starting: 400–500 MB
- Total overlap: ~2000 MB → OOM

**Fix**: Changed to `MEMORY_WARN_RSS_MB=1000, MEMORY_RESTART_RSS_MB=1400, --max-old-space-size=900, HLS_MAX_CONCURRENT=20` in production deployment run command.

Math: 900 MB V8 + 20×8 MB external + 100 MB native = ~1160 MB peak. Threshold 1400 MB. Restart overlap: 1400 + 400 = 1800 MB < 2 GB ✓

### 3. Workflow rebuilt on every watchdog restart

The "Start API" workflow ran `pnpm --filter @workspace/api-server run build` every restart. Three esbuild bundles + 36 MB source maps ≈ 500 MB build spike combined with Admin Vite (400 MB) → 2 GB+ container.

**Fix**: `scripts/build-if-changed.sh` — skips rebuild if `dist/index.mjs` is newer than all `.ts` files in `artifacts/api-server/src` and `lib/`. Workflow now calls `bash scripts/build-if-changed.sh` instead.

## Additional hardening

- `artifacts/api-server/build.mjs`: openapi bundle now has `sourcemap: false` — saves ~12 MiB output, cuts build peak RSS by ~1/3 (openapi script is dev-only codegen, never loaded at runtime)
- `video-serve.routes.ts` startup block: infers V8 heap cap from `process.execArgv` (`--max-old-space-size=N`), logs ERROR if `N×16 MiB > 80% of V8 cap`, logs WARN if `estimatedPeakRssMb > effectiveRestartMb`, logs INFO if budget OK

## Why

The V8 hex-string cost was completely undocumented in the codebase. The old comment only counted the 8 MiB external Buffer and missed the transient 16 MiB V8 string — exactly 2× undercounting. The production threshold inversion (RESTART < WARN) was masked by the `Math.max` guard in `memory-watchdog.ts` which silently uses the higher value, causing the process to never restart until RSS hit 1500 MB.

## How to apply

- Before raising `HLS_MAX_CONCURRENT`: verify `N × 16 ≤ 0.8 × --max-old-space-size`. The startup check in `video-serve.routes.ts` will ERROR if violated.
- When setting `MEMORY_RESTART_RSS_MB`: must be > steady-state RSS but < (container RAM − 600 MB) to leave room for restart overlap.
- `scripts/build-if-changed.sh` will auto-rebuild if any `.ts` source is newer than `dist/index.mjs`; to force a rebuild, `touch artifacts/api-server/src/main.ts`.
