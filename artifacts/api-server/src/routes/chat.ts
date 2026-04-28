/**
 * Chat REST surface.
 *
 * Live messages flow over the WS gateway at `/api/chat/ws`. These routes
 * are intentionally narrow:
 *
 *   GET  /api/chat/history       — initial paint + reconnect catchup
 *   GET  /api/chat/diagnostics   — connected counts + per-channel viewers
 *   POST /api/chat/admin/messages/:id/delete  — moderator soft-delete
 *   POST /api/chat/admin/moderate             — moderator mute/ban
 *
 * REST is never used to SEND a chat message — that path is push-only over
 * the WS gateway, which is what enables sub-100ms delivery.
 */

import { Router } from "express";
import {
  fetchHistory,
  softDeleteMessage,
  applyModeration,
  invalidateModerationCache,
  getChatWsStats,
  TEMPLE_TV_LIVE_CHANNEL,
  getChatBus,
} from "../chat";

const router: ReturnType<typeof Router> = Router();

router.get("/chat/history", async (req, res) => {
  const channelId =
    typeof req.query.channelId === "string"
      ? req.query.channelId
      : TEMPLE_TV_LIVE_CHANNEL;
  const rawLimit =
    typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 50;
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
  try {
    const messages = await fetchHistory(channelId, limit);
    res.setHeader("Cache-Control", "private, max-age=0, no-store");
    res.json({ channelId, messages });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/chat/diagnostics", (_req, res) => {
  res.json({ ws: getChatWsStats() });
});

// ── Admin actions ─────────────────────────────────────────────────────────
// `adminAccessControl` middleware (registered globally for /api/admin/*) is
// not in our prefix, so we mount these under /api/admin/chat/* in the
// router below. The middleware will guard them automatically.

const adminRouter: ReturnType<typeof Router> = Router();

adminRouter.post("/admin/chat/messages/:id/delete", async (req, res) => {
  const { id } = req.params;
  if (!id || id.length > 200) {
    return res.status(400).json({ error: "invalid_id" });
  }
  try {
    const result = await softDeleteMessage(id, "admin");
    if (!result.deleted || !result.channelId) {
      return res.status(404).json({ error: "not_found" });
    }
    getChatBus().publish({
      type: "delete",
      channelId: result.channelId,
      messageId: id,
    });
    return res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: msg });
  }
});

adminRouter.post("/admin/chat/moderate", async (req, res) => {
  const body = req.body as {
    subjectKind?: unknown;
    subjectId?: unknown;
    action?: unknown;
    reason?: unknown;
    durationSecs?: unknown;
  };
  const subjectKind = body.subjectKind === "ip" ? "ip" : body.subjectKind === "user" ? "user" : null;
  const action = body.action === "mute" ? "mute" : body.action === "ban" ? "ban" : null;
  const subjectId = typeof body.subjectId === "string" ? body.subjectId.trim() : "";
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : null;
  const durationSecs =
    typeof body.durationSecs === "number" && Number.isFinite(body.durationSecs)
      ? Math.max(0, Math.floor(body.durationSecs))
      : null;

  if (!subjectKind || !action || !subjectId) {
    return res.status(400).json({ error: "invalid_input" });
  }

  try {
    const row = await applyModeration({
      subjectKind,
      subjectId,
      action,
      reason: reason || null,
      durationSecs,
      createdBy: "admin",
    });
    invalidateModerationCache(subjectKind, subjectId);
    getChatBus().publish({
      type: "moderate",
      channelId: TEMPLE_TV_LIVE_CHANNEL,
      action,
      subjectKind,
      subjectId,
      expiresAtMs: row.expiresAt ? row.expiresAt.getTime() : null,
    });
    return res.json({
      ok: true,
      id: row.id,
      expiresAtMs: row.expiresAt ? row.expiresAt.getTime() : null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: msg });
  }
});

router.use(adminRouter);

export default router;
