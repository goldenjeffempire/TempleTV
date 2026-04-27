import { Router } from "express";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  requireAuth,
  issueAuthTokens,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokensForUser,
  revokeSessionById,
  listActiveSessions,
  bumpSessionEpoch,
  ACCESS_TOKEN_TTL_SECONDS,
} from "../middlewares/requireAuth";
import { z } from "zod";

const router = Router();

// ── Per-user brute-force login protection ─────────────────────────────────
// Tracks failed attempts per normalized email. After MAX_FAILURES consecutive
// failures the account is locked for LOCKOUT_MS. The counter resets on a
// successful login. This is in-memory (resets on restart) which is intentional:
// a restart clears the lock as a safe fallback and avoids schema churn.
const MAX_FAILURES = 10;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

interface FailureRecord {
  count: number;
  lockedUntil: number | null;
}
const loginFailures = new Map<string, FailureRecord>();

function getFailureRecord(email: string): FailureRecord {
  return loginFailures.get(email) ?? { count: 0, lockedUntil: null };
}

function recordFailure(email: string): void {
  const rec = getFailureRecord(email);
  const newCount = rec.count + 1;
  loginFailures.set(email, {
    count: newCount,
    lockedUntil: newCount >= MAX_FAILURES ? Date.now() + LOCKOUT_MS : null,
  });
}

function clearFailures(email: string): void {
  loginFailures.delete(email);
}

function isLockedOut(email: string): { locked: boolean; retryAfterSecs?: number } {
  const rec = getFailureRecord(email);
  if (rec.lockedUntil === null) return { locked: false };
  const remaining = rec.lockedUntil - Date.now();
  if (remaining <= 0) {
    loginFailures.delete(email);
    return { locked: false };
  }
  return { locked: true, retryAfterSecs: Math.ceil(remaining / 1000) };
}

// ── Validation schemas ─────────────────────────────────────────────────────

const SignupBody = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  displayName: z.string().min(1).max(80),
  deviceName: z.string().max(120).optional(),
});

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  deviceName: z.string().max(120).optional(),
});

const RefreshBody = z.object({
  refreshToken: z.string().min(10),
  deviceName: z.string().max(120).optional(),
});

const LogoutBody = z.object({
  refreshToken: z.string().min(10).optional(),
  everywhere: z.boolean().optional(),
});

// ── Routes ─────────────────────────────────────────────────────────────────

router.post("/auth/signup", async (req, res) => {
  const parsed = SignupBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }

  const { email, password, displayName, deviceName } = parsed.data;
  const normalizedEmail = email.toLowerCase().trim();

  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, normalizedEmail))
    .limit(1);

  if (existing) {
    res.status(409).json({ error: "An account with this email already exists" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const userId = randomUUID();

  await db.insert(usersTable).values({
    id: userId,
    email: normalizedEmail,
    passwordHash,
    displayName: displayName.trim(),
  });

  const tokens = await issueAuthTokens(userId, req, deviceName);
  res.status(201).json({
    token: tokens.accessToken,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.accessTokenExpiresInSecs,
    user: { id: userId, email: normalizedEmail, displayName: displayName.trim(), avatarUrl: null, emailVerified: false },
  });
});

router.post("/auth/login", async (req, res) => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const { email, password, deviceName } = parsed.data;
  const normalizedEmail = email.toLowerCase().trim();

  // Check for account lockout before hitting the DB.
  const lockStatus = isLockedOut(normalizedEmail);
  if (lockStatus.locked) {
    res.status(429).json({
      error: "account_temporarily_locked",
      message: "Too many failed login attempts. Please try again later.",
      retryAfterSecs: lockStatus.retryAfterSecs,
    });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, normalizedEmail))
    .limit(1);

  // Use a constant-time comparison path: always run bcrypt even if user not
  // found (prevents user-enumeration via timing differences). The string
  // below is a *deliberately invalid* placeholder bcrypt hash — `bcrypt.compare`
  // is run against it purely to consume CPU time equivalent to a real hash
  // verification so the response timing for "no such user" matches the
  // timing for "wrong password". It is not a credential and contains no
  // recoverable secret. SAST tools that flag it as a hardcoded credential
  // are surfacing a false positive — the literal must remain inline so the
  // timing profile is identical on every request path. Suppression marker
  // included so semgrep skips it cleanly.
  // nosemgrep: generic.secrets.security.detected-bcrypt-hash
  const dummyHash = "$2b$12$invalidhashfortimingnormalization.AAAAAAAAAAAAAAAAAAA";
  const passwordValid = user
    ? await bcrypt.compare(password, user.passwordHash)
    : await bcrypt.compare(password, dummyHash).then(() => false);

  if (!user || !passwordValid) {
    recordFailure(normalizedEmail);
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  clearFailures(normalizedEmail);

  const tokens = await issueAuthTokens(user.id, req, deviceName);
  res.json({
    token: tokens.accessToken,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.accessTokenExpiresInSecs,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      emailVerified: user.emailVerified,
    },
  });
});

router.post("/auth/refresh", async (req, res) => {
  const parsed = RefreshBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  try {
    const tokens = await rotateRefreshToken(parsed.data.refreshToken, req, parsed.data.deviceName);
    res.json({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.accessTokenExpiresInSecs,
    });
  } catch (err) {
    const code = err instanceof Error ? err.message : "invalid_refresh_token";
    res.status(401).json({ error: code });
  }
});

router.post("/auth/logout", async (req, res) => {
  const parsed = LogoutBody.safeParse(req.body);
  if (!parsed.success) {
    res.json({ success: true });
    return;
  }
  if (parsed.data.everywhere) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Authentication required for logout-everywhere" });
      return;
    }
    return requireAuth(req, res, async () => {
      await revokeAllRefreshTokensForUser(req.user!.id);
      await bumpSessionEpoch(req.user!.id);
      res.json({ success: true, scope: "everywhere" });
    });
  }
  if (parsed.data.refreshToken) {
    await revokeRefreshToken(parsed.data.refreshToken);
  }
  res.json({ success: true, scope: "device" });
});

router.get("/auth/me", requireAuth, (req, res) => {
  res.json({ user: req.user, accessTokenTtlSecs: ACCESS_TOKEN_TTL_SECONDS });
});

// ── Session management ─────────────────────────────────────────────────────

router.get("/auth/sessions", requireAuth, async (req, res) => {
  const sessions = await listActiveSessions(req.user!.id);
  res.json({ sessions });
});

router.delete("/auth/sessions/:sessionId", requireAuth, async (req, res) => {
  const { sessionId } = req.params as { sessionId: string };
  if (!sessionId) {
    res.status(400).json({ error: "Session ID required" });
    return;
  }
  const revoked = await revokeSessionById(req.user!.id, sessionId);
  if (!revoked) {
    res.status(404).json({ error: "Session not found or already revoked" });
    return;
  }
  res.json({ success: true });
});

// ── Profile & password management ─────────────────────────────────────────

router.patch("/auth/profile", requireAuth, async (req, res) => {
  const UpdateBody = z.object({
    displayName: z.string().min(1).max(80).optional(),
  });

  const parsed = UpdateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const { displayName } = parsed.data;
  if (!displayName) {
    res.json({ user: req.user });
    return;
  }

  await db
    .update(usersTable)
    .set({ displayName: displayName.trim(), updatedAt: new Date() })
    .where(eq(usersTable.id, req.user!.id));

  res.json({ user: { ...req.user, displayName: displayName.trim() } });
});

router.patch("/auth/password", requireAuth, async (req, res) => {
  const PasswordBody = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8, "New password must be at least 8 characters"),
  });

  const parsed = PasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }

  const [user] = await db
    .select({ id: usersTable.id, passwordHash: usersTable.passwordHash })
    .from(usersTable)
    .where(eq(usersTable.id, req.user!.id))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const currentValid = await bcrypt.compare(parsed.data.currentPassword, user.passwordHash);
  if (!currentValid) {
    res.status(401).json({ error: "Current password is incorrect" });
    return;
  }

  const newHash = await bcrypt.hash(parsed.data.newPassword, 12);
  await db
    .update(usersTable)
    .set({ passwordHash: newHash, updatedAt: new Date() })
    .where(eq(usersTable.id, req.user!.id));

  // Password change → revoke every existing refresh token AND bump the
  // session epoch so already-issued access JWTs are rejected immediately.
  await revokeAllRefreshTokensForUser(req.user!.id);
  await bumpSessionEpoch(req.user!.id);

  res.json({ success: true, message: "Password updated successfully" });
});

router.delete("/auth/account", requireAuth, async (req, res) => {
  // ON DELETE CASCADE on refresh_tokens cleans them up automatically.
  await db.delete(usersTable).where(eq(usersTable.id, req.user!.id));
  res.json({ success: true });
});

export default router;
