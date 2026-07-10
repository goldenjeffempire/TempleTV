---
name: expo-modules-core 3.x Coroutine DSL
description: AsyncFunction crossinline lambdas cannot call suspend functions — use AsyncFunctionBuilder.Coroutine infix instead
---

## Rule
In **expo-modules-core 3.x** (Expo SDK 54), ALL `AsyncFunction("name") { ... }` inline overloads declare their lambda as `crossinline`, which **prohibits suspend calls** (Kotlin spec: crossinline lambdas cannot contain suspend function calls).

Using `suspendCancellableCoroutine`, `.await()`, `withTimeout`, or any other suspend function inside `AsyncFunction("name") { ... }` is a **Kotlin compile error** → `EAS_BUILD_UNKNOWN_GRADLE_ERROR`.

## Correct API for suspend bodies
Use the builder pattern with the `Coroutine` infix extension:

```kotlin
import expo.modules.kotlin.functions.Coroutine   // required import

// Zero params:
AsyncFunction("foo") Coroutine {
    mgr.appUpdateInfo.await()  // suspend OK inside Coroutine { }
}

// With params:
AsyncFunction("bar") Coroutine { updateType: Int ->
    mgr.doThing(updateType).await()
}

// Early return — label is @Coroutine, NOT @AsyncFunction:
AsyncFunction("baz") Coroutine {
    val mgr = manager ?: return@Coroutine fallback
    mgr.doWork().await()
}
```

This routes through `AsyncFunctionBuilder.SuspendBody()` → `SuspendFunctionComponent`, which launches the body inside Expo's `modulesQueue` coroutine scope. Cooperative cancellation, `withTimeout`, and all suspend primitives work correctly.

## Non-suspend functions — no change needed
Regular (non-suspend) functions still use the standard inline shorthand:
```kotlin
AsyncFunction("cancelThing") {
    cleanup()
    null
}
```

**Why:** `crossinline` prevents both non-local returns AND suspend calls per Kotlin spec. The `.Coroutine` infix is the intended DSL escape hatch for suspend work in EMC 3.x.

**How to apply:** Every Expo native module function that calls `.await()`, `suspendCancellableCoroutine`, `withTimeout`, or any other suspend fun **must** use `AsyncFunction("name") Coroutine { ... }` syntax. Files fixed: `ExpoInAppUpdatesModule.kt` (checkForUpdate, startUpdate, completeUpdate) and `ExpoPipAndroidModule.kt` (enterPictureInPicture, updatePipParams).
