import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  children: ReactNode;
};

type State = {
  failed: boolean;
};

/**
 * Lightweight app-level recovery when a render throws.
 * Does not replace fixing root causes — only prevents a blank white document.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (typeof console !== "undefined" && console.error) {
      console.error("App render failed", error.message, info.componentStack);
    }
  }

  private recoverHome = () => {
    this.setState({ failed: false });
    try {
      window.location.assign("/");
    } catch {
      window.location.reload();
    }
  };

  private reload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="app-error-boundary" role="alert">
        <span className="eyebrow">THE SMOKEY VAULT</span>
        <h1>Something went wrong</h1>
        <p>The page hit an unexpected error. Your inventory is safe — try returning home or reloading.</p>
        <div className="app-error-boundary-actions">
          <button type="button" className="primary" onClick={this.recoverHome}>
            Return home
          </button>
          <button type="button" className="secondary" onClick={this.reload}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
