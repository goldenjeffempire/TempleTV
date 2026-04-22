import React from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

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
    void fetch("/api/client-errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "admin",
        message: error.message,
        stack: error.stack ?? "",
        componentStack: info.componentStack ?? "",
        url: typeof window !== "undefined" ? window.location.href : "",
        ts: Date.now(),
      }),
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
