---
name: Mobile↔API contract-mismatch bug class
description: How to audit and fix cases where the mobile client and API route schema disagree about a field's meaning or presence.
---

Two recurring sub-patterns found during a full mobile+backend audit (July 2026):

1. **Accepted-but-ignored field.** The client (`authApi.ts`) built a request body with an extra field (`everywhere` on `/api/auth/logout`) and the server's zod schema didn't reject it, but the service function never read it — the feature silently no-op'd instead of erroring, which is worse than a validation failure because nothing surfaces the gap. Grep isn't enough here: schema acceptance ≠ business-logic wiring. Verify the *service* function actually consumes every field the route schema declares.

2. **Conditionally-required field with no client escape hatch.** `/api/auth/password` requires `totpCode` when the account has MFA enabled, but the mobile change-password screen never collected or sent it — MFA users hit a permanent dead end (a 401 with no UI to recover). Fix pattern: give the client a dedicated error subclass keyed off the exact server error condition (status + message match), and add a second UI step to collect the missing input and retry — don't just surface the raw error string.

**How to apply:** when auditing a mobile app against its backend, don't stop at "does the request succeed" — trace each optional/conditional field on both sides and confirm (a) the server actually uses it, and (b) the client has a real path to supply it when required.
