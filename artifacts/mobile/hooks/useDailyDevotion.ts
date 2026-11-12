import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNetworkStatus } from "./useNetworkStatus";
import { dailyDevotionRepository } from "@/services/dailyDevotion";
import { DEVOTION_QUERY_KEY, DEVOTION_REFRESH_MS, type DevotionSnapshot } from "@/services/dailyDevotionCore";

export function useDailyDevotion() {
  const client = useQueryClient();
  const { isOnline, apiUnreachable } = useNetworkStatus();
  const [foreground, setForeground] = useState(AppState.currentState !== "background");
  const [focused, setFocused] = useState(false);
  const [manuallyRefreshing, setManuallyRefreshing] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const reachable = isOnline || apiUnreachable === true;
  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => setFocused(false);
  }, []));
  useEffect(() => {
    const subscription = AppState.addEventListener("change", state => setForeground(state === "active"));
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    let active = true;
    void dailyDevotionRepository.cached().then(saved => {
      if (!active || !saved) return;
      const current = client.getQueryData<DevotionSnapshot>(DEVOTION_QUERY_KEY);
      if (!current || current.fetchedAt < saved.fetchedAt) {
        client.setQueryData(DEVOTION_QUERY_KEY, saved, { updatedAt: saved.fetchedAt });
      }
    });
    return () => { active = false; };
  }, [client]);

  const query = useQuery<DevotionSnapshot>({
    queryKey: DEVOTION_QUERY_KEY,
    enabled: foreground && focused && reachable,
    networkMode: "always",
    staleTime: DEVOTION_REFRESH_MS,
    gcTime: 24 * 60 * 60 * 1000,
    refetchInterval: foreground && focused && reachable ? DEVOTION_REFRESH_MS : false,
    refetchIntervalInBackground: false,
    retry: 1,
  });
  const refresh = useCallback(async () => {
    if (manuallyRefreshing) return;
    setManuallyRefreshing(true); setManualError(null);
    try {
      const snapshot = await dailyDevotionRepository.load(true);
      client.setQueryData(DEVOTION_QUERY_KEY, snapshot, { updatedAt: snapshot.fetchedAt });
    } catch (error) {
      setManualError(error instanceof Error ? error.message : "The devotion could not be refreshed.");
    } finally { setManuallyRefreshing(false); }
  }, [client, manuallyRefreshing]);
  return {
    devotion: query.data?.devotion ?? null,
    loading: !query.data && query.isFetching,
    refreshing: manuallyRefreshing || (query.isFetching && !!query.data),
    stale: !!query.data && (query.data.stale || !reachable || !!query.error ||
      Date.now() - query.data.fetchedAt >= DEVOTION_REFRESH_MS),
    error: manualError ?? query.data?.error ?? query.error?.message ?? null,
    refresh,
  };
}
