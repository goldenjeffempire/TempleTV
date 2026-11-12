/** Parse an internal HTTP origin, never an arbitrary URL scheme or URL path. */
export function parseDaemonOrigin(value: string): string {
  let raw = value.trim();
  // Render's Connect menu copies host:port, without a protocol.
  if (/^[a-z0-9][a-z0-9.-]*:\d+\/?$/i.test(raw)) raw = `http://${raw}`;
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) ||
      url.username || url.password || url.search || url.hash ||
      url.pathname !== "/") {
    throw new Error("Expected an HTTP(S) origin or Render hostname:port");
  }
  return url.origin;
}
