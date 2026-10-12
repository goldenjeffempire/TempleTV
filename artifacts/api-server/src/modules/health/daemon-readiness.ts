import { validateDaemonHealthBody } from "../broadcast-v2/io/daemon-health-contract.js";

export interface DaemonReadiness {
  status: "ok" | "stuck" | "down";
  hasCurrent: boolean;
  engine: {
    ok: boolean;
    mode: string;
    sequence: number;
    uptimeMs: number;
    itemCount: number;
  };
}

/** Single-flight, short-lived probes avoid multiplying traffic during health checks.
 * A failed remote probe must never fall back to the API's unused local engine.
 */
export function createDaemonReadinessProbe(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 2_000,
  ttlMs = 2_000,
) {
  let cachedUrl: string | undefined;
  let expiresAt = 0;
  let pending: Promise<DaemonReadiness | null> | undefined;

  return function probe(baseUrl: string): Promise<DaemonReadiness | null> {
    if (cachedUrl === baseUrl && pending && Date.now() < expiresAt) return pending;
    cachedUrl = baseUrl;
    expiresAt = Date.now() + ttlMs;
    pending = (async () => {
      try {
        const response = await fetchImpl(
          `${baseUrl.replace(/\/+$/, "")}/api/v1/broadcast-v2/health`,
          { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) },
        );
        if (!response.ok) {
          await response.body?.cancel();
          return null;
        }
        const raw = await response.text();
        const validation = validateDaemonHealthBody(raw);
        if (!validation.valid) return null;
        const payload = JSON.parse(raw) as {
          sequence: unknown;
          uptimeMs: unknown;
          stuck?: unknown;
          sequenceStale?: unknown;
        };
        if (
          typeof payload.sequence !== "number" ||
          !Number.isSafeInteger(payload.sequence) || payload.sequence < 0 ||
          typeof payload.uptimeMs !== "number" ||
          !Number.isSafeInteger(payload.uptimeMs) || payload.uptimeMs < 0 ||
          !Number.isSafeInteger(validation.payload.itemCount) ||
          validation.payload.itemCount < 0
        ) return null;
        const health = validation.payload;
        const status = !health.ok || !health.boot.started
          ? "down"
          : payload.stuck === true || payload.sequenceStale === true ? "stuck" : "ok";
        return {
          status,
          hasCurrent: health.hasCurrent,
          engine: {
            ok: status === "ok",
            mode: health.mode,
            sequence: payload.sequence,
            uptimeMs: payload.uptimeMs,
            itemCount: health.itemCount,
          },
        };
      } catch {
        // DNS, connection, timeout, and body-read failures all mean unready.
        return null;
      }
    })();
    return pending;
  };
}
