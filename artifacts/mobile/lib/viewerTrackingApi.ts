export const MOBILE_VIEWER_STREAM_ID = "temple-tv-live";
const REQUEST_TIMEOUT_MS = 8_000;

export type ViewerSession = { sessionId: string; streamId: string };

function endpoint(apiBase: string, path: string) {
  return `${apiBase}${path}`;
}

async function jsonRequest(
  apiBase: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(endpoint(apiBase, path), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The issued credential is deliberately never put in this header.
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function issueViewerCredential(
  apiBase: string,
  token?: string,
): Promise<ViewerSession> {
  const response = await jsonRequest(
    apiBase,
    "/api/viewer-tracking/issue",
    { streamId: MOBILE_VIEWER_STREAM_ID, platform: "mobile" },
    token,
  );
  if (!response.ok) {
    throw Object.assign(
      new Error(`Viewer credential issue failed (${response.status})`),
      { status: response.status },
    );
  }
  const value = (await response.json()) as ViewerSession;
  if (!value?.sessionId || value.streamId !== MOBILE_VIEWER_STREAM_ID) {
    throw new Error("Viewer credential response was invalid");
  }
  return value;
}

export async function sendViewerHeartbeat(
  apiBase: string,
  session: ViewerSession,
): Promise<Response> {
  return jsonRequest(apiBase, "/api/viewer-tracking/heartbeat", {
    sessionId: session.sessionId,
    streamId: session.streamId,
    platform: "mobile",
    clientTs: Date.now(),
  });
}

export async function leaveViewerSession(
  apiBase: string,
  session: ViewerSession,
): Promise<void> {
  // keepalive is not supported consistently by RN, but this best-effort request
  // still gives the server an immediate leave when the app/player is stopped.
  await jsonRequest(apiBase, "/api/viewer-tracking/leave", {
    sessionId: session.sessionId,
    streamId: session.streamId,
  }).catch(() => {});
}