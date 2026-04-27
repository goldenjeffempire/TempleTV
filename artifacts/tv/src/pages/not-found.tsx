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
      </div>
    </div>
  );
}
