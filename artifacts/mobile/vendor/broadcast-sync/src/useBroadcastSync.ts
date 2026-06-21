/**
 * useBroadcastSync — React hook wrapping the BroadcastEngine.
 *
 * Creates a single BroadcastEngine instance per hook mount, starts it, and
 * keeps React state synchronised with engine emissions. Cleans up completely
 * on unmount — all WebSocket/SSE connections closed, all timers cleared.
 *
 * The engine reads options via a ref so changing URLs after mount (e.g.
 * dynamic env vars) does not restart the connection — only the next event
 * picks up new normalizeUrl.
 *
 * Public API: identical to the previous implementation so all existing
 * consumers (TV's useLiveSync, Mobile's useBroadcastSync adapter) continue
 * to work without modification.
 */

import { useState, useEffect, useRef } from "react";
import type { BroadcastSyncState } from "@workspace/broadcast-types";
import { BroadcastEngine } from "./engine/BroadcastEngine";
import type { BroadcastEngineOptions } from "./engine/types";

export type { BroadcastSyncState };

export interface BroadcastSyncOptions {
  wsUrl:         string;
  stateUrl:      string;
  liveStatusUrl?: string;
  normalizeUrl?:  (url: string) => string;
  sseUrl?:        string;
}

const INITIAL: BroadcastSyncState = {
  isLive:             false,
  title:              null,
  videoId:            null,
  hlsStreamUrl:       null,
  failoverHlsUrl:     null,
  liveOverride:       null,
  ytLive:             false,
  ytVideoId:          null,
  ytTitle:            null,
  syncedAt:           null,
  serverTimeMs:       null,
  connected:          false,
  positionSecs:       null,
  currentItemEndsAtMs: null,
  itemStartEpochSecs: null,
  index:              null,
  totalSecs:          null,
  queueLength:        null,
  progressPercent:    null,
  currentItem:        null,
  nextItem:           null,
  nextNextItem:       null,
  viewerCount:        null,
  payload:            null,
  libraryRevision:    0,
  scheduleRevision:   0,
  emergencyBroadcast: false,
  emergencyMessage:   null,
};

export function useBroadcastSync(options: BroadcastSyncOptions): BroadcastSyncState {
  const [state, setState] = useState<BroadcastSyncState>(INITIAL);
  // Keep options in a ref so the effect's closure always reads the latest
  // values without triggering a re-run (and therefore a reconnect).
  const optsRef = useRef<BroadcastSyncOptions>(options);
  optsRef.current = options;

  useEffect(() => {
    const opts: BroadcastEngineOptions = {
      wsUrl:         optsRef.current.wsUrl,
      stateUrl:      optsRef.current.stateUrl,
      liveStatusUrl: optsRef.current.liveStatusUrl,
      normalizeUrl:  optsRef.current.normalizeUrl,
      sseUrl:        optsRef.current.sseUrl,
    };

    const engine = new BroadcastEngine(opts);
    const unsub  = engine.subscribe(setState);
    engine.start();

    return () => {
      unsub();
      engine.stop();
    };
  // Mount-once: options are read from the ref, never trigger re-mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}
