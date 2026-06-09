---
name: Subagent rate-limit + 429-schema syntax patterns
description: 8 distinct syntax error variants subagents introduce when adding rateLimit configs and 429 schemas to Fastify route files.
---

# Subagent route syntax errors — 8 patterns

When subagents add `rateLimit` + `429` response schemas to many Fastify route files in a single pass,
they introduce these recurring syntax errors. Always do a **global grep-and-fix pass** across the
entire `src/` tree before the first rebuild — do NOT fix incrementally as esbuild surfaces them.

## Pattern A — schema embedded inside config (without comma)
```
config: { rateLimit: { max: X, timeWindow: "Y" } schema: { response: { 429: ... } } },
```
**Fix**: `perl -i -pe 's/ schema: \{ response: \{ 429: z\.object\(\{ error: z\.string\(\) \}\) \} \}(,)/$1/g'`
Then run Pattern B fix to close the now-unclosed config object.

## Pattern B — unclosed config (missing closing `}`)
```
config: { rateLimit: { max: X, timeWindow: "Y" },   ← config { never closed
schema: {
```
**Fix**: `perl -i -pe 's/(rateLimit: \{ max: \d+, timeWindow: "[^"]+" \}),\s*$/$1 },/'`

## Pattern C — schema as second property of config (inline, with comma)
```
{ config: { rateLimit: { max: X, timeWindow: "Y" }, schema: { response: { 429: ... } } }
```
**Fix**: `perl -i -pe 's/(rateLimit: \{ max: \d+, timeWindow: "[^"]+" \}), schema:/$1 }, schema:/g'`

## Pattern D — `.unref()` injected into arrow function parameter
```
setInterval(().unref() => {   or   setTimeout(().unref() => ctrl.abort(),
```
**Fix**: `perl -i -pe 's/\(\)\.unref\(\) =>/() =>/g'` across all `.ts` files.

## Pattern E — stray trailing commas after config block
```
config: { rateLimit: { max: X, timeWindow: "Y" } },     ,
```
**Fix**: remove the extra `     ,` manually or via sed per file.

## Pattern F — unclosed rateLimit (trailing comma, no closing `}`)
```
rateLimit: { max: X, timeWindow: "Y",
},
```
**Fix**: `sed -i 's/rateLimit: { max: X, timeWindow: "Y",$/rateLimit: { max: X, timeWindow: "Y" },/'`

## Pattern G — stray standalone `,` line inside rateLimit object
```
          keyGenerator: jwtUserKey,
       ,          ← spurious
      },
```
**Fix**: remove the stray `,` line; change the closing `},` to `} },` if config is also unclosed.

## Pattern H — extra `},` or `} },};` in rate-limit constant definitions
```
const authRateLimit = {
  rateLimit: { max: 20, timeWindow: "1 minute" } },};
```
**Fix**: change to `rateLimit: { max: 20, timeWindow: "1 minute" },\n};`

## Comprehensive pre-rebuild check commands
```bash
# A/F: schema in config OR unclosed rateLimit
grep -rn 'rateLimit.*} schema: { response:' src/
grep -rn 'rateLimit: { max:.*timeWindow:.*" },' src/ | grep -v '} },'
# B: inline schema-with-comma in config
grep -rn 'rateLimit.*timeWindow.*" }, schema:' src/
# D: unref arrow
grep -rn '()\.unref() =>' src/
# E/G: stray commas
grep -rn '^\s*,$' src/
grep -rn 'timeWindow:.*",$' src/
```

**Why:** These patterns cascade from 5 unique file errors into 30+ broken files across an entire API
codebase. Single-incremental fix loops waste significant time; a global sweep before the first rebuild
prevents that.

**How to apply:** After any multi-file subagent run that adds rate limits, run the check commands
above BEFORE building. Fix with the global perl/sed one-liners, then build once.
