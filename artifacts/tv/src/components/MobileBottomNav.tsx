import React from "react";

export interface MobileBottomNavProps {
  onWatch: () => void;
  onLibrary: () => void;
  onLive: () => void;
  onSearch: () => void;
  onSettings: () => void;
  hasLive?: boolean;
}

interface TabItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  highlight?: boolean;
}

export function MobileBottomNav({
  onWatch,
  onLibrary,
  onLive,
  onSearch,
  onSettings,
  hasLive = false,
}: MobileBottomNavProps) {
  const tabs: TabItem[] = [
    {
      id: "watch",
      label: "Watch",
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="7" width="20" height="15" rx="2" ry="2"/>
          <polyline points="17 2 12 7 7 2"/>
        </svg>
      ),
      onClick: onWatch,
    },
    {
      id: "search",
      label: "Search",
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8"/>
          <path d="m21 21-4.35-4.35"/>
        </svg>
      ),
      onClick: onSearch,
    },
    {
      id: "live",
      label: "Live",
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="2"/>
          <path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/>
        </svg>
      ),
      onClick: onLive,
      highlight: hasLive,
    },
    {
      id: "library",
      label: "Library",
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
        </svg>
      ),
      onClick: onLibrary,
    },
    {
      id: "settings",
      label: "Settings",
      icon: (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
      ),
      onClick: onSettings,
    },
  ];

  return (
    <nav
      className="tt-mobile-nav"
      aria-label="Main navigation"
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "stretch",
        background: "rgba(5, 5, 15, 0.88)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderTop: "1px solid rgba(255,255,255,0.07)",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
        height: "calc(68px + env(safe-area-inset-bottom, 0px))",
      }}
    >
      {tabs.map((tab) => (
        <NavTab key={tab.id} tab={tab} />
      ))}
    </nav>
  );
}

function NavTab({ tab }: { tab: TabItem }) {
  const [pressed, setPressed] = React.useState(false);
  const isLive = tab.id === "live";

  return (
    <button
      onClick={tab.onClick}
      onTouchStart={() => setPressed(true)}
      onTouchEnd={() => { setPressed(false); }}
      aria-label={tab.label}
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        background: "none",
        border: "none",
        cursor: "pointer",
        padding: "0 4px",
        height: "100%",
        WebkitTapHighlightColor: "transparent",
        position: "relative",
        transform: pressed ? "scale(0.92)" : "scale(1)",
        transition: "transform 0.1s ease",
      }}
    >
      {/* Live tab: elevated pill button */}
      {isLive ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 3,
            background: tab.highlight
              ? "linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)"
              : "linear-gradient(135deg, #7c3aed 0%, #5b21b6 100%)",
            borderRadius: 16,
            width: 52,
            height: 44,
            boxShadow: tab.highlight
              ? "0 4px 20px rgba(220,38,38,0.5)"
              : "0 4px 20px rgba(124,58,237,0.5)",
            color: "#fff",
            marginTop: -8,
          }}
        >
          {tab.icon}
          {tab.highlight && (
            <span
              style={{
                position: "absolute",
                top: 6,
                right: "calc(50% - 22px)",
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "#fff",
                boxShadow: "0 0 6px rgba(255,255,255,0.8)",
              }}
              className="live-pulse"
            />
          )}
        </div>
      ) : (
        <span style={{ color: "rgba(255,255,255,0.5)", display: "flex" }}>
          {tab.icon}
        </span>
      )}
      <span
        style={{
          fontSize: 10,
          fontWeight: isLive ? 700 : 500,
          color: isLive
            ? tab.highlight ? "#f87171" : "#c084fc"
            : "rgba(255,255,255,0.45)",
          letterSpacing: "0.03em",
          lineHeight: 1,
          marginTop: isLive ? 4 : 0,
        }}
      >
        {isLive && tab.highlight ? "● LIVE" : tab.label}
      </span>
    </button>
  );
}
