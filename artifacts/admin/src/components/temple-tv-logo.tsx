interface TempleTvLogoProps {
  size?: number;
}

export function TempleTvLogo({ size = 36 }: TempleTvLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Temple TV"
    >
      <rect width="48" height="48" rx="10" fill="hsl(0 78% 50%)" />
      <path
        d="M24 6 L36 18 L36 38 L12 38 L12 18 Z"
        fill="none"
        stroke="rgba(255,255,255,0.28)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <rect x="22.5" y="13" width="3" height="22" rx="0.5" fill="#fff" />
      <rect x="17" y="20" width="14" height="3" rx="0.5" fill="#fff" />
      <path d="M20 30 L20 38 L28 34 Z" fill="#fff" opacity="0.95" />
    </svg>
  );
}
