---
name: Player FSM FATAL backoff base is 10s not 30s
description: FATAL_AUTO_RECOVERY_MS=10_000 in machine.ts; three test files had it wrong as 30s.
---

## Fact

`vendor/player-core/src/machine.ts`:
  FATAL_AUTO_RECOVERY_MS = 10_000   (10 seconds)
  FATAL_BACKOFF_MAX_MS   = 240_000  (4 minutes cap)

Correct schedule (attempts 1–6): 10s → 20s → 40s → 80s → 160s → 240s (cap)

## What was wrong (July 2026)

Three test files hardcoded `const FATAL_AUTO_RECOVERY_MS = 30_000` and used
`vi.advanceTimersByTime(31_000)`. Timer-advance tests still passed (31s > 10s
actual timer), but the backoff schedule assertion tested the WRONG expected
sequence ([30s, 60s, 120s, 240s, 240s]).

Fixed in: tests/machine.test.ts, tests/failover.test.ts, tests/stability.test.ts.
Correct timer sentinel: 11_000 ms (not 31_000).

**Why:** Mismatched constant caused the backoff schedule test to pass for the wrong
formula; future timer-based assertions would fail unexpectedly.
