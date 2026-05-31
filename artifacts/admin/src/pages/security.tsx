/**
 * Security page — MFA / TOTP management.
 *
 * Allows admin users to set up, verify, and disable TOTP-based
 * two-factor authentication on their account.
 *
 * Setup flow:
 *   1. POST /auth/mfa/setup   → get secret + otpauthUri + backup codes
 *   2. Show QR code + manual secret + backup codes
 *   3. User enters 6-digit code from authenticator
 *   4. POST /auth/mfa/enable  → MFA is now active
 *
 * Disable flow:
 *   1. User enters 6-digit TOTP code + account password
 *   2. POST /auth/mfa/disable → MFA removed
 */
import { useState, useEffect, useRef } from "react";
import QRCode from "qrcode";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/use-auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import {
  ShieldCheck, ShieldOff, KeyRound, Copy, RefreshCw,
  AlertCircle, CheckCircle2, Smartphone, Eye, EyeOff,
} from "lucide-react";

interface MfaStatus {
  enabled: boolean;
  configuredAt: string | null;
  backupCodesRemaining: number;
}

interface MfaSetupData {
  secret: string;
  otpauthUri: string;
  backupCodes: string[];
}

type SetupStep = "idle" | "scanning" | "verifying" | "done";

function CodeDisplay({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the "copied" reset timer on unmount to avoid a setState call on an
  // unmounted component (which React will warn about and can leak memory).
  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);

  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(code);
        setCopied(true);
        // Cancel any in-flight reset before scheduling a new one, so rapid
        // clicks don't stack timers and cause the icon to flicker prematurely.
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => { timerRef.current = null; setCopied(false); }, 2000);
      }}
      className="flex items-center gap-2 text-sm font-mono bg-muted px-3 py-1.5 rounded hover:bg-muted/80 transition-colors cursor-pointer select-all"
      title="Click to copy"
    >
      {code}
      {copied ? <CheckCircle2 size={14} className="text-green-500 flex-shrink-0" /> : <Copy size={14} className="text-muted-foreground flex-shrink-0" />}
    </button>
  );
}

function QrCode({ uri }: { uri: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [qrError, setQrError] = useState(false);

  useEffect(() => {
    setQrError(false);
    const canvas = canvasRef.current;
    if (!canvas) return;
    QRCode.toCanvas(canvas, uri, {
      width: 200,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    }).catch(() => setQrError(true));
  }, [uri]);

  return (
    <div className="flex flex-col items-center gap-3">
      {qrError ? (
        <div className="w-[200px] h-[200px] flex items-center justify-center rounded-lg border bg-muted text-center p-4 text-sm text-muted-foreground">
          QR code could not be generated. Use the manual key below.
        </div>
      ) : (
        <canvas
          ref={canvasRef}
          className="rounded-lg border shadow-sm"
          aria-label="Scan this QR code with your authenticator app"
        />
      )}
      <p className="text-xs text-muted-foreground text-center max-w-[220px]">
        Scan with Google Authenticator, Authy, or any TOTP app
      </p>
    </div>
  );
}

export default function SecurityPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [setupStep, setSetupStep] = useState<SetupStep>("idle");
  const [setupData, setSetupData] = useState<MfaSetupData | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [disablePassword, setDisablePassword] = useState("");
  const [showDisableForm, setShowDisableForm] = useState(false);
  const [showRegenForm, setShowRegenForm] = useState(false);
  const [regenCode, setRegenCode] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [newBackupCodes, setNewBackupCodes] = useState<string[] | null>(null);

  const { data: status, isLoading } = useQuery({
    queryKey: ["mfa-status"],
    queryFn: () => api.get<MfaStatus>("/auth/mfa/status"),
    staleTime: 30_000,
  });

  const setupMutation = useMutation({
    mutationFn: () => api.post<MfaSetupData>("/auth/mfa/setup", {}),
    onSuccess: (data) => {
      setSetupData(data);
      setSetupStep("scanning");
      setTotpCode("");
    },
    onError: () => toast({ title: "Setup failed", description: "Could not generate MFA secret. Try again.", variant: "destructive" }),
  });

  const enableMutation = useMutation({
    mutationFn: (code: string) => api.post<{ ok: boolean }>("/auth/mfa/enable", { code }),
    onSuccess: () => {
      setSetupStep("done");
      void qc.invalidateQueries({ queryKey: ["mfa-status"] });
      toast({ title: "MFA enabled", description: "Your account is now protected by two-factor authentication." });
    },
    onError: () => toast({ title: "Verification failed", description: "Code is incorrect or expired. Check your authenticator app.", variant: "destructive" }),
  });

  const disableMutation = useMutation({
    mutationFn: ({ code, password }: { code: string; password: string }) =>
      api.post<{ ok: boolean }>("/auth/mfa/disable", { code, password }),
    onSuccess: () => {
      setShowDisableForm(false);
      setDisableCode("");
      setDisablePassword("");
      setSetupStep("idle");
      setSetupData(null);
      void qc.invalidateQueries({ queryKey: ["mfa-status"] });
      toast({ title: "MFA disabled", description: "Two-factor authentication has been removed from your account." });
    },
    onError: () => toast({ title: "Disable failed", description: "Code or password is incorrect.", variant: "destructive" }),
  });

  const regenMutation = useMutation({
    mutationFn: (code: string) =>
      api.post<{ backupCodes: string[] }>("/auth/mfa/regenerate-backup-codes", { code }),
    onSuccess: (data) => {
      setNewBackupCodes(data.backupCodes);
      setShowRegenForm(false);
      setRegenCode("");
      void qc.invalidateQueries({ queryKey: ["mfa-status"] });
      toast({ title: "Backup codes regenerated", description: "Save your new backup codes — the old ones are now invalid." });
    },
    onError: () => toast({ title: "Failed", description: "TOTP code is incorrect or expired.", variant: "destructive" }),
  });

  if (isLoading) {
    return (
      <div className="max-w-2xl mx-auto p-6 space-y-6">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        <div className="h-40 bg-muted animate-pulse rounded-lg" />
      </div>
    );
  }

  const mfaEnabled = status?.enabled ?? false;

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <KeyRound size={22} />
          Account Security
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Manage two-factor authentication for{" "}
          <span className="font-medium text-foreground">{user?.email}</span>
        </p>
      </div>

      {/* MFA Status Card */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Smartphone size={16} />
              Authenticator App (TOTP)
            </CardTitle>
            <Badge variant={mfaEnabled ? "default" : "secondary"} className={mfaEnabled ? "bg-green-600" : ""}>
              {mfaEnabled ? "Enabled" : "Disabled"}
            </Badge>
          </div>
          <CardDescription>
            {mfaEnabled
              ? "Your account requires a 6-digit code from your authenticator app at every login."
              : "Add a second verification step using Google Authenticator, Authy, or any TOTP app."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* ── Not enabled — setup flow ── */}
          {!mfaEnabled && (
            <div className="space-y-4">
              {setupStep === "idle" && (
                <Button onClick={() => setupMutation.mutate()} disabled={setupMutation.isPending}>
                  {setupMutation.isPending ? <><RefreshCw size={14} className="mr-2 animate-spin" />Generating…</> : <><ShieldCheck size={14} className="mr-2" />Enable Two-Factor Authentication</>}
                </Button>
              )}

              {(setupStep === "scanning" || setupStep === "verifying") && setupData && (
                <div className="space-y-6">
                  <Alert>
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>
                      Save your backup codes before continuing — they won't be shown again.
                    </AlertDescription>
                  </Alert>

                  {/* Step 1: Scan QR */}
                  <div className="space-y-4">
                    <p className="text-sm font-medium">Step 1 — Scan the QR code</p>
                    <div className="flex flex-col sm:flex-row gap-6 items-start">
                      <QrCode uri={setupData.otpauthUri} />
                      <div className="space-y-3 flex-1">
                        <p className="text-sm text-muted-foreground">
                          Can't scan? Enter the secret key manually in your app:
                        </p>
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <code className="flex-1 text-xs bg-muted px-3 py-2 rounded font-mono tracking-widest break-all">
                              {showSecret ? setupData.secret : "•".repeat(setupData.secret.length)}
                            </code>
                            <button
                              onClick={() => setShowSecret((v) => !v)}
                              className="p-1.5 text-muted-foreground hover:text-foreground rounded"
                              title={showSecret ? "Hide secret" : "Reveal secret"}
                            >
                              {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
                            </button>
                            <button
                              onClick={() => { void navigator.clipboard.writeText(setupData.secret); toast({ title: "Secret copied" }); }}
                              className="p-1.5 text-muted-foreground hover:text-foreground rounded"
                              title="Copy secret"
                            >
                              <Copy size={14} />
                            </button>
                          </div>
                          <p className="text-[10px] text-muted-foreground">Algorithm: SHA-1 · Digits: 6 · Period: 30s</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  <Separator />

                  {/* Step 2: Save backup codes */}
                  <div className="space-y-3">
                    <p className="text-sm font-medium">Step 2 — Save your backup codes</p>
                    <p className="text-xs text-muted-foreground">
                      Each code can be used once if you lose access to your phone. Store them somewhere safe.
                    </p>
                    <div className="grid grid-cols-2 gap-1.5">
                      {setupData.backupCodes.map((code) => (
                        <CodeDisplay key={code} code={code} />
                      ))}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void navigator.clipboard.writeText(setupData.backupCodes.join("\n"));
                        toast({ title: "Backup codes copied" });
                      }}
                    >
                      <Copy size={13} className="mr-1.5" /> Copy all codes
                    </Button>
                  </div>

                  <Separator />

                  {/* Step 3: Verify first code */}
                  <div className="space-y-3">
                    <p className="text-sm font-medium">Step 3 — Verify your authenticator</p>
                    <p className="text-xs text-muted-foreground">
                      Enter the current 6-digit code from your app to confirm setup.
                    </p>
                    <div className="flex gap-2 items-end">
                      <div className="space-y-1.5 flex-1 max-w-[160px]">
                        <Label htmlFor="totp-code">6-digit code</Label>
                        <Input
                          id="totp-code"
                          inputMode="numeric"
                          maxLength={6}
                          placeholder="000000"
                          value={totpCode}
                          onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                          className="text-center text-lg tracking-widest font-mono"
                          autoFocus
                        />
                      </div>
                      <Button
                        onClick={() => enableMutation.mutate(totpCode)}
                        disabled={totpCode.length !== 6 || enableMutation.isPending}
                      >
                        {enableMutation.isPending ? <><RefreshCw size={13} className="mr-1.5 animate-spin" />Verifying…</> : "Activate MFA"}
                      </Button>
                    </div>
                    {enableMutation.isError && (
                      <p className="text-xs text-destructive">Incorrect code. Wait for the next 30-second cycle and try again.</p>
                    )}
                  </div>
                </div>
              )}

              {setupStep === "done" && (
                <div className="flex items-center gap-2 text-green-600 text-sm font-medium">
                  <CheckCircle2 size={16} />
                  MFA activated successfully. Your account is now protected.
                </div>
              )}
            </div>
          )}

          {/* ── Enabled — manage flow ── */}
          {mfaEnabled && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 size={15} className="text-green-500" />
                {status?.configuredAt
                  ? `MFA configured on ${new Date(status.configuredAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}`
                  : "MFA is active"}
                {status && (
                  <span className="ml-2">· {status.backupCodesRemaining} backup code{status.backupCodesRemaining !== 1 ? "s" : ""} remaining</span>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { setShowRegenForm((v) => !v); setShowDisableForm(false); }}
                >
                  <RefreshCw size={13} className="mr-1.5" /> Regenerate backup codes
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => { setShowDisableForm((v) => !v); setShowRegenForm(false); }}
                >
                  <ShieldOff size={13} className="mr-1.5" /> Disable MFA
                </Button>
              </div>

              {/* Regenerate backup codes */}
              {showRegenForm && (
                <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
                  <p className="text-sm font-medium">Regenerate backup codes</p>
                  <p className="text-xs text-muted-foreground">Enter your current TOTP code to get 8 fresh backup codes. All existing codes will be invalidated.</p>
                  <div className="flex gap-2 items-end">
                    <div className="space-y-1.5 flex-1 max-w-[160px]">
                      <Label htmlFor="regen-code">TOTP code</Label>
                      <Input
                        id="regen-code"
                        inputMode="numeric"
                        maxLength={6}
                        placeholder="000000"
                        value={regenCode}
                        onChange={(e) => setRegenCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                        className="text-center font-mono tracking-widest"
                        autoFocus
                      />
                    </div>
                    <Button
                      size="sm"
                      onClick={() => regenMutation.mutate(regenCode)}
                      disabled={regenCode.length !== 6 || regenMutation.isPending}
                    >
                      {regenMutation.isPending ? <RefreshCw size={13} className="animate-spin" /> : "Regenerate"}
                    </Button>
                  </div>
                </div>
              )}

              {/* New backup codes display after regeneration */}
              {newBackupCodes && (
                <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
                  <Alert>
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>Save these now — they won't be shown again.</AlertDescription>
                  </Alert>
                  <div className="grid grid-cols-2 gap-1.5">
                    {newBackupCodes.map((code) => (
                      <CodeDisplay key={code} code={code} />
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => { void navigator.clipboard.writeText(newBackupCodes.join("\n")); toast({ title: "Codes copied" }); }}>
                      <Copy size={13} className="mr-1.5" /> Copy all
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setNewBackupCodes(null)}>Dismiss</Button>
                  </div>
                </div>
              )}

              {/* Disable MFA form */}
              {showDisableForm && (
                <div className="border border-destructive/30 rounded-lg p-4 space-y-3 bg-destructive/5">
                  <p className="text-sm font-medium text-destructive">Disable two-factor authentication</p>
                  <p className="text-xs text-muted-foreground">You'll need your current TOTP code and account password to disable MFA.</p>
                  <div className="space-y-3">
                    <div className="space-y-1.5 max-w-[160px]">
                      <Label htmlFor="disable-code">TOTP code</Label>
                      <Input
                        id="disable-code"
                        inputMode="numeric"
                        maxLength={6}
                        placeholder="000000"
                        value={disableCode}
                        onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                        className="text-center font-mono tracking-widest"
                        autoFocus
                      />
                    </div>
                    <div className="space-y-1.5 max-w-[260px]">
                      <Label htmlFor="disable-pw">Account password</Label>
                      <Input
                        id="disable-pw"
                        type="password"
                        placeholder="Enter your password"
                        value={disablePassword}
                        onChange={(e) => setDisablePassword(e.target.value)}
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => disableMutation.mutate({ code: disableCode, password: disablePassword })}
                        disabled={disableCode.length !== 6 || !disablePassword || disableMutation.isPending}
                      >
                        {disableMutation.isPending ? <RefreshCw size={13} className="mr-1.5 animate-spin" /> : null}
                        Disable MFA
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setShowDisableForm(false)}>Cancel</Button>
                    </div>
                    {disableMutation.isError && (
                      <p className="text-xs text-destructive">Incorrect code or password. Try again.</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Info card */}
      <Card className="bg-muted/30">
        <CardContent className="pt-4">
          <p className="text-xs text-muted-foreground leading-relaxed">
            <strong>What is TOTP?</strong> Time-based One-Time Passwords (RFC 6238) generate a
            new 6-digit code every 30 seconds using your phone's clock and a shared secret key.
            Even if your password is compromised, an attacker cannot log in without physical
            access to your phone. Compatible apps include Google Authenticator, Microsoft
            Authenticator, Authy, and 1Password.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
