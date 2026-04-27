import { useCallback, useEffect, useRef, useState } from "react";
import { fetchGuide, type GuideItem } from "../lib/api";
import { useLiveSync } from "./useLiveSync";

const REMINDERS_KEY = "tv_guide_reminders";
const REFRESH_INTERVAL_MS = 60_000;

function loadReminders(): Set<string> {
  try {
    const raw = localStorage.getItem(REMINDERS_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function saveReminders(ids: Set<string>) {
  try {
    localStorage.setItem(REMINDERS_KEY, JSON.stringify([...ids]));
  } catch {}
}

export function useGuide() {
  const [items, setItems] = useState<GuideItem[]>([]);
  const [liveOverrideTitle, setLiveOverrideTitle] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reminders, setReminders] = useState<Set<string>>(loadReminders);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable ref so the SSE-driven effect can call load() without capturing a
  // stale closure or adding it to the syncedAt effect's dependency array.
  const loadRef = useRef<((showLoading?: boolean) => Promise<void>) | null>(null);

  const load = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const data = await fetchGuide();
      setItems(data.items ?? []);
      setLiveOverrideTitle(data.liveOverride?.title ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load guide");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    load(true);
    const schedule = () => {
      timerRef.current = setTimeout(() => {
        load(false);
        schedule();
      }, REFRESH_INTERVAL_MS);
    };
    schedule();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [load]);

  // When useLiveSync receives a broadcast-current-updated SSE event its
  // syncedAt changes — immediately refresh the guide so the "NOW" indicator
  // and progress bar update within seconds of a real item transition.
  // `scheduleRevision` is bumped on broadcast-schedule-updated (admin
  // creates/edits/deletes a schedule entry) so an admin schedule change
  // shows on the TV Guide within one event round-trip instead of waiting
  // on the 60s polling tick above.
  const { syncedAt, scheduleRevision } = useLiveSync();
  useEffect(() => {
    if (syncedAt) loadRef.current?.(false);
  }, [syncedAt]);
  useEffect(() => {
    if (scheduleRevision > 0) loadRef.current?.(false);
  }, [scheduleRevision]);

  const toggleReminder = useCallback((itemId: string) => {
    setReminders((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      saveReminders(next);
      return next;
    });
  }, []);

  const hasReminder = useCallback((itemId: string) => reminders.has(itemId), [reminders]);

  return { items, liveOverrideTitle, loading, error, toggleReminder, hasReminder, refresh: () => load(true) };
}
