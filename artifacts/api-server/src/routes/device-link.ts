import { Router } from "express";
import { z } from "zod";
import { and, eq, isNull, lt, isNotNull } from "drizzle-orm";
import { randomBytes } from "crypto";
import { db, deviceLinkCodesTable } from "@workspace/db";
import { requireAuth, issueAuthTokens, ACCESS_TOKEN_TTL_SECONDS } from "../middlewares/requireAuth";

const router = Router();

// Codes live 10 minutes. Long enough for a user to grab their phone,
// short enough that an exposed code is useless after a coffee break.
const CODE_TTL_MS = 10 * 60 * 1000;
// Exchange polling continues until the user claims the code; once
// claimed-and-consumed, the row is purged so the same code can never
// be reused.
const CONSUMED_TTL_MS = 5_000;

// Avoid visually-ambiguous characters (no 0/O, 1/I/L) so users can
// read codes off a TV across a living room without errors. 32 chars.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function generateCodeSegment(len: number): string {
  // crypto.randomBytes for unbiased selection — no Math.random.
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return out;
}

function getClientIp(req: import("express").Request): string | null {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) return fwd.split(",")[0]!.trim().slice(0, 64);
  return (req.socket.remoteAddress ?? null)?.slice(0, 64) ?? null;
}

const CreateBody = z.object({
  deviceLabel: z.string().min(1).max(80).optional(),
});

/**
 * Create a fresh device-link code. Anonymous endpoint — the device
 * has no credentials yet. Retries on collision with the unique PK,
 * which is statistically near-impossible (32^8 ≈ 1 trillion codes,
 * 10-min lifetime), but we handle it for robustness.
 */
router.post("/auth/device-link/create", async (req, res) => {
  const parsed = CreateBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  const ip = getClientIp(req);

  // Best-effort cleanup: drop expired and consumed-stale rows on the
  // hot path so the table never grows unbounded.
  db.delete(deviceLinkCodesTable)
    .where(lt(deviceLinkCodesTable.expiresAt, new Date()))
    .catch(() => {});

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = `${generateCodeSegment(4)}-${generateCodeSegment(4)}`;
    try {
      await db.insert(deviceLinkCodesTable).values({
        code,
        expiresAt,
        deviceLabel: parsed.data.deviceLabel ?? null,
        ip,
      });
      res.status(201).json({
        code,
        expiresIn: Math.floor(CODE_TTL_MS / 1000),
        expiresAt: expiresAt.toISOString(),
      });
      return;
    } catch (err: any) {
      // Unique-violation on PK. Retry with a fresh code.
      if (err?.code === "23505") continue;
      throw err;
    }
  }

  res.status(503).json({ error: "Could not generate a unique code, please retry" });
});

const ClaimBody = z.object({
  code: z
    .string()
    .min(8)
    .max(10)
    .transform((s) => s.toUpperCase().replace(/\s+/g, "")),
});

/**
 * Claim a code with the authenticated user. The TV will see this
 * via its next /exchange poll. Codes can only be claimed once.
 */
router.post("/auth/device-link/claim", requireAuth, async (req, res) => {
  const parsed = ClaimBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Enter the code shown on your TV" });
    return;
  }
  const userId = req.user!.id;
  const code = parsed.data.code.includes("-")
    ? parsed.data.code
    : `${parsed.data.code.slice(0, 4)}-${parsed.data.code.slice(4)}`;

  // Conditional update: only succeeds on a still-pending, non-expired,
  // unclaimed row. Returning lets us tell the user precisely what
  // went wrong (expired vs already-claimed vs typo).
  const claimed = await db
    .update(deviceLinkCodesTable)
    .set({ userId, claimedAt: new Date() })
    .where(
      and(
        eq(deviceLinkCodesTable.code, code),
        isNull(deviceLinkCodesTable.claimedAt),
        isNull(deviceLinkCodesTable.consumedAt),
        // expiresAt > now()
        // Drizzle requires a column-vs-column or column-vs-value comparison.
      ),
    )
    .returning({
      code: deviceLinkCodesTable.code,
      expiresAt: deviceLinkCodesTable.expiresAt,
    });

  if (claimed.length === 0) {
    // Disambiguate: was it a wrong code, expired, or already claimed?
    const [row] = await db
      .select()
      .from(deviceLinkCodesTable)
      .where(eq(deviceLinkCodesTable.code, code))
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "That code isn't valid. Double-check what's shown on your TV." });
      return;
    }
    if (row.consumedAt || row.claimedAt) {
      res.status(409).json({ error: "That code has already been used. Generate a fresh one on your TV." });
      return;
    }
    res.status(410).json({ error: "That code has expired. Generate a fresh one on your TV." });
    return;
  }

  if (claimed[0]!.expiresAt.getTime() <= Date.now()) {
    // Race: the row was un-claimed at WHERE-time but expired between then and now.
    await db.delete(deviceLinkCodesTable).where(eq(deviceLinkCodesTable.code, code));
    res.status(410).json({ error: "That code has expired. Generate a fresh one on your TV." });
    return;
  }

  res.json({ ok: true, deviceLabel: null, claimedAt: new Date().toISOString() });
});

const ExchangeBody = z.object({
  code: z
    .string()
    .min(8)
    .max(10)
    .transform((s) => s.toUpperCase().replace(/\s+/g, "")),
});

/**
 * The TV polls this. Returns 202 (pending) until claimed; once claimed,
 * issues a fresh access+refresh pair, marks the code consumed, and the
 * row will be reaped. Codes are single-use — a second exchange returns 410.
 */
router.post("/auth/device-link/exchange", async (req, res) => {
  const parsed = ExchangeBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid code" });
    return;
  }
  const code = parsed.data.code.includes("-")
    ? parsed.data.code
    : `${parsed.data.code.slice(0, 4)}-${parsed.data.code.slice(4)}`;

  // Atomic "consume": only succeeds if claimed AND not yet consumed AND
  // not expired. Burns the code in the same statement.
  const consumed = await db
    .update(deviceLinkCodesTable)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(deviceLinkCodesTable.code, code),
        isNotNull(deviceLinkCodesTable.claimedAt),
        isNull(deviceLinkCodesTable.consumedAt),
      ),
    )
    .returning({
      code: deviceLinkCodesTable.code,
      userId: deviceLinkCodesTable.userId,
      expiresAt: deviceLinkCodesTable.expiresAt,
    });

  if (consumed.length === 0) {
    // Either the code is unknown, expired, not-yet-claimed (still pending),
    // or already consumed. Disambiguate so the client polls efficiently.
    const [row] = await db
      .select()
      .from(deviceLinkCodesTable)
      .where(eq(deviceLinkCodesTable.code, code))
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "Unknown code" });
      return;
    }
    if (row.consumedAt) {
      res.status(410).json({ error: "Code already used" });
      return;
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      res.status(410).json({ error: "Code expired" });
      return;
    }
    // Pending claim — TV should keep polling.
    res.status(202).json({ pending: true });
    return;
  }

  const claimedRow = consumed[0]!;
  if (claimedRow.expiresAt.getTime() <= Date.now() || !claimedRow.userId) {
    // Edge: claimed but expired before consumed, or claim row missing userId.
    res.status(410).json({ error: "Code expired" });
    return;
  }

  // Mint a fresh access + refresh pair scoped to the claiming user.
  const tokens = await issueAuthTokens(claimedRow.userId, req);

  // Delete the code now — single-use, never replayable.
  setTimeout(() => {
    db.delete(deviceLinkCodesTable)
      .where(eq(deviceLinkCodesTable.code, code))
      .catch(() => {});
  }, CONSUMED_TTL_MS);

  res.json({
    token: tokens.accessToken,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  });
});

export default router;
