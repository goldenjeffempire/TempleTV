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
  bumpSessionEpoch,
  ACCESS_TOKEN_TTL_SECONDS,
} from "../middlewares/requireAuth";
import { z } from "zod";

const router = Router();

const SignupBody = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  displayName: z.string().min(1).max(80),
});

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const RefreshBody = z.object({
  refreshToken: z.string().min(10),
});

const LogoutBody = z.object({
  refreshToken: z.string().min(10).optional(),
  everywhere: z.boolean().optional(),
});

router.post("/auth/signup", async (req, res) => {
  const parsed = SignupBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }

  const { email, password, displayName } = parsed.data;
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

  const tokens = await issueAuthTokens(userId, req);
  res.status(201).json({
    // `token` retained for backward-compat with older mobile builds.
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

  const { email, password } = parsed.data;
  const normalizedEmail = email.toLowerCase().trim();

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, normalizedEmail))
    .limit(1);

  if (!user) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const passwordValid = await bcrypt.compare(password, user.passwordHash);
  if (!passwordValid) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const tokens = await issueAuthTokens(user.id, req);
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
    const tokens = await rotateRefreshToken(parsed.data.refreshToken, req);
    res.json({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.accessTokenExpiresInSecs,
    });
  } catch (err) {
    const code = err instanceof Error ? err.message : "invalid_refresh_token";
    const status = code === "refresh_token_reused" ? 401 : 401;
    res.status(status).json({ error: code });
  }
});

router.post("/auth/logout", async (req, res) => {
  const parsed = LogoutBody.safeParse(req.body);
  if (!parsed.success) {
    res.json({ success: true });
    return;
  }
  if (parsed.data.everywhere) {
    // Logout-everywhere requires an authenticated request.
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Authentication required for logout-everywhere" });
      return;
    }
    return requireAuth(req, res, async () => {
      await revokeAllRefreshTokensForUser(req.user!.id);
      // Also bump session epoch so any access token already issued is rejected.
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
