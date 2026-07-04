import { useEffect, useRef, useState } from "react";
import { debugController, type ScopeInfo, type VariableInfo } from "./controller";
import { useDebugState } from "./useDebug";
import { basename } from "../lib/path";

interface DebugPanelProps {
  activeFilePath: string | null;
  workspaceRoot: string | null;
  onOpenFile: (path: string, line?: number) => void;
}

const REASON_PT: Record<string, string> = {
  breakpoint: "num ponto de parada",
  step: "após um passo",
  exception: "por causa de um erro",
  entry: "no início do programa",
  pause: "a seu pedido",
  "function breakpoint": "num ponto de parada",
  goto: "após um salto",
};

export function DebugPanel({ activeFilePath, workspaceRoot, onOpenFile }: DebugPanelProps) {
  const state = useDebugState();
  const active = state.status === "starting" || state.status === "running" || state.status === "stopped";
  const stopped = state.status === "stopped";
  const fileName = activeFilePath ? basename(activeFilePath) : null;

  const start = () => debugController.start(activeFilePath, workspaceRoot);

  return (
    <div className="debug-panel">
      <div className="git-header">
        <span>Depuração</span>
        <span className={`debug-status-badge ${state.status}`}>
          {state.status === "inactive" && "pronta"}
          {state.status === "starting" && "iniciando…"}
          {state.status === "running" && "rodando"}
          {state.status === "stopped" && "pausada"}
          {state.status === "ended" && "encerrada"}
        </span>
      </div>

      {/* Toolbar */}
      {active && (
        <div className="debug-toolbar">
          {stopped ? (
            <button className="debug-btn" onClick={() => debugController.continue_()} title="Continuar (F5)">▶</button>
          ) : (
            <button className="debug-btn" onClick={() => debugController.pause()} title="Pausar" disabled={state.status !== "running"}>⏸</button>
          )}
          <button className="debug-btn" onClick={() => debugController.next()} title="Próxima linha (F10)" disabled={!stopped}>⤼</button>
          <button className="debug-btn" onClick={() => debugController.stepIn()} title="Entrar na função (F11)" disabled={!stopped}>⤓</button>
          <button className="debug-btn" onClick={() => debugController.stepOut()} title="Sair da função (Shift+F11)" disabled={!stopped}>⤒</button>
          <button className="debug-btn stop" onClick={() => debugController.stop()} title="Parar (Shift+F5)">⏹</button>
          <span className="debug-toolbar-info">
            {state.programName}
            {stopped && state.stopReason && ` — pausado ${REASON_PT[state.stopReason] ?? `(${state.stopReason})`}`}
          </span>
        </div>
      )}

      {/* Start screen */}
      {!active && (
        <div className="debug-start">
          <button className="debug-start-btn" onClick={start} disabled={!activeFilePath}>
            ▶ Depurar {fileName ?? "arquivo atual"} <span className="debug-kbd">F5</span>
          </button>
          {!activeFilePath && (
            <p className="debug-hint">Salve o arquivo antes de depurar (Ctrl+S).</p>
          )}
          <p className="debug-hint">
            Clique à esquerda do número de uma linha para criar um <b>ponto de parada</b>{" "}
            (<span className="debug-bp-dot" />). O programa pausa ali e você vê o valor de cada
            variável, linha por linha — sem precisar encher o código de <code>print</code>.
          </p>
          <p className="debug-hint">
            Funciona com Python, JavaScript (Node), Rust e C/C++ — tudo local, sem internet.
          </p>
        </div>
      )}

      {/* Exception banner */}
      {state.exception && (
        <div className="debug-exception">
          <div className="debug-exception-title">
            {state.status === "ended" ? "Não foi possível depurar" : "O programa parou com um erro"}
          </div>
          <div className="debug-exception-body">{state.exception}</div>
        </div>
      )}

      {/* Variables */}
      {stopped && state.frames.length > 0 && (
        <div className="git-section debug-section">
          <div className="git-section-title">Variáveis</div>
          {state.scopes.length === 0 && <div className="debug-empty">Nada para mostrar aqui.</div>}
          {state.scopes.map((scope) => (
            <ScopeRow
              key={`${state.frames[state.activeFrameIndex]?.id}-${scope.variablesReference}`}
              scope={scope}
              sessionKey={state.frames[state.activeFrameIndex]?.sessionKey}
            />
          ))}
        </div>
      )}

      {/* Call stack */}
      {stopped && state.frames.length > 0 && (
        <div className="git-section debug-section">
          <div className="git-section-title">Pilha de chamadas</div>
          {state.frames.map((f, i) => (
            <div
              key={`${f.sessionKey}-${f.id}`}
              className={`debug-frame ${i === state.activeFrameIndex ? "active" : ""}`}
              onClick={() => {
                debugController.selectFrame(i);
                if (f.path) onOpenFile(f.path, f.line);
              }}
              title={f.path ?? undefined}
            >
              <span className="debug-frame-name">{f.name}</span>
              {f.path && (
                <span className="debug-frame-loc">{basename(f.path)}:{f.line}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Breakpoints */}
      {Object.keys(state.breakpoints).length > 0 && (
        <div className="git-section debug-section">
          <div className="git-section-title">Pontos de parada</div>
          {Object.entries(state.breakpoints).flatMap(([path, lines]) =>
            lines.map((line) => (
              <div key={`${path}:${line}`} className="debug-frame" onClick={() => onOpenFile(path, line)}>
                <span className="debug-bp-dot" />
                <span className="debug-frame-name">{basename(path)}</span>
                <span className="debug-frame-loc">linha {line}</span>
                <button
                  className="debug-bp-remove"
                  title="Remover ponto de parada"
                  onClick={(e) => { e.stopPropagation(); debugController.removeBreakpoint(path, line); }}
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* Console */}
      {(active || state.status === "ended") && (
        <DebugConsole
          lines={state.console}
          canEvaluate={stopped}
          onEvaluate={(expr) => debugController.evaluate(expr)}
          onClearEnded={state.status === "ended" ? () => debugController.reset() : undefined}
        />
      )}
    </div>
  );
}

// ---- Variables tree ----

function ScopeRow({ scope, sessionKey }: { scope: ScopeInfo; sessionKey?: string }) {
  const [open, setOpen] = useState(!scope.expensive);
  return (
    <div className="debug-scope">
      <div className="debug-scope-name" onClick={() => setOpen((v) => !v)}>
        <span className="debug-twisty">{open ? "▾" : "▸"}</span> {translateScope(scope.name)}
      </div>
      {open && sessionKey && (
        <VariableList sessionKey={sessionKey} variablesReference={scope.variablesReference} depth={0} />
      )}
    </div>
  );
}

function VariableList({ sessionKey, variablesReference, depth }: {
  sessionKey: string;
  variablesReference: number;
  depth: number;
}) {
  const [vars, setVars] = useState<VariableInfo[] | null>(null);
  useEffect(() => {
    let alive = true;
    debugController.getVariables(sessionKey, variablesReference).then((v) => {
      if (alive) setVars(v);
    });
    return () => { alive = false; };
  }, [sessionKey, variablesReference]);

  if (vars === null) return <div className="debug-empty" style={{ paddingLeft: 12 + depth * 12 }}>carregando…</div>;
  if (vars.length === 0) return <div className="debug-empty" style={{ paddingLeft: 12 + depth * 12 }}>vazio</div>;
  return (
    <>
      {vars.map((v, i) => (
        <VariableRow key={`${i}-${v.name}`} v={v} sessionKey={sessionKey} depth={depth} />
      ))}
    </>
  );
}

function VariableRow({ v, sessionKey, depth }: { v: VariableInfo; sessionKey: string; depth: number }) {
  const [open, setOpen] = useState(false);
  const expandable = v.variablesReference > 0;
  return (
    <>
      <div
        className="debug-var"
        style={{ paddingLeft: 12 + depth * 12 }}
        onClick={() => expandable && setOpen((o) => !o)}
        title={v.type ? `${v.name}: ${v.type}` : v.name}
      >
        <span className="debug-twisty">{expandable ? (open ? "▾" : "▸") : "·"}</span>
        <span className="debug-var-name">{v.name}</span>
        <span className="debug-var-value">{v.value}</span>
      </div>
      {open && (
        <VariableList sessionKey={sessionKey} variablesReference={v.variablesReference} depth={depth + 1} />
      )}
    </>
  );
}

function translateScope(name: string): string {
  const n = name.toLowerCase();
  if (n.startsWith("local")) return "Variáveis locais";
  if (n.startsWith("global")) return "Variáveis globais";
  if (n.startsWith("closure")) return "Variáveis do contexto";
  if (n.startsWith("registers")) return "Registradores";
  if (n.startsWith("static")) return "Estáticas";
  return name;
}

// ---- Console ----

function DebugConsole({ lines, canEvaluate, onEvaluate, onClearEnded }: {
  lines: { kind: string; text: string }[];
  canEvaluate: boolean;
  onEvaluate: (expr: string) => void;
  onClearEnded?: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [expr, setExpr] = useState("");

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  return (
    <div className="debug-console">
      <div className="git-section-title" style={{ padding: "8px 12px 0" }}>
        Console
        {onClearEnded && (
          <button className="debug-bp-remove" style={{ float: "right" }} title="Limpar e fechar" onClick={onClearEnded}>✕</button>
        )}
      </div>
      <div className="debug-console-body" ref={bodyRef}>
        {lines.map((l, i) => (
          <div key={i} className={`debug-console-line ${l.kind}`}>{l.text}</div>
        ))}
        {lines.length === 0 && <div className="debug-empty">A saída do programa aparece aqui.</div>}
      </div>
      {canEvaluate && (
        <form
          className="debug-console-input"
          onSubmit={(e) => {
            e.preventDefault();
            if (!expr.trim()) return;
            onEvaluate(expr.trim());
            setExpr("");
          }}
        >
          <input
            value={expr}
            onChange={(e) => setExpr(e.target.value)}
            placeholder="Avaliar expressão (ex.: nome_da_variavel)"
            spellCheck={false}
          />
        </form>
      )}
    </div>
  );
}
