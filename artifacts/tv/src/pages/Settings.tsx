/**
 * Settings / Profile screen for the TV app.
 *
 * Shows auth status, display name, and gives the user a sign-in or
 * sign-out option. D-pad navigable; Back/ESC goes home.
 */

import { useEffect, useRef, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { useFavorites } from "../hooks/useFavorites";
import { getWatchHistory } from "../lib/watchHistory";
import { clearServerHistory } from "../lib/serverSync";
import { clearWatchHistory } from "../lib/watchHistory";
import { clearFavorites } from "../lib/favorites";
import { TempleTvLogo } from "../components/TempleTvLogo";

interface SettingsProps {
  onBack: () => void;
  onSignIn: () => void;
}

type FocusItem = "signin" | "signout" | "clear-history" | "clear-favorites" | "back";

export function Settings({ onBack, onSignIn }: SettingsProps) {
  const { loggedIn, displayName, signOut } = useAuth();
  const { count: favCount } = useFavorites();
  const [historyCount] = useState(() => getWatchHistory().length);
  const [cleared, setCleared] = useState<"history" | "favorites" | null>(null);
  const [confirm, setConfirm] = useState<"history" | "favorites" | null>(null);
  const [focusIdx, setFocusIdx] = useState(0);
  const backRef = useRef<HTMLButtonElement>(null);

  const menuItems: { key: FocusItem; label: string; icon: React.ReactNode; danger?: boolean; hidden?: boolean }[] = [
    {
      key: "back",
      label: "Back to Home",
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      ),
    },
    ...(loggedIn
      ? [
          {
            key: "signout" as FocusItem,
            label: "Sign Out",
            icon: (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            ),
            danger: true,
          },
        ]
      : [
          {
            key: "signin" as FocusItem,
            label: "Sign In",
            icon: (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                <polyline points="10 17 15 12 10 7" />
                <line x1="15" y1="12" x2="3" y2="12" />
              </svg>
            ),
          },
        ]),
    {
      key: "clear-history",
      label: `Clear Watch History (${historyCount})`,
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
        </svg>
      ),
      danger: true,
    },
    {
      key: "clear-favorites",
      label: `Clear Favorites (${favCount})`,
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      ),
      danger: true,
    },
  ];

  const visibleItems = menuItems.filter((m) => !m.hidden);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Backspace") {
        e.preventDefault();
        if (confirm) { setConfirm(null); return; }
        onBack();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusIdx((i) => Math.max(0, i - 1));
        setConfirm(null);
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusIdx((i) => Math.min(visibleItems.length - 1, i + 1));
        setConfirm(null);
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const item = visibleItems[focusIdx];
        if (!item) return;

        if (item.key === "back") { onBack(); return; }
        if (item.key === "signin") { onSignIn(); return; }
        if (item.key === "signout") { signOut(); return; }

        if (item.key === "clear-history") {
          if (confirm === "history") {
            clearWatchHistory();
            clearServerHistory();
            setCleared("history");
            setConfirm(null);
          } else {
            setConfirm("history");
          }
          return;
        }
        if (item.key === "clear-favorites") {
          if (confirm === "favorites") {
            clearFavorites();
            setCleared("favorites");
            setConfirm(null);
          } else {
            setConfirm("favorites");
          }
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [focusIdx, confirm, visibleItems, onBack, onSignIn, signOut]);

  useEffect(() => {
    backRef.current?.focus();
  }, []);

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        display: "flex",
        background: "linear-gradient(135deg, #0a0011 0%, #0f0520 100%)",
        color: "#fff",
        overflow: "hidden",
      }}
    >
      {/* Left panel */}
      <div
        style={{
          width: 380,
          display: "flex",
          flexDirection: "column",
          borderRight: "1px solid rgba(255,255,255,0.07)",
          padding: "40px 32px",
          gap: 24,
          flexShrink: 0,
        }}
      >
        {/* Logo */}
        <TempleTvLogo size={36} variant="wordmark" priority />

        {/* Auth card */}
        <div
          style={{
            background: "rgba(106,13,173,0.15)",
            border: "1px solid rgba(168,85,247,0.25)",
            borderRadius: 16,
            padding: "20px 20px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: "50%",
                background: loggedIn
                  ? "linear-gradient(135deg, #6A0DAD, #a855f7)"
                  : "rgba(255,255,255,0.1)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 18,
                flexShrink: 0,
              }}
            >
              {loggedIn ? "👤" : "📺"}
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.2 }}>
                {loggedIn
                  ? (displayName ?? "Signed In")
                  : "Guest Viewer"}
              </div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", marginTop: 2 }}>
                {loggedIn ? "Account synced" : "Not signed in"}
              </div>
            </div>
          </div>
          {loggedIn && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginTop: 4,
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: "#22c55e",
                  display: "inline-block",
                }}
              />
              <span style={{ fontSize: 11, color: "rgba(34,197,94,0.85)", fontWeight: 600 }}>
                Watch history & favorites synced
              </span>
            </div>
          )}
        </div>

        {/* Stats */}
        <div style={{ display: "flex", gap: 12 }}>
          {[
            { label: "Favorites", value: favCount },
            { label: "History", value: historyCount },
          ].map(({ label, value }) => (
            <div
              key={label}
              style={{
                flex: 1,
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 10,
                padding: "12px 14px",
              }}
            >
              <div style={{ fontSize: 22, fontWeight: 800, color: "#a855f7" }}>{value}</div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>{label}</div>
            </div>
          ))}
        </div>

        {/* Hint */}
        <div style={{ marginTop: "auto", fontSize: 12, color: "rgba(255,255,255,0.25)" }}>
          Use ↑ ↓ to navigate · ENTER to select · ESC to go back
        </div>
      </div>

      {/* Right panel — menu */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          padding: "40px 48px",
          gap: 8,
          overflowY: "auto",
        }}
      >
        <h1
          style={{
            fontSize: 28,
            fontWeight: 800,
            letterSpacing: "-0.02em",
            marginBottom: 24,
            color: "rgba(255,255,255,0.92)",
          }}
        >
          Settings
        </h1>

        {visibleItems.map((item, idx) => {
          const focused = idx === focusIdx;
          const isConfirming =
            (item.key === "clear-history" && confirm === "history") ||
            (item.key === "clear-favorites" && confirm === "favorites");
          const wasCleared =
            (item.key === "clear-history" && cleared === "history") ||
            (item.key === "clear-favorites" && cleared === "favorites");

          return (
            <button
              key={item.key}
              ref={item.key === "back" ? backRef : undefined}
              onClick={() => {
                setFocusIdx(idx);
                if (item.key === "back") { onBack(); return; }
                if (item.key === "signin") { onSignIn(); return; }
                if (item.key === "signout") { signOut(); return; }
                if (item.key === "clear-history") {
                  if (confirm === "history") {
                    clearWatchHistory();
                    clearServerHistory();
                    setCleared("history");
                    setConfirm(null);
                  } else {
                    setConfirm("history");
                  }
                  return;
                }
                if (item.key === "clear-favorites") {
                  if (confirm === "favorites") {
                    clearFavorites();
                    setCleared("favorites");
                    setConfirm(null);
                  } else {
                    setConfirm("favorites");
                  }
                }
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                padding: "16px 20px",
                borderRadius: 14,
                background: focused
                  ? item.danger
                    ? "rgba(239,68,68,0.15)"
                    : "rgba(106,13,173,0.2)"
                  : "rgba(255,255,255,0.04)",
                border: `1px solid ${
                  focused
                    ? item.danger
                      ? "rgba(239,68,68,0.4)"
                      : "rgba(168,85,247,0.4)"
                    : "rgba(255,255,255,0.06)"
                }`,
                boxShadow: focused
                  ? `0 0 0 2px ${item.danger ? "rgba(239,68,68,0.2)" : "rgba(168,85,247,0.2)"}`
                  : "none",
                color: wasCleared
                  ? "#22c55e"
                  : isConfirming
                  ? "#ef4444"
                  : item.danger
                  ? focused
                    ? "#fca5a5"
                    : "rgba(239,68,68,0.7)"
                  : focused
                  ? "#e9d5ff"
                  : "rgba(255,255,255,0.75)",
                fontSize: 16,
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: "pointer",
                textAlign: "left",
                transition: "all 0.15s ease",
              }}
            >
              <span style={{ flexShrink: 0 }}>{item.icon}</span>
              <span style={{ flex: 1 }}>
                {wasCleared
                  ? "Cleared!"
                  : isConfirming
                  ? `Press ENTER again to confirm`
                  : item.label}
              </span>
              {focused && (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              )}
            </button>
          );
        })}

        <div style={{ marginTop: 32, fontSize: 12, color: "rgba(255,255,255,0.15)", textAlign: "center" }}>
          JCTM Broadcasting Network
        </div>
      </div>
    </div>
  );
}
