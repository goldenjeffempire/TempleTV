---
name: Mobile auth screen mounted guards
description: Auth screens missing mountedRef guards; router.replace() after unmount corrupts the Expo Router stack on iOS swipe-back during in-flight requests.
---

## The rule

Every async handler in an Expo Router screen that calls `router.replace()` / `router.back()` or `setState` after an `await` **must** guard with a `mountedRef`:

```tsx
const mountedRef = useRef(true);
useEffect(() => () => { mountedRef.current = false; }, []);

async function handleSubmit() {
  setLoading(true);
  try {
    await someApiCall();
    if (!mountedRef.current) return;   // ← guard before navigation
    router.replace("/(tabs)");
  } catch (err) {
    if (!mountedRef.current) return;   // ← guard before setState
    setError(err.message);
  } finally {
    if (mountedRef.current) setLoading(false);  // ← guard in finally
  }
}
```

**Why:** On iOS, swipe-back dismisses the screen while a network call is still in-flight. Without the guard, `router.replace()` fires on an already-dismissed route, pushing a stale entry onto the navigator stack that can be extremely difficult to recover from (double tabs, phantom back stack entries). React 18 no longer warns on setState-after-unmount, so it silently swallows the update, but navigation calls are not idempotent.

## Files fixed (June 2026)

- `app/login.tsx` — `handleLogin` + `handleMfaSubmit` (both call `router.replace` after `signIn`)
- `app/signup.tsx` — `handleSignup` (calls `router.replace` after `signIn`)
- `app/forgot-password.tsx` — `handleSubmit` (calls `setSent(true)` after await)
- `app/reset-password.tsx` — `handleSubmit` (calls `setDone(true)` after await)
- `app/change-password.tsx` — `handleSubmit` (calls `Alert.alert` + `setLoading` after await); also needed `useRef`/`useEffect` added to import

## How to apply

When adding any new screen with an async form handler, include the `mountedRef` + cleanup effect boilerplate before the first `await` in the handler.
