import { useEffect, useState } from "react";

export interface EmergencyAlertData {
  alertId: string;
  title: string;
  message: string;
  severity: "info" | "warning" | "critical" | "emergency";
  expiresAt?: string | null;
}

interface EmergencyAlertProps {
  alert: EmergencyAlertData;
  onDismiss?: () => void;
}

const SEVERITY_STYLES: Record<EmergencyAlertData["severity"], {
  bg: string;
  border: string;
  accent: string;
  label: string;
  canDismiss: boolean;
}> = {
  info: {
    bg: "rgba(37,99,235,0.92)",
    border: "rgba(147,197,253,0.3)",
    accent: "#60a5fa",
    label: "INFORMATION",
    canDismiss: true,
  },
  warning: {
    bg: "rgba(180,83,9,0.92)",
    border: "rgba(252,211,77,0.3)",
    accent: "#fcd34d",
    label: "NOTICE",
    canDismiss: true,
  },
  critical: {
    bg: "rgba(185,28,28,0.95)",
    border: "rgba(252,165,165,0.3)",
    accent: "#fca5a5",
    label: "CRITICAL ALERT",
    canDismiss: false,
  },
  emergency: {
    bg: "rgba(127,29,29,0.98)",
    border: "rgba(252,165,165,0.4)",
    accent: "#f87171",
    label: "EMERGENCY BROADCAST",
    canDismiss: false,
  },
};

/**
 * Full-screen emergency alert overlay for the TV app.
 * Slides in from the top, fills the viewport for critical/emergency,
 * shows as a top banner for info/warning.
 * The underlying broadcast continues playing behind the overlay.
 */
export function EmergencyAlert({ alert, onDismiss }: EmergencyAlertProps) {
  const [visible, setVisible] = useState(false);
  const [pulse, setPulse] = useState(false);
  const styles = SEVERITY_STYLES[alert.severity];
  const isMajor = alert.severity === "critical" || alert.severity === "emergency";

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 80);
    return () => clearTimeout(t);
  }, []);

  // Pulse animation for emergency
  useEffect(() => {
    if (alert.severity !== "emergency") return;
    const interval = setInterval(() => setPulse((p) => !p), 1200);
    return () => clearInterval(interval);
  }, [alert.severity]);

  const handleDismiss = () => {
    if (!styles.canDismiss) return;
    setVisible(false);
    setTimeout(() => onDismiss?.(), 400);
  };

  if (isMajor) {
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 9999,
          background: styles.bg,
          backdropFilter: "blur(4px)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "clamp(32px, 5vw, 80px)",
          opacity: visible ? 1 : 0,
          transition: "opacity 400ms ease-out",
          borderTop: `4px solid ${styles.accent}`,
        }}
        role="alertdialog"
        aria-modal="true"
        aria-label={alert.title}
      >
        {/* Flashing border for emergency */}
        {alert.severity === "emergency" && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              border: `6px solid ${styles.accent}`,
              opacity: pulse ? 0.8 : 0,
              transition: "opacity 600ms ease-in-out",
              pointerEvents: "none",
            }}
          />
        )}

        {/* Label */}
        <div style={{
          color: styles.accent,
          fontSize: "clamp(11px, 1.1vw, 14px)",
          fontWeight: 900,
          letterSpacing: "0.25em",
          textTransform: "uppercase",
          marginBottom: "clamp(16px, 3vh, 32px)",
        }}>
          ⚠ {styles.label} ⚠
        </div>

        {/* Station ident */}
        <div style={{
          color: "rgba(255,255,255,0.5)",
          fontSize: "clamp(9px, 0.9vw, 11px)",
          fontWeight: 700,
          letterSpacing: "0.3em",
          textTransform: "uppercase",
          marginBottom: "clamp(12px, 2vh, 20px)",
        }}>
          TEMPLE TV · JCTM BROADCASTING
        </div>

        {/* Title */}
        <h1 style={{
          color: "#fff",
          fontSize: "clamp(24px, 4vw, 56px)",
          fontWeight: 800,
          textAlign: "center",
          lineHeight: 1.1,
          letterSpacing: "-0.02em",
          marginBottom: "clamp(12px, 2vh, 24px)",
          maxWidth: "80vw",
        }}>
          {alert.title}
        </h1>

        {/* Message */}
        <p style={{
          color: "rgba(255,255,255,0.85)",
          fontSize: "clamp(14px, 1.8vw, 24px)",
          fontWeight: 400,
          textAlign: "center",
          lineHeight: 1.5,
          maxWidth: "60vw",
        }}>
          {alert.message}
        </p>
      </div>
    );
  }

  // Info / warning — banner style
  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9000,
        background: styles.bg,
        borderBottom: `2px solid ${styles.border}`,
        display: "flex",
        alignItems: "center",
        gap: "clamp(12px, 2vw, 24px)",
        padding: "clamp(14px, 2vh, 20px) clamp(20px, 3vw, 48px)",
        transform: visible ? "translateY(0)" : "translateY(-100%)",
        transition: "transform 400ms cubic-bezier(0.16,1,0.3,1)",
      }}
      role="alert"
    >
      <div style={{
        color: styles.accent,
        fontSize: "clamp(9px, 0.9vw, 11px)",
        fontWeight: 900,
        letterSpacing: "0.2em",
        flexShrink: 0,
        whiteSpace: "nowrap",
      }}>
        {styles.label}
      </div>
      <div style={{ minWidth: 1, width: 1, background: "rgba(255,255,255,0.2)", alignSelf: "stretch" }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: "#fff", fontSize: "clamp(13px, 1.4vw, 18px)", fontWeight: 700 }}>{alert.title}</div>
        <div style={{ color: "rgba(255,255,255,0.8)", fontSize: "clamp(11px, 1.1vw, 14px)", marginTop: 2 }}>{alert.message}</div>
      </div>
      {styles.canDismiss && (
        <button
          onClick={handleDismiss}
          style={{
            background: "rgba(255,255,255,0.15)",
            border: "1px solid rgba(255,255,255,0.2)",
            color: "#fff",
            borderRadius: 6,
            padding: "clamp(6px, 0.8vh, 10px) clamp(12px, 1.5vw, 20px)",
            cursor: "pointer",
            fontSize: "clamp(10px, 1vw, 13px)",
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          Dismiss
        </button>
      )}
    </div>
  );
}
