/**
 * Chat moderation primitives.
 *
 * - Sanitization: strip HTML, normalize whitespace, cap length, reject empty
 * - Profanity: minimal word list, replaced with `***` (don't reject — that
 *   trains spammers; quietly mask)
 * - Per-session token bucket: 5 messages per 10s burst, refill 1 / 2s
 * - Duplicate guard: identical body within 30s on the same session ⇒ reject
 * - Active mute/ban lookup with a small in-memory TTL cache so the WS hot
 *   path doesn't hammer the DB
 *
 * The bucket and dup-guard live in-memory and are scoped to this process.
 * Multi-instance fairness can come for free once the chat bus has a Redis
 * adapter (use SETEX-backed counters); single-instance is the only target
 * today.
 */

import { db, chatModerationTable } from "@workspace/db";
import { and, eq, gt, isNull, or } from "drizzle-orm";

// ── 1. Sanitization ────────────────────────────────────────────────────────

const MAX_BODY_LEN = 500;

const HTML_TAG_RE = /<[^>]*>/g;
// Zero-width + bidi-control characters spammers love.
const ZW_RE = /[\u200B-\u200F\u202A-\u202E\uFEFF]/g;
// Collapse repeated whitespace including newlines so chat stays single-line-ish.
const WS_COLLAPSE_RE = /\s+/g;

export interface SanitizeResult {
  body: string;
  reason?: "empty" | "too_long";
}

export function sanitizeBody(raw: unknown): SanitizeResult {
  if (typeof raw !== "string") return { body: "", reason: "empty" };
  let s = raw.normalize("NFKC");
  s = s.replace(HTML_TAG_RE, "");
  s = s.replace(ZW_RE, "");
  s = s.replace(WS_COLLAPSE_RE, " ").trim();
  if (s.length === 0) return { body: "", reason: "empty" };
  if (s.length > MAX_BODY_LEN) return { body: s.slice(0, MAX_BODY_LEN), reason: "too_long" };
  return { body: s };
}

// ── 2. Profanity (minimal, configurable) ──────────────────────────────────
// Intentionally tiny — broad lists trigger Scunthorpe-problems on a faith
// platform with international viewers. Operators can extend via the env
// var `CHAT_PROFANITY_LIST=word1,word2,...` without redeploying code.

const BUILTIN_PROFANITY = ["fuck", "shit", "bitch", "asshole", "cunt"];
const ENV_PROFANITY = (process.env.CHAT_PROFANITY_LIST ?? "")
  .split(",")
  .map((w) => w.trim().toLowerCase())
  .filter(Boolean);
const PROFANITY = Array.from(new Set([...BUILTIN_PROFANITY, ...ENV_PROFANITY]));
const PROFANITY_RE = PROFANITY.length
  ? new RegExp(`\\b(${PROFANITY.join("|")})\\b`, "gi")
  : null;

export function maskProfanity(body: string): string {
  if (!PROFANITY_RE) return body;
  return body.replace(PROFANITY_RE, (m) => "*".repeat(m.length));
}

// ── 3. Per-session token bucket ───────────────────────────────────────────

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const BUCKET_CAP = 5;
const REFILL_INTERVAL_MS = 2_000;
const buckets = new Map<string, Bucket>();
// Reap idle buckets so a steady churn of anonymous viewers doesn't leak.
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, v] of buckets) {
    if (v.lastRefillMs < cutoff) buckets.delete(k);
  }
}, 60_000).unref();

export function tryConsumeToken(sessionId: string): {
  ok: boolean;
  retryAtMs?: number;
} {
  const now = Date.now();
  let b = buckets.get(sessionId);
  if (!b) {
    b = { tokens: BUCKET_CAP, lastRefillMs: now };
    buckets.set(sessionId, b);
  }
  // Refill since last touch.
  const elapsed = now - b.lastRefillMs;
  if (elapsed > 0) {
    const refill = Math.floor(elapsed / REFILL_INTERVAL_MS);
    if (refill > 0) {
      b.tokens = Math.min(BUCKET_CAP, b.tokens + refill);
      b.lastRefillMs += refill * REFILL_INTERVAL_MS;
    }
  }
  if (b.tokens <= 0) {
    const retryAtMs = b.lastRefillMs + REFILL_INTERVAL_MS;
    return { ok: false, retryAtMs };
  }
  b.tokens -= 1;
  return { ok: true };
}

// ── 4. Duplicate guard ────────────────────────────────────────────────────

interface LastMsg {
  body: string;
  atMs: number;
}
const DUP_WINDOW_MS = 30_000;
const lastMsgs = new Map<string, LastMsg>();
setInterval(() => {
  const cutoff = Date.now() - DUP_WINDOW_MS * 2;
  for (const [k, v] of lastMsgs) if (v.atMs < cutoff) lastMsgs.delete(k);
}, 60_000).unref();

export function isDuplicate(sessionId: string, body: string): boolean {
  const prev = lastMsgs.get(sessionId);
  const now = Date.now();
  if (prev && prev.body === body && now - prev.atMs < DUP_WINDOW_MS) return true;
  lastMsgs.set(sessionId, { body, atMs: now });
  return false;
}

// ── 5. Active mute/ban lookup with TTL cache ──────────────────────────────

export type ModerationDecision =
  | { ok: true }
  | {
      ok: false;
      action: "mute" | "ban";
      expiresAtMs: number | null;
      reason: string | null;
    };

const CACHE_TTL_MS = 10_000;
interface CacheEntry {
  decision: ModerationDecision;
  fetchedAtMs: number;
}
const decisionCache = new Map<string, CacheEntry>();

function cacheKey(subjectKind: "user" | "ip", subjectId: string): string {
  return `${subjectKind}:${subjectId}`;
}

export function invalidateModerationCache(
  subjectKind: "user" | "ip",
  subjectId: string,
): void {
  decisionCache.delete(cacheKey(subjectKind, subjectId));
}

/**
 * Returns the strictest active action against a subject. Bans dominate mutes
 * (a banned user can't post; their mute is moot).
 */
export async function lookupModeration(
  subjectKind: "user" | "ip",
  subjectId: string,
): Promise<ModerationDecision> {
  const key = cacheKey(subjectKind, subjectId);
  const cached = decisionCache.get(key);
  const now = Date.now();
  if (cached && now - cached.fetchedAtMs < CACHE_TTL_MS) {
    // Re-validate expiry on cached miss-decisions only — a cached "ok"
    // remains "ok"; a cached "blocked" might have expired in the window.
    if (cached.decision.ok) return cached.decision;
    if (
      cached.decision.expiresAtMs !== null &&
      cached.decision.expiresAtMs <= now
    ) {
      // Expired — fall through to DB.
    } else {
      return cached.decision;
    }
  }

  const rows = await db
    .select()
    .from(chatModerationTable)
    .where(
      and(
        eq(chatModerationTable.subjectKind, subjectKind),
        eq(chatModerationTable.subjectId, subjectId),
        or(
          isNull(chatModerationTable.expiresAt),
          gt(chatModerationTable.expiresAt, new Date(now)),
        ),
      ),
    );

  let decision: ModerationDecision = { ok: true };
  // Bans dominate.
  const ban = rows.find((r: typeof rows[number]) => r.action === "ban");
  const mute = rows.find((r: typeof rows[number]) => r.action === "mute");
  const winner = ban ?? mute;
  if (winner) {
    decision = {
      ok: false,
      action: winner.action as "mute" | "ban",
      expiresAtMs: winner.expiresAt ? winner.expiresAt.getTime() : null,
      reason: winner.reason ?? null,
    };
  }
  decisionCache.set(key, { decision, fetchedAtMs: now });
  return decision;
}

// ── 6. IP hashing (avoids storing raw IPs in chat tables) ─────────────────

import { createHash } from "node:crypto";

export function hashIp(ip: string): string {
  // 16 hex chars (64-bit) is plenty for ban-by-IP correlation while
  // staying short enough not to inflate every chat row.
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}
