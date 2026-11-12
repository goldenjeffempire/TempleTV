/**
 * The proxy API's legacy engine is deliberately not started. Never present its
 * OFF AIR default as the daemon's status. Coalesce reads across admin consoles.
 */
export function createAdminBroadcastStatusReader(options: {
  daemonUrl?: string;
  localSnapshot: () => Record<string, unknown>;
  fetcher?: typeof fetch;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let cached: Record<string, unknown> | null = null;
  let expiresAt = 0;
  let pending: Promise<Record<string, unknown> | null> | null = null;
  return function read(): Promise<Record<string, unknown> | null> {
    if (!options.daemonUrl) return Promise.resolve(options.localSnapshot());
    if (now() < expiresAt) return Promise.resolve(cached);
    if (pending) return pending;
    pending = (async () => {
      // Ensure single-flight ownership is established even if a custom fetcher
      // throws synchronously before returning its promise.
      await Promise.resolve();
      try {
        const response = await (options.fetcher ?? fetch)(
          `${options.daemonUrl!.replace(/\/+$/, "")}/api/v1/broadcast-v2/state`,
          { signal: AbortSignal.timeout(2_500), cache: "no-store", redirect: "error" },
        );
        if (!response.ok) throw new Error("Broadcast status unavailable");
        const text = await response.text();
        if (text.length > 256_000) throw new Error("Broadcast status too large");
        const body = JSON.parse(text) as Record<string, unknown> | null;
        // REST uses { state: V2Snapshot }; WS frames carry the snapshot
        // directly. Preserve flat-payload compatibility without mistaking
        // the REST envelope for a stopped/invalid broadcast.
        const value = (body && typeof body === "object" && "state" in body
          ? body.state : body) as Record<string, unknown>;
        if (!value || !["queue", "override", "failover", "offline_hold"].includes(String(value.mode)) ||
            typeof value.serverTimeMs !== "number" || !Number.isFinite(value.serverTimeMs) ||
            typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) ||
            !("current" in value) || !("override" in value)) throw new Error("Invalid daemon snapshot");
        for (const key of ["current", "override"] as const) {
          const entry = value[key];
          if (entry !== null && (typeof entry !== "object" ||
              typeof (entry as Record<string, unknown>).id !== "string")) {
            throw new Error("Invalid daemon playback item");
          }
        }
        const override = value.override as Record<string, unknown> | null;
        const activeOverride = value.mode === "override" && override !== null;
        if (activeOverride && (typeof override?.id !== "string" ||
            typeof override.startedAtMs !== "number" ||
            !Number.isFinite(override.startedAtMs))) throw new Error("Invalid daemon override");
        const isLive = value.mode !== "offline_hold" &&
          (value.current !== null || activeOverride ||
            (value.mode === "failover" && (value.failover as { active?: unknown } | null)?.active === true));
        cached = {
          ...options.localSnapshot(),
          isLive,
          liveOverride: activeOverride ? {
            id: override!.id, title: override!.title,
            startedAt: new Date(override!.startedAtMs as number).toISOString(),
            endsAt: typeof override!.endsAtMs === "number" ? new Date(override!.endsAtMs).toISOString() : null,
            elapsedSecs: Math.max(0, (value.serverTimeMs - (override!.startedAtMs as number)) / 1000),
            remainingSecs: typeof override!.endsAtMs === "number"
              ? Math.max(0, (override!.endsAtMs - value.serverTimeMs) / 1000) : null,
          } : null,
          ts: value.serverTimeMs,
        };
      } catch {
        // Unknown, not "off air". The client retains its last-known frame and
        // identifies the unavailable runtime rather than manufacturing state.
        cached = null;
      } finally {
        expiresAt = now() + 5_000;
        pending = null;
      }
      return cached;
    })();
    return pending;
  };
}
