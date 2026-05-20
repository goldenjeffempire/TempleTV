import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ErrorAlertProps {
  title?: string;
  message?: string;
  onRetry?: () => void;
  className?: string;
  /**
   * Round 4l: when true, render a softer "Reconnecting…" style instead of
   * the destructive red banner. Intended for use with `AdminApiError.transient`
   * — i.e., a workflow-restart race where the page's polling will auto-recover
   * within a few seconds and a scary red banner overstates the severity. The
   * default visual stays destructive to preserve existing call sites that pass
   * real, non-transient errors.
   */
  transient?: boolean;
}

export function ErrorAlert({
  title,
  message,
  onRetry,
  className,
  transient = false,
}: ErrorAlertProps) {
  if (transient) {
    return (
      <div
        className={cn(
          "flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm",
          className,
        )}
      >
        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-amber-600" />
        <div className="flex-1 min-w-0">
          <p className="font-medium text-amber-700 dark:text-amber-400">
            {title ?? "Reconnecting to API server…"}
          </p>
          <p className="text-muted-foreground mt-0.5">
            {message ??
              "The server is briefly unreachable (likely restarting). This page will refresh automatically as soon as it responds."}
          </p>
        </div>
        {onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry} className="shrink-0">
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
            Retry now
          </Button>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm",
        className,
      )}
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div className="flex-1 min-w-0">
        <p className="font-medium text-destructive">{title ?? "Something went wrong"}</p>
        {message && <p className="text-muted-foreground mt-0.5">{message}</p>}
      </div>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry} className="shrink-0">
          <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
          Retry
        </Button>
      )}
    </div>
  );
}
