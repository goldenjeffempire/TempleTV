import { apiBase } from "@/lib/api-base";

/** API reachability must not depend on the separately deployed broadcast daemon. */
export async function checkAdminApiHealth(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${apiBase()}/healthz`, {
      signal: controller.signal,
      credentials: "omit",
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
