import { useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import {
  spawnTerminal, writeTerminal, resizeTerminal, killTerminal,
  onTerminalOutput, onTerminalExit,
} from "../lib/terminal";

/** A pre-spawned PTY session the panel should attach to (debugger runInTerminal). */
export interface TerminalAdoption {
  key: string;
  sessionId: string;
  title?: string;
}

interface TerminalPanelProps {
  workspaceRoot?: string | null;
  onClose: () => void;
  adoptions?: TerminalAdoption[];
}

interface TermEntry {
  key: string;
  adoptSessionId?: string;
  title?: string;
}

export function TerminalPanel({ workspaceRoot, onClose, adoptions }: TerminalPanelProps) {
  const [keys, setKeys] = useState<TermEntry[]>(() => [{ key: crypto.randomUUID() }]);
  const [activeKey, setActiveKey] = useState(keys[0].key);

  // Attach terminals handed to us from outside (debugger runInTerminal).
  useEffect(() => {
    if (!adoptions || adoptions.length === 0) return;
    setKeys((ks) => {
      const known = new Set(ks.map((k) => k.key));
      const fresh = adoptions.filter((a) => !known.has(a.key));
      if (fresh.length === 0) return ks;
      setActiveKey(fresh[fresh.length - 1].key);
      return [...ks, ...fresh.map((a) => ({ key: a.key, adoptSessionId: a.sessionId, title: a.title }))];
    });
  }, [adoptions]);

  // Reconcile active terminal / close panel when empty
  useEffect(() => {
    if (keys.length === 0) { onClose(); return; }
    if (!keys.some((k) => k.key === activeKey)) setActiveKey(keys[keys.length - 1].key);
  }, [keys, activeKey, onClose]);

  const addTerm = () => {
    const k = crypto.randomUUID();
    setKeys((ks) => [...ks, { key: k }]);
    setActiveKey(k);
  };

  const closeTerm = (k: string) => setKeys((ks) => ks.filter((x) => x.key !== k));

  return (
    <div className="terminal-panel">
      <div className="terminal-header">
        <div className="terminal-tabs" style={{ display: "flex", gap: 2, alignItems: "center", overflowX: "auto" }}>
          {keys.map((k, i) => (
            <div
              key={k.key}
              className={`terminal-tab ${k.key === activeKey ? "active" : ""}`}
              onClick={() => setActiveKey(k.key)}
              style={{
                display: "flex", alignItems: "center", gap: 4, padding: "2px 8px",
                cursor: "pointer", fontSize: 12, borderRadius: 4,
                background: k.key === activeKey ? "var(--bg-active, #2a2a2a)" : "transparent",
                color: k.key === activeKey ? "var(--text-primary, #ddd)" : "var(--text-secondary, #999)",
              }}
            >
              {k.title ?? `Terminal ${i + 1}`}
              <button
                className="terminal-tab-close"
                onClick={(e) => { e.stopPropagation(); closeTerm(k.key); }}
                style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 0, fontSize: 11 }}
                title="Fechar terminal"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            className="terminal-add"
            onClick={addTerm}
            style={{ background: "none", border: "none", color: "var(--text-secondary, #999)", cursor: "pointer", fontSize: 16, padding: "0 6px" }}
            title="Novo terminal"
          >
            +
          </button>
        </div>
        <button className="terminal-close-btn" onClick={onClose} title="Fechar painel">✕</button>
      </div>
      <div className="terminal-body" style={{ position: "relative", flex: 1, minHeight: 0 }}>
        {keys.map((k) => (
          <TerminalInstance
            key={k.key}
            active={k.key === activeKey}
            workspaceRoot={workspaceRoot}
            adoptSessionId={k.adoptSessionId}
            onExit={() => closeTerm(k.key)}
          />
        ))}
      </div>
    </div>
  );
}

interface TerminalInstanceProps {
  active: boolean;
  workspaceRoot?: string | null;
  /** Attach to an already-spawned PTY session instead of spawning a shell. */
  adoptSessionId?: string;
  onExit: () => void;
}

function TerminalInstance({ active, workspaceRoot, adoptSessionId, onExit }: TerminalInstanceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
  const spawnedRef = useRef(false);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  useEffect(() => {
    if (!containerRef.current || spawnedRef.current) return;
    spawnedRef.current = true;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontSize: 13,
      fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, monospace",
      theme: xtermTheme(),
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();
    termRef.current = term;
    fitRef.current = fitAddon;

    // Keep xterm colors in sync with the app theme
    const themeObserver = new MutationObserver(() => {
      term.options.theme = xtermTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true, attributeFilter: ["data-theme"],
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      const dims = fitAddon.proposeDimensions();
      if (dims && sessionRef.current) {
        resizeTerminal(sessionRef.current, dims.rows, dims.cols).catch(() => {});
      }
    });
    resizeObserver.observe(containerRef.current);

    let unlistenOutput: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;

    const sessionPromise = adoptSessionId
      ? Promise.resolve(adoptSessionId)
      : spawnTerminal(workspaceRoot ?? null);

    sessionPromise
      .then((id) => {
        sessionRef.current = id;
        term.focus();

        unlistenOutput = onTerminalOutput(id, (data) => term.write(data));
        unlistenExit = onTerminalExit(id, () => {
          term.write("\r\n\x1b[31mProcesso encerrado\x1b[0m\r\n");
          onExitRef.current();
        });

        term.onData((data) => {
          if (sessionRef.current) writeTerminal(sessionRef.current, data).catch(() => {});
        });

        const dims = fitAddon.proposeDimensions();
        if (dims) resizeTerminal(id, dims.rows, dims.cols).catch(() => {});
      })
      .catch((e) => {
        term.write(`\r\n\x1b[31mErro: ${e}\x1b[0m\r\n`);
      });

    return () => {
      themeObserver.disconnect();
      resizeObserver.disconnect();
      unlistenOutput?.();
      unlistenExit?.();
      if (sessionRef.current) killTerminal(sessionRef.current).catch(() => {});
      term.dispose();
      termRef.current = null;
      spawnedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refit + focus when this terminal becomes the active tab
  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      fitRef.current?.fit();
      termRef.current?.focus();
      const dims = fitRef.current?.proposeDimensions();
      if (dims && sessionRef.current) {
        resizeTerminal(sessionRef.current, dims.rows, dims.cols).catch(() => {});
      }
    });
  }, [active]);

  return (
    <div
      ref={containerRef}
      className="terminal-container"
      style={{ position: "absolute", inset: 0, display: active ? "block" : "none" }}
    />
  );
}

function xtermTheme(): ITheme {
  const t = document.documentElement.getAttribute("data-theme");
  if (t === "light") {
    return {
      background: "#ffffff", foreground: "#1e1e1e", cursor: "#1e1e1e",
      selectionBackground: "#add6ff",
      black: "#000000", red: "#cd3131", green: "#107c10", yellow: "#795e26",
      blue: "#0451a5", magenta: "#bc05bc", cyan: "#0598bc", white: "#555555",
      brightBlack: "#666666", brightRed: "#cd3131", brightGreen: "#14ce14",
      brightYellow: "#b5ba00", brightBlue: "#0451a5", brightMagenta: "#bc05bc",
      brightCyan: "#0598bc", brightWhite: "#000000",
    };
  }
  if (t === "high-contrast") {
    return {
      background: "#000000", foreground: "#ffffff", cursor: "#ffffff",
      selectionBackground: "#ffffff44",
      black: "#000000", red: "#ff5050", green: "#0dff0d", yellow: "#ffff00",
      blue: "#3b8eea", magenta: "#ff40ff", cyan: "#00ffff", white: "#ffffff",
      brightBlack: "#808080", brightRed: "#ff5050", brightGreen: "#0dff0d",
      brightYellow: "#ffff00", brightBlue: "#3b8eea", brightMagenta: "#ff40ff",
      brightCyan: "#00ffff", brightWhite: "#ffffff",
    };
  }
  // dark (default)
  return {
    background: "#1e1e1e", foreground: "#d4d4d4", cursor: "#d4d4d4",
    selectionBackground: "#264f78",
    black: "#000000", red: "#cd3131", green: "#0dbc79", yellow: "#e5e510",
    blue: "#2472c8", magenta: "#bc3fbc", cyan: "#11b8bd", white: "#e5e5e5",
    brightBlack: "#666666", brightRed: "#f14c4c", brightGreen: "#23d18b",
    brightYellow: "#f5f543", brightBlue: "#3b8eea", brightMagenta: "#d670d6",
    brightCyan: "#29b8db", brightWhite: "#e5e5e5",
  };
}
