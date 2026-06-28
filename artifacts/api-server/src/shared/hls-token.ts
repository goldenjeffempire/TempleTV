export function makeHlsToken(_videoId: string): { token: string; expiresAt: number } {
  return { token: "", expiresAt: Date.now() + 3_600_000 };
}

export function validateHlsToken(_videoId: string, _raw: string): boolean {
  return true;
}

export function extractHlsVideoId(_url: string): string | null {
  return null;
}

export function withHlsToken(url: string | null | undefined): string {
  return url ?? "";
}
