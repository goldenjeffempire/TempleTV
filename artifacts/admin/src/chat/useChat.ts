import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { ChatClient, type ChatClientOptions, type ChatSnapshot } from "./ChatClient";
import { tokenStore } from "@/lib/api";

const EMPTY_SNAPSHOT: ChatSnapshot = {
  state: "idle",
  identity: null,
  viewers: 0,
  messages: [],
  pending: [],
  lastError: null,
};

export interface UseChatResult extends ChatSnapshot {
  send: (body: string) => void;
}

/**
 * React hook that owns the lifecycle of a `ChatClient` and surfaces its
 * snapshot via `useSyncExternalStore` so renders only fire on actual change.
 *
 * The client is created exactly once per (channel, token, bufferSize) tuple.
 * Token rotation will tear down and rebuild — desired, because it changes
 * the WS handshake URL.
 */
export function useChat(options: ChatClientOptions = {}): UseChatResult {
  // When no explicit static token or getToken factory is provided, default to
  // reading the current access token from the store on every WS connection
  // attempt. This ensures reconnects always use the latest token without
  // rebuilding the ChatClient on every keep-alive rotation cycle.
  const effectiveOptions: ChatClientOptions = useMemo(() => {
    if (options.token != null || options.getToken != null) return options;
    return { ...options, getToken: () => tokenStore.getAccess() || null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.channelId, options.bufferSize, options.url, options.token, options.getToken]);

  // Stable key for client identity. When getToken is the source of truth,
  // exclude the token value from the key so proactive keep-alive token
  // rotation does not rebuild the client (and tear down the socket) every
  // 3 minutes. The dynamic token is resolved fresh on every connect() call.
  const key = effectiveOptions.getToken
    ? `${effectiveOptions.channelId ?? ""}::${effectiveOptions.bufferSize ?? ""}:${effectiveOptions.url ?? ""}`
    : `${effectiveOptions.channelId ?? ""}:${effectiveOptions.token ?? ""}:${effectiveOptions.bufferSize ?? ""}:${effectiveOptions.url ?? ""}`;

  const clientRef = useRef<{ key: string; client: ChatClient } | null>(null);

  const client = useMemo(() => {
    if (clientRef.current && clientRef.current.key === key) {
      return clientRef.current.client;
    }
    if (clientRef.current) clientRef.current.client.stop();
    const c = new ChatClient(effectiveOptions);
    clientRef.current = { key, client: c };
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Single effect: start on mount / key-change, stop on cleanup.
  // The useMemo above already calls stop() on the *previous* client before
  // returning the new one, so this cleanup handles the unmount case and the
  // React StrictMode double-invoke case — no duplicate connections possible.
  useEffect(() => {
    client.start();
    return () => {
      client.stop();
    };
  }, [client]);

  const subscribe = useMemo(() => (cb: () => void) => client.subscribe(cb), [client]);
  const getSnapshot = useMemo(
    () => () => client.snapshot(),
    [client],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_SNAPSHOT);

  return {
    ...snapshot,
    send: (body: string) => {
      client.send(body);
    },
  };
}
