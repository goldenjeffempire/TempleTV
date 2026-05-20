import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { ChatClient, type ChatClientOptions, type ChatSnapshot } from "./ChatClient";

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
 * React Native binding for `ChatClient`. Same shape as the TV/admin
 * `useChat` so any UI built against `ChatSnapshot` is portable.
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
      client.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const subscribe = useMemo(() => (cb: () => void) => client.subscribe(cb), [client]);
  const getSnapshot = useMemo(() => () => client.snapshot(), [client]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_SNAPSHOT);

  return {
    ...snapshot,
    send: (body: string) => {
      client.send(body);
    },
  };
}
