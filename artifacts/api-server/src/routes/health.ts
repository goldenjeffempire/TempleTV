import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { cache } from "../lib/cache";
import { metricsText } from "../middlewares/observability";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/cache/status", (_req, res) => {
  const status = cache.status();
  res.json(status);
});

router.get("/metrics", (_req, res) => {
  res.type("text/plain; version=0.0.4; charset=utf-8").send(metricsText());
});

export default router;
