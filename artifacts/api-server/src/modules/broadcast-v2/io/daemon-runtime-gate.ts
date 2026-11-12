import type { FastifyInstance } from "fastify";

/** Opening the health socket for a rolling handoff must not serve fake OFF AIR. */
export function installDaemonRuntimeGate(
  app: FastifyInstance,
  runtime: () => { ready: boolean; phase: string },
): void {
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    const state = runtime();
    if (state.ready) return;
    // Pre-serialize to avoid per-route success schemas serializing an early
    // lifecycle error as a healthy broadcast snapshot.
    return reply.code(503).header("Retry-After", "5")
      .type("application/json; charset=utf-8")
      .send(JSON.stringify({
        error: "Broadcast runtime is not ready",
        code: "BROADCAST_DAEMON_NOT_READY",
        startupPhase: state.phase,
      }));
  });
}
