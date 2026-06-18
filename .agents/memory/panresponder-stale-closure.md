---
name: PanResponder stale closure via useRef.create
description: PanResponder created once in useRef captures outer scope at initial render; changing props/computed values need explicit refs.
---

## The rule

Any value from the enclosing component scope that is read inside a `PanResponder.create({...})` wrapped in `useRef(...)` is **frozen at the render where `useRef` is first initialised** (i.e. the mount render). The responder is never recreated, so the closure never updates.

**Why:** `useRef(value).current` evaluates `value` once (mount), then discards it. Subsequent renders never re-run the initialiser.

## Pattern to fix it

Declare a plain ref **outside** the PanResponder and update it every render (no `useEffect` needed — assignments in the render body are synchronous before paint):

```tsx
const onCloseRef = useRef(onClose);
const sheetHeightRef = useRef(sheetHeight);
onCloseRef.current = onClose;        // updated every render
sheetHeightRef.current = sheetHeight; // updated every render

const panResponder = useRef(
  PanResponder.create({
    onPanResponderRelease: (_e, g) => {
      if (g.dy > sheetHeightRef.current * 0.25 || g.vy > 1.2) {
        onCloseRef.current();   // always the latest onClose
      }
    },
  }),
).current;
```

## How to apply

Check every `useRef(SomeClass.create({...})).current` pattern in the codebase. Any closure inside the factory that reads props, state, or derived values (`useMemo`) is a stale-closure bug.

Affected file: `artifacts/mobile/components/BroadcastLiveSheet.tsx` — `sheetHeight` (changes on device rotation, wrong dismiss threshold) and `onClose` (prop identity could change).
