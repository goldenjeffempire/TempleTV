import { useCallback, useEffect, useState } from "react";
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
  | { kind: "server-down"; message: string };

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
        return { kind: "server-down", message: "Could not reach the API server." };
      }
      return {
        kind: "server-down",
        message: `Unexpected response from API (HTTP ${err.status}).`,
      };
    }
    return { kind: "server-down", message: "Could not reach the API server." };
  }
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>({ kind: "checking" });
  const [dialogOpen, setDialogOpen] = useState(false);

  const recheck = useCallback(() => {
    setState({ kind: "checking" });
    void probeAdminAccess().then(setState);
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
                <p className="text-muted-foreground">{state.message}</p>
              </div>
            </div>
            <Button className="w-full" variant="outline" onClick={recheck}>
              Try again
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
