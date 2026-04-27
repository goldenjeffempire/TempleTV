import React from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";
import { apiBase } from "@/lib/api-base";

interface State {
  error: Error | null;
}

interface Props {
  children: React.ReactNode;
  resetKey?: string;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prevProps: Props) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary] Caught render error:", error, info);
    // Payload shape MUST match the server's `ClientErrorSchema` in
    // artifacts/api-server/src/routes/client-errors.ts. The mobile app's
    // `lib/errorReporter.ts` is the reference implementation — admin, TV,
    // and mobile all post the SAME shape to the SAME endpoint
    // (/api/client-errors) so a single Mission Control feed shows every
    // platform's crashes uniformly. The previous payload used
    // `{source, message, ts}` which the schema rejected with a 400 — every
    // admin client-error was silently discarded for as long as that drift
    // existed. The "admin" identity is preserved in `context.source` so
    // operators can still filter by platform surface.
    const payload = {
      platform: "web" as const,
      errorName: error.name,
      errorMessage: error.message.slice(0, 2048),
      stack: error.stack?.slice(0, 8192),
      componentStack: info.componentStack?.slice(0, 8192) ?? undefined,
      context: {
        source: "admin",
        url: typeof window !== "undefined" ? window.location.href : "",
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
      },
      occurredAt: new Date().toISOString(),
    };
    void fetch(`${apiBase()}/client-errors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      // keepalive lets the browser flush the report even if the user
      // navigates away or the tab is closed in the same gesture that
      // triggered the crash. Mirrors the TV boundary.
      keepalive: true,
    }).catch(() => {
      // best-effort report; never let the boundary itself throw
    });
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="container mx-auto p-8 max-w-2xl">
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-8 text-center">
          <AlertTriangle className="h-12 w-12 text-destructive mx-auto mb-4" />
          <h2 className="text-xl font-bold mb-2">This page hit an error</h2>
          <p className="text-sm text-muted-foreground mb-4">
            The rest of the admin console is still working — only this view crashed. The error
            has been reported automatically.
          </p>
          <pre className="text-xs text-left bg-background border rounded p-3 mb-4 overflow-auto max-h-40">
            {this.state.error.message}
          </pre>
          <div className="flex gap-2 justify-center">
            <Button onClick={this.reset}>Try again</Button>
            <Button variant="outline" onClick={() => window.location.reload()}>
              Hard refresh
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
