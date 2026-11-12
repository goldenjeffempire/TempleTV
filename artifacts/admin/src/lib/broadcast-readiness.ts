type Failure = { code?: string; startupPhase?: string; message?: string };

export function broadcastReadiness(
  started: boolean | undefined,
  hasSnapshot: boolean,
  healthError: unknown,
  stateError: unknown,
) {
  const failure = (healthError || stateError) as Failure | null;
  if (failure?.startupPhase?.startsWith("leadership-")) {
    return { ready: false, message: "Broadcast startup is waiting for database leadership. Check the daemon logs for the lock owner. Queue reload, failover and transcoding cannot release another daemon’s lock." };
  }
  if (failure?.code === "BROADCAST_DAEMON_NOT_READY" || started === false) {
    return { ready: false, message: "The broadcast daemon has not finished starting. Check its readiness and startup logs; dashboard connectivity does not mean the broadcast engine is running." };
  }
  if (failure) {
    return { ready: false, message: "Broadcast status is unavailable. The last snapshot may be stale. Check the API-to-daemon connection and service health; this is not confirmation that the channel is off air." };
  }
  if (started !== true || !hasSnapshot) {
    return { ready: false, message: "Checking broadcast readiness and waiting for a current server snapshot…" };
  }
  return { ready: true, message: "" };
}
