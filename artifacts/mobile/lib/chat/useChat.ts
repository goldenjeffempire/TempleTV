import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { ChatClient, type ChatClientOptions, type ChatSnapshot } from "./ChatClient";

const EMPTY_SNAPSHOT: ChatSnapshot = {
  state: "idle",
  identity: null,
  viewers: 0,
  messages: [],
  pending: [],
  lastError: null,
  settings: null,
  pinnedMessage: null,
  lastAckAtMs: 0,
};

export interface UseChatResult extends ChatSnapshot {
  send: (body: string) => void;
  react: (messageId: string, emoji: string) => void;
}

/**
 * React Native binding for `ChatClient`.
 *
 * Returns the full `ChatSnapshot` plus `send()` and `react()` action helpers.
 * Same external shape as the TV/admin `useChat` so any UI built against
 * `ChatSnapshot` is portable across surfaces.
 */
export function useChat(options: ChatClientOptions = {}): UseChatResult {
  const key = `${options.channelId ?? ""}:${options.token ?? ""}:${options.bufferSize ?? ""}:${options.url ?? ""}`;
  const clientRef = useRef<{ key: string; client: ChatClient } | null>(null);

  const client = useMemo(() => {
    if (clientRef.current && clientRef.current.key === key) {
      return clientRef.current.client;
    }
    if (clientRef.current) clientRef.current.client.stop();
    const c = new ChatClient(options);
    clientRef.current = { key, client: c };
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    client.start();
  }, [client]);

  useEffect(() => {
    return () => {
      clientRef.current?.client.stop();
    };
  }, []);

  const subscribe = useMemo(() => (cb: () => void) => client.subscribe(cb), [client]);
  const getSnapshot = useMemo(() => () => client.snapshot(), [client]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_SNAPSHOT);

  const send = useCallback(
    (body: string) => { client.send(body); },
    [client],
  );

  const react = useCallback(
    (messageId: string, emoji: string) => { client.react(messageId, emoji); },
    [client],
  );

  return { ...snapshot, send, react };
}
