interface TempleTvLogoProps {
  size?: number;
  withWordmark?: boolean;
}

export function TempleTvLogo({ size = 48, withWordmark = false }: TempleTvLogoProps) {
  if (withWordmark) {
    return (
      <img
        src="/tv/temple-tv-logo.png"
        alt="Temple TV"
        style={{ height: size * 2.2, width: "auto", objectFit: "contain" }}
      />
    );
  }

  return (
    <img
      src="/tv/temple-tv-logo.png"
      alt="Temple TV"
      style={{ width: size, height: size, objectFit: "contain" }}
    />
  );
}
