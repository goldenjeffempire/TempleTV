/**
 * Compatibility shim — see `lib/api-zod/src/index.ts` for the full
 * rationale. This package was deleted on April 2026 and rebuilt from
 * the new OpenAPI spec at `/docs/json`.
 *
 * Every named import (hook, query-key getter, mutation, etc.) resolves
 * to a permissive `any` via a Proxy so the legacy admin/mobile/tv
 * source still type-checks while the migration is in flight. Calls to
 * the stubbed hooks throw a clearly-labeled runtime error so a failing
 * dev surface is obvious rather than silent.
 */
const STUB_MARKER = "@workspace/api-client-react:stub";

function stubHook(name: string): any {
  const fn = (..._args: unknown[]) => {
    return {
      data: undefined,
      error: new Error(
        `[${STUB_MARKER}] '${name}' was invoked but the legacy client is removed. ` +
          `Migrate this call site to the new API at /api/v1.`,
      ),
      isLoading: false,
      isFetching: false,
      isSuccess: false,
      isError: true,
      isPending: false,
      mutate: () => undefined,
      mutateAsync: async () => {
        throw new Error(`[${STUB_MARKER}] '${name}' is not implemented in the stub client.`);
      },
      refetch: async () => undefined,
    };
  };
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === "name") return name;
      if (prop === Symbol.toPrimitive) return () => `[${STUB_MARKER}:${name}]`;
      return stubHook(`${name}.${String(prop)}`);
    },
  });
}

const handler = {
  get(_target: object, prop: string | symbol): any {
    if (prop === "__esModule") return true;
    if (typeof prop === "symbol") return undefined;
    return stubHook(prop);
  },
};

const root = new Proxy({}, handler) as Record<string, any>;
export default root;
export const __isStub: true = true;

/**
 * Statically-named export stubs.
 *
 * Why these exist: ESM bundlers (rolldown / vite / esbuild / webpack) do
 * static analysis of `export` declarations and reject `import { foo }` if
 * `foo` isn't found at parse time, even when the runtime would have
 * resolved it via a Proxy on the default export. The TypeScript ambient
 * `export = anything` shim lets `tsc` accept any name, but the bundler
 * still fails the build with "MISSING_EXPORT".
 *
 * Each name below is one that the in-flight admin / mobile / TV migration
 * still imports (see `rg "from \"@workspace/api-client-react\""`). They
 * all delegate to the same Proxy stub, so calling any of them at runtime
 * throws the same clearly-labelled "stub client" error — preserving the
 * original failure-mode while letting the bundle compile.
 *
 * When a real call site is migrated to fetch from `/api/v1/...` directly,
 * delete the corresponding line here. When a new legacy call site is
 * added during the migration, add its name to this list.
 */
export const useGetAdminStats: any = stubHook("useGetAdminStats");
export const getGetAdminStatsQueryKey: any = stubHook("getGetAdminStatsQueryKey");
export const useGetAnalytics: any = stubHook("useGetAnalytics");
export const getGetAnalyticsQueryKey: any = stubHook("getGetAnalyticsQueryKey");
export const useGetLiveStatus: any = stubHook("useGetLiveStatus");
export const getGetLiveStatusQueryKey: any = stubHook("getGetLiveStatusQueryKey");
export const useStartLiveOverride: any = stubHook("useStartLiveOverride");
export const useStopLiveOverride: any = stubHook("useStopLiveOverride");

export const useListAdminVideos: any = stubHook("useListAdminVideos");
export const getListAdminVideosQueryKey: any = stubHook("getListAdminVideosQueryKey");
export const useImportVideo: any = stubHook("useImportVideo");
export const useUpdateAdminVideo: any = stubHook("useUpdateAdminVideo");
export const useDeleteAdminVideo: any = stubHook("useDeleteAdminVideo");

export const useListAdminUsers: any = stubHook("useListAdminUsers");
export const getListAdminUsersQueryKey: any = stubHook("getListAdminUsersQueryKey");

export const useListSchedule: any = stubHook("useListSchedule");
export const getListScheduleQueryKey: any = stubHook("getListScheduleQueryKey");
export const useCreateScheduleEntry: any = stubHook("useCreateScheduleEntry");
export const useUpdateScheduleEntry: any = stubHook("useUpdateScheduleEntry");
export const useDeleteScheduleEntry: any = stubHook("useDeleteScheduleEntry");

export const useListPlaylists: any = stubHook("useListPlaylists");
export const getListPlaylistsQueryKey: any = stubHook("getListPlaylistsQueryKey");
export const useGetPlaylist: any = stubHook("useGetPlaylist");
export const getGetPlaylistQueryKey: any = stubHook("getGetPlaylistQueryKey");
export const useCreatePlaylist: any = stubHook("useCreatePlaylist");
export const useUpdatePlaylist: any = stubHook("useUpdatePlaylist");
export const useDeletePlaylist: any = stubHook("useDeletePlaylist");
export const useAddVideoToPlaylist: any = stubHook("useAddVideoToPlaylist");
export const useRemoveVideoFromPlaylist: any = stubHook("useRemoveVideoFromPlaylist");
export const useReorderPlaylist: any = stubHook("useReorderPlaylist");

export const useListNotificationHistory: any = stubHook("useListNotificationHistory");
export const getListNotificationHistoryQueryKey: any = stubHook(
  "getListNotificationHistoryQueryKey",
);
export const useSendPushNotification: any = stubHook("useSendPushNotification");
