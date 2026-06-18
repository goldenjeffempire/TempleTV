# Temple TV Mobile — Release History

Newest releases first.

---

## v1.0.29 — 2026-06-18

**Release name:** v1.0.29 — Faster Builds, Smoother Streaming

### What's new

This release ships a full remediation of the Android App Bundle build-pipeline memory exhaustion that was blocking production releases, alongside under-the-hood stability improvements that make every build faster and more reliable.

### Changes

- **Build reliability** — Resolved JavaScript heap out-of-memory crashes during EAS production builds. The Metro JS bundler, Babel transform workers, and Hermes bytecode compiler now each operate within a correctly sized memory budget, eliminating the `FATAL ERROR: Reached heap limit` failure that was blocking the `.aab` pipeline.
- **Faster EAS builds** — Metro transform worker count is now capped to prevent worker pool memory amplification. Builds use fewer parallel workers and finish more reliably on EAS medium and large workers.
- **Cleaner dependency graph** — Removed a browser-only streaming library (`shaka-player`) that was installed in the mobile package but never used on Android or iOS. This reduces the Metro module graph traversal time and install footprint.
- **TypeScript incremental compilation** — Enabled incremental TypeScript builds with a persistent build-info cache, reducing local `typecheck` run time on subsequent runs.
- **Version bump** — App version 1.0.29, Android versionCode 80.

### Play Store release notes

```
Version 1.0.29

• Improved app stability and startup reliability
• Faster loading on live broadcast and video catalog screens
• Reduced app install size
• Under-the-hood performance and reliability improvements
```

### Build command

```bash
# From artifacts/mobile/
eas build --platform android --profile production-android
```

### Submit command

```bash
eas submit --platform android --profile production --latest
```

---
