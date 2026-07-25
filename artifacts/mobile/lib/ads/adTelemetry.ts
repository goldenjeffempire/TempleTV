/**
 * adTelemetry — fire-and-forget reporting for ad lifecycle + revenue events.
 *
 * Two sinks (both best-effort, neither ever throws):
 *   • Sentry breadcrumbs/metrics — always available, works offline, gives the
 *     ad funnel context inside crash reports.
 *   • Backend telemetry endpoint (/api/telemetry/client-errors) — mirrors the
 *     existing `trackEvent` pattern used by services/playStoreUpdate.ts so ad
 *     impressions / revenue land in the same admin telemetry pipeline.
 *
 * Impression-Level Ad Revenue (ILRD): every ad format exposes an `onPaid` /
 * `revenue` PaidEvent { currency, precision, value }. `reportAdRevenue` funnels
 * those into analytics so eligible impressions are attributable to earnings.
 */

import { Platform } from "react-native";
import Constants from "expo-constants";
import { getApiBase } from "@/lib/apiBase";
import { fetchWithRetry } from "@/lib/fetchWithRetry";
import { ADS_REPORTING_CURRENCY, IS_DEV } from "@/lib/ads/adConfig";

const TELEMETRY_TIMEOUT_MS = 5_000;

export type AdEventName =
  | "ad_sdk_initialized"
  | "ad_consent_obtained"
  | "ad_consent_required"
  | "ad_consent_error"
  | "ad_requested"
  | "ad_loaded"
  | "ad_load_failed"
  | "ad_impression"
  | "ad_opened"
  | "ad_clicked"
  | "ad_closed"
  | "ad_reward_earned"
  | "ad_show_failed";

export interface AdEventMeta {
  format?: string;
  adUnitId?: string;
  errorCode?: string | number;
  errorMessage?: string;
  attempt?: number;
  [key: string]: unknown;
}

/** PaidEvent shape from react-native-google-mobile-ads (kept local to avoid a
 * native import in this module). */
export interface AdPaidEvent {
  currency: string;
  /** RevenuePrecisions enum value (0=ESTIMATED,1=PRECISE,2=PUBLISHER,3=UNKNOWN). */
  precision: number;
  /** Micros-normalised value already converted by the SDK to currency units. */
  value: number;
}

async function addSentryBreadcrumb(
  message: string,
  data: Record<string, unknown>,
  level: "info" | "warning" | "error" = "info",
): Promise<void> {
  if (!process.env.EXPO_PUBLIC_SENTRY_DSN) return;
  try {
    const Sentry = await import("@sentry/react-native");
    Sentry.addBreadcrumb({ category: "ads", message, level, data });
  } catch {
    /* never let telemetry throw */
  }
}

function postTelemetry(type: string, body: Record<string, unknown>): void {
  try {
    const base = getApiBase();
    if (!base) return;
    const payload = JSON.stringify({
      type,
      platform: Platform.OS,
      appVersion: Constants.expoConfig?.version ?? "unknown",
      timestamp: Date.now(),
      ...body,
    });
    fetchWithRetry(
      `${base}/api/telemetry/client-errors`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(TELEMETRY_TIMEOUT_MS),
      },
      { maxRetries: 2 },
    ).catch(() => {
      /* fire-and-forget */
    });
  } catch {
    /* never let telemetry throw */
  }
}

/** Report a non-revenue ad lifecycle event. */
export function reportAdEvent(event: AdEventName, meta: AdEventMeta = {}): void {
  const level =
    event === "ad_load_failed" ||
    event === "ad_show_failed" ||
    event === "ad_consent_error"
      ? "warning"
      : "info";
  void addSentryBreadcrumb(event, meta, level);
  postTelemetry("ad_telemetry", { eventType: event, ...meta });
  if (IS_DEV && typeof console !== "undefined") {
    // Dev-only visibility into the ad funnel.
    console.log(`[ads] ${event}`, meta);
  }
}

/**
 * Report an impression-level ad revenue (ILRD) paid event. Normalises the
 * PaidEvent and forwards it to both sinks for revenue analytics.
 */
export function reportAdRevenue(
  paid: AdPaidEvent,
  meta: AdEventMeta = {},
): void {
  const record = {
    eventType: "ad_paid" as const,
    currency: paid?.currency ?? ADS_REPORTING_CURRENCY,
    precision: paid?.precision,
    value: paid?.value,
    ...meta,
  };
  void addSentryBreadcrumb("ad_paid", record, "info");
  postTelemetry("ad_revenue", record);
  if (IS_DEV && typeof console !== "undefined") {
    console.log(
      `[ads] revenue ${record.value} ${record.currency} (${meta.format ?? "?"})`,
    );
  }
}
