import { Router } from "express";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { signToken, requireAuth } from "../middlewares/requireAuth";
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

  const token = signToken(userId);
  res.status(201).json({
    token,
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

  const token = signToken(user.id);
  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      emailVerified: user.emailVerified,
    },
  });
});

router.get("/auth/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
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

router.delete("/auth/account", requireAuth, async (req, res) => {
  await db.delete(usersTable).where(eq(usersTable.id, req.user!.id));
  res.json({ success: true });
});

export default router;
