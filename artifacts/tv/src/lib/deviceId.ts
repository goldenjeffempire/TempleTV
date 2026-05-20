/**
 * Stable device UUID — generated on first call and persisted in
 * localStorage. Used to key server-side watch-history without requiring
 * the viewer to sign in. Generating it at the module level (lazily) means
 * the first call always returns the same value within a page lifetime.
 */

const DEVICE_ID_KEY = "ttv:device-id:v1";

export function getDeviceId(): string {
  try {
    if (typeof window === "undefined") return "ssr";
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    return "anonymous";
  }
}
