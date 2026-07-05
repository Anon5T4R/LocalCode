import { Component, type ReactNode } from "react";
import { t } from "./lib/i18n";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          height: "100vh", background: "#1e1e1e", color: "#ccc", fontFamily: "sans-serif",
          padding: 40, textAlign: "center",
        }}>
          <h2 style={{ color: "#f14c4c", marginBottom: 12 }}>{t("eb.title")}</h2>
          <pre style={{
            background: "#2d2d2d", padding: 16, borderRadius: 6, fontSize: 12,
            maxWidth: "80%", overflow: "auto", color: "#ce9178", fontFamily: "monospace",
          }}>
            {this.state.error?.message}
          </pre>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}
            style={{
              marginTop: 16, background: "#0078d4", color: "#fff", border: "none",
              padding: "8px 24px", borderRadius: 4, cursor: "pointer", fontSize: 13,
            }}
          >
            {t("eb.restart")}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
