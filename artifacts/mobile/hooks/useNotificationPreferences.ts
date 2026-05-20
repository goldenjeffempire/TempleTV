import { useCallback, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "@temple_tv/notif_prefs";
const OPT_IN_SEEN_KEY = "@temple_tv/notif_opt_in_seen";

interface NotifPrefs {
  liveAlerts: boolean;
  newSermonAlerts: boolean;
  emergencyAlerts: boolean;
}

const DEFAULT: NotifPrefs = {
  liveAlerts: false,
  newSermonAlerts: false,
  emergencyAlerts: false,
};

export function useNotificationPreferences() {
  const [prefs, setPrefs] = useState<NotifPrefs>(DEFAULT);
  const [loaded, setLoaded] = useState(false);
  const [hasSeenOptIn, setHasSeenOptIn] = useState(false);
  const [optInLoaded, setOptInLoaded] = useState(false);

  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(KEY),
      AsyncStorage.getItem(OPT_IN_SEEN_KEY),
    ])
      .then(([raw, seen]) => {
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as Partial<NotifPrefs>;
            setPrefs({ ...DEFAULT, ...parsed });
          } catch {
            // malformed — use defaults
          }
        }
        setHasSeenOptIn(seen === "1");
      })
      .finally(() => {
        setLoaded(true);
        setOptInLoaded(true);
      });
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

  const markOptInSeen = useCallback(async () => {
    setHasSeenOptIn(true);
    try {
      await AsyncStorage.setItem(OPT_IN_SEEN_KEY, "1");
    } catch {
      //
    }
  }, []);

  const syncWithPermissionStatus = useCallback(
    async (granted: boolean) => {
      if (!granted) return;
      const next: NotifPrefs = {
        liveAlerts: true,
        newSermonAlerts: true,
        emergencyAlerts: true,
      };
      setPrefs(next);
      try {
        await AsyncStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        //
      }
    },
    [],
  );

  return { prefs, save, loaded, syncWithPermissionStatus, hasSeenOptIn, optInLoaded, markOptInSeen };
}
