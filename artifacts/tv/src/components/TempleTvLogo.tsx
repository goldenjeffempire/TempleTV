interface TempleTvLogoProps {
  size?: number;
  withWordmark?: boolean;
}

export function TempleTvLogo({ size = 48, withWordmark = false }: TempleTvLogoProps) {
  const mark = (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Temple TV"
    >
      <rect width="48" height="48" rx="12" fill="hsl(0 78% 50%)" />
      <path
        d="M24 6 L36 18 L36 38 L12 38 L12 18 Z"
        fill="none"
        stroke="rgba(255,255,255,0.25)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <rect x="22.5" y="13" width="3" height="22" rx="0.5" fill="#fff" />
      <rect x="17" y="20" width="14" height="3" rx="0.5" fill="#fff" />
      <path
        d="M20 30 L20 38 L28 34 Z"
        fill="#fff"
        opacity="0.95"
      />
    </svg>
  );

  if (!withWordmark) return mark;

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 14 }}>
      {mark}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: 24, fontWeight: 800, color: "#fff", letterSpacing: "-0.01em" }}>
          Temple TV
        </span>
        <span style={{ fontSize: 14, color: "rgba(255,255,255,0.4)" }}>JCTM</span>
      </div>
    </div>
  );
}
