/**
 * liveNotificationBus — lightweight in-process event bus for foreground
 * live-stream push notifications.
 *
 * When expo-notifications fires `addNotificationReceivedListener` while the
 * app is open, the system banner shows but no navigation or in-app UI change
 * happens automatically. This bus lets any screen subscribe so it can display
 * an in-app "Live now — tap to join" banner without requiring the user to tap
 * the system notification.
 *
 * Usage:
 *   // Subscribe (e.g. in a screen's useEffect):
 *   const unsub = liveNotificationBus.subscribe(() => showLiveBanner());
 *   return () => unsub();
 *
 *   // Emit (in _layout.tsx foreground notification handler):
 *   liveNotificationBus.emit();
 */

type Listener = () => void;

class LiveNotificationBus {
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  emit(): void {
    for (const l of this.listeners) {
      try { l(); } catch { /* never let one bad listener kill others */ }
    }
  }
}

export const liveNotificationBus = new LiveNotificationBus();
