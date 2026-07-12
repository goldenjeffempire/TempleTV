---
name: lucide-react icon stub — stale pnpm peer-hash path
description: A hardcoded pnpm store path (with a react peer-version hash suffix) used as a build-time workaround will silently break every time the workspace's React version changes.
---

## Lesson

`artifacts/admin/vite.config.ts` has a `lucideIconStubs()` Vite plugin that works
around two icons missing from `lucide-react@0.545.0`'s ESM dist
(`square-dashed-kanban.js`, `square-dashed-mouse-pointer.js`). It located the
real package directory on disk via a **hardcoded pnpm store path**:

```
node_modules/.pnpm/lucide-react@0.545.0_react@19.1.0/node_modules/lucide-react/dist/esm/icons
```

pnpm encodes the resolved peer dependency version into the store directory
name. When the workspace's React version bumped from 19.1.0 to 19.2.0, the
directory renamed itself and the hardcoded path silently stopped resolving —
every `admin` production build failed with `UNLOADABLE_DEPENDENCY` errors that
were easy to misdiagnose as pnpm store corruption (the real symptom looks
identical: `Could not load .../lucide-react@0.545.0_react@19.1.0/.../icons/*.js`).

**Why:** Any workaround that path-references a pnpm virtual-store directory by
its full resolved name (including a peer-hash suffix) is inherently fragile —
it silently rots on the next dependency bump instead of failing loudly at
install time.

**How to apply:** Never hardcode a `node_modules/.pnpm/<pkg>@<version>_<peer>@<peerVersion>/...`
path in source. Resolve packages dynamically instead, e.g.
`createRequire(import.meta.url).resolve("lucide-react/dist/esm/lucide-react.js")`
then derive sibling paths (`path.dirname(...)`) from that. This pattern is
already used correctly elsewhere in the same file for `d3-format`. If you see
an `UNLOADABLE_DEPENDENCY` / "no such file or directory" error mentioning a
pnpm store path with a peer-hash suffix, check for a hardcoded path like this
before assuming store corruption.
