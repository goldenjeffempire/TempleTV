export interface DaemonHealthPayload {
  ok: boolean;
  mode: string;
  hasCurrent: boolean;
  itemCount: number;
  boot: {
    started: boolean;
  };
  runtime: {
    role: string;
    gitCommit: string | null;
    serviceName: string | null;
    instanceId: string | null;
  };
}

export type DaemonHealthValidation =
  | { valid: true; payload: DaemonHealthPayload }
  | { valid: false; reason: string };

/**
 * Validate the daemon health response at the API/daemon process boundary.
 *
 * A reachable TCP socket or HTTP 200 is not sufficient: an old daemon build
 * once returned a zero-byte 200 response, which the API forwarded as healthy
 * while the orchestrator remained OFF AIR. Requiring the runtime identity and
 * core playback fields prevents that failure from being masked again.
 */
export function validateDaemonHealthBody(rawBody: string): DaemonHealthValidation {
  if (rawBody.trim().length === 0) {
    return { valid: false, reason: "empty response body" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { valid: false, reason: "response body is not valid JSON" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { valid: false, reason: "response body is not a JSON object" };
  }

  const payload = parsed as Partial<DaemonHealthPayload>;
  if (typeof payload.ok !== "boolean") {
    return { valid: false, reason: "missing boolean ok field" };
  }
  if (typeof payload.mode !== "string") {
    return { valid: false, reason: "missing string mode field" };
  }
  if (typeof payload.hasCurrent !== "boolean") {
    return { valid: false, reason: "missing boolean hasCurrent field" };
  }
  if (typeof payload.itemCount !== "number" || !Number.isFinite(payload.itemCount)) {
    return { valid: false, reason: "missing numeric itemCount field" };
  }
  if (typeof payload.boot?.started !== "boolean") {
    return { valid: false, reason: "missing boolean boot.started field" };
  }
  if (payload.runtime?.role !== "broadcast-daemon") {
    return { valid: false, reason: "response is not from a broadcast-daemon runtime" };
  }

  return { valid: true, payload: payload as DaemonHealthPayload };
}