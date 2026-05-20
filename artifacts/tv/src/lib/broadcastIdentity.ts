/**
 * Single source of truth for the user-facing broadcast channel identity
 * on the Smart-TV surface.
 *
 * Per the Round 9 broadcast-clean directive, the live broadcast surface
 * never exposes a per-program title — it always reads as the channel
 * brand instead. Every site that previously fell back to
 * `liveStatus.title ?? "Temple TV Live"` now imports the constants
 * below so a future identity change happens in one place and propagates
 * everywhere consistently.
 *
 * The matching constants on the mobile / web surface live at
 * `artifacts/mobile/lib/broadcastIdentity.ts` — when changing one,
 * change the other to keep cross-platform parity.
 */

/** Title shown in route params, the player chrome (when not actively
 *  hidden in live mode), and any label that needs to identify the live
 *  feed. */
export const BROADCAST_TITLE = "Temple TV Live";

/** Hero headline shown on the live landing — matches the mobile/web surface
 *  so all client platforms present the same station identity. */
export const BROADCAST_HERO_TITLE = "Temple TV";
