/**
 * Live Chat moderation page.
 *
 * The admin sees the global Temple TV chat in real time, can delete any
 * message, mute or ban any subject (user id or hashed-IP), and watches
 * the live viewer count.
 *
 * Connection auth: we authenticate the WS as a moderator by passing the
 * configured ADMIN_API_TOKEN (already in localStorage from the AuthGate
 * flow) as the bearer token. The server short-circuits rate-limit and
 * dup-checks for moderator sockets so an admin can paste long
 * announcement strings without getting throttled.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Send, Trash2, Wifi, WifiOff, Shield, Users, Ban, MicOff } from "lucide-react";
import { useChat } from "@/chat/useChat";
import { TEMPLE_TV_LIVE_CHANNEL, type ChatMessage } from "@/chat/types";
import { getAdminToken } from "@/lib/admin-access";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function ConnectionPill({ state }: { state: string }) {
  if (state === "open") {
    return (
      <Badge variant="default" className="gap-1 bg-emerald-600">
        <Wifi className="h-3 w-3" /> Live
      </Badge>
    );
  }
  if (state === "connecting" || state === "reconnecting") {
    return (
      <Badge variant="secondary" className="gap-1">
        <Loader2 className="h-3 w-3 animate-spin" /> {state}
      </Badge>
    );
  }
  return (
    <Badge variant="destructive" className="gap-1">
      <WifiOff className="h-3 w-3" /> {state}
    </Badge>
  );
}

export default function ChatPage(): JSX.Element {
  const adminToken = getAdminToken() ?? null;
  const channelId = TEMPLE_TV_LIVE_CHANNEL;
  const { toast } = useToast();

  const { state, identity, viewers, messages, pending, lastError, send } = useChat({
    channelId,
    token: adminToken,
    bufferSize: 500,
  });

  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to newest only when already pinned to bottom (don't yank an
  // admin who scrolled up to read context).
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const distanceFromBottom = node.scrollHeight - node.clientHeight - node.scrollTop;
    if (distanceFromBottom < 120) {
      node.scrollTop = node.scrollHeight;
    }
  }, [messages.length, pending.length]);

  // Show errors as toasts (debounced via ref-tracked atMs).
  const lastErrorAtMs = useRef(0);
  useEffect(() => {
    if (!lastError) return;
    if (lastError.atMs <= lastErrorAtMs.current) return;
    lastErrorAtMs.current = lastError.atMs;
    toast({
      title: `Chat: ${lastError.code}`,
      description: lastError.message,
      variant: "destructive",
    });
  }, [lastError, toast]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    send(trimmed);
    setDraft("");
  };

  const deleteMessage = async (msg: ChatMessage) => {
    try {
      const res = await fetch(`/api/admin/chat/messages/${encodeURIComponent(msg.id)}/delete`, {
        method: "POST",
        headers: {
          ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
        },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      toast({ title: "Deleted", description: `Removed message from ${msg.displayName}.` });
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  const moderate = async (
    subjectKind: "user" | "ip",
    subjectId: string,
    action: "mute" | "ban",
    durationSecs: number | null,
  ) => {
    try {
      const res = await fetch(`/api/admin/chat/moderate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
        },
        body: JSON.stringify({ subjectKind, subjectId, action, durationSecs }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      toast({
        title: action === "ban" ? "Banned" : "Muted",
        description: `${subjectKind}:${subjectId.slice(0, 12)}…${
          durationSecs ? ` for ${durationSecs}s` : ""
        }`,
      });
    } catch (err) {
      toast({
        title: `${action} failed`,
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  const renderableRows = useMemo(() => {
    return [
      ...messages.map((m) => ({ kind: "msg" as const, key: m.id, message: m })),
      ...pending.map((p) => ({
        kind: "pending" as const,
        key: p.clientMsgId,
        clientMsgId: p.clientMsgId,
        body: p.body,
        status: p.status,
        error: p.error,
      })),
    ];
  }, [messages, pending]);

  return (
    <div className="container mx-auto p-6 max-w-6xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Shield className="h-7 w-7 text-blue-600" /> Live Chat
          </h1>
          <p className="text-muted-foreground mt-1">
            Real-time moderator view of the global Temple TV chat room.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="gap-1">
            <Users className="h-3 w-3" /> {viewers} watching
          </Badge>
          <ConnectionPill state={state} />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            <span>
              #{channelId} {identity ? `· you appear as ${identity.displayName}` : ""}
            </span>
            <span className="text-xs text-muted-foreground">
              Buffered: {messages.length} · Pending: {pending.length}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div
            ref={scrollRef}
            className="h-[60vh] overflow-y-auto px-4 py-3 space-y-1 bg-muted/30"
            data-testid="chat-scroll"
          >
            <div ref={listRef}>
              {renderableRows.length === 0 ? (
                <div className="text-center text-muted-foreground py-12">
                  No messages yet. Be the first to say hello.
                </div>
              ) : (
                renderableRows.map((row) => {
                  if (row.kind === "msg") {
                    const m = row.message;
                    const subjectKind: "user" | "ip" = m.userId ? "user" : "ip";
                    const subjectId = m.userId ?? "";
                    return (
                      <div
                        key={row.key}
                        className="group flex gap-2 items-start py-1.5 px-2 hover:bg-background rounded"
                        data-testid={`chat-msg-${m.id}`}
                      >
                        <span className="text-xs text-muted-foreground tabular-nums shrink-0 mt-0.5">
                          {formatTime(m.createdAtMs)}
                        </span>
                        <span className="font-semibold text-sm shrink-0">
                          {m.displayName}
                          {m.userId ? null : (
                            <span className="ml-1 text-[10px] text-amber-600 align-middle">guest</span>
                          )}
                        </span>
                        <span className="text-sm break-words flex-1">{m.body}</span>
                        <div className="hidden group-hover:flex items-center gap-1 shrink-0">
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            title="Delete message"
                            onClick={() => void deleteMessage(m)}
                            data-testid={`chat-delete-${m.id}`}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-red-600" />
                          </Button>
                          {subjectId ? (
                            <>
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7"
                                title="Mute user for 10 minutes"
                                onClick={() =>
                                  void moderate(subjectKind, subjectId, "mute", 600)
                                }
                              >
                                <MicOff className="h-3.5 w-3.5 text-amber-600" />
                              </Button>
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7"
                                title="Permanent ban"
                                onClick={() =>
                                  void moderate(subjectKind, subjectId, "ban", null)
                                }
                              >
                                <Ban className="h-3.5 w-3.5 text-red-600" />
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </div>
                    );
                  }
                  // Pending row.
                  return (
                    <div
                      key={row.key}
                      className="flex gap-2 items-start py-1.5 px-2 opacity-70 italic"
                      data-testid={`chat-pending-${row.clientMsgId}`}
                    >
                      <Loader2 className="h-3 w-3 animate-spin mt-1" />
                      <span className="text-sm break-words flex-1">{row.body}</span>
                      {row.status === "error" ? (
                        <span className="text-xs text-red-600">{row.error ?? "failed"}</span>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
          </div>
          <form onSubmit={onSubmit} className="flex gap-2 p-3 border-t">
            <Input
              type="text"
              placeholder="Send as moderator…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={500}
              data-testid="chat-input"
              disabled={state !== "open"}
            />
            <Button type="submit" disabled={!draft.trim() || state !== "open"} data-testid="chat-send">
              <Send className="h-4 w-4 mr-1" /> Send
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
