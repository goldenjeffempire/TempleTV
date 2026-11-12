/** Public, publisher-owned data. No account/session credentials are sent. */
export const DEVOTION_SITE = "https://jctm.org.ng";
export const DEVOTION_PAGE = `${DEVOTION_SITE}/devotion`;
export const DEVOTION_API = `${DEVOTION_SITE}/api/devotion/daily`;
export const DEVOTION_CACHE_KEY = "@temple_tv/public_devotion_v1";
export const DEVOTION_QUERY_KEY = ["temple:daily-devotion:v1"] as const;
export const DEVOTION_REFRESH_MS = 5 * 60 * 1000;

export interface DailyDevotion {
  id: string;
  title: string;
  excerpt: string;
  publishedAt: string | null;
  imageUrl: string | null;
  url: string;
}
export interface DevotionSnapshot {
  devotion: DailyDevotion;
  fetchedAt: number;
  stale: boolean;
  error: string | null;
}

export function formatDevotionDate(value: string | null, locale?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    return date.toLocaleDateString(locale, {
      weekday: "long", day: "numeric", month: "long", year: "numeric",
      // A publisher's calendar date must not move to yesterday in America.
      ...(/^\d{4}-\d{2}-\d{2}$/.test(value) ? { timeZone: "UTC" } : {}),
    });
  } catch { return value.slice(0, 10); }
}
interface DevotionIO {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  fetch(signal: AbortSignal): Promise<unknown>;
  now(): number;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Render only bounded plain text, never publisher HTML in a WebView. */
export function devotionText(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return value.slice(0, 100_000)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity: string) => {
      const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
      if (!entity.startsWith("#")) return named[entity.toLowerCase()] ?? whole;
      const code = entity.toLowerCase().startsWith("#x")
        ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code) : "";
    }).replace(/\s+/g, " ").trim().slice(0, limit);
}

export function devotionLink(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) return DEVOTION_PAGE;
  try {
    const url = new URL(value, DEVOTION_SITE);
    if (url.protocol !== "https:" || !["jctm.org.ng", "www.jctm.org.ng"].includes(url.hostname) ||
        url.username || url.password || url.port ||
        !/^\/devotion(?:\/|$)/.test(url.pathname)) return DEVOTION_PAGE;
    return url.toString();
  } catch { return DEVOTION_PAGE; }
}

function imageLink(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) return null;
  try {
    const url = new URL(value, DEVOTION_SITE);
    // Do not turn publisher metadata into a local-network probe.
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        !url.hostname.includes(".") || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname) ||
        url.hostname.endsWith(".local") || url.hostname.endsWith(".internal")) return null;
    return url.toString();
  } catch { return null; }
}

export function normalizeDailyDevotion(payload: unknown): DailyDevotion {
  const entry = object(object(payload)?.devotion);
  if (!entry || entry.status === "draft" || entry.published === false) {
    throw new Error("The official website did not provide a published devotion.");
  }
  const title = devotionText(entry.title, 240);
  if (!title) throw new Error("The official devotion has no title.");
  const date = typeof entry.date === "string" ? entry.date : entry.publishedAt;
  let publishedAt: string | null = null;
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(date) &&
      Number.isFinite(Date.parse(date))) {
    const canonical = new Date(date).toISOString().slice(0, 10);
    if (canonical === date.slice(0, 10)) publishedAt = date;
  }
  const excerpt = devotionText(entry.excerpt ?? entry.description ?? entry.reflection ?? entry.scripture, 300);
  return {
    id: devotionText(entry.id, 180) || publishedAt || title,
    title, excerpt, publishedAt,
    imageUrl: imageLink(entry.imageUrl ?? entry.featuredImage ?? entry.image),
    // The official daily API currently provides no per-devotion permalink.
    url: devotionLink(entry.url ?? entry.link),
  };
}

function stationDay(now: number): string {
  // Nigeria is UTC+1 year-round. Avoid dozens of Intl formatter allocations.
  return new Date(now + 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Single-flight, persistent stale-if-error repository, independent of Temple API health. */
export class DailyDevotionRepository {
  private cache: DevotionSnapshot | null = null;
  private hydration: Promise<void> | null = null;
  private inFlight: Promise<DevotionSnapshot> | null = null;
  constructor(private readonly io: DevotionIO) {}

  private async hydrate(): Promise<void> {
    if (!this.hydration) this.hydration = (async () => {
      try {
        const raw = await this.io.read();
        if (!raw || raw.length > 32_000) return;
        const stored = object(JSON.parse(raw));
        const fetchedAt = stored?.fetchedAt;
        const d = object(stored?.devotion);
        if (stored?.version !== 1 || !d || typeof fetchedAt !== "number" ||
            fetchedAt <= 0 || fetchedAt > this.io.now() + 60_000) return;
        const devotion = normalizeDailyDevotion({ devotion: {
          ...d, date: d.publishedAt, description: d.excerpt,
        } });
        this.cache = { devotion, fetchedAt, stale: true, error: null };
      } catch { /* A broken/unavailable cache must not block the public website. */ }
    })();
    return this.hydration;
  }

  async cached(): Promise<DevotionSnapshot | null> {
    await this.hydrate();
    return this.cache ? { ...this.cache, stale: true } : null;
  }

  private fresh(): boolean {
    return !!this.cache && this.io.now() >= this.cache.fetchedAt &&
      this.io.now() - this.cache.fetchedAt < DEVOTION_REFRESH_MS &&
      stationDay(this.io.now()) === stationDay(this.cache.fetchedAt);
  }

  async load(force = false, parentSignal?: AbortSignal): Promise<DevotionSnapshot> {
    await this.hydrate();
    if (parentSignal?.aborted) throw Object.assign(new Error("Devotion request cancelled"), { name: "AbortError" });
    if (!force && this.fresh()) return { ...this.cache!, stale: false, error: null };
    if (this.inFlight) return this.inFlight;
    const controller = new AbortController();
    const abort = () => controller.abort();
    parentSignal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 12_000);
    this.inFlight = (async () => {
      try {
        const payload = await this.io.fetch(controller.signal);
        const devotion = normalizeDailyDevotion(payload);
        if (controller.signal.aborted) throw new Error("The devotion request timed out.");
        const relay = object(payload);
        const stale = relay?.stale === true;
        const timestamp = relay?.fetchedAt;
        const fetchedAt = stale && typeof timestamp === "number" && timestamp > 0 && timestamp <= this.io.now()
          ? timestamp : this.io.now();
        const snapshot: DevotionSnapshot = { devotion, fetchedAt, stale,
          error: stale ? "The latest devotion could not be refreshed. Your saved copy is available." : null };
        this.cache = snapshot;
        try { await this.io.write(JSON.stringify({ version: 1, devotion, fetchedAt: snapshot.fetchedAt })); }
        catch { /* Keep valid fetched content visible even if device storage is full. */ }
        return snapshot;
      } catch (error) {
        if (parentSignal?.aborted) throw Object.assign(new Error("Devotion request cancelled"), { name: "AbortError" });
        if (this.cache) return { ...this.cache, stale: true, error: "The latest devotion could not be refreshed. Your saved copy is available." };
        throw error instanceof Error ? error : new Error("The official devotion is temporarily unavailable.");
      } finally {
        clearTimeout(timeout);
        parentSignal?.removeEventListener("abort", abort);
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }
}
