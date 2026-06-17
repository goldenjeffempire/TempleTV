---
name: Admin panel accessibility audit
description: Pattern for finding and fixing icon-only buttons missing aria-label in admin SPA; scanning approach and common locations.
---

## Rule
Every `<Button size="icon">` across all admin pages, components, and playback files must have `aria-label="..."` (and optionally `title="..."`).

**Why:** Screen readers announce icon buttons as "button" with no context. aria-label provides the accessible name for keyboard and AT users.

**How to apply:** Use a 20-line windowed Python grep (not a same-line grep) since aria-label is always on a separate line from `size="icon"` in multi-line JSX:
```python
for i, line in enumerate(lines):
    if 'size="icon"' in line:
        window_text = "".join(lines[max(0,i-20):min(len(lines),i+20)])
        if "aria-label" not in window_text:
            # MISSING
```

Skip `calendar.tsx` and `sidebar.tsx` (shadcn/ui vendored files).

## Locations fixed in comprehensive audit
- All `artifacts/admin/src/pages/*.tsx` (15+ files)
- `artifacts/admin/src/components/upload/UploadQueuePanel.tsx`
- `artifacts/admin/src/components/layout/header.tsx` (already had them)
- `artifacts/admin/src/playback/BroadcastPreviewV2.tsx` (PiP button — aria-label is 16+ lines below size="icon" due to long onClick)

## Page structure conventions confirmed
- All pages use `PageHeader` from `@/components/shared/page-header` (except login.tsx, not-found.tsx which are special layouts)
- Error handling: either `{error && <ErrorAlert ...>}` OR inline `isError ? (<error-ui>)` inside card OR `.catch(() => null)` graceful degradation
- Toasts: all use `import { toast } from "sonner"` — zero `useToast` imports remain in pages/components
