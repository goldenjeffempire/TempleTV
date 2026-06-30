import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Forward to Sentry when configured; fall back to console only in dev so
    // production builds don't spam the user's browser console.
    const S = (window as unknown as { Sentry?: { captureException?: (e: unknown, ctx?: unknown) => void } }).Sentry;
    if (S?.captureException) {
      S.captureException(error, { contexts: { react: { componentStack: info.componentStack } } });
    } else if (import.meta.env.DEV) {
      console.error("[ErrorBoundary] Uncaught render error:", error, info.componentStack);
    }
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback !== undefined) {
        return this.props.fallback;
      }

      const sentryConfigured = !!import.meta.env.VITE_SENTRY_DSN;

      return (
        <div className="min-h-screen flex items-center justify-center p-8 bg-background">
          <div className="max-w-md w-full text-center space-y-5">
            <div className="flex justify-center">
              <div className="rounded-full bg-amber-500/10 p-5">
                <AlertTriangle size={32} className="text-amber-500" />
              </div>
            </div>
            <div>
              <h1 className="text-xl font-bold">
                We encountered a temporary issue loading the dashboard.
              </h1>
              <p className="text-muted-foreground text-sm mt-2">
                Our systems detected it automatically — please try again or reload the page.
              </p>
              {import.meta.env.DEV && this.state.error.message && (
                <pre className="mt-3 text-xs font-mono text-muted-foreground/70 bg-muted rounded-lg p-3 text-left whitespace-pre-wrap break-words">
                  {this.state.error.message}
                </pre>
              )}
            </div>
            <div className="flex gap-3 justify-center">
              <Button
                onClick={() => this.setState({ error: null })}
                className="gap-2"
              >
                <RotateCcw size={14} /> Try again
              </Button>
              <Button variant="outline" onClick={() => window.location.reload()} className="gap-2">
                <RefreshCw size={14} /> Reload page
              </Button>
            </div>
            {sentryConfigured && (
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  const S = (window as unknown as { Sentry?: { showReportDialog: () => void } }).Sentry;
                  if (S?.showReportDialog) S.showReportDialog();
                }}
                className="block text-xs text-muted-foreground/60 hover:text-muted-foreground underline-offset-2 hover:underline transition-colors"
              >
                Submit error report
              </a>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
