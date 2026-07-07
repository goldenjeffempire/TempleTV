import type { ComponentType, PropsWithChildren } from "react";
import React, { Component } from "react";

import type { ErrorFallbackProps } from "@/components/ErrorFallback";
import { ErrorFallback } from "@/components/ErrorFallback";
import { reportClientError } from "@/lib/errorReporter";

export type ErrorBoundaryProps = PropsWithChildren<{
  FallbackComponent?: ComponentType<ErrorFallbackProps>;
  onError?: (error: Error, stackTrace: string) => void;
  /**
   * When this value changes, the boundary automatically resets — clearing the
   * error state and re-rendering children. Use a navigation key, route segment
   * string, or any value that changes when the user navigates away from the
   * crashed surface. This prevents the app from being permanently stuck in an
   * error state after navigating (e.g. dismissing a crashed player modal).
   *
   * Example:
   *   const segments = useSegments();
   *   <ErrorBoundary resetKey={segments.join("/")} ...>
   */
  resetKey?: unknown;
}>;

type ErrorBoundaryState = {
  error: Error | null;
  prevResetKey: unknown;
};

/**
 * This is a special case for for using the class components. Error boundaries must be class components because React only provides error boundary functionality through lifecycle methods (componentDidCatch and getDerivedStateFromError) which are not available in functional components.
 * https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null, prevResetKey: undefined };

  static defaultProps: {
    FallbackComponent: ComponentType<ErrorFallbackProps>;
  } = {
    FallbackComponent: ErrorFallback,
  };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  /**
   * Auto-reset the boundary when `resetKey` changes. This fires synchronously
   * during React's reconciliation phase (before render), so the new children
   * render directly without an intermediate error-fallback flash. The previous
   * key is stored in state (not a ref) so this static method — which has no
   * `this` — can compare old vs new cleanly.
   */
  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): Partial<ErrorBoundaryState> | null {
    if (props.resetKey !== undefined && state.prevResetKey !== props.resetKey) {
      return { error: null, prevResetKey: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error: Error, info: { componentStack: string }): void {
    void reportClientError({
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
    });
    if (typeof this.props.onError === "function") {
      this.props.onError(error, info.componentStack);
    }
  }

  resetError = (): void => {
    this.setState({ error: null });
  };

  render() {
    const { FallbackComponent } = this.props;

    return this.state.error && FallbackComponent ? (
      <FallbackComponent
        error={this.state.error}
        resetError={this.resetError}
      />
    ) : (
      this.props.children
    );
  }
}
