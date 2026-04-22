import { useEffect, useState } from "react";
import { Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { getAdminToken, setAdminToken } from "@/lib/admin-access";

interface AdminKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a key is verified and stored. */
  onAuthenticated?: () => void;
  /** When true, the dialog cannot be dismissed (used for the auth gate). */
  required?: boolean;
}

async function verifyAdminToken(token: string): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  try {
    const res = await fetch("/api/admin/stats", {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.ok) return { ok: true };
    if (res.status === 401) {
      return { ok: false, status: 401, message: "That admin key was rejected by the server." };
    }
    if (res.status === 503) {
      return {
        ok: false,
        status: 503,
        message: "The server has not been configured with an admin token yet. Set ADMIN_API_TOKEN on the API service.",
      };
    }
    return { ok: false, status: res.status, message: `Verification failed (HTTP ${res.status}).` };
  } catch {
    return { ok: false, status: 0, message: "Could not reach the API server. Check your network and try again." };
  }
}

export function AdminKeyDialog({ open, onOpenChange, onAuthenticated, required = false }: AdminKeyDialogProps) {
  const { toast } = useToast();
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValue(getAdminToken());
      setError(null);
      setShow(false);
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      setAdminToken("");
      onOpenChange(false);
      toast({ title: "Admin key cleared" });
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await verifyAdminToken(trimmed);
    setSubmitting(false);
    if (result.ok) {
      setAdminToken(trimmed);
      toast({ title: "Admin key verified" });
      onAuthenticated?.();
      onOpenChange(false);
      return;
    }
    setError(result.message);
  };

  const handleOpenChange = (next: boolean) => {
    if (required && !next) return;
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        onPointerDownOutside={(e) => required && e.preventDefault()}
        onEscapeKeyDown={(e) => required && e.preventDefault()}
      >
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
              <KeyRound className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle>Admin access required</DialogTitle>
              <DialogDescription className="mt-1">
                Enter your admin access key to manage the Temple TV broadcast.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Hidden username field so password managers don't warn (a11y) */}
          <input
            type="text"
            name="username"
            autoComplete="username"
            value="temple-tv-admin"
            readOnly
            hidden
            aria-hidden="true"
          />
          <div className="space-y-2">
            <Label htmlFor="admin-key-input">Admin key</Label>
            <div className="relative">
              <Input
                id="admin-key-input"
                type={show ? "text" : "password"}
                autoComplete="current-password"
                autoFocus
                placeholder="Paste your ADMIN_API_TOKEN value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="pr-10 font-mono"
                disabled={submitting}
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
                tabIndex={-1}
                aria-label={show ? "Hide key" : "Show key"}
              >
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                The key is stored in this browser only and sent as a Bearer token to <code className="font-mono">/api/admin/*</code>.
              </p>
            )}
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            {!required && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
            )}
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Verifying…
                </>
              ) : (
                "Save & verify"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
