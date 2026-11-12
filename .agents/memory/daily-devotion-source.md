---
name: Official Daily Devotion source
description: Why the website's dedicated daily endpoint must not be replaced with its generic RSS feed.
---

Use the source behind JCTM's actual Daily Devotion page, not the newest RSS item
tagged "Devotionals".

**Why:** The RSS feed includes older blog/sermon posts in that category; it does
not represent the daily devotion shown on the official devotion page. The
verified daily endpoint is `https://jctm.org.ng/api/devotion/daily`.

**How to apply:** Recheck the official page and source contract before changing
the integration. Do not fabricate a featured image or a date-specific permalink:
the observed daily response supplied neither. The public daily page is the
valid fallback reading URL. Its API restricts browser origins, so browser access
needs a fixed same-origin relay; native fetching should remain independent of
the Temple TV backend's availability.

The publisher advertises a 20-request-per-minute rate limit. Keep refreshes
foreground-only, coalesce rapid focus events and retain an explicitly stale
saved copy on source errors rather than pretending it was just refreshed.

**Why:** "Always current" must mean revalidation against the actual publisher;
stacked multi-minute caches can show the wrong daily entry, while unrestricted
per-render requests can exhaust the publisher's limit.
