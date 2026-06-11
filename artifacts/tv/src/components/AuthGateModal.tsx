import { useEffect, useRef, useState } from "react";
import { createLinkCode, exchangeCode } from "../lib/deviceLink";
import { saveAuth } from "../lib/auth";

/**
 * TV pairing modal.
 *
 * Shown when a non-authenticated viewer attempts to play a sermon. We
 * create a one-time 8-character code on the API, render it large
 * enough to read from across the room, and poll /exchange until the
 * user finishes signing in on their phone.
 *
 * Design goals:
 *  • Read-from-the-couch typography (>= 6rem code text)
 *  • Brand-consistent gradient surface (purple/JCTM)
 *  • Live countdown so the user knows the code is fresh
 *  • Auto-regenerate when expired (guarded against duplicate creates)
 *  • D-pad-friendly: a single primary "Cancel" focus ring
 *  • Zero polling after success or when modal is closed
 *
 * Implementation note on polling: we use a ref-managed recursive
 * setTimeout (instead of setInterval) so that only one in-flight
 * exchange poll exists at any moment, even when phase or code change
 * mid-poll. This eliminates timer accumulation if the network slows
 * down or the API returns "expired" repeatedly.
 */
export interface AuthGateModalProps {
  open: boolean;
  onClose: () => void;
  onAuthed: () => void;
  /** Optional headline override (e.g. "Sign in to keep watching"). */
  reason?: string;
}

const POLL_INTERVAL_MS = 2500;

export function AuthGateModal({ open, onClose, onAuthed, reason }: AuthGateModalProps) {
  const [code, setCode] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "linked">("idle");
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const countdownTimerRef = useRef<number | null>(null);
  // Prevents two overlapping POST /create requests when both the
  // expiry-countdown effect and the exchange-poll effect fire
  // "regenerate" at the same instant.
  const creatingRef = useRef(false);
  // Prevents the polling loop from continuing after unmount/close.
  const aliveRef = useRef(false);

  /**
   * Single source of truth for "make a fresh code". Guarded against
   * concurrent calls so we never burn two codes on the server.
   */
  const regenerateCode = async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setPhase("loading");
    setError(null);
    setCode(null);
    try {
      const created = await createLinkCode();
      if (!aliveRef.current) return; // modal closed mid-flight
      setCode(created.code);
      setSecondsLeft(Math.max(0, Math.floor(created.expiresIn)));
      setPhase("ready");
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err instanceof Error ? err.message : "Could not generate a pairing code.");
      setPhase("idle");
    } finally {
      creatingRef.current = false;
    }
  };

  // Generate a new pairing code whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    aliveRef.current = true;
    regenerateCode();
    return () => {
      aliveRef.current = false;
    };
     
  }, [open]);

  // Countdown ticker.
  useEffect(() => {
    if (!open || phase !== "ready") return;
    countdownTimerRef.current = window.setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1));
    }, 1000);
    return () => {
      if (countdownTimerRef.current) {
        window.clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
    };
  }, [open, phase]);

  // Auto-regenerate the code when the countdown expires so the user
  // is never staring at a dead code.
  useEffect(() => {
    if (open && phase === "ready" && secondsLeft === 0 && code) {
      regenerateCode();
    }
     
  }, [open, phase, secondsLeft, code]);

  // Poll for exchange while we have a live code. Implemented as a
  // self-rescheduling setTimeout chain so only ONE poll is ever in
  // flight; the `aliveRef` and local `cancelled` flag guarantee no
  // ticks happen after close/unmount.
  useEffect(() => {
    if (!open || phase !== "ready" || !code) return;

    let cancelled = false;
    const scheduleNext = () => {
      if (cancelled || !aliveRef.current) return;
      pollTimerRef.current = window.setTimeout(tick, POLL_INTERVAL_MS);
    };
    const tick = async () => {
      if (cancelled || !aliveRef.current) return;
      try {
        const result = await exchangeCode(code);
        if (cancelled || !aliveRef.current) return;
        if (result.status === "linked") {
          saveAuth({
            accessToken: result.tokens.accessToken,
            refreshToken: result.tokens.refreshToken ?? null,
            displayName: result.tokens.user?.displayName ?? result.tokens.user?.email ?? null,
          });
          setPhase("linked");
          // Tiny delay so the success state is visible.
          window.setTimeout(() => {
            if (aliveRef.current) onAuthed();
          }, 600);
          return; // stop polling — success
        }
        if (result.status === "expired") {
          // Don't reschedule; the regenerate path takes over and the
          // next code change will trigger a fresh poll effect.
          regenerateCode();
          return;
        }
      } catch {
        /* network blips → keep polling */
      }
      scheduleNext();
    };

    scheduleNext();
    return () => {
      cancelled = true;
      if (pollTimerRef.current) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
     
  }, [open, phase, code, onAuthed]);

  // Auto-focus Cancel so the back button on the remote works immediately.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => cancelRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [open]);

  // Allow ESC / hardware back to close.
  //
  // Registered with `{ capture: true }` so this handler runs *before*
  // any underlying-screen `window` keydown listeners (Player, Search,
  // VideoDetails all attach their own). The combination of capture
  // phase + stopPropagation guarantees that pressing Back on the
  // remote closes ONLY the modal, not the modal *and* the screen
  // beneath it (which previously sent the viewer back two steps in
  // one click). Without this guard, key handlers attached during the
  // bubble phase by the host screen would still fire after the modal
  // mounted on top of them.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "GoBack" || e.key === "Backspace") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [open, onClose]);

  // Hard reset on close so the next open starts fresh.
  useEffect(() => {
    if (!open) {
      aliveRef.current = false;
      creatingRef.current = false;
      if (pollTimerRef.current) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      if (countdownTimerRef.current) {
        window.clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
      setCode(null);
      setSecondsLeft(0);
      setPhase("idle");
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  // Split the raw code into two visual chunks so each chunk renders as its
  // own inline-block. This avoids letter-spacing propagating to the
  // separator (which made earlier renders look like "7UBB - - MU5") and
  // lets the chunks wrap as a unit when the viewport gets narrow.
  // Codes can be 6, 7, or 8 characters depending on the API; we always
  // split at the midpoint for a balanced visual.
  const codeChunks: string[] | null = code
    ? (() => {
        const mid = Math.ceil(code.length / 2);
        return [code.slice(0, mid), code.slice(mid)];
      })()
    : null;
  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  const placeholderChunks =
    phase === "loading" ? ["····", "····"] : ["----", "----"];

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tv-gate-title"
    >
      {/* Dim, blurred backdrop so the underlying app stays visible but soft. */}
      <div
        className="absolute inset-0 bg-black/85 backdrop-blur-md"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        className="relative w-full max-w-[960px] max-h-[calc(100vh-1.5rem)] overflow-y-auto rounded-2xl sm:rounded-3xl shadow-[0_30px_120px_rgba(0,0,0,0.7)]"
        style={{
          background: "linear-gradient(135deg, #1a0233 0%, #3a0571 55%, #6A0DAD 100%)",
        }}
      >
        {/* Subtle top accent so the card reads as elevated. */}
        <div className="absolute inset-x-0 top-0 h-px bg-white/20" aria-hidden="true" />

        <div className="px-5 py-6 sm:px-10 sm:py-10 md:px-14 md:py-12 text-white">
          <div className="flex items-center gap-3 mb-3 opacity-80">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-xs sm:text-sm tracking-[0.3em] uppercase">Sign in</span>
          </div>

          <h2
            id="tv-gate-title"
            className="text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-bold leading-tight tracking-tight"
          >
            {phase === "linked" ? "You're signed in" : (reason ?? "Sign in to start watching")}
          </h2>

          {phase !== "linked" && (
            <p className="mt-3 sm:mt-4 text-sm sm:text-base md:text-lg lg:text-xl text-white/80 leading-relaxed max-w-3xl">
              On your phone or computer, open{" "}
              <span className="text-white font-semibold whitespace-nowrap">templetv.org.ng/link</span>{" "}
              and enter the code below.
            </p>
          )}

          <div className="mt-6 sm:mt-10 flex flex-col lg:grid lg:grid-cols-[1fr_auto] gap-6 lg:gap-12 lg:items-center">
            <div className="min-w-0">
              <div className="text-xs sm:text-sm uppercase tracking-[0.3em] text-white/60 mb-3 sm:mb-4">
                {phase === "linked" ? "Linked" : "Your code"}
              </div>
              <div
                className="font-mono font-bold tabular-nums select-all flex flex-wrap items-baseline gap-x-[0.35em] gap-y-2 leading-none"
                style={{
                  // Scale aggressively with viewport but clamp so it never
                  // forces horizontal overflow on narrow screens.
                  fontSize: "clamp(2.75rem, 9vw, 6.5rem)",
                  textShadow: "0 4px 32px rgba(0,0,0,0.5)",
                }}
                aria-live="polite"
                aria-label={
                  phase === "linked"
                    ? "Successfully linked"
                    : code
                      ? `Your pairing code is ${code.split("").join(" ")}`
                      : "Generating pairing code"
                }
              >
                {phase === "linked" ? (
                  <span>✓</span>
                ) : codeChunks ? (
                  <>
                    <span style={{ letterSpacing: "0.08em" }}>{codeChunks[0]}</span>
                    <span aria-hidden="true" className="opacity-50">–</span>
                    <span style={{ letterSpacing: "0.08em" }}>{codeChunks[1]}</span>
                  </>
                ) : (
                  <>
                    <span style={{ letterSpacing: "0.08em" }} className="opacity-40">
                      {placeholderChunks[0]}
                    </span>
                    <span aria-hidden="true" className="opacity-30">–</span>
                    <span style={{ letterSpacing: "0.08em" }} className="opacity-40">
                      {placeholderChunks[1]}
                    </span>
                  </>
                )}
              </div>

              {phase === "ready" && (
                <div className="mt-4 sm:mt-6 text-sm sm:text-base text-white/60">
                  Code expires in{" "}
                  <span className="text-white font-semibold tabular-nums">
                    {minutes}:{String(seconds).padStart(2, "0")}
                  </span>
                </div>
              )}
              {phase === "loading" && !error && (
                <div className="mt-4 sm:mt-6 text-sm sm:text-base text-white/60">
                  Generating a fresh code…
                </div>
              )}
              {phase === "linked" && (
                <div className="mt-4 sm:mt-6 text-sm sm:text-base text-white/80">
                  Starting your sermon now…
                </div>
              )}
            </div>

            <div className="hidden lg:flex flex-col items-start gap-3 bg-white/5 border border-white/10 rounded-2xl p-5 min-w-[240px]">
              <div className="text-xs uppercase tracking-[0.3em] text-white/60">
                Free account
              </div>
              <ul className="text-sm text-white/80 space-y-1.5 mt-1 list-none">
                <li>• Watch full sermons</li>
                <li>• Sync progress across devices</li>
                <li>• Live service alerts</li>
              </ul>
            </div>
          </div>

          {error && (
            <div
              className="mt-5 sm:mt-6 text-sm text-red-200 bg-red-950/60 border border-red-500/40 rounded-lg px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
              role="alert"
            >
              <span className="break-words">{error}</span>
              <button
                type="button"
                onClick={() => regenerateCode()}
                className="self-start sm:self-auto px-4 py-1.5 rounded-full bg-white/10 border border-white/30 text-white text-sm font-semibold transition focus:outline-none focus:ring-4 focus:ring-white/40 focus:bg-white/20 hover:bg-white/15"
              >
                Try again
              </button>
            </div>
          )}

          <div className="mt-8 sm:mt-12 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-white/50 order-2 sm:order-1">
              Press <span className="text-white/80 font-semibold">Back</span> on your remote to cancel
            </div>
            <button
              ref={cancelRef}
              onClick={onClose}
              type="button"
              aria-label="Cancel sign in"
              className="order-1 sm:order-2 ml-auto sm:ml-0 px-6 sm:px-8 py-2.5 sm:py-3 rounded-full bg-white/10 border border-white/30 text-white text-sm sm:text-base font-semibold transition focus:outline-none focus:ring-4 focus:ring-white/40 focus:bg-white/20 hover:bg-white/15"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
