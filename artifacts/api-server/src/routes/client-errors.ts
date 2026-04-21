import { Router } from "express";
import { z } from "zod";
import { logger } from "../lib/logger";

const router = Router();

const ClientErrorSchema = z.object({
  platform: z.enum(["ios", "android", "web", "tv", "unknown"]).default("unknown"),
  appVersion: z.string().max(64).optional(),
  buildNumber: z.string().max(32).optional(),
  errorName: z.string().max(256).optional(),
  errorMessage: z.string().max(2048),
  stack: z.string().max(8192).optional(),
  componentStack: z.string().max(8192).optional(),
  context: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  occurredAt: z.string().datetime().optional(),
});

router.post("/client-errors", (req, res) => {
  const parsed = ClientErrorSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "invalid_payload",
      message: "Invalid client error payload",
      issues: parsed.error.issues,
    });
  }

  const payload = parsed.data;
  logger.error(
    {
      clientError: true,
      platform: payload.platform,
      appVersion: payload.appVersion,
      buildNumber: payload.buildNumber,
      errorName: payload.errorName,
      stack: payload.stack,
      componentStack: payload.componentStack,
      context: payload.context,
      occurredAt: payload.occurredAt,
    },
    `[ClientError] ${payload.errorMessage}`,
  );

  return res.status(202).json({ ok: true });
});

export default router;
