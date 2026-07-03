/**
 * Faststart recovery worker — DISABLED (MP4-only pipeline).
 *
 * Raw MP4 files are broadcast-eligible immediately via HTTP Range streaming.
 * Moov-atom relocation (faststart) is not required for broadcast admission.
 * This module retains the public API shape so call-sites require no changes.
 */

import { logger } from "../../../infrastructure/logger.js";

// ── Public API ────────────────────────────────────────────────────────────

export const faststartRecoveryWorker = {
  /**
   * No-op sweep — faststart pipeline is disabled in the MP4-only pipeline.
   */
  async sweep(): Promise<void> {
    logger.debug("[faststart-recovery] sweep disabled — MP4-only pipeline, faststart not required");
  },

  /**
   * Alias for sweep() kept for call-site compatibility.
   */
  async runSweep(): Promise<void> {
    logger.debug("[faststart-recovery] runSweep disabled — MP4-only pipeline");
  },

  /**
   * No-op — cooldown state is not maintained when faststart is disabled.
   */
  resetAttempts(_videoId?: string): void {
    // no-op
  },

  /**
   * No-op — no "given up" state when faststart is disabled.
   */
  clearGivenUp(_videoId?: string): void {
    // no-op
  },

  /**
   * No-op — background sweep is permanently disabled.
   */
  start(_intervalMs?: number): void {
    logger.debug("[faststart-recovery] start() called but faststart is disabled — MP4-only pipeline");
  },

  /**
   * No-op — nothing to stop.
   */
  stop(): void {
    // no-op
  },
};
