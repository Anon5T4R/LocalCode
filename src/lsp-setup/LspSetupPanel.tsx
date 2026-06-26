import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface LspServerStatus {
  name: string;
  installed: boolean;
  install_hint: string;
}

export function LspSetupPanel() {
  const [servers, setServers] = useState<LspServerStatus[]>([]);
  const [log, setLog] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      const list = await invoke<LspServerStatus[]>("check_lsp_servers");
      setServers(list);
    } catch (e) {
      setLog((prev) => [...prev, `Erro: ${e}`]);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const allInstalled = servers.length > 0 && servers.every((s) => s.installed);
  const offlineCount = servers.filter((s) => s.installed && s.install_hint === "Embutido (offline)").length;

  return (
    <div className="lsp-setup-panel">
      <div className="lsp-setup-header">
        <span>LSP Servers</span>
        <button className="lsp-refresh-btn" onClick={refresh}>↻</button>
      </div>

      {allInstalled ? (
        <div className="lsp-all-ok">
          ✅ Todos os language servers estão instalados!
          {offlineCount > 0 && <span className="lsp-offline-info"> ({offlineCount} embutidos)</span>}
        </div>
      ) : (
        <div className="lsp-setup-info">
          Language servers fornecem autocomplete, diagnósticos, hover, etc.
        </div>
      )}

      <div className="lsp-server-list">
        {servers.map((s) => (
          <div key={s.name} className={`lsp-server-item ${s.installed ? "installed" : "missing"}`}>
            <div className="lsp-server-info">
              <span className="lsp-server-name">{s.name}</span>
              <span className={`lsp-server-badge ${s.installed ? "ok" : "missing"}`}>
                {s.installed ? "✅" : "❌"}
              </span>
              {s.installed && s.install_hint === "Embutido (offline)" && (
                <span className="lsp-bundled-badge">offline</span>
              )}
            </div>
            {!s.installed && (
              <div className="lsp-server-actions">
                <code className="lsp-install-hint">{s.install_hint}</code>
              </div>
            )}
          </div>
        ))}
      </div>

      {log.length > 0 && (
        <div className="lsp-log">
          <h4>Log:</h4>
          {log.map((line, i) => (
            <pre key={i} className="lsp-log-line">{line}</pre>
          ))}
        </div>
      )}
    </div>
  );
}
