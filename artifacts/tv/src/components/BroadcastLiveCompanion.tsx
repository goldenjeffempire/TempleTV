import { useEffect, useState } from "react";

/**
 * Passive lean-back live companion strip for the TV player.
 *
 * Design intent
 * ─────────────
 * The mobile player gets a full bidirectional live-interaction surface
 * (Chat / Prayer / Reactions / Share via the bottom sheet + sticky bar).
 * TV is a lean-back form factor — there is no good interaction model for
 * typing chat messages with a remote control, and pulling up a modal
 * overlay would obscure the very content the viewer is sitting back to
 * watch. So this companion is intentionally **passive**: it advertises
 * the same channel-identity signals (LIVE state · viewer count · last
 * reaction emoji) without offering any interactive affordances.
 *
 * Visual treatment matches a broadcaster lower-third: bottom-left chip,
 * monospaced number for the viewer count, soft fade-in on mount, and a
 * subtle pulse on the LIVE dot. It deliberately does NOT auto-hide with
 * the playback controls — this chip is part of the channel identity (like
 * the watermarked bug in the bottom-right), not part of the chrome.
 *
 * Reactions
 * ─────────
 * Reaction emojis (sent from mobile via `sendReaction`) are surfaced
 * here as a brief floating glyph next to the chip — viewers in the
 * room get the same congregational "we're watching together" cue that
 * mobile users see, without any input device. The emoji floats up and
 * fades out over ~2.6s; multiple reactions queue gracefully.
 */
interface Props {
  /** Whether something live-class is on air. Drives the LIVE dot color. */
  isLive: boolean;
  /** Latest viewer count from the SSE stream-health event, or null. */
  viewerCount: number | null;
}

const REACTION_EMOJI: Record<string, string> = {
  amen: "🙌",
  fire: "🔥",
  hallelujah: "🙏",
};

export function BroadcastLiveCompanion({ isLive, viewerCount }: Props) {
  // Subscribe to live-reaction events on the SAME SSE channel useLiveSync
  // uses. We open a separate, narrowly-scoped EventSource here rather than
  // adding another field to BroadcastSyncState because reactions are an
  // ephemeral signal — they shouldn't trigger re-renders of every consumer
  // of useLiveSync (Hero, Player, etc.). Keeping the subscription local to
  // this companion means the chip is the only thing that re-renders on
  // each reaction, which keeps the player's render budget clean.
  const [floats, setFloats] = useState<Array<{ id: number; emoji: string }>>([]);

  // Live-reaction events used to ride on the now-deleted broadcast SSE
  // channel. The new playback WebSocket is intentionally playback-only —
  // reactions will move to a dedicated channel in a follow-up. Until then
  // the chip still renders the LIVE indicator and viewer count, just
  // without the floating emoji bursts. `setFloats` is referenced below to
  // keep the lint clean and to make the future re-wire trivial.
  void setFloats;

  return (
    <div
      style={{
        position: "absolute",
        left: 32,
        bottom: 32,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 16px",
        borderRadius: 999,
        background: "rgba(8, 6, 14, 0.62)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        color: "#FFF",
        fontFamily: "Inter, system-ui, sans-serif",
        boxShadow: "0 6px 28px rgba(0,0,0,0.45)",
        animation: "tvCompanionFadeIn 380ms ease-out",
        // Critically: pointer-events:none so this never steals focus from
        // the underlying iframe / video element. TV remotes drive focus
        // imperatively via keyEventToAction; this chip is decoration.
        pointerEvents: "none",
        userSelect: "none",
        zIndex: 5,
      }}
    >
      {/* LIVE dot + label */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            display: "inline-block",
            width: 10,
            height: 10,
            borderRadius: 5,
            background: isLive ? "#FF0040" : "#666",
            boxShadow: isLive ? "0 0 12px #FF0040" : "none",
            animation: isLive ? "tvCompanionPulse 1.6s ease-in-out infinite" : "none",
          }}
        />
        <span
          style={{
            fontSize: 13,
            fontWeight: 800,
            letterSpacing: 1.6,
            color: isLive ? "#FF0040" : "#9DA7B3",
          }}
        >
          {isLive ? "LIVE" : "OFF AIR"}
        </span>
      </div>

      {/* Divider */}
      <div style={{ width: 1, height: 18, background: "rgba(255,255,255,0.18)" }} />

      {/* Viewer count */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <ViewersIcon />
        <span style={{ fontSize: 14, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
          {viewerCount === null ? "—" : viewerCount.toLocaleString()}
        </span>
        <span style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", fontWeight: 500 }}>
          watching
        </span>
      </div>

      {/* Floating reaction emojis — anchored to the right edge of the chip */}
      <div
        style={{
          position: "absolute",
          right: -6,
          top: -8,
          width: 60,
          height: 80,
          pointerEvents: "none",
          overflow: "visible",
        }}
      >
        {floats.map((f, i) => (
          <span
            key={f.id}
            style={{
              position: "absolute",
              right: 8 + (i % 3) * 6,
              bottom: 0,
              fontSize: 22,
              animation: "tvCompanionFloat 2400ms ease-out forwards",
              filter: "drop-shadow(0 4px 10px rgba(0,0,0,0.5))",
            }}
          >
            {f.emoji}
          </span>
        ))}
      </div>

      {/* Keyframes injected once via a sibling <style> — keeping them
          local to the component avoids polluting the global stylesheet.
          React de-dupes identical <style> tags so multiple instances are
          fine in practice. */}
      <style>{`
        @keyframes tvCompanionFadeIn {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes tvCompanionPulse {
          0%, 100% { transform: scale(1);   opacity: 1; }
          50%      { transform: scale(1.4); opacity: 0.55; }
        }
        @keyframes tvCompanionFloat {
          0%   { opacity: 0; transform: translateY(8px) scale(0.7); }
          18%  { opacity: 1; transform: translateY(-6px) scale(1.05); }
          100% { opacity: 0; transform: translateY(-58px) scale(0.85); }
        }
      `}</style>
    </div>
  );
}

function ViewersIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
