/**
 * Admin Audit Log — activity feed for the admin panel.
 *
 * Builds a unified activity trail by querying multiple tables:
 *   • videos  — recently added / finalized uploads
 *   • users   — recently registered accounts
 *   • scheduleItems — recent schedule additions
 *
 * All items are merged, sorted by timestamp, and returned as a flat
 * array of AuditEntry objects — no dedicated audit table required.
 * Limit: 200 most-recent entries.
 */
import type { FastifyInstance } from "fastify";
export declare function auditLogRoutes(app: FastifyInstance): Promise<void>;
