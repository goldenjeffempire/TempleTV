/**
 * Smart-TV chat overlay.
 *
 * Optimized for the constrained TV environment:
 *   - Capped at 60 messages in memory; older fade out
 *   - No animations beyond a single CSS opacity transition (heavy keyframes
 *     stutter on under-powered TV browsers)
 *   - Single text node per row, no avatars or rich formatting
 *   - Persistent WS connection via the shared `useChat` hook
 *   - Send box collapses to a "Tap to chat" button on TVs without keyboards;
 *     pointing remotes / mobile companion apps can expand it.
 *
 * The overlay is anchored bottom-right with a glass background so the
 * underlying broadcast video remains visible. A `compact` prop renders a
 * smaller chip-style overlay for the live home page; the player page uses
 * the full panel.
 */

import { useEffect, useRef, useState } from "react";
import { useChat } from "@/chat/useChat";
import { TEMPLE_TV_LIVE_CHANNEL } from "@/chat/types";

interface ChatOverlayProps {
  compact?: boolean;
  className?: string;
}

function formatHM(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function ChatOverlay({ compact = false, className }: ChatOverlayProps) {
  const { state, identity, viewers, messages, pending, send } = useChat({
    channelId: TEMPLE_TV_LIVE_CHANNEL,
    bufferSize: 60,
  });
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(!compact);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to newest. TV displays don't have a "scroll up to read"
  // affordance — newest is always what matters.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
    });
  }, [messages.length, pending.length]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`fixed z-30 px-4 py-2 rounded-full bg-black/70 backdrop-blur text-white text-sm font-medium hover:bg-black/85 ${className ?? ""}`}
        style={{ bottom: "var(--tv-safe-v, 1.5rem)", right: "var(--tv-safe-h, 1.5rem)" }}
        data-testid="chat-overlay-open"
      >
        💬 Live chat · {viewers}
      </button>
    );
  }

  const dotColor =
    state === "open" ? "bg-emerald-400" : state === "reconnecting" ? "bg-amber-400" : "bg-red-400";

  return (
    <div
      className={`fixed z-30 w-[360px] max-w-[90vw] rounded-xl overflow-hidden shadow-2xl bg-black/75 backdrop-blur text-white border border-white/10 ${className ?? ""}`}
      style={{ bottom: "var(--tv-safe-v, 1.5rem)", right: "var(--tv-safe-h, 1.5rem)" }}
      data-testid="chat-overlay"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10 text-xs">
        <div className="flex items-center gap-2">
          <span className={`inline-block h-2 w-2 rounded-full ${dotColor}`} />
          <span className="font-medium">Live chat</span>
          <span className="text-white/60">·</span>
          <span className="text-white/70">{viewers} watching</span>
        </div>
        {compact ? (
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-white/70 hover:text-white"
            aria-label="Hide chat"
            data-testid="chat-overlay-close"
          >
            ✕
          </button>
        ) : null}
      </div>

      <div
        ref={scrollRef}
        className="h-[260px] overflow-y-auto px-3 py-2 space-y-1 text-sm"
        data-testid="chat-overlay-list"
      >
        {messages.length === 0 ? (
          <div className="text-white/50 text-center py-6">
            Be the first to say hello.
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className="leading-snug" data-testid={`chat-msg-${m.id}`}>
              <span className="text-white/40 text-[11px] mr-1.5 tabular-nums">
                {formatHM(m.createdAtMs)}
              </span>
              <span className="font-semibold text-amber-300 mr-1">{m.displayName}</span>
              <span className="text-white/95">{m.body}</span>
            </div>
          ))
        )}
        {pending.map((p) => (
          <div
            key={p.clientMsgId}
            className="leading-snug opacity-60 italic"
            data-testid={`chat-pending-${p.clientMsgId}`}
          >
            <span className="font-semibold text-amber-300 mr-1">
              {identity?.displayName ?? "You"}
            </span>
            <span>{p.body}</span>
            {p.status === "error" ? (
              <span className="text-red-400 text-xs ml-2">{p.error ?? "failed"}</span>
            ) : null}
          </div>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = draft.trim();
          if (!trimmed) return;
          send(trimmed);
          setDraft("");
        }}
        className="flex gap-2 p-2 border-t border-white/10 bg-black/30"
      >
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={500}
          placeholder={
            state === "open"
              ? identity
                ? `Chat as ${identity.displayName}…`
                : "Connecting…"
              : "Reconnecting…"
          }
          disabled={state !== "open"}
          className="flex-1 bg-white/10 text-white placeholder-white/40 px-3 py-1.5 rounded-md outline-none focus:bg-white/15 text-sm"
          data-testid="chat-overlay-input"
        />
        <button
          type="submit"
          disabled={!draft.trim() || state !== "open"}
          className="px-3 py-1.5 rounded-md bg-amber-500 text-black text-sm font-medium disabled:opacity-40 hover:bg-amber-400"
          data-testid="chat-overlay-send"
        >
          Send
        </button>
      </form>
    </div>
  );
}
