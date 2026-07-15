#!/usr/bin/env node
/**
 * Production process supervisor — Temple TV.
 *
 * Runs the Broadcast Daemon (RUN_MODE=broadcast) and the API server
 * (RUN_MODE=all, BROADCAST_DAEMON_URL=http://127.0.0.1:<daemonPort>) as two
 * independent OS processes inside a single Reserved VM deployment.
 *
 * WHY THIS EXISTS
 * ────────────────
 * A Replit VM deployment runs one process tree per publish. Without this
 * supervisor, `node dist/index.mjs` with RUN_MODE=all is BOTH the public API
 * AND the broadcast engine in one process — any crash, unhandled exception,
 * or memory-watchdog restart of the API takes the live 24/7 broadcast down
 * with it, and every code deploy restarts the playlist from scratch.
 *
 * This script keeps those two concerns in separate processes so:
 *   - An API crash / OOM restart / unhandled exception NEVER interrupts
 *     on-air playback — the daemon (and the broadcast engine it owns) is
 *     untouched, and the API's daemon-proxy layer (SSE/WS/REST) reconnects
 *     to the still-running daemon within milliseconds.
 *   - A daemon crash is restarted independently and rehydrates the exact
 *     playback position from its DB checkpoint (broadcast-orchestrator.ts,
 *     5s checkpoint interval + event-driven bump()) — verified ~9ms dead-air
 *     on restart, not a playlist reset. The API's daemon-proxy buffers/
 *     retries for up to 30s while this happens, so viewers see at worst a
 *     brief reconnect, never a dropped stream.
 *   - A full container replacement (an actual new deploy / VM restart) is
 *     the only case where both processes restart together — and even then,
 *     DB-backed state hydration makes the resume effectively instantaneous.
 *
 * This is deliberately dependency-free (only Node built-ins) so it never
 * needs a build step and can't itself become a point of failure.
 */

import { spawn } from "node:child_process";
import http from "node:http";

const NODE = process.execPath;

const DAEMON_PORT = Number(process.env.DAEMON_PORT || 9000);
const API_PORT = Number(process.env.PORT || process.env.API_PORT || 8080);
const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;
const SHUTDOWN_FORCE_EXIT_BUDGET_MS = Number(process.env.SHUTDOWN_FORCE_EXIT_BUDGET_MS || 28_000);
const DAEMON_HEALTH_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_MS = 15_000;

function log(msg, extra = {}) {
  // Plain JSON line so it merges cleanly with the pino JSON logs of the
  // children in deployment log aggregation.
  console.log(JSON.stringify({ service: "prod-supervisor", msg, ts: Date.now(), ...extra }));
}

// Base env shared by both children (secrets, DB url, SMTP, etc. all flow
// through here via process.env). RUN_MODE/PORT/BROADCAST_DAEMON_URL are set
// per-child below so neither inherits the other's identity.
const sharedEnv = { ...process.env };
delete sharedEnv.RUN_MODE;
delete sharedEnv.PORT;
delete sharedEnv.BROADCAST_DAEMON_URL;

const daemonEnv = {
  ...sharedEnv,
  RUN_MODE: "broadcast",
  PORT: String(DAEMON_PORT),
  MEMORY_WARN_RSS_MB: process.env.DAEMON_MEMORY_WARN_RSS_MB || "800",
  MEMORY_RESTART_RSS_MB: process.env.DAEMON_MEMORY_RESTART_RSS_MB || "1200",
  TRANSCODER_DISABLE: "1",
  TRANSCODING_AUTO_RETRY_DISABLE: "1",
};

const apiEnv = {
  ...sharedEnv,
  RUN_MODE: "all",
  PORT: String(API_PORT),
  BROADCAST_DAEMON_URL: DAEMON_URL,
};

const daemonArgs = [
  "--max-old-space-size=512",
  "--expose-gc",
  "--enable-source-maps",
  "--import",
  "./artifacts/api-server/dist/instrument.mjs",
  "./artifacts/api-server/dist/index.mjs",
];

const apiArgs = [
  "--max-old-space-size=1536",
  "--expose-gc",
  "--enable-source-maps",
  "--import",
  "./artifacts/api-server/dist/instrument.mjs",
  "./artifacts/api-server/dist/index.mjs",
];

let shuttingDown = false;
let daemonChild = null;
let apiChild = null;
let daemonRestarts = 0;
let apiRestarts = 0;

function backoffMs(attempt) {
  return Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
}

function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tryOnce = () => {
      const req = http.get(`${url}/healthz`, { timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) return resolve(true);
        retry();
      });
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tryOnce, 500);
    };
    tryOnce();
  });
}

function spawnDaemon() {
  log("starting broadcast daemon", { port: DAEMON_PORT });
  daemonChild = spawn(NODE, daemonArgs, { env: daemonEnv, stdio: "inherit" });
  daemonChild.on("exit", (code, signal) => {
    daemonChild = null;
    if (shuttingDown) return;
    daemonRestarts += 1;
    const wait = backoffMs(Math.min(daemonRestarts, 5));
    log("broadcast daemon exited unexpectedly — restarting", { code, signal, restarts: daemonRestarts, waitMs: wait });
    setTimeout(spawnDaemon, wait);
  });
}

function spawnApi() {
  log("starting api server", { port: API_PORT });
  apiChild = spawn(NODE, apiArgs, { env: apiEnv, stdio: "inherit" });
  apiChild.on("exit", (code, signal) => {
    apiChild = null;
    if (shuttingDown) return;
    apiRestarts += 1;
    const wait = backoffMs(Math.min(apiRestarts, 5));
    log("api server exited unexpectedly — restarting (broadcast daemon unaffected)", {
      code,
      signal,
      restarts: apiRestarts,
      waitMs: wait,
    });
    setTimeout(spawnApi, wait);
  });
}

function stopChild(child, name) {
  return new Promise((resolve) => {
    if (!child) return resolve();
    const timer = setTimeout(() => {
      log(`${name} did not exit within shutdown budget — sending SIGKILL`, { name });
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, SHUTDOWN_FORCE_EXIT_BUDGET_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("supervisor shutdown starting", { signal });
  // Drain the public-facing API first — its own SIGTERM handler broadcasts a
  // "reconnect" hint to connected SSE/WS clients and drains in-flight HTTP
  // requests (SHUTDOWN_PRECLOSE_DELAY_MS / SHUTDOWN_DRAIN_MS) — while the
  // daemon keeps the broadcast engine alive for any traffic still in flight.
  await stopChild(apiChild, "api");
  // Now stop the daemon. Its own SIGTERM handler (daemonShutdown() in
  // main.ts) flushes the playback checkpoint to the DB before exiting, so
  // the next boot resumes at the exact position instead of restarting the
  // playlist.
  await stopChild(daemonChild, "daemon");
  log("supervisor shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

async function main() {
  log("supervisor starting", { daemonPort: DAEMON_PORT, apiPort: API_PORT });
  spawnDaemon();
  const healthy = await waitForHealth(DAEMON_URL, DAEMON_HEALTH_TIMEOUT_MS);
  if (!healthy) {
    log("broadcast daemon did not become healthy within timeout — starting API anyway; daemon-proxy will retry", {
      timeoutMs: DAEMON_HEALTH_TIMEOUT_MS,
    });
  } else {
    log("broadcast daemon healthy — starting api server");
  }
  spawnApi();
}

main();
