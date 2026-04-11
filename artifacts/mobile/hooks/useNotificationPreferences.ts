import { useCallback, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "@temple_tv/notif_prefs";

interface NotifPrefs {
  liveAlerts: boolean;
  newSermonAlerts: boolean;
}

const DEFAULT: NotifPrefs = { liveAlerts: false, newSermonAlerts: false };

export function useNotificationPreferences() {
  const [prefs, setPrefs] = useState<NotifPrefs>(DEFAULT);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((raw) => {
        if (raw) {
          try {
            setPrefs(JSON.parse(raw) as NotifPrefs);
          } catch {
            // malformed — use defaults
          }
        }
      })
      .finally(() => setLoaded(true));
  }, []);

  const save = useCallback(
    async (update: Partial<NotifPrefs>) => {
      const next: NotifPrefs = { ...prefs, ...update };
      setPrefs(next);
      try {
        await AsyncStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Non-critical
      }
    },
    [prefs],
  );

  const syncWithPermissionStatus = useCallback(
    async (granted: boolean) => {
      if (!granted) return;
      const next: NotifPrefs = { liveAlerts: true, newSermonAlerts: true };
      setPrefs(next);
      try {
        await AsyncStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        //
      }
    },
    [],
  );

  return { prefs, save, loaded, syncWithPermissionStatus };
}
