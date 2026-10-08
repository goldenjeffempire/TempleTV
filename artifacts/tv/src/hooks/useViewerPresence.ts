import { useEffect, useRef } from "react";
import { resolveApiOrigin } from "../lib/api";

// One installation lease shared by the hero/fullscreen surfaces. A sync
// socket alone no longer counts as a viewer, so TV must report real playback.
const owners = new Set<symbol>();
let credential: string | null = null;
let pending: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let sequence = 0;
const storageKey = "temple_tv_viewer_capability";
const streamId = "temple-tv-live";
const nextSequence = () => sequence = Math.max(sequence + 1, Date.now() * 1000);

async function request(path: string, body: unknown, keepalive = false) {
  return fetch(`${resolveApiOrigin()}/api/viewer-tracking/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(8000), keepalive,
  });
}

async function heartbeat() {
  if (!owners.size || pending) return;
  pending = (async () => {
    if (!credential) {
      let resumeSessionId: string | null = null;
      try { resumeSessionId = localStorage.getItem(storageKey); } catch { /* private browsing */ }
      const response = await request("issue", { streamId, platform: "tv", ...(resumeSessionId ? { resumeSessionId } : {}) });
      if (!response.ok) throw new Error("Viewer credential unavailable");
      const value = await response.json();
      if (typeof value.sessionId !== "string" || value.streamId !== streamId) throw new Error("Invalid viewer credential");
      credential = value.sessionId;
      if (Number.isSafeInteger(value.nextSequence)) sequence = Math.max(sequence, value.nextSequence);
      try { localStorage.setItem(storageKey, credential!); } catch { /* retain in memory for this page */ }
    }
    if (!owners.size) return;
    const response = await request("heartbeat", { sessionId: credential, streamId, sequence: nextSequence(), platform: "tv" });
    if (response.status === 401) credential = null;
    if (!owners.size && credential) {
      await request("leave", { sessionId: credential, streamId, sequence: nextSequence() }, true);
    }
  })().catch(() => { /* expiry is the safety net; next tick retries */ }).finally(() => {
    pending = null;
    if (owners.size) timer = setTimeout(() => { void heartbeat(); }, 10_000);
  });
  await pending;
}

function setWatching(owner: symbol, watching: boolean) {
  if (watching) {
    owners.add(owner);
    if (timer) clearTimeout(timer);
    void heartbeat();
  } else {
    owners.delete(owner);
    if (!owners.size) {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (credential) void request("leave", {
        sessionId: credential, streamId, sequence: nextSequence(),
      }, true).catch(() => {});
    }
  }
}

export function useViewerPresence(state: string) {
  const owner = useRef(Symbol("tv-player"));
  useEffect(() => {
    const playing = ["PLAYING", "PREPARING_NEXT", "HANDOFF", "LIVE_OVERRIDE_ACTIVE"].includes(state);
    const update = () => setWatching(owner.current, playing && document.visibilityState === "visible");
    update();
    document.addEventListener("visibilitychange", update);
    const leave = () => setWatching(owner.current, false);
    window.addEventListener("pagehide", leave);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [state]);
}
