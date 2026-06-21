import { useState, useRef, type FormEvent } from "react";
import { useAuth } from "@/contexts/use-auth";
import { HttpError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle, Loader2, Eye, EyeOff, Radio, ShieldCheck, ArrowLeft, Wifi } from "lucide-react";

// How many times to silently retry a transient failure before surfacing an
// error.  Two scenarios drive the window:
//   • Graceful API restart (memory-watchdog SIGTERM → drain → boot): ~30 s
//   • Render free-tier cold start (service sleeping → waking): 45-60 s
// 6 retries × 8 s = 48 s — covers both without the user seeing an error.
const MAX_NETWORK_RETRIES = 6;
const RETRY_DELAY_MS = 8000;

/**
 * Returns true for errors that are worth retrying automatically.
 *   status === 0   — fetch threw (DNS/TLS/offline/CORS preflight failure)
 *   status 502/503/504 — Render/proxy gateway error during cold start or restart
 *   status 408     — upstream request timeout (also transient)
 */
function isTransientError(status: number): boolean {
  return status === 0 || status === 502 || status === 503 || status === 504 || status === 408;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(id); reject(new DOMException("aborted", "AbortError")); }, { once: true });
  });
}

export default function LoginPage() {
  const { login, mfaPendingToken, verifyMfa, clearMfaPending } = useAuth();

  // Credentials step
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);

  // MFA step
  const [totpCode, setTotpCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [backupCode, setBackupCode] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Transient "connecting…" message shown while retrying after a network error
  const [connectingMsg, setConnectingMsg] = useState<string | null>(null);

  // Lets the user cancel an in-progress retry sequence by pressing Sign in again
  const abortRef = useRef<AbortController | null>(null);

  // ── Step 1: Credentials ────────────────────────────────────────────────────

  const handleCredentials = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;

    // Cancel any previous in-flight retry
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setLoading(true);
    setError(null);
    setConnectingMsg(null);

    let lastNetworkError: HttpError | null = null;

    for (let attempt = 0; attempt <= MAX_NETWORK_RETRIES; attempt++) {
      if (ac.signal.aborted) break;

      if (attempt > 0) {
        // Show warm feedback during the wait — never show a hard error for
        // transient network issues while retries are still in progress.
        const remaining = MAX_NETWORK_RETRIES - attempt + 1;
        setConnectingMsg(
          attempt === 1
            ? "Server is warming up, connecting…"
            : `Still connecting… (${remaining} attempt${remaining !== 1 ? "s" : ""} left)`,
        );
        try {
          await sleep(RETRY_DELAY_MS, ac.signal);
        } catch {
          break; // aborted by user re-submit or unmount
        }
        setConnectingMsg(null);
        if (ac.signal.aborted) break;
      }

      try {
        await login(email.trim(), password);
        // Success — router redirect handled by auth context
        return;
      } catch (err) {
        if (err instanceof HttpError) {
          if (isTransientError(err.status)) {
            // Network failure or gateway error (502/503/504/408) — retry
            // silently.  Render's 502 during cold start is HTML, not JSON,
            // so the API client normalises it to HttpError(502); we treat it
            // identically to a pure fetch failure (status 0).
            lastNetworkError = err;
            continue;
          }
          // Definitive server response — stop retrying immediately
          if (err.status === 401) {
            setError("Invalid email or password.");
          } else if (err.status === 403) {
            setError(err.message);
          } else {
            setError(err.message || "Login failed. Please try again.");
          }
          lastNetworkError = null;
          break;
        } else {
          // Unexpected JS error (not a network issue)
          setError("An unexpected error occurred. Please refresh and try again.");
          lastNetworkError = null;
          break;
        }
      }
    }

    // All retries exhausted on network errors
    if (lastNetworkError) {
      setError(
        "Unable to reach the server. The service may be temporarily unavailable — please wait a moment and try again.",
      );
    }

    setConnectingMsg(null);
    setLoading(false);
  };

  // ── Step 2: TOTP verification ──────────────────────────────────────────────

  const handleMfa = async (e: FormEvent) => {
    e.preventDefault();
    if (!mfaPendingToken) return;
    const code = useBackupCode ? undefined : totpCode;
    const bCode = useBackupCode ? backupCode : undefined;
    if (useBackupCode ? !bCode : !code || code.length !== 6) return;
    setLoading(true);
    setError(null);
    try {
      await verifyMfa(mfaPendingToken, code ?? "", bCode);
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 401) setError(useBackupCode ? "Backup code is invalid." : "Incorrect code. Wait for the next 30-second cycle and try again.");
        else setError(err.message || "Verification failed.");
      } else {
        setError("Unable to reach the server.");
      }
    } finally {
      setLoading(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        {/* Brand */}
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex items-center gap-2.5">
            <img
              src="/temple-tv-logo.png"
              alt="Temple TV"
              className="h-10 w-auto object-contain"
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
            <p className="text-xs text-muted-foreground uppercase tracking-widest">Admin Panel</p>
          </div>
        </div>

        {/* ── MFA step ── */}
        {mfaPendingToken ? (
          <Card>
            <CardHeader className="pb-4">
              <div className="flex items-center gap-2">
                <ShieldCheck size={18} className="text-primary" />
                <CardTitle className="text-lg">Two-factor authentication</CardTitle>
              </div>
              <CardDescription>
                {useBackupCode
                  ? "Enter one of your saved backup codes."
                  : "Enter the 6-digit code from your authenticator app."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleMfa} className="space-y-4">
                {error && (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                {!useBackupCode ? (
                  <div className="space-y-2">
                    <Label htmlFor="totp-code">Authenticator code</Label>
                    <Input
                      id="totp-code"
                      inputMode="numeric"
                      maxLength={6}
                      placeholder="000000"
                      value={totpCode}
                      onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      className="text-center text-2xl tracking-[0.5em] font-mono"
                      autoFocus
                      disabled={loading}
                      autoComplete="one-time-code"
                    />
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label htmlFor="backup-code">Backup code</Label>
                    <Input
                      id="backup-code"
                      placeholder="XXXX-XXXX"
                      value={backupCode}
                      onChange={(e) => setBackupCode(e.target.value.toUpperCase())}
                      className="text-center font-mono tracking-widest"
                      autoFocus
                      disabled={loading}
                    />
                  </div>
                )}

                <Button
                  type="submit"
                  className="w-full"
                  disabled={loading || (useBackupCode ? !backupCode : totpCode.length !== 6)}
                >
                  {loading ? (
                    <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Verifying…</>
                  ) : (
                    "Verify"
                  )}
                </Button>

                <div className="flex items-center justify-between pt-1">
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors underline-offset-2 hover:underline"
                    onClick={() => { setUseBackupCode((v) => !v); setError(null); setTotpCode(""); setBackupCode(""); }}
                  >
                    {useBackupCode ? "Use authenticator code instead" : "Use a backup code"}
                  </button>
                  <button
                    type="button"
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => { clearMfaPending(); setError(null); setTotpCode(""); setBackupCode(""); }}
                  >
                    <ArrowLeft size={12} /> Back
                  </button>
                </div>
              </form>
            </CardContent>
          </Card>
        ) : (
          /* ── Credentials step ── */
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-lg">Sign in</CardTitle>
              <CardDescription>Enter your admin credentials to continue.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleCredentials} className="space-y-4">
                {/* Hard error — shown only after all retries are exhausted */}
                {error && (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                {/* Soft connecting state — shown during network-error retries */}
                {connectingMsg && !error && (
                  <Alert className="border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/40">
                    <Wifi className="h-4 w-4 text-blue-500 animate-pulse" />
                    <AlertDescription className="text-blue-700 dark:text-blue-300">
                      {connectingMsg}
                    </AlertDescription>
                  </Alert>
                )}

                <div className="space-y-2">
                  <Label htmlFor="email">Email address</Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    placeholder="admin@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={loading}
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPw ? "text" : "password"}
                      autoComplete="current-password"
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      disabled={loading}
                      required
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPw(!showPw)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                      aria-label={showPw ? "Hide password" : "Show password"}
                    >
                      {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>

                <Button type="submit" className="w-full" disabled={loading || !email || !password}>
                  {loading ? (
                    <><Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {connectingMsg ? "Connecting…" : "Signing in…"}
                    </>
                  ) : (
                    "Sign in"
                  )}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        <p className="text-center text-xs text-muted-foreground flex items-center justify-center gap-1.5">
          <Radio size={11} className="text-red-500" />
          JCTM Broadcasting System
        </p>
      </div>
    </div>
  );
}
