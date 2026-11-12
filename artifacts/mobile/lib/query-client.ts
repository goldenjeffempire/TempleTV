import { QueryClient, type QueryFunctionContext } from "@tanstack/react-query";
import { getApiBase } from "./apiBase";
import { dailyDevotionRepository } from "@/services/dailyDevotion";
import { DEVOTION_QUERY_KEY } from "@/services/dailyDevotionCore";

export function getApiUrl(): string { return `${getApiBase()}/`; }

async function defaultQueryFn({ queryKey, signal }: QueryFunctionContext) {
  if (queryKey[0] === DEVOTION_QUERY_KEY[0]) return dailyDevotionRepository.load(false, signal);
  const path = queryKey[0];
  if (typeof path !== "string" || !path.startsWith("/api/")) {
    throw new Error("This query requires a registered data source.");
  }
  const response = await fetch(new URL(path, getApiUrl()).toString(), { signal, credentials: "include" });
  if (!response.ok) throw new Error(`API request failed (${response.status})`);
  return response.json();
}

/** Preserve the existing global cache/reconnect policies for all other queries. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: defaultQueryFn,
      retry: 2,
      staleTime: 5 * 60 * 1000,
      gcTime: 15 * 60 * 1000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
    },
  },
});
