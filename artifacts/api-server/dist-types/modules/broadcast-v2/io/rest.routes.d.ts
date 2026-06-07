import type { FastifyInstance } from "fastify";
export declare function restRoutes(app: FastifyInstance): Promise<void>;
/**
 * Called from main.ts ~10 s after the orchestrator starts so broadcast queue
 * health issues appear in the server startup log immediately — without waiting
 * for the first validator cycle (≈2-min cadence). Non-fatal.
 *
 * Exported so main.ts can dynamic-import this module after the orchestrator is
 * confirmed running, minimising startup-time module loading.
 */
export declare function runBootRemediationReport(): Promise<void>;
