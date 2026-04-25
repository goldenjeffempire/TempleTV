import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, ShieldCheck } from "lucide-react";
import { TempleTvLogo } from "@/components/temple-tv-logo";
import { AdminKeyDialog } from "@/components/admin-key-dialog";
import { Button } from "@/components/ui/button";
import { adminGet, AdminApiError } from "@/services/adminApi";

type GateState =
  | { kind: "checking" }
  | { kind: "ok" }
  | { kind: "needs-token" }
  | { kind: "server-misconfigured"; message: string }
  | { kind: "server-down"; message: string; retryAttempt?: number };

async function probeAdminAccess(): Promise<GateState> {
  // Round 4l: route through adminGet rather than raw fetch. adminGet:
  //   1. Already retries on transient failures (network / 502/503/504 / HTML
  //      fallthrough) with the same backoff.
  //   2. Performs real JSON parsing — so an HTML body mislabelled as
  //      application/json would still throw AdminApiError instead of
  //      incorrectly granting access. This closes the auth-bypass gap
  //      flagged in code review for the previous raw-fetch implementation.
  //   3. Reads the admin token from localStorage the same way the previous
  //      implementation did, so behavior is identical for the happy path.
  try {
    await adminGet<unknown>("/admin/stats");
    return { kind: "ok" };
  } catch (err) {
    if (err instanceof AdminApiError) {
      if (err.status === 401) return { kind: "needs-token" };
      if (err.status === 503) {
        return {
          kind: "server-misconfigured",
          message: "Admin access is disabled until ADMIN_API_TOKEN is configured on the API server.",
        };
      }
      if (err.status === 0) {
        // Surface adminGet's detailed network-failure message (it already
        // includes the URL it tried and the underlying fetch error). That's
        // far more actionable than the generic "Could not reach" text and
        // immediately tells the operator whether it's a CORS/DNS/down issue.
        return { kind: "server-down", message: err.message };
      }
      return {
        kind: "server-down",
        message: `Unexpected response from API (HTTP ${err.status}): ${err.message}`,
      };
    }
    return {
      kind: "server-down",
      message:
        err instanceof Error && err.message
          ? `Could not reach the API server: ${err.message}`
          : "Could not reach the API server.",
    };
  }
}

// Auto-retry schedule when the API is unreachable. Caps at 15s so a long
// outage doesn't hammer the API once it comes back, but the first few retries
// happen quickly (3s, 5s, 8s) to ride through the typical Render restart
// window without operator intervention.
const SERVER_DOWN_RETRY_MS = [3_000, 5_000, 8_000, 15_000] as const;

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>({ kind: "checking" });
  const [dialogOpen, setDialogOpen] = useState(false);
  // Tracks consecutive server-down probes so the auto-retry backoff can
  // stretch out instead of restarting from 3s on every failure.
  const retryAttemptRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const recheck = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    setState({ kind: "checking" });
    void probeAdminAccess().then((next) => {
      if (next.kind === "server-down") {
        const attempt = retryAttemptRef.current + 1;
        retryAttemptRef.current = attempt;
        setState({ ...next, retryAttempt: attempt });
      } else {
        retryAttemptRef.current = 0;
        setState(next);
      }
    });
  }, []);

  useEffect(() => {
    recheck();
    const onChange = () => recheck();
    window.addEventListener("temple-tv-admin-token-changed", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("temple-tv-admin-token-changed", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, [recheck]);

  // Auto-retry while the server is unreachable, with a backoff schedule that
  // covers the typical 6s Render restart window on the first try and stretches
  // to 15s for sustained outages. Only runs in `server-down` state — never for
  // misconfiguration (which won't fix itself without an env var change) or
  // needs-token (which is gated on user input). The manual "Try again" button
  // remains available and bypasses the timer.
  useEffect(() => {
    if (state.kind !== "server-down") return;
    const idx = Math.min(
      (state.retryAttempt ?? 1) - 1,
      SERVER_DOWN_RETRY_MS.length - 1,
    );
    const delay = SERVER_DOWN_RETRY_MS[idx];
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      recheck();
    }, delay);
    return () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [state, recheck]);

  useEffect(() => {
    if (state.kind === "needs-token") setDialogOpen(true);
    else setDialogOpen(false);
  }, [state.kind]);

  if (state.kind === "ok") return <>{children}</>;

  return (
    <div className="min-h-screen w-full bg-muted/30 flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border bg-card shadow-sm p-8 space-y-6">
        <div className="flex items-center gap-3">
          <TempleTvLogo size={44} />
          <div>
            <p className="font-bold text-lg leading-tight">Temple TV</p>
            <p className="text-xs text-muted-foreground">Admin Console</p>
          </div>
        </div>

        {state.kind === "checking" && (
          <div className="flex items-center gap-3 rounded-lg border bg-muted/40 p-4 text-sm">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="text-muted-foreground">Verifying admin access…</span>
          </div>
        )}

        {state.kind === "needs-token" && (
          <>
            <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div className="space-y-1">
                <p className="font-medium text-amber-700 dark:text-amber-400">Sign in required</p>
                <p className="text-muted-foreground">
                  This console controls the Temple TV broadcast. Enter your admin access key to continue.
                </p>
              </div>
            </div>
            <Button className="w-full" onClick={() => setDialogOpen(true)}>
              Enter admin key
            </Button>
            <AdminKeyDialog
              open={dialogOpen}
              onOpenChange={setDialogOpen}
              onAuthenticated={recheck}
              required
            />
          </>
        )}

        {(state.kind === "server-misconfigured" || state.kind === "server-down") && (
          <>
            <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="space-y-1">
                <p className="font-medium text-destructive">
                  {state.kind === "server-misconfigured" ? "API not configured" : "API unreachable"}
                </p>
                <p className="text-muted-foreground break-words">{state.message}</p>
              </div>
            </div>
            {state.kind === "server-down" && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>
                  Retrying automatically
                  {state.retryAttempt && state.retryAttempt > 1
                    ? ` (attempt ${state.retryAttempt})`
                    : ""}
                  …
                </span>
              </div>
            )}
            <Button className="w-full" variant="outline" onClick={recheck}>
              Try again now
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
