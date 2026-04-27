import { fetchWithTransientRetry } from "@/services/adminApi";
import { apiBase } from "@/lib/api-base";

/**
 * Probe a candidate admin token against `/api/admin/stats` to find out
 * whether the API server will accept it for authenticated calls.
 *
 * History
 * ───────
 * Originally this lived inside `admin-key-dialog.tsx` (search for the
 * "Round 4l" comment in the git log). The defensive JSON-parse step
 * exists because a load balancer fronting the API can return an HTML
 * error page with `Content-Type: application/json` during a deploy,
 * and the dialog was previously treating that 200-with-HTML body as a
 * passing verification — silently bypassing auth on the client. The
 * fix: explicitly JSON.parse the body before accepting `res.ok`.
 *
 * Why it's now shared
 * ───────────────────
 * Two surfaces need the same guarantee:
 *   1. The admin key dialog, when an operator pastes a key.
 *   2. The video upload modal, where firing this BEFORE the user picks
 *      a 12 GB file means an invalid token gets caught at "open the
 *      modal" instead of after a long file-selection + chunking +
 *      network round-trip to s3-multipart-init that then fails 401.
 * Keeping a single implementation prevents the two from drifting (the
 * dialog has been hardened iteratively; the upload modal must inherit
 * every one of those hardenings, not re-derive them).
 *
 * Note on the call site
 * ─────────────────────
 * This uses raw `fetch` (not `adminGet`) because in the dialog case the
 * caller is verifying a token that has NOT been written to localStorage
 * yet. The same shape works for the upload modal where the token IS in
 * localStorage — the explicit `Authorization` header overrides any
 * implicit one anyway, and that asymmetry is harmless.
 */
export type VerifyAdminTokenResult =
  | { ok: true }
  | { ok: false; status: number; message: string };

export async function verifyAdminToken(
  token: string,
): Promise<VerifyAdminTokenResult> {
  if (!token.trim()) {
    return {
      ok: false,
      status: 0,
      message:
        "No admin key set on this browser. Click the key icon in the top bar to enter one.",
    };
  }
  try {
    const res = await fetchWithTransientRetry(() =>
      fetch(`${apiBase()}/admin/stats`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    if (res.ok) {
      // Defense-in-depth JSON validation. The endpoint always returns
      // a JSON object on success; if the body is HTML or otherwise
      // unparseable we treat it as a server problem rather than as a
      // passing verification. See history note above.
      try {
        const text = await res.text();
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === "object") return { ok: true };
        return {
          ok: false,
          status: res.status,
          message:
            "Server returned an unexpected response shape; cannot verify admin key.",
        };
      } catch {
        return {
          ok: false,
          status: res.status,
          message:
            "Server returned a non-JSON response (the API server may be restarting). Try again in a moment.",
        };
      }
    }
    if (res.status === 401) {
      return {
        ok: false,
        status: 401,
        message: "That admin key was rejected by the server.",
      };
    }
    if (res.status === 503) {
      return {
        ok: false,
        status: 503,
        message:
          "The server has not been configured with an admin token yet. Set ADMIN_API_TOKEN on the API service.",
      };
    }
    return {
      ok: false,
      status: res.status,
      message: `Verification failed (HTTP ${res.status}).`,
    };
  } catch {
    return {
      ok: false,
      status: 0,
      message:
        "Could not reach the API server. Check your network and try again.",
    };
  }
}
