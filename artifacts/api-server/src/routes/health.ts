import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { cache } from "../lib/cache";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/cache/status", (_req, res) => {
  const status = cache.status();
  res.json(status);
});

export default router;
