/**
 * Midnight Prayers — time-window unit tests
 *
 * Tests the pure isWindowActive() and getLocalHour() helpers in window-utils.ts.
 * No Fastify, no Drizzle, no DB connection required — these are pure functions.
 *
 * Run with:
 *   node --test --import tsx/esm \
 *     artifacts/api-server/src/modules/midnight-prayers/__tests__/window.test.ts
 *
 * Africa/Lagos is UTC+1 (no DST, year-round). All Lagos timestamps below are
 * constructed using ISO 8601 offset notation (e.g. "2024-01-16T00:00:00+01:00")
 * which Node's Date constructor parses correctly without a third-party library.
 */
export {};
