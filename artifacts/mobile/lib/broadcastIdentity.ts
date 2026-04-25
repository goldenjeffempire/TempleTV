/**
 * Single source of truth for the user-facing broadcast channel identity
 * on the mobile / web surface.
 *
 * Per the Round 9 broadcast-clean directive, the live broadcast surface
 * never exposes a per-program title — it always reads as the channel
 * brand instead. Every site that previously fell back to
 * `liveStatus.title ?? "Temple TV Live"` now imports the constants
 * below so a future identity change happens in one place and propagates
 * everywhere consistently.
 *
 * The matching constant on the TV/Smart-TV surface lives at
 * `artifacts/tv/src/lib/broadcastIdentity.ts` — when changing one,
 * change the other to keep cross-platform parity.
 */

/** Title shown in route params, system "now playing" metadata, share
 *  sheets, and any chrome that needs a label for the live feed. */
export const BROADCAST_TITLE = "Temple TV Live";

/** Slightly more descriptive variant used by the live notification
 *  banner ("LIVE NOW" tease above the hero). */
export const BROADCAST_LIVE_BANNER_TITLE = "Temple TV is LIVE now";

/** Hero headline shown when the channel is live. Replaces the dynamic
 *  `liveStatus.title` so the hero reads as a station landing, not a
 *  sermon-specific landing. */
export const BROADCAST_HERO_TITLE = "Temple TV";

/** Preacher / artist label paired with `BROADCAST_TITLE` in the player
 *  chrome. Reads as the broadcaster identity rather than a sermon-
 *  specific preacher name. */
export const BROADCAST_PREACHER = "Temple TV JCTM";
