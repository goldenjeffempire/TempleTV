---
name: isProdNodeEnv TDZ crash pattern
description: Pre-flight block referenced isProdNodeEnv before its declaration in the same function, causing FATAL ReferenceError.
---

## The Bug
`main()` in `main.ts` had a production-readiness pre-flight check at line ~237 that used `isProdNodeEnv`. The variable was declared with `const isProdNodeEnv = ...` at line ~306. JavaScript/TypeScript let/const are in the temporal dead zone (TDZ) between the start of the function and their declaration. Referencing them before declaration throws `ReferenceError: Cannot access 'isProdNodeEnv' before initialization`.

## The Fix
Replace `if (isProdNodeEnv)` in the pre-flight block with `if (env.NODE_ENV === "production")` — uses the already-initialized `env` object instead of the not-yet-declared local variable.

**Why:** `env` is imported at module load time (before `main()` runs) so it is always safe to use. Local `let`/`const` declared later in the same function body are TDZ until their declaration runs.

## How to Apply
Any time a pre-flight or early-in-function block needs to check the environment: use `env.NODE_ENV` directly. Never hoist a check above the variable declaration that would satisfy it.
