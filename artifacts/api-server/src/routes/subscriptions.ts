import { Router } from "express";
import { db, subscriptionTiersTable, userSubscriptionsTable, usersTable } from "@workspace/db";
import { eq, asc, desc } from "drizzle-orm";
import { randomUUID } from "crypto";
import { z } from "zod/v4";

const router = Router();

const tierSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
  description: z.string().default(""),
  priceMonthlyCents: z.number().int().min(0).default(0),
  priceYearlyCents: z.number().int().min(0).default(0),
  features: z.array(z.string()).default([]),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

router.get("/subscriptions/tiers", async (_req, res) => {
  try {
    const tiers = await db.select().from(subscriptionTiersTable).where(eq(subscriptionTiersTable.isActive, true)).orderBy(asc(subscriptionTiersTable.sortOrder));
    const parsed = tiers.map((t) => ({ ...t, features: JSON.parse(t.features || "[]") as string[] }));
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

router.get("/admin/subscriptions/tiers", async (_req, res) => {
  try {
    const tiers = await db.select().from(subscriptionTiersTable).orderBy(asc(subscriptionTiersTable.sortOrder));
    const parsed = tiers.map((t) => ({ ...t, features: JSON.parse(t.features || "[]") as string[] }));
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

router.post("/admin/subscriptions/tiers", async (req, res) => {
  try {
    const body = tierSchema.parse(req.body);
    const [tier] = await db.insert(subscriptionTiersTable).values({
      id: randomUUID(),
      ...body,
      features: JSON.stringify(body.features),
    }).returning();
    res.status(201).json({ ...tier, features: JSON.parse(tier.features || "[]") });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Invalid data" });
  }
});

router.patch("/admin/subscriptions/tiers/:id", async (req, res) => {
  const { id } = req.params as { id: string };
  try {
    const body = tierSchema.partial().parse(req.body);
    const updates: Record<string, unknown> = { ...body, updatedAt: new Date() };
    if (body.features) updates.features = JSON.stringify(body.features);
    const [updated] = await db.update(subscriptionTiersTable).set(updates).where(eq(subscriptionTiersTable.id, id)).returning();
    if (!updated) return res.status(404).json({ error: "Tier not found" });
    res.json({ ...updated, features: JSON.parse(updated.features || "[]") });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Invalid data" });
  }
});

router.delete("/admin/subscriptions/tiers/:id", async (req, res) => {
  const { id } = req.params as { id: string };
  await db.delete(subscriptionTiersTable).where(eq(subscriptionTiersTable.id, id));
  res.json({ ok: true });
});

router.get("/admin/subscriptions/users", async (_req, res) => {
  try {
    const subs = await db.select({
      id: userSubscriptionsTable.id,
      userId: userSubscriptionsTable.userId,
      tierId: userSubscriptionsTable.tierId,
      status: userSubscriptionsTable.status,
      provider: userSubscriptionsTable.provider,
      currentPeriodStart: userSubscriptionsTable.currentPeriodStart,
      currentPeriodEnd: userSubscriptionsTable.currentPeriodEnd,
      cancelAtPeriodEnd: userSubscriptionsTable.cancelAtPeriodEnd,
      createdAt: userSubscriptionsTable.createdAt,
      userEmail: usersTable.email,
      userName: usersTable.displayName,
      tierName: subscriptionTiersTable.name,
    })
    .from(userSubscriptionsTable)
    .leftJoin(usersTable, eq(userSubscriptionsTable.userId, usersTable.id))
    .leftJoin(subscriptionTiersTable, eq(userSubscriptionsTable.tierId, subscriptionTiersTable.id))
    .orderBy(desc(userSubscriptionsTable.createdAt));
    res.json(subs);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

router.post("/admin/subscriptions/grant", async (req, res) => {
  try {
    const { userId, tierId, periodDays = 30 } = req.body as { userId: string; tierId: string; periodDays?: number };
    if (!userId || !tierId) return res.status(400).json({ error: "userId and tierId are required" });
    const start = new Date();
    const end = new Date(start.getTime() + periodDays * 24 * 60 * 60 * 1000);
    const [sub] = await db.insert(userSubscriptionsTable).values({
      id: randomUUID(),
      userId,
      tierId,
      status: "active",
      provider: "manual",
      currentPeriodStart: start,
      currentPeriodEnd: end,
    }).returning();
    res.status(201).json(sub);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Invalid data" });
  }
});

router.patch("/admin/subscriptions/:id/status", async (req, res) => {
  const { id } = req.params as { id: string };
  const { status } = req.body as { status: string };
  if (!["active", "canceled", "expired", "past_due"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  const [updated] = await db.update(userSubscriptionsTable)
    .set({ status, updatedAt: new Date() })
    .where(eq(userSubscriptionsTable.id, id))
    .returning();
  if (!updated) return res.status(404).json({ error: "Subscription not found" });
  res.json(updated);
});

router.get("/me/subscription", async (req, res) => {
  const userId = (req as { user?: { id: string } }).user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const [sub] = await db.select({
      id: userSubscriptionsTable.id,
      status: userSubscriptionsTable.status,
      currentPeriodEnd: userSubscriptionsTable.currentPeriodEnd,
      tierId: userSubscriptionsTable.tierId,
      tierName: subscriptionTiersTable.name,
      tierSlug: subscriptionTiersTable.slug,
      features: subscriptionTiersTable.features,
    })
    .from(userSubscriptionsTable)
    .leftJoin(subscriptionTiersTable, eq(userSubscriptionsTable.tierId, subscriptionTiersTable.id))
    .where(eq(userSubscriptionsTable.userId, userId))
    .orderBy(desc(userSubscriptionsTable.createdAt))
    .limit(1);
    if (!sub) return res.json({ subscription: null });
    res.json({ subscription: { ...sub, features: JSON.parse(sub.features || "[]") as string[] } });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

export default router;
