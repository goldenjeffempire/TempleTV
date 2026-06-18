import { useCallback, useEffect, useRef, useState } from "react";
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
  // Ref that mirrors `prefs` state so that rapid toggle calls (before re-render)
  // build on the latest values rather than a stale closure snapshot.
  const prefsRef = useRef<NotifPrefs>(DEFAULT);

  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(KEY),
      AsyncStorage.getItem(OPT_IN_SEEN_KEY),
    ])
      .then(([raw, seen]) => {
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as Partial<NotifPrefs>;
            const loaded = { ...DEFAULT, ...parsed };
            prefsRef.current = loaded;
            setPrefs(loaded);
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
      // Merge into prefsRef.current (not the `prefs` state closure) so
      // concurrent calls within the same render cycle don't clobber each other.
      const next: NotifPrefs = { ...prefsRef.current, ...update };
      prefsRef.current = next;
      setPrefs(next);
      try {
        await AsyncStorage.setItem(KEY, JSON.stringify(next));
      } catch (e) {
        if (process.env.NODE_ENV !== "production") {
          if (__DEV__) console.error("[useNotificationPreferences] Failed to save prefs:", e);
        }
      }
    },
    [],
  );

  const markOptInSeen = useCallback(async () => {
    setHasSeenOptIn(true);
    try {
      await AsyncStorage.setItem(OPT_IN_SEEN_KEY, "1");
    } catch (e) {
      if (process.env.NODE_ENV !== "production") {
        if (__DEV__) console.error("[useNotificationPreferences] Failed to mark opt-in seen:", e);
      }
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
      // Update the ref FIRST so any concurrent save() call merges from the
      // already-granted state rather than the old all-false prefsRef snapshot.
      prefsRef.current = next;
      setPrefs(next);
      try {
        await AsyncStorage.setItem(KEY, JSON.stringify(next));
      } catch (e) {
        if (process.env.NODE_ENV !== "production") {
          if (__DEV__) console.error("[useNotificationPreferences] Failed to sync prefs:", e);
        }
      }
    },
    [],
  );

  return { prefs, save, loaded, syncWithPermissionStatus, hasSeenOptIn, optInLoaded, markOptInSeen };
}
