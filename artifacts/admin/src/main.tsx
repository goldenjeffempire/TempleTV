import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { AuthProvider } from "@/contexts/auth-context";
import { ThemeProvider } from "@/contexts/theme-context";
import { HttpError } from "@/lib/api";
import { ErrorBoundary } from "@/components/shared/error-boundary";
import App from "./App";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => {
        if (err instanceof HttpError && [401, 403, 404].includes(err.status)) return false;
        // Network-level failures (status 0) and server-startup errors (502/503/504)
        // occur during Render free-tier cold starts (~30 s). Allow up to 5 retries
        // so the query keeps trying long enough for the service to become ready
        // before surfacing a hard error to the user.
        if (err instanceof HttpError && (err.status === 0 || err.status >= 502)) {
          return count < 5;
        }
        return count < 2;
      },
      retryDelay: (attempt, err) => {
        // Cold-start errors get exponential backoff up to 30 s to span the full
        // Render warm-up window. Other errors use the shorter 8 s cap.
        const isColdStart = err instanceof HttpError && (err.status === 0 || err.status >= 502);
        return Math.min(1000 * Math.pow(2, attempt), isColdStart ? 30_000 : 8_000);
      },
      // 60 s stale window — SSE invalidation fires within milliseconds of any
      // server-side mutation so we don't need aggressive polling to stay fresh.
      // Raising this from 30 s halves the number of background refetch cycles.
      staleTime: 60_000,
      // Keep unused data in the cache for 10 minutes. Because we rely on SSE
      // for push invalidation, data that was recently active is almost always
      // still valid when the user navigates back to a page.
      gcTime: 10 * 60 * 1000,
      // Tabbing away and back to the admin panel should not trigger a refetch
      // storm — SSE handles server-push invalidation. Disable focus-based
      // refetch to avoid redundant network requests when the user switches
      // browser tabs or alt-tabs from another app.
      refetchOnWindowFocus: false,
      // Reconnect refetch is still useful: if the browser was offline and comes
      // back, re-fetching on reconnect ensures stale data is refreshed.
      refetchOnReconnect: true,
      // Keep rendering stale data while the background revalidation is in
      // flight rather than blinking back to a loading skeleton.
      placeholderData: (prev: unknown) => prev,
    },
    mutations: { retry: false },
  },
});

// Hide the inline loading screen once React is ready to paint
function removeLoadingScreen() {
  const el = document.getElementById("app-loading");
  if (!el) return;
  el.style.opacity = "0";
  el.style.pointerEvents = "none";
  setTimeout(() => el.remove(), 280);
}

const root = createRoot(document.getElementById("root")!);

root.render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <App />
            <Toaster position="bottom-right" richColors closeButton duration={4000} />
          </AuthProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
);

// Remove loading overlay after first paint
requestAnimationFrame(() => requestAnimationFrame(removeLoadingScreen));
