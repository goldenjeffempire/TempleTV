/**
 * Device-link API client (TV side).
 *
 * Flow:
 *   1. POST /api/auth/device-link/create  → returns { code, expiresIn }
 *   2. Display the code on the TV.
 *   3. Poll /api/auth/device-link/exchange every ~2.5s with the code:
 *        • 202 Accepted  → still waiting for the user
 *        • 200 OK        → returns { accessToken, refreshToken, user }
 *        • 410 Gone      → code expired; create a new one
 */

function apiUrl(path: string): string {
  return `${window.location.origin}/api${path}`;
}

export interface CreatedCode {
  code: string;
  expiresIn: number;
  expiresAt: string;
}

export interface ExchangedTokens {
  accessToken: string;
  refreshToken?: string | null;
  user?: { id: string; email: string; displayName?: string | null };
}

export async function createLinkCode(deviceLabel?: string): Promise<CreatedCode> {
  const res = await fetch(apiUrl("/auth/device-link/create"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceLabel: deviceLabel ?? "Smart TV" }),
  });
  if (!res.ok) {
    throw new Error("Could not create a pairing code. Please try again.");
  }
  return res.json();
}

export type ExchangeResult =
  | { status: "pending" }
  | { status: "linked"; tokens: ExchangedTokens }
  | { status: "expired" };

export async function exchangeCode(code: string): Promise<ExchangeResult> {
  const res = await fetch(apiUrl("/auth/device-link/exchange"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (res.status === 202) return { status: "pending" };
  if (res.status === 410 || res.status === 404) return { status: "expired" };
  if (!res.ok) {
    // Treat transient errors as "pending" so the poll doesn't terminate.
    return { status: "pending" };
  }
  const tokens = (await res.json()) as ExchangedTokens;
  return { status: "linked", tokens };
}
