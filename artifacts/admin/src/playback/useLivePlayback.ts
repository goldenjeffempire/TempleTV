/**
 * useLivePlayback — singleton React hook around PlaybackClient.
 *
 * One PlaybackClient per browser tab is enough: every consumer subscribes
 * to the same in-memory state, the WS connection is shared, and React's
 * StrictMode double-mount is a no-op (start/stop are idempotent on the
 * shared instance).
 */

import { useEffect, useState } from "react";
import { PlaybackClient } from "./PlaybackClient";
import type {
  PlaybackConnectionState,
  PlaybackEvent,
  PlaybackState,
} from "./types";

let sharedClient: PlaybackClient | null = null;
let refCount = 0;

function getSharedClient(): PlaybackClient {
  if (!sharedClient) {
    sharedClient = new PlaybackClient();
    sharedClient.start();
  }
  return sharedClient;
}

function releaseSharedClient() {
  refCount -= 1;
  if (refCount <= 0 && sharedClient) {
    sharedClient.stop();
    sharedClient = null;
    refCount = 0;
  }
}

export interface UseLivePlaybackResult {
  state: PlaybackState | null;
  connection: PlaybackConnectionState;
  /** Subscribe to raw events (preload hints, transitions). Returns an unsub. */
  subscribe: (listener: (event: PlaybackEvent) => void) => () => void;
}

export function useLivePlayback(): UseLivePlaybackResult {
  const [state, setState] = useState<PlaybackState | null>(() =>
    sharedClient?.getState() ?? null,
  );
  const [connection, setConnection] = useState<PlaybackConnectionState>(() =>
    sharedClient?.getConnection() ?? "connecting",
  );

  useEffect(() => {
    const client = getSharedClient();
    refCount += 1;
    setState(client.getState());
    setConnection(client.getConnection());
    const unsubState = client.onState(setState);
    const unsubConn = client.onConnection(setConnection);
    return () => {
      unsubState();
      unsubConn();
      releaseSharedClient();
    };
  }, []);

  return {
    state,
    connection,
    subscribe: (listener) => {
      const client = getSharedClient();
      return client.onEvent(listener);
    },
  };
}
