const STORAGE_KEY = "temple-tv-admin-token";

let installed = false;

export function getAdminToken(): string {
  return window.localStorage.getItem(STORAGE_KEY)?.trim() ?? "";
}

export function setAdminToken(token: string): void {
  const clean = token.trim();
  if (clean) window.localStorage.setItem(STORAGE_KEY, clean);
  else window.localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event("temple-tv-admin-token-changed"));
}

export function getAdminEventSourceUrl(path: string): string {
  const token = getAdminToken();
  if (!token) return path;
  const url = new URL(path, window.location.origin);
  url.searchParams.set("adminToken", token);
  return `${url.pathname}${url.search}`;
}

export function configureAdminAccess(): void {
  if (installed) return;
  installed = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const token = getAdminToken();

    if (token && new URL(url, window.location.origin).pathname.startsWith("/api/admin")) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
      return originalFetch(input, { ...init, headers });
    }

    return originalFetch(input, init);
  };
}