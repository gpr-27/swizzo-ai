'use client';

// A per-panel React error boundary: one broken card / tray / picker shows a
// small "couldn't show this" notice with a retry, instead of blanking the
// whole app. The error itself is never shown (no stack traces in the UI); in
// development it is logged to the console for debugging.
//
//   <ErrorBoundary name="food-cart"><FoodCartPanel … /></ErrorBoundary>
//
// `resetKeys`: when any value changes (e.g. the message id or the open
// service), the boundary clears itself and tries rendering again.

import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface ErrorBoundaryProps {
  /** Short label for logs, e.g. "cart-panel". */
  name: string;
  children: ReactNode;
  /** Custom fallback; receives a retry callback. */
  fallback?: (retry: () => void) => ReactNode;
  /** A change in any of these re-mounts the children after an error. */
  resetKeys?: unknown[];
  /** Render nothing on error (for purely decorative bits). */
  silent?: boolean;
  className?: string;
}

interface State {
  failed: boolean;
  keys?: unknown[];
}

function keysChanged(a: unknown[] = [], b: unknown[] = []): boolean {
  return a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  state: State = { failed: false, keys: this.props.resetKeys };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: State): Partial<State> | null {
    if (state.failed && keysChanged(props.resetKeys, state.keys)) return { failed: false, keys: props.resetKeys };
    if (keysChanged(props.resetKeys, state.keys)) return { keys: props.resetKeys };
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (process.env.NODE_ENV !== 'production') {
      console.error(`[ErrorBoundary:${this.props.name}]`, error, info.componentStack);
    }
  }

  private retry = () => this.setState({ failed: false });

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    if (this.props.silent) return null;
    if (this.props.fallback) return this.props.fallback(this.retry);
    return (
      <div
        role="alert"
        className={`flex items-center justify-between gap-3 rounded-2xl border border-hairline bg-surface-soft px-4 py-3 text-sm text-muted ${this.props.className ?? ''}`}
      >
        <span>This part couldn&apos;t be shown right now.</span>
        <button
          type="button"
          onClick={this.retry}
          className="shrink-0 rounded-full border border-hairline px-3 py-1 text-xs font-medium text-ink hover:bg-surface-card focus-visible:outline-2 focus-visible:outline-coral"
        >
          Try again
        </button>
      </div>
    );
  }
}
