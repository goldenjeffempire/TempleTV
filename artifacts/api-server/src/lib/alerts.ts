import { logger } from "./logger";
import { cache } from "./cache";

export type AlertSeverity = "info" | "warning" | "critical";

export interface OpsAlertField {
  label: string;
  value: string;
}

export interface OpsAlertInput {
  severity: AlertSeverity;
  title: string;
  message: string;
  fields?: OpsAlertField[];
  /**
   * Stable key used to suppress duplicate alerts (across processes and
   * restarts). When set, repeat alerts with the same key inside `dedupTtlSec`
   * are silently dropped. Recommended format: `<feature>:<dimension>:<dateLabel>`.
   */
  dedupKey?: string;
  /**
   * Dedup window. Defaults to 4h — long enough to prevent spam during
   * sustained incidents, short enough that a recurring problem still pages.
   */
  dedupTtlSec?: number;
}

export type ChannelStatus = "sent" | "skipped" | "failed" | "disabled";

export interface OpsAlertResult {
  slack: ChannelStatus;
  webhook: ChannelStatus;
  dedupKey: string | null;
  deduped: boolean;
}

const DEDUP_PREFIX = "ops:alert:dedup:";
const LAST_DELIVERY_KEY = "ops:alert:lastDelivery";

const SLACK_WEBHOOK_URL = process.env.ALERT_SLACK_WEBHOOK_URL?.trim() || "";
const GENERIC_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL?.trim() || "";

// Shared signing secret for the generic webhook — operators can verify
// payload authenticity in their Zapier/n8n/etc receiver. Sent in the
// `X-Alert-Token` header when present.
const GENERIC_WEBHOOK_TOKEN = process.env.ALERT_WEBHOOK_TOKEN?.trim() || "";

/** Color codes for Slack attachment styling. */
const SEVERITY_COLOR: Record<AlertSeverity, string> = {
  info: "#3b82f6",
  warning: "#f59e0b",
  critical: "#dc2626",
};

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  info: ":information_source:",
  warning: ":warning:",
  critical: ":rotating_light:",
};

export function isAlertingConfigured(): boolean {
  return Boolean(SLACK_WEBHOOK_URL || GENERIC_WEBHOOK_URL);
}

export function getAlertingChannels(): {
  slack: boolean;
  webhook: boolean;
} {
  return {
    slack: Boolean(SLACK_WEBHOOK_URL),
    webhook: Boolean(GENERIC_WEBHOOK_URL),
  };
}

/**
 * Last delivery telemetry surfaced to the admin UI so operators can see
 * whether alerting is working without having to trigger a real incident.
 */
export interface LastDelivery {
  at: string;
  title: string;
  severity: AlertSeverity;
  slack: ChannelStatus;
  webhook: ChannelStatus;
  deduped: boolean;
}

export async function getLastAlertDelivery(): Promise<LastDelivery | null> {
  return (await cache.get<LastDelivery>(LAST_DELIVERY_KEY)) ?? null;
}

async function postSlack(input: OpsAlertInput): Promise<ChannelStatus> {
  if (!SLACK_WEBHOOK_URL) return "disabled";
  const payload = {
    text: `${SEVERITY_EMOJI[input.severity]} *${input.title}*`,
    attachments: [
      {
        color: SEVERITY_COLOR[input.severity],
        text: input.message,
        fields: (input.fields ?? []).map((f) => ({
          title: f.label,
          value: f.value,
          short: f.value.length < 40,
        })),
        ts: Math.floor(Date.now() / 1000),
      },
    ],
  };
  try {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      const snippet = (await res.text().catch(() => "")).slice(0, 200);
      logger.warn(
        { status: res.status, snippet },
        "Slack alert webhook returned non-OK",
      );
      return "failed";
    }
    return "sent";
  } catch (err) {
    logger.warn({ err }, "Slack alert webhook failed (network/timeout)");
    return "failed";
  }
}

async function postGenericWebhook(
  input: OpsAlertInput,
): Promise<ChannelStatus> {
  if (!GENERIC_WEBHOOK_URL) return "disabled";
  const payload = {
    severity: input.severity,
    title: input.title,
    message: input.message,
    fields: input.fields ?? [],
    sentAt: new Date().toISOString(),
    source: "jctm-api",
  };
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (GENERIC_WEBHOOK_TOKEN) {
    headers["x-alert-token"] = GENERIC_WEBHOOK_TOKEN;
  }
  try {
    const res = await fetch(GENERIC_WEBHOOK_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      const snippet = (await res.text().catch(() => "")).slice(0, 200);
      logger.warn(
        { status: res.status, snippet },
        "Generic alert webhook returned non-OK",
      );
      return "failed";
    }
    return "sent";
  } catch (err) {
    logger.warn({ err }, "Generic alert webhook failed (network/timeout)");
    return "failed";
  }
}

/**
 * Best-effort multi-channel ops notification. Never throws — alerting
 * failures must never disrupt the calling code path. Caller is free to
 * `void`-fire this for non-blocking semantics.
 */
export async function sendOpsAlert(
  input: OpsAlertInput,
): Promise<OpsAlertResult> {
  // Distributed dedup — one process sending the alert blocks duplicates
  // from any other replica for the configured window.
  if (input.dedupKey) {
    const key = DEDUP_PREFIX + input.dedupKey;
    const seen = await cache.get<number>(key);
    if (seen) {
      const result: OpsAlertResult = {
        slack: "skipped",
        webhook: "skipped",
        dedupKey: input.dedupKey,
        deduped: true,
      };
      logger.debug(
        { dedupKey: input.dedupKey, title: input.title },
        "Ops alert deduped (already sent within window)",
      );
      return result;
    }
    const ttlMs = (input.dedupTtlSec ?? 4 * 60 * 60) * 1000;
    await cache.set(key, Date.now(), ttlMs);
  }

  if (!isAlertingConfigured()) {
    logger.info(
      { title: input.title, severity: input.severity },
      "Ops alert raised but no channels configured",
    );
    return {
      slack: "disabled",
      webhook: "disabled",
      dedupKey: input.dedupKey ?? null,
      deduped: false,
    };
  }

  const [slack, webhook] = await Promise.all([
    postSlack(input),
    postGenericWebhook(input),
  ]);

  // Record last-delivery telemetry for the admin UI.
  await cache.set<LastDelivery>(
    LAST_DELIVERY_KEY,
    {
      at: new Date().toISOString(),
      title: input.title,
      severity: input.severity,
      slack,
      webhook,
      deduped: false,
    },
    7 * 24 * 60 * 60 * 1000,
  );

  return {
    slack,
    webhook,
    dedupKey: input.dedupKey ?? null,
    deduped: false,
  };
}
