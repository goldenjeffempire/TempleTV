export type BroadcastWebhookEvent = "dead_air" | "item_deactivated" | "recovery" | "test";
export interface WebhookPayload {
    event: BroadcastWebhookEvent;
    timestamp: string;
    channel: string;
    data: Record<string, unknown>;
}
export type WebhookDeliveryStatus = "success" | "failed" | "pending";
export interface WebhookDelivery {
    id: string;
    event: BroadcastWebhookEvent;
    timestamp: number;
    status: WebhookDeliveryStatus;
    statusCode?: number;
    durationMs?: number;
    error?: string;
}
export interface WebhookDeliveryResult {
    deliveryId: string;
    status: "success" | "failed" | "not_configured";
    statusCode?: number;
    durationMs?: number;
    error?: string;
}
export declare function isWebhookConfigured(): boolean;
export declare function getWebhookStatus(): {
    configured: boolean;
    urlMasked?: string;
    recentDeliveries: WebhookDelivery[];
};
/**
 * Fire-and-forget webhook delivery. Errors are logged but never thrown to the
 * caller. Safe to call with `void` from any synchronous or async context.
 */
export declare function sendBroadcastWebhook(event: BroadcastWebhookEvent, channel: string, data: Record<string, unknown>): void;
/**
 * Synchronous (awaitable) webhook delivery — used by the test endpoint so the
 * API can return the delivery result in the HTTP response body.
 */
export declare function sendBroadcastWebhookSync(event: BroadcastWebhookEvent, channel: string, data: Record<string, unknown>): Promise<WebhookDeliveryResult>;
