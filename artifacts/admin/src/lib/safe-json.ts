// Shared JSON-parsing diagnostics for admin API responses.
//
// Round 4e introduced a tagged JsonResult pattern inside broadcast.tsx so the
// operator could see WHY a response failed (proxy returned HTML, body was
// empty, content-type mismatch, etc.) instead of a generic "empty or malformed
// response". Round 4g lifts that pattern into a shared module so the central
// adminRequest path and the per-page raw-fetch paths can all surface the same
// actionable detail.
//
// Design constraints honored:
//   - No new runtime dependencies.
//   - No schema changes.
//   - Backwards-compatible: AdminApiError still carries (status, message);
//     callers that already do `instanceof AdminApiError` keep working.
//   - The body preview is suppressed in the user-visible string when the
//     server claimed application/json — a half-parsed JSON body may contain
//     user data we shouldn't render in a banner. Console diagnostics still
//     get the preview for debugging.

export type JsonError = {
  reason: "empty" | "html_fallback" | "non_json";
  status: number;
  contentType: string;
  bodyPreview: string;
};

export type JsonResult<T> = { ok: true; data: T } | ({ ok: false } & JsonError);

const JSON_CONTENT_TYPE_RE = /\bapplication\/(?:[\w.+-]*\+)?json\b/i;
const HTML_FALLBACK_RE = /^\s*<(?:!doctype\s+html|html\b|head\b|body\b)/i;

/**
 * Parse a fetch Response body as JSON, returning a tagged result that captures
 * the failure mode in detail. Never throws.
 *
 * `consoleLabel` is included in the structured console.error so devtools shows
 * which call site produced the failure.
 */
export async function safeJson<T = unknown>(
  res: Response,
  consoleLabel = "admin-api",
): Promise<JsonResult<T>> {
  const text = await res.text();
  const ctype = res.headers.get("content-type") ?? "(none)";
  if (!text) {
    console.error(`[${consoleLabel}] empty response body`, {
      url: res.url,
      status: res.status,
      contentType: ctype,
    });
    return { ok: false, reason: "empty", status: res.status, contentType: ctype, bodyPreview: "" };
  }
  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch (err) {
    const isJsonContentType = JSON_CONTENT_TYPE_RE.test(ctype);
    const bodyPreview = text.slice(0, 200).replace(/\s+/g, " ");
    const looksLikeHtml = HTML_FALLBACK_RE.test(text);
    console.error(`[${consoleLabel}] non-JSON response body`, {
      url: res.url,
      status: res.status,
      contentType: ctype,
      // Don't echo the body to console either if the server CLAIMED JSON —
      // it's most likely to contain user data when truncated mid-stream.
      bodyPreview: isJsonContentType ? "(suppressed: JSON content-type)" : bodyPreview,
      parseError: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      reason: looksLikeHtml ? "html_fallback" : "non_json",
      status: res.status,
      contentType: ctype,
      bodyPreview,
    };
  }
}

/**
 * Build a short, human-readable explanation suitable for an inline banner or
 * error message. The HTML-fallback case explicitly tells the operator the
 * symptom suggests `/api/*` is hitting the SPA instead of the API server,
 * which is the single most common deployment misconfiguration.
 */
export function describeJsonError(label: string, err: JsonError): string {
  if (err.reason === "html_fallback") {
    return `${label}: server returned HTML instead of JSON (likely the admin SPA fell through — check that /api/* is routed to the API server).`;
  }
  if (err.reason === "empty") {
    return `${label}: empty body (HTTP ${err.status}, ${err.contentType}). Try reloading; if it persists, check API server logs.`;
  }
  // non_json
  const isJsonContentType = JSON_CONTENT_TYPE_RE.test(err.contentType);
  const snippet =
    err.bodyPreview && !isJsonContentType
      ? ` — body started with: "${err.bodyPreview.slice(0, 80)}…"`
      : "";
  return `${label}: malformed JSON (HTTP ${err.status}, ${err.contentType})${snippet}`;
}
