export interface PlatformStatus {
  generatedAt: string;
  overallStatus: "ok" | "degraded" | "critical";
  checks: Array<{ key: string; label: string; status: "ok" | "degraded" | "critical" }>;
  database?: {
    counts?: {
      videos?: number;
      activeScheduleEntries?: number;
    };
  };
  broadcast?: {
    activeQueueItems?: number;
    activeLiveOverrides?: number;
  };
}

function resolveApiBase(): string | null {
  const apiUrl = process.env.EXPO_PUBLIC_API_URL;
  if (apiUrl) return apiUrl.replace(/\/+$/, "");
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (domain) return `https://${domain}`;
  return null;
}

export async function fetchPlatformStatus(): Promise<PlatformStatus | null> {
  const base = resolveApiBase();
  if (!base) return null;
  try {
    const res = await fetch(`${base}/api/ops/status`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    return await res.json() as PlatformStatus;
  } catch {
    return null;
  }
}