/**
 * Push Delivery Service
 *
 * Handles actual delivery of push notifications to:
 *   • Expo Push Notification Service → iOS (APNs) + Android (FCM)
 *   • W3C Web Push API               → browser service workers
 *
 * Called by `notificationsService.sendPush()` as a fire-and-forget
 * background task after the audit row is written. All errors are caught
 * and logged — a delivery failure must never crash the HTTP handler or
 * block the response.
 *
 * Retry policy (Expo path):
 *   Transient failures (network timeouts, Expo API 5xx) are retried up
 *   to MAX_CHUNK_RETRIES times with exponential backoff (1 s, 5 s, 30 s).
 *   Permanent failures (DeviceNotRegistered, InvalidCredentials) are never
 *   retried — they trigger immediate stale-token cleanup instead. A chunk
 *   that exhausts its retry budget is logged as an error and skipped; the
 *   remaining chunks still proceed, so one bad chunk never kills the batch.
 *
 * Stale token cleanup:
 *   Expo returns `DeviceNotRegistered` when a token has been revoked or
 *   the app is uninstalled. We hard-delete those tokens from `push_tokens`
 *   so the recipient count stays accurate on subsequent sends.
 *
 *   Web Push returns 410 (Gone) for expired subscriptions. We hard-delete
 *   those from `web_push_subscriptions` for the same reason.
 */
export interface PushPayload {
    notificationId: string;
    title: string;
    body: string;
    type: string;
    videoId?: string | null;
}
/**
 * Fire-and-forget entry point. Call this after writing the audit row.
 * All errors are caught — a delivery failure never propagates to the caller.
 */
export declare function deliverPushNotification(payload: PushPayload): Promise<void>;
