import { secureStorage } from "@/lib/secureStorage";
import { SECURE_KEYS } from "@/constants/config";
import { getApiBase } from "@/lib/apiBase";
import { fetchWithRetry } from "@/lib/fetchWithRetry";

/**
 * Claim a TV device-link code with the currently-authenticated user.
 * The TV's next /exchange poll (within ~3s) will then receive a fresh
 * access + refresh token pair bound to this user.
 *
 * Self-contained API call (reads the token directly) so it can run on
 * the public /link route without depending on a refresh-token rotation.
 */
export async function apiClaimDeviceCode(code: string): Promise<{ ok: true }> {
  const token = await secureStorage.getItem(SECURE_KEYS.authToken);
  if (!token) {
    throw new Error("You need to be signed in to link a TV.");
  }
  const res = await fetchWithRetry(
    `${getApiBase()}/api/auth/device-link/claim`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ code: code.toUpperCase().replace(/\s+/g, "") }),
      signal: AbortSignal.timeout(12_000),
    },
    { maxRetries: 2, baseDelayMs: 400, isRetryable: (r) => r.status >= 500 },
  );
  if (!res.ok) {
    let message = "Could not link your TV. Please try again.";
    try {
      const data = await res.json();
      if (typeof data?.error === "string") message = data.error;
    } catch {}
    throw new Error(message);
  }
  return { ok: true };
}
