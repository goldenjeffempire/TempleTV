import { secureStorage } from "@/lib/secureStorage";
import { STORAGE_KEYS } from "@/constants/config";

function getApiBase(): string {
  const apiUrl = process.env.EXPO_PUBLIC_API_URL;
  if (apiUrl) return apiUrl.replace(/\/+$/, "");
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (domain) return `https://${domain}`;
  return "";
}

/**
 * Claim a TV device-link code with the currently-authenticated user.
 * The TV's next /exchange poll (within ~3s) will then receive a fresh
 * access + refresh token pair bound to this user.
 *
 * Self-contained API call (reads the token directly) so it can run on
 * the public /link route without depending on a refresh-token rotation.
 */
export async function apiClaimDeviceCode(code: string): Promise<{ ok: true }> {
  const token = await secureStorage.getItem(STORAGE_KEYS.authToken);
  if (!token) {
    throw new Error("You need to be signed in to link a TV.");
  }
  const res = await fetch(`${getApiBase()}/api/auth/device-link/claim`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ code: code.toUpperCase().replace(/\s+/g, "") }),
  });
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
