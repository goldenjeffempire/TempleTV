import { TempleTvLogo } from "../components/TempleTvLogo";

/**
 * 404 surface for the Smart-TV shell.
 *
 * Replaces the previous shadcn-style light-theme card (which looked
 * stranded against the dark TV chrome and shipped no brand identity at
 * all) with a centred wordmark + plain-language copy + back-button hint
 * sized for 10-foot viewing. Renders cleanly on Tizen, webOS, and
 * standard browser fallbacks because it relies only on flex centring
 * and inline styles — no Tailwind classes that might race the CSS load.
 */
export default function NotFound() {
  return (
    <div
      style={{
        minHeight: "100vh",
        width: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#000",
        color: "#fff",
        padding: 48,
        textAlign: "center",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 24, maxWidth: 720 }}>
        <TempleTvLogo size={56} variant="wordmark" priority />
        <h1 style={{ fontSize: 48, fontWeight: 800, margin: 0, letterSpacing: "-0.02em" }}>
          Channel not found
        </h1>
        <p style={{ fontSize: 22, lineHeight: 1.5, color: "rgba(255,255,255,0.7)", margin: 0 }}>
          The page you tried to open isn't part of Temple TV. Press the{" "}
          <strong style={{ color: "#fff" }}>Back</strong> button on your remote to return to the
          home screen, or restart the app to continue watching.
        </p>

        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", justifyContent: "center" }}>
          <button
            onClick={() => window.history.back()}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              background: "rgba(168,85,247,0.18)",
              border: "1px solid rgba(168,85,247,0.45)",
              borderRadius: 14,
              padding: "14px 36px",
              color: "#fff",
              fontSize: 18,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: "inherit",
              transition: "background 0.15s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(168,85,247,0.30)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(168,85,247,0.18)")}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Go Back
          </button>

          <button
            onClick={() => { window.location.href = "/"; }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.18)",
              borderRadius: 14,
              padding: "14px 36px",
              color: "rgba(255,255,255,0.8)",
              fontSize: 18,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: "inherit",
              transition: "background 0.15s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.14)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
            Home
          </button>
        </div>
      </div>
    </div>
  );
}
