import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Polyfills a global `WebSocket` on runtimes that lack one (Node < 22) so
    // the broadcast-v2 WS integration tests exercise the real gateway.
    setupFiles: ["./tests/setup.ts"],
    // buildApp() pulls in Drizzle, Fastify plugins, and the broadcast
    // orchestrator — startup can take 10–25 s in the Replit sandbox.
    hookTimeout: 30_000,
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/scripts/**", "src/instrument.ts", "src/main.ts"],
    },
  },
  resolve: {
    conditions: ["workspace"],
  },
});
