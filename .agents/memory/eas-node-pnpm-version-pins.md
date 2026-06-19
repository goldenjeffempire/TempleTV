
## Update — UNKNOWN_ERROR / empty artifacts pattern

If EAS build shows `UNKNOWN_ERROR` at Install dependencies AND `artifacts: {}` (no log file at all), the build worker crashed before logging started. Root cause: the requested Node version (e.g. `"24.1.0"`) is not available in EAS's nvm image for that worker class.

**Contrast with the pnpm-engines error**: that failure produces log output ("ERR_PNPM_UNSUPPORTED_ENGINE", "Got: 8.7.5") because the worker DID start and pnpm ran briefly. Empty artifacts = worker never ran.

**Safe confirmed versions on EAS as of June 2026:**
- `"node": "22.14.0"` — confirmed available, produces log output on failure
- `"pnpm": "9.15.9"` — pnpm 9 reads lockfileVersion 9.0 (same as pnpm 10); lower engines to `>=9.0.0`

**Do NOT use `"node": "24.1.0"` in eas.json** — causes silent worker crash (UNKNOWN_ERROR, empty artifacts).
