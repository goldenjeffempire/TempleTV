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