interface TempleTvLogoProps {
  size?: number;
}

export function TempleTvLogo({ size = 36 }: TempleTvLogoProps) {
  return (
    <img
      src="/admin/temple-tv-logo.png"
      alt="Temple TV"
      width={size}
      height={size}
      style={{ objectFit: "contain" }}
    />
  );
}
