/**
 * @workspace/api-client-react
 * ----------------------------------------------------------------------------
 * Real React Query hooks that talk to the v1 API exposed by
 * `artifacts/api-server`. Replaces the prior throw-on-call stub now that all
 * 39 endpoints are implemented and reachable.
 *
 * Design notes
 * - Hook signatures match the shape the in-tree admin/mobile/tv code already
 *   uses (orval-style: `useFoo(params?, { query: { ... } })` for queries and
 *   `useFoo({ mutation: { ... } })` for mutations) so call sites do not have
 *   to change.
 * - Some list endpoints return `{ items, total, ... }` server-side but the
 *   admin UI reads `data` as a raw array (playlists, schedule, notification
 *   history) or under a different key (`videos`, `users`). The wrappers below
 *   adapt the API envelope to the shape each consumer expects.
 * - Auth: the bearer token lives in `localStorage["temple-tv-admin-token"]`
 *   per the existing admin convention. The fetch helper attaches it
 *   automatically; in non-browser contexts (SSR/tests) the request goes out
 *   without an `Authorization` header and the server returns 401, which is
 *   the correct failure mode.
 * - Base URL: defaults to a same-origin relative `/api/v1`. A consumer can
 *   set `VITE_API_BASE_URL` (or `VITE_API_URL`) at build time to point at a
 *   different origin (split-domain prod). A trailing `/api` segment is
 *   stripped so either form is accepted.
 */
import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
  type UseMutationOptions,
  type QueryKey,
} from "@tanstack/react-query";

// ─── Configuration ──────────────────────────────────────────────────────────

const ADMIN_TOKEN_STORAGE_KEY = "temple-tv-admin-token";

function resolveBaseUrl(): string {
  // import.meta.env access guarded for environments (Node tests, SSR) that
  // don't define it. We treat any non-string as "use default".
  let raw: string | undefined;
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    raw = env?.VITE_API_BASE_URL ?? env?.VITE_API_URL;
  } catch {
    raw = undefined;
  }
  if (raw && typeof raw === "string" && raw.trim().length > 0) {
    return raw
      .trim()
      .replace(/\/+$/, "")
      .replace(/\/api\/v1$/, "")
      .replace(/\/api$/, "")
      .concat("/api/v1");
  }
  return "/api/v1";
}

const BASE_URL = resolveBaseUrl();

function readToken(): string | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const t = window.localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY);
    return t && t.trim().length > 0 ? t.trim() : null;
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  public status: number;
  public payload: unknown;
  constructor(status: number, message: string, payload?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

/**
 * Default per-request timeout. A hung backend (TCP black-hole, broken
 * Cloudflare tunnel, frozen Smart-TV proxy) would otherwise leave every
 * `useQuery` permanently pending — React Query's `retry` only fires on
 * settled rejections, not in-flight hangs. 30 s is generous enough for
 * cold-start cases (cold Lambda, OpenAPI build, large catalog page) yet
 * tight enough that the UI's loading spinner doesn't outlive a user's
 * patience. Override per call via `opts.timeoutMs` (e.g. uploads).
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Combine a caller-supplied AbortSignal with a timeout signal without
 * relying on `AbortSignal.any()` (Chromium 116+ / Node 20+) — older
 * Smart-TV runtimes (Tizen 5, webOS 5) ship Chromium 76/79 and would
 * silently bypass the timeout if we used the modern API.
 */
function combineSignals(
  external: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const ctrl = new AbortController();
  const onExternal = () => ctrl.abort(external?.reason);
  if (external) {
    if (external.aborted) ctrl.abort(external.reason);
    else external.addEventListener("abort", onExternal, { once: true });
  }
  const timer = setTimeout(() => {
    ctrl.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, "TimeoutError"));
  }, timeoutMs);
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternal);
    },
  };
}

async function request<T>(
  method: string,
  path: string,
  opts: {
    body?: unknown;
    query?: Record<string, unknown>;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const url = new URL(
    `${BASE_URL}${path}`,
    typeof window !== "undefined" ? window.location.href : "http://localhost/",
  );
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = readToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  // Use a relative URL when same-origin so the browser doesn't expand it to
  // include the absolute origin (avoids surprises behind reverse proxies).
  const finalUrl = BASE_URL.startsWith("http") ? url.toString() : `${url.pathname}${url.search}`;

  const { signal, cleanup } = combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(finalUrl, {
      method,
      headers,
      body,
      signal,
      cache: "no-store",
    });
  } catch (err) {
    cleanup();
    // Re-raise caller-driven aborts unchanged so React Query treats them
    // as cancellations rather than failures (no retry, no error toast).
    if (opts.signal?.aborted) throw err;
    // Normalize network failures + timeouts to ApiError(0, …) so every
    // caller can `instanceof ApiError` without special-casing TypeError.
    const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
    const message = isTimeout
      ? `Request timed out after ${opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS}ms`
      : err instanceof Error
        ? `Network error: ${err.message}`
        : "Network error";
    throw new ApiError(0, message, { cause: err instanceof Error ? err.message : String(err) });
  }
  cleanup();

  // 204 / empty responses
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const msg =
      (parsed && typeof parsed === "object" && parsed !== null && "title" in parsed
        ? String((parsed as Record<string, unknown>).title ?? "")
        : "") ||
      (parsed && typeof parsed === "object" && parsed !== null && "message" in parsed
        ? String((parsed as Record<string, unknown>).message ?? "")
        : "") ||
      res.statusText ||
      `Request failed with status ${res.status}`;
    throw new ApiError(res.status, msg, parsed);
  }
  return parsed as T;
}

// ─── Common types ───────────────────────────────────────────────────────────

type ListEnvelope<T> = { items: T[]; total: number; limit?: number; offset?: number };
type QueryOpts<TData> = { query?: Partial<UseQueryOptions<TData, ApiError, TData, QueryKey>> };
// Caller-supplied mutation options. We deliberately strip `mutationFn` from
// the surface so a typo or stale call site can't replace our wired-up
// implementation, AND so the spread `...opts.mutation` below doesn't widen
// the inline `mutationFn` type and break parameter inference (TS would
// otherwise mark every destructured arg as `any`).
type MutationOpts<TData, TVars> = {
  mutation?: Omit<UseMutationOptions<TData, ApiError, TVars>, "mutationFn">;
};

function mergeQueryOpts<T>(
  base: { queryKey: QueryKey; queryFn: () => Promise<T>; enabled?: boolean },
  extra?: QueryOpts<T>,
) {
  // The caller may supply their own queryKey (orval pattern) — honor it.
  const merged = { ...base, ...(extra?.query ?? {}) };
  return merged as UseQueryOptions<T, ApiError, T, QueryKey>;
}

// Helper that builds a typed onSuccess wrapper which fires the package-level
// invalidation first and then defers to any caller-supplied onSuccess. Keeps
// each mutation block compact and avoids the repeated `(...args)` spread that
// loses type information at the call site.
function chainOnSuccess<TData, TVars>(
  invalidate: () => void,
  user?: UseMutationOptions<TData, ApiError, TVars>["onSuccess"],
): UseMutationOptions<TData, ApiError, TVars>["onSuccess"] {
  return (...args) => {
    invalidate();
    return user?.(...args);
  };
}

// ─── Admin: stats & analytics ───────────────────────────────────────────────

// Raw shape from /admin/stats — kept for the API contract.
type RawAdminStats = {
  videos: { total: number; featured: number; bySource: Record<string, number> };
  users: { total: number; byRole: Record<string, number> };
  playlists: { total: number };
  schedule: { total: number; active: number };
  notifications: { sentLast24h: number; sentTotal: number };
  broadcast: { queueDepth: number; activeQueueDepth: number };
  devices: { total: number };
  generatedAt: string;
};

// AdminStats exposes BOTH the raw nested shape (for callers that walk into
// `videos.total`, `users.byRole`, etc.) AND a flat alias surface that the
// admin dashboard pages were originally written against. The flat aliases
// are derived in `useGetAdminStats` below; live-status fields default to
// safe values when /live/status hasn't been merged in (the dashboard also
// queries `useGetLiveStatus` separately for the canonical live data).
export type AdminStats = RawAdminStats & {
  totalVideos: number;
  recentImports: number;
  totalPlaylists: number;
  activeScheduleEntries: number;
  notificationsSentToday: number;
  registeredUsers: number;
  registeredDevices: number;
  isLiveNow: boolean;
  liveTitle: string | undefined;
  ytLive: boolean;
  concurrentViewers: number;
  ytViewerCount: number;
};

export const getGetAdminStatsQueryKey = (): QueryKey => ["admin", "stats"];
export function useGetAdminStats(opts?: QueryOpts<AdminStats>) {
  return useQuery<AdminStats, ApiError, AdminStats, QueryKey>(
    mergeQueryOpts<AdminStats>(
      {
        queryKey: getGetAdminStatsQueryKey(),
        queryFn: async () => {
          const stats = await request<RawAdminStats>("GET", "/admin/stats");
          return {
            ...stats,
            totalVideos: stats.videos.total,
            recentImports: 0,
            totalPlaylists: stats.playlists.total,
            activeScheduleEntries: stats.schedule.active,
            notificationsSentToday: stats.notifications.sentLast24h,
            registeredUsers: stats.users.total,
            registeredDevices: stats.devices.total,
            isLiveNow: false,
            liveTitle: undefined,
            ytLive: false,
            concurrentViewers: 0,
            ytViewerCount: 0,
          };
        },
      },
      opts,
    ),
  );
}

// Raw shape from /admin/analytics — kept for the API contract.
type RawAnalyticsResponse = {
  topVideos: Array<{
    id: string;
    title: string;
    viewCount: number;
    thumbnailUrl: string;
  }>;
  totalViews: number;
  generatedAt: string;
};

// AnalyticsResponse is the page-facing shape: keeps everything the API
// returns and adds the dashboard-friendly fields. Fields the API doesn't
// (yet) compute default to safe zero/empty values so the UI can render.
export type AnalyticsResponse = {
  topVideos: Array<{
    id: string;
    title: string;
    youtubeId: string;
    views: number;
    viewCount: number;
    thumbnailUrl: string;
  }>;
  totalViews: number;
  uniqueViewers: number;
  avgWatchTimeMinutes: number;
  liveStreamEvents: number;
  dailyViews: Array<{ date: string; views: number }>;
  categoryBreakdown: Array<{ category: string; count: number; percentage: number }>;
  generatedAt: string;
};
export const getGetAnalyticsQueryKey = (params?: { period?: string }): QueryKey => [
  "admin",
  "analytics",
  params?.period ?? "30d",
];
export function useGetAnalytics(
  params?: { period?: "7d" | "30d" | "90d" },
  opts?: QueryOpts<AnalyticsResponse>,
) {
  return useQuery<AnalyticsResponse, ApiError, AnalyticsResponse, QueryKey>(
    mergeQueryOpts<AnalyticsResponse>(
      {
        queryKey: getGetAnalyticsQueryKey(params),
        queryFn: async () => {
          const raw = await request<RawAnalyticsResponse>("GET", "/admin/analytics", {
            query: { period: params?.period },
          });
          return {
            topVideos: raw.topVideos.map((v) => ({
              id: v.id,
              title: v.title,
              youtubeId: "",
              views: v.viewCount,
              viewCount: v.viewCount,
              thumbnailUrl: v.thumbnailUrl,
            })),
            totalViews: raw.totalViews,
            uniqueViewers: 0,
            avgWatchTimeMinutes: 0,
            liveStreamEvents: 0,
            dailyViews: [],
            categoryBreakdown: [],
            generatedAt: raw.generatedAt,
          };
        },
      },
      opts,
    ),
  );
}

// ─── Admin: users ───────────────────────────────────────────────────────────

export type AdminUser = {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  role: string;
  emailVerified: boolean;
  createdAt: string;
  updatedAt: string;
};
type ListUsersParams = { search?: string; role?: string; page?: number; limit?: number };
type ListUsersResponse = {
  users: AdminUser[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export const getListAdminUsersQueryKey = (params?: ListUsersParams): QueryKey => [
  "admin",
  "users",
  params?.search ?? "",
  params?.role ?? "",
  params?.page ?? 1,
  params?.limit ?? 25,
];

export function useListAdminUsers(
  params?: ListUsersParams,
  opts?: QueryOpts<ListUsersResponse>,
) {
  const limit = params?.limit ?? 25;
  const page = params?.page ?? 1;
  const offset = (page - 1) * limit;
  return useQuery<ListUsersResponse, ApiError, ListUsersResponse, QueryKey>(
    mergeQueryOpts<ListUsersResponse>(
      {
        queryKey: getListAdminUsersQueryKey(params),
        queryFn: async () => {
          const res = await request<ListEnvelope<AdminUser>>("GET", "/admin/users", {
            query: { search: params?.search, role: params?.role, limit, offset },
          });
          const totalPages = Math.max(1, Math.ceil(res.total / limit));
          return { users: res.items, total: res.total, page, limit, totalPages };
        },
      },
      opts,
    ),
  );
}

export function useUpdateUserRole(
  opts?: MutationOpts<AdminUser, { id: string; data: { role: "user" | "editor" | "admin" } }>,
) {
  const qc = useQueryClient();
  return useMutation<AdminUser, ApiError, { id: string; data: { role: "user" | "editor" | "admin" } }>(
    {
      mutationFn: ({ id, data }: { id: string; data: { role: "user" | "editor" | "admin" } }) => request<AdminUser>("PATCH", `/admin/users/${encodeURIComponent(id)}/role`, { body: data }),
    onError: opts?.mutation?.onError,
    onSettled: opts?.mutation?.onSettled,
    retry: opts?.mutation?.retry,
    onSuccess: chainOnSuccess(
      () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
      opts?.mutation?.onSuccess,
    ),
    },
  );
}

// ─── Live overrides ─────────────────────────────────────────────────────────

export type LiveOverride = {
  id: string;
  title: string;
  youtubeUrl: string;
  youtubeVideoId: string | null;
  startedAt: string;
  endedAt: string | null;
};

// LiveStatus exposes both the API's `active` field AND a `liveOverride`
// alias the dashboard pages were written against. `ytLive` defaults to
// false until the API surfaces real YouTube live-detection state.
export type LiveStatus = {
  isLive: boolean;
  active: LiveOverride | null;
  liveOverride: LiveOverride | null;
  ytLive: boolean;
};

type RawLiveStatus = { isLive: boolean; active: LiveOverride | null };

export const getGetLiveStatusQueryKey = (): QueryKey => ["live", "status"];
export function useGetLiveStatus(opts?: QueryOpts<LiveStatus>) {
  return useQuery<LiveStatus, ApiError, LiveStatus, QueryKey>(
    mergeQueryOpts<LiveStatus>(
      {
        queryKey: getGetLiveStatusQueryKey(),
        queryFn: async () => {
          const raw = await request<RawLiveStatus>("GET", "/live/status");
          return {
            isLive: raw.isLive,
            active: raw.active,
            liveOverride: raw.active,
            ytLive: false,
          };
        },
      },
      opts,
    ),
  );
}

export const getListRecentLiveQueryKey = (): QueryKey => ["live", "recent"];
export function useListRecentLive(opts?: QueryOpts<{ items: Array<LiveOverride | null> }>) {
  return useQuery<{ items: Array<LiveOverride | null> }, ApiError, { items: Array<LiveOverride | null> }, QueryKey>(
    mergeQueryOpts<{ items: Array<LiveOverride | null> }>(
      {
        queryKey: getListRecentLiveQueryKey(),
        queryFn: () =>
          request<{ items: Array<LiveOverride | null> }>("GET", "/live/recent"),
      },
      opts,
    ),
  );
}

// StartLiveBody intentionally accepts a SUPERSET of the API contract: the
// dashboard's "Go Live" form sends `{title, durationMinutes, notify}` while
// the API also accepts `youtubeUrl|hlsStreamUrl|rtmpIngestKey`. Keeping
// both shapes optional here lets the page compile; runtime validation
// stays the source of truth on the server.
type StartLiveBody = {
  title: string;
  youtubeUrl?: string | null;
  hlsStreamUrl?: string | null;
  rtmpIngestKey?: string | null;
  streamNotes?: string | null;
  endsAt?: string | null;
  scheduledFor?: string | null;
  durationMinutes?: number;
  notify?: boolean;
};
type StartLiveResult = {
  override: NonNullable<LiveStatus["active"]>;
  push: { sent: number; failed: number };
};
type StartLiveVars = { data: StartLiveBody };
export function useStartLiveOverride(opts?: MutationOpts<StartLiveResult, StartLiveVars>) {
  const qc = useQueryClient();
  return useMutation<StartLiveResult, ApiError, StartLiveVars>({
    mutationFn: ({ data }: StartLiveVars) =>
      request<StartLiveResult>("POST", "/live/start", { body: data }),
    onError: opts?.mutation?.onError,
    onSettled: opts?.mutation?.onSettled,
    retry: opts?.mutation?.retry,
    onSuccess: chainOnSuccess(
      () => qc.invalidateQueries({ queryKey: ["live"] }),
      opts?.mutation?.onSuccess,
    ),
  });
}

export function useStopLiveOverride(opts?: MutationOpts<{ stopped: boolean }, void>) {
  const qc = useQueryClient();
  return useMutation<{ stopped: boolean }, ApiError, void>({
    mutationFn: () => request<{ stopped: boolean }>("POST", "/live/stop"),
    onError: opts?.mutation?.onError,
    onSettled: opts?.mutation?.onSettled,
    retry: opts?.mutation?.retry,
    onSuccess: chainOnSuccess(
      () => qc.invalidateQueries({ queryKey: ["live"] }),
      opts?.mutation?.onSuccess,
    ),
  });
}

// ─── Schedule ───────────────────────────────────────────────────────────────

// ScheduleEntry exposes nullable fields as `string | undefined` rather
// than `string | null` because the dashboard's ScheduleEntryRow component
// (and several form helpers) assume the looser undefined-only shape.
// We coerce nulls→undefined in the adapter below.
export type ScheduleEntry = {
  id: string;
  title: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string | undefined;
  contentType: string;
  contentId: string | undefined;
  isRecurring: boolean;
  isActive: boolean;
  createdAt: string;
};

type RawScheduleEntry = Omit<ScheduleEntry, "endTime" | "contentId"> & {
  endTime: string | null;
  contentId: string | null;
};

function toScheduleEntry(r: RawScheduleEntry): ScheduleEntry {
  return {
    ...r,
    endTime: r.endTime ?? undefined,
    contentId: r.contentId ?? undefined,
  };
}

export const getListScheduleQueryKey = (): QueryKey => ["schedule", "list"];
export function useListSchedule(opts?: QueryOpts<ScheduleEntry[]>) {
  return useQuery<ScheduleEntry[], ApiError, ScheduleEntry[], QueryKey>(
    mergeQueryOpts<ScheduleEntry[]>(
      {
        queryKey: getListScheduleQueryKey(),
        queryFn: async () => {
          const res = await request<ListEnvelope<RawScheduleEntry>>("GET", "/schedule");
          return res.items.map(toScheduleEntry);
        },
      },
      opts,
    ),
  );
}

type ScheduleBody = Omit<ScheduleEntry, "id" | "createdAt"> & {
  endTime?: string | null;
  contentId?: string | null;
};
type CreateScheduleVars = { data: ScheduleBody };
export function useCreateScheduleEntry(opts?: MutationOpts<ScheduleEntry, CreateScheduleVars>) {
  const qc = useQueryClient();
  return useMutation<ScheduleEntry, ApiError, CreateScheduleVars>({
    mutationFn: ({ data }: CreateScheduleVars) =>
      request<ScheduleEntry>("POST", "/schedule", { body: data }),
    onError: opts?.mutation?.onError,
    onSettled: opts?.mutation?.onSettled,
    retry: opts?.mutation?.retry,
    onSuccess: chainOnSuccess(
      () => qc.invalidateQueries({ queryKey: ["schedule"] }),
      opts?.mutation?.onSuccess,
    ),
  });
}

export function useUpdateScheduleEntry(
  opts?: MutationOpts<ScheduleEntry, { id: string; data: Partial<ScheduleBody> }>,
) {
  const qc = useQueryClient();
  return useMutation<ScheduleEntry, ApiError, { id: string; data: Partial<ScheduleBody> }>({
    mutationFn: ({ id, data }: { id: string; data: Partial<ScheduleBody> }) => request<ScheduleEntry>("PATCH", `/schedule/${encodeURIComponent(id)}`, { body: data }),
    onError: opts?.mutation?.onError,
    onSettled: opts?.mutation?.onSettled,
    retry: opts?.mutation?.retry,
    onSuccess: chainOnSuccess(
      () => qc.invalidateQueries({ queryKey: ["schedule"] }),
      opts?.mutation?.onSuccess,
    ),
  });
}

export function useDeleteScheduleEntry(
  opts?: MutationOpts<{ id: string; deleted: true }, { id: string }>,
) {
  const qc = useQueryClient();
  return useMutation<{ id: string; deleted: true }, ApiError, { id: string }>({
    mutationFn: ({ id }: { id: string }) => request<{ id: string; deleted: true }>("DELETE", `/schedule/${encodeURIComponent(id)}`),
    onError: opts?.mutation?.onError,
    onSettled: opts?.mutation?.onSettled,
    retry: opts?.mutation?.retry,
    onSuccess: chainOnSuccess(
      () => qc.invalidateQueries({ queryKey: ["schedule"] }),
      opts?.mutation?.onSuccess,
    ),
  });
}

// ─── Playlists ──────────────────────────────────────────────────────────────

export type Playlist = {
  id: string;
  name: string;
  description: string;
  loopMode: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  videoCount: number;
};

export type PlaylistVideo = {
  id: string;
  playlistId: string;
  videoId: string;
  youtubeId: string;
  title: string;
  thumbnailUrl: string;
  duration: string;
  category: string;
  sortOrder: number;
  addedAt: string;
};

export type PlaylistDetail = Playlist & { videos: PlaylistVideo[] };

export const getListPlaylistsQueryKey = (): QueryKey => ["playlists", "list"];
export function useListPlaylists(opts?: QueryOpts<Playlist[]>) {
  return useQuery<Playlist[], ApiError, Playlist[], QueryKey>(
    mergeQueryOpts<Playlist[]>(
      {
        queryKey: getListPlaylistsQueryKey(),
        queryFn: async () => {
          const res = await request<ListEnvelope<Playlist>>("GET", "/playlists");
          return res.items;
        },
      },
      opts,
    ),
  );
}

export const getGetPlaylistQueryKey = (id: string): QueryKey => ["playlists", "detail", id];
export function useGetPlaylist(id: string, opts?: QueryOpts<PlaylistDetail>) {
  return useQuery<PlaylistDetail, ApiError, PlaylistDetail, QueryKey>(
    mergeQueryOpts<PlaylistDetail>(
      {
        queryKey: getGetPlaylistQueryKey(id),
        queryFn: () => request<PlaylistDetail>("GET", `/playlists/${encodeURIComponent(id)}`),
        enabled: !!id,
      },
      opts,
    ),
  );
}

type CreatePlaylistBody = {
  name: string;
  description?: string;
  // Accept the page's vocabulary ("none"/"random") AND the API's vocabulary
  // ("shuffle"/"single") so the dashboard form compiles. The hook adapter
  // below normalizes page values → API values before sending.
  loopMode?: "sequential" | "shuffle" | "single" | "none" | "random";
  isActive?: boolean;
};

function normalizePlaylistBody(body: CreatePlaylistBody): {
  name: string;
  description?: string;
  loopMode?: "sequential" | "shuffle" | "single";
  isActive?: boolean;
} {
  let loopMode: "sequential" | "shuffle" | "single" | undefined;
  switch (body.loopMode) {
    case "none":
      loopMode = "sequential";
      break;
    case "random":
      loopMode = "shuffle";
      break;
    case undefined:
      loopMode = undefined;
      break;
    default:
      loopMode = body.loopMode;
  }
  return { name: body.name, description: body.description, loopMode, isActive: body.isActive };
}
type CreatePlaylistVars = { data: CreatePlaylistBody };
export function useCreatePlaylist(opts?: MutationOpts<Playlist, CreatePlaylistVars>) {
  const qc = useQueryClient();
  return useMutation<Playlist, ApiError, CreatePlaylistVars>({
    mutationFn: ({ data }: CreatePlaylistVars) =>
      request<Playlist>("POST", "/playlists", { body: normalizePlaylistBody(data) }),
    onError: opts?.mutation?.onError,
    onSettled: opts?.mutation?.onSettled,
    retry: opts?.mutation?.retry,
    onSuccess: chainOnSuccess(
      () => qc.invalidateQueries({ queryKey: ["playlists"] }),
      opts?.mutation?.onSuccess,
    ),
  });
}

export function useUpdatePlaylist(
  opts?: MutationOpts<Playlist, { id: string; data: Partial<CreatePlaylistBody> }>,
) {
  const qc = useQueryClient();
  return useMutation<Playlist, ApiError, { id: string; data: Partial<CreatePlaylistBody> }>({
    mutationFn: ({ id, data }: { id: string; data: Partial<CreatePlaylistBody> }) =>
      request<Playlist>("PATCH", `/playlists/${encodeURIComponent(id)}`, {
        body: normalizePlaylistBody({ name: "", ...data }),
      }),
    onError: opts?.mutation?.onError,
    onSettled: opts?.mutation?.onSettled,
    retry: opts?.mutation?.retry,
    onSuccess: chainOnSuccess(
      () => qc.invalidateQueries({ queryKey: ["playlists"] }),
      opts?.mutation?.onSuccess,
    ),
  });
}

export function useDeletePlaylist(
  opts?: MutationOpts<{ id: string; deleted: true }, { id: string }>,
) {
  const qc = useQueryClient();
  return useMutation<{ id: string; deleted: true }, ApiError, { id: string }>({
    mutationFn: ({ id }: { id: string }) => request<{ id: string; deleted: true }>("DELETE", `/playlists/${encodeURIComponent(id)}`),
    onError: opts?.mutation?.onError,
    onSettled: opts?.mutation?.onSettled,
    retry: opts?.mutation?.retry,
    onSuccess: chainOnSuccess(
      () => qc.invalidateQueries({ queryKey: ["playlists"] }),
      opts?.mutation?.onSuccess,
    ),
  });
}

export function useAddVideoToPlaylist(
  opts?: MutationOpts<PlaylistDetail, { id: string; data: { videoId: string } }>,
) {
  const qc = useQueryClient();
  return useMutation<PlaylistDetail, ApiError, { id: string; data: { videoId: string } }>({
    mutationFn: ({ id, data }: { id: string; data: { videoId: string } }) => request<PlaylistDetail>("POST", `/playlists/${encodeURIComponent(id)}/videos`, {
        body: data,
      }),
    onSuccess: chainOnSuccess<PlaylistDetail, { id: string; data: { videoId: string } }>(
      () => {
        qc.invalidateQueries({ queryKey: ["playlists"] });
      },
      opts?.mutation?.onSuccess,
    ),
  });
}

export function useRemoveVideoFromPlaylist(
  opts?: MutationOpts<PlaylistDetail, { id: string; videoId: string }>,
) {
  const qc = useQueryClient();
  return useMutation<PlaylistDetail, ApiError, { id: string; videoId: string }>({
    mutationFn: ({ id, videoId }: { id: string; videoId: string }) => request<PlaylistDetail>(
        "DELETE",
        `/playlists/${encodeURIComponent(id)}/videos/${encodeURIComponent(videoId)}`,
      ),
    onSuccess: chainOnSuccess<PlaylistDetail, { id: string; videoId: string }>(
      () => {
        qc.invalidateQueries({ queryKey: ["playlists"] });
      },
      opts?.mutation?.onSuccess,
    ),
  });
}

export function useReorderPlaylist(
  opts?: MutationOpts<PlaylistDetail, { id: string; data: { videoIds: string[] } }>,
) {
  const qc = useQueryClient();
  return useMutation<PlaylistDetail, ApiError, { id: string; data: { videoIds: string[] } }>({
    onError: opts?.mutation?.onError,
    onSettled: opts?.mutation?.onSettled,
    retry: opts?.mutation?.retry,
    mutationFn: ({ id, data }: { id: string; data: { videoIds: string[] } }) => request<PlaylistDetail>("POST", `/playlists/${encodeURIComponent(id)}/reorder`, {
        body: data,
      }),
    onSuccess: chainOnSuccess<PlaylistDetail, { id: string; data: { videoIds: string[] } }>(
      () => {
        qc.invalidateQueries({ queryKey: ["playlists"] });
      },
      opts?.mutation?.onSuccess,
    ),
  });
}

// ─── Notifications ──────────────────────────────────────────────────────────

export type SentNotification = {
  id: string;
  title: string;
  body: string;
  type: string;
  videoId: string | null;
  scheduledAt: string;
  status: string;
  sentCount: number;
  errorMessage: string | null;
  createdAt: string;
  // Coerced non-null in the adapter so `new Date(notif.sentAt)` typechecks
  // in the notifications page (see toSentNotification below).
  sentAt: string;
};

type RawSentNotification = Omit<SentNotification, "sentAt" | "sentCount"> & {
  sentAt: string | null;
  sentCount: number | null;
};

function toSentNotification(r: RawSentNotification): SentNotification {
  return {
    ...r,
    sentAt: r.sentAt ?? r.scheduledAt ?? r.createdAt,
    sentCount: r.sentCount ?? 0,
  };
}

export const getListNotificationHistoryQueryKey = (): QueryKey => ["notifications", "history"];
export function useListNotificationHistory(opts?: QueryOpts<SentNotification[]>) {
  return useQuery<SentNotification[], ApiError, SentNotification[], QueryKey>(
    mergeQueryOpts<SentNotification[]>(
      {
        queryKey: getListNotificationHistoryQueryKey(),
        queryFn: async () => {
          const res = await request<ListEnvelope<RawSentNotification>>(
            "GET",
            "/notifications/history",
          );
          return res.items.map(toSentNotification);
        },
      },
      opts,
    ),
  );
}

type SendPushBody = {
  title: string;
  body: string;
  type?: string;
  videoId?: string | null;
  data?: Record<string, unknown>;
};
type SendPushVars = { data: SendPushBody };
// Page expects `{sent, failed}`. The API returns the persisted notification
// row extended with `recipients` (total audience) and `delivered` (actually
// dispatched). Use those for the page-friendly shape; fall back to sentCount
// for backward compat with older api-server builds.
type SendPushResult = { sent: number; failed: number };
type RawSendPushResponse = SentNotification & {
  recipients: number;
  delivered: number;
  deduplicated: boolean;
};
export function useSendPushNotification(opts?: MutationOpts<SendPushResult, SendPushVars>) {
  const qc = useQueryClient();
  return useMutation<SendPushResult, ApiError, SendPushVars>({
    mutationFn: async ({ data }: SendPushVars) => {
      const raw = await request<RawSendPushResponse>("POST", "/notifications/send", { body: data });
      const sent = raw.delivered ?? raw.sentCount;
      const total = raw.recipients ?? raw.sentCount;
      return {
        sent,
        failed: Math.max(0, total - sent),
      };
    },
    onError: opts?.mutation?.onError,
    onSettled: opts?.mutation?.onSettled,
    retry: opts?.mutation?.retry,
    onSuccess: chainOnSuccess(
      () => qc.invalidateQueries({ queryKey: ["notifications"] }),
      opts?.mutation?.onSuccess,
    ),
  });
}

// ─── Media (videos) ─────────────────────────────────────────────────────────

export type AdminVideo = {
  id: string;
  youtubeId: string | null;
  title: string;
  description: string | null;
  // Coerced non-null in the adapter (default "") so consumers like
  // <img src={video.thumbnailUrl}> compile without nullable handling.
  thumbnailUrl: string;
  duration: string | null;
  category: string | null;
  preacher: string | null;
  publishedAt: string | null;
  importedAt: string;
  viewCount: number;
  featured: boolean;
  videoSource: "youtube" | "local";
  localVideoUrl: string | null;
  hlsMasterUrl: string | null;
  transcodingStatus: string | null;
  originalFilename: string | null;
  sizeBytes: number | null;
};

type RawAdminVideo = Omit<AdminVideo, "thumbnailUrl"> & { thumbnailUrl: string | null };
function toAdminVideo(v: RawAdminVideo): AdminVideo {
  return { ...v, thumbnailUrl: v.thumbnailUrl ?? "" };
}

type ListAdminVideosParams = {
  search?: string;
  category?: string;
  source?: string;
  transcodingStatus?: string;
  featured?: boolean;
  limit?: number;
  offset?: number;
  page?: number;
};

type ListAdminVideosResponse = {
  videos: AdminVideo[];
  total: number;
  totalPages: number;
  page: number;
  limit: number;
};

type RawAdminVideosEnvelope = {
  videos: RawAdminVideo[];
  total: number;
  totalPages: number;
  page: number;
  limit: number;
};

export const getListAdminVideosQueryKey = (params?: ListAdminVideosParams): QueryKey => [
  "admin",
  "videos",
  params?.search ?? "",
  params?.category ?? "",
  params?.source ?? "",
  params?.transcodingStatus ?? "",
  params?.featured ?? "",
  params?.page ?? 1,
  params?.limit ?? 20,
];

export function useListAdminVideos(
  params?: ListAdminVideosParams,
  opts?: QueryOpts<ListAdminVideosResponse>,
) {
  const limit = params?.limit ?? 20;
  const page = params?.page ?? 1;
  return useQuery<ListAdminVideosResponse, ApiError, ListAdminVideosResponse, QueryKey>(
    mergeQueryOpts<ListAdminVideosResponse>(
      {
        queryKey: getListAdminVideosQueryKey(params),
        queryFn: async () => {
          // Use the admin endpoint which supports all filters server-side
          // (category, source, transcodingStatus, search) and returns proper
          // page-based pagination. The public /media endpoint lacks source and
          // transcodingStatus filters and uses offset-based pagination.
          const res = await request<RawAdminVideosEnvelope>("GET", "/admin/videos", {
            query: {
              search: params?.search,
              category: params?.category,
              source: params?.source,
              transcodingStatus: params?.transcodingStatus,
              featured: params?.featured,
              page,
              limit,
            },
          });
          return {
            videos: res.videos.map(toAdminVideo),
            total: res.total,
            totalPages: res.totalPages,
            page: res.page,
            limit: res.limit,
          };
        },
      },
      opts,
    ),
  );
}

type ImportVideoBody = {
  youtubeId: string;
  // Optional — the API can hydrate title/metadata from YouTube when only an
  // id is provided, so the dashboard's quick-import form can send {youtubeId}
  // alone.
  title?: string;
  description?: string;
  thumbnailUrl?: string;
  duration?: string;
  category?: string;
  preacher?: string;
  videoSource?: "youtube" | "local" | "hls";
  localVideoUrl?: string | null;
  featured?: boolean;
  publishedAt?: string;
};

type ImportVideoVars = { data: ImportVideoBody };
export function useImportVideo(opts?: MutationOpts<AdminVideo, ImportVideoVars>) {
  const qc = useQueryClient();
  return useMutation<AdminVideo, ApiError, ImportVideoVars>({
    mutationFn: ({ data }: ImportVideoVars) =>
      request<AdminVideo>("POST", "/media", { body: data }),
    onError: opts?.mutation?.onError,
    onSettled: opts?.mutation?.onSettled,
    retry: opts?.mutation?.retry,
    onSuccess: chainOnSuccess(
      () => qc.invalidateQueries({ queryKey: ["admin", "videos"] }),
      opts?.mutation?.onSuccess,
    ),
  });
}

type UpdateVideoBody = Partial<{
  title: string;
  description: string;
  thumbnailUrl: string;
  duration: string;
  category: string;
  preacher: string;
  featured: boolean;
  publishedAt: string | null;
}>;

export function useUpdateAdminVideo(
  opts?: MutationOpts<AdminVideo, { id: string; data: UpdateVideoBody }>,
) {
  const qc = useQueryClient();
  return useMutation<AdminVideo, ApiError, { id: string; data: UpdateVideoBody }>({
    mutationFn: ({ id, data }: { id: string; data: UpdateVideoBody }) => request<AdminVideo>("PATCH", `/media/${encodeURIComponent(id)}`, { body: data }),
    onError: opts?.mutation?.onError,
    onSettled: opts?.mutation?.onSettled,
    retry: opts?.mutation?.retry,
    onSuccess: chainOnSuccess(
      () => qc.invalidateQueries({ queryKey: ["admin", "videos"] }),
      opts?.mutation?.onSuccess,
    ),
  });
}

export function useDeleteAdminVideo(
  opts?: MutationOpts<{ id: string; deleted: true }, { id: string }>,
) {
  const qc = useQueryClient();
  return useMutation<{ id: string; deleted: true }, ApiError, { id: string }>({
    mutationFn: ({ id }: { id: string }) => request<{ id: string; deleted: true }>("DELETE", `/media/${encodeURIComponent(id)}`),
    onError: opts?.mutation?.onError,
    onSettled: opts?.mutation?.onSettled,
    retry: opts?.mutation?.retry,
    onSuccess: chainOnSuccess(
      () => qc.invalidateQueries({ queryKey: ["admin", "videos"] }),
      opts?.mutation?.onSuccess,
    ),
  });
}

// ─── Default export & migration marker ──────────────────────────────────────
//
// Some legacy call sites import the package as a default and fish hooks off
// it. Re-export the named surface as the default to keep those working.

const namespace = {
  ApiError,
  // queries
  useGetAdminStats,
  getGetAdminStatsQueryKey,
  useGetAnalytics,
  getGetAnalyticsQueryKey,
  useListAdminUsers,
  getListAdminUsersQueryKey,
  useGetLiveStatus,
  getGetLiveStatusQueryKey,
  useListRecentLive,
  getListRecentLiveQueryKey,
  useListSchedule,
  getListScheduleQueryKey,
  useListPlaylists,
  getListPlaylistsQueryKey,
  useGetPlaylist,
  getGetPlaylistQueryKey,
  useListNotificationHistory,
  getListNotificationHistoryQueryKey,
  useListAdminVideos,
  getListAdminVideosQueryKey,
  // mutations
  useUpdateUserRole,
  useStartLiveOverride,
  useStopLiveOverride,
  useCreateScheduleEntry,
  useUpdateScheduleEntry,
  useDeleteScheduleEntry,
  useCreatePlaylist,
  useUpdatePlaylist,
  useDeletePlaylist,
  useAddVideoToPlaylist,
  useRemoveVideoFromPlaylist,
  useReorderPlaylist,
  useSendPushNotification,
  useImportVideo,
  useUpdateAdminVideo,
  useDeleteAdminVideo,
};

export default namespace;
export const __isStub = false as const;
