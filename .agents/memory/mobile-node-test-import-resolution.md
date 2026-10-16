---
name: Mobile Node test import resolution
description: Documents the local-module import pattern required by the mobile Node test runner.
---

In mobile Node tests run with `node --import tsx/esm --test`, load local
TypeScript modules with a dynamic import using the emitted `.js` path. Static
imports using either an extensionless path or a `.js` path fail to resolve.

**Why:** The current tsx loader resolves the suite's dynamic `.js` imports to
their TypeScript sources, but its CommonJS-transformed static imports do not.

**How to apply:** Follow the existing `typeof import("../lib/module.js")` plus
`await import("../lib/module.js")` pattern when a mobile Node test needs a
local module.

For a tested module that itself has local static imports, use the full
`node --import tsx --test` registration instead of `tsx/esm` alone. Dynamic
imports in the suite do not fix nested CommonJS-transformed imports. Do not
rewrite production Metro imports solely to work around the partial Node loader.

**Why:** The ESM-only hook resolves the suite but does not register the CommonJS
resolver used by its transitive local dependencies.