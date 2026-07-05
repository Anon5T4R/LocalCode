import { useEffect, useRef, useState } from "react";
import { debugController, type ScopeInfo, type VariableInfo } from "./controller";
import { useDebugState } from "./useDebug";
import { basename } from "../lib/path";
import { t, type MessageKey } from "../lib/i18n";

interface DebugPanelProps {
  activeFilePath: string | null;
  workspaceRoot: string | null;
  onOpenFile: (path: string, line?: number) => void;
}

const REASON_KEYS: Record<string, MessageKey> = {
  breakpoint: "debug.reason.breakpoint",
  step: "debug.reason.step",
  exception: "debug.reason.exception",
  entry: "debug.reason.entry",
  pause: "debug.reason.pause",
  "function breakpoint": "debug.reason.breakpoint",
  goto: "debug.reason.goto",
};

export function DebugPanel({ activeFilePath, workspaceRoot, onOpenFile }: DebugPanelProps) {
  const state = useDebugState();
  const active = state.status === "starting" || state.status === "running" || state.status === "stopped";
  const stopped = state.status === "stopped";
  const fileName = activeFilePath ? basename(activeFilePath) : null;

  const start = () => debugController.start(activeFilePath, workspaceRoot);

  const stopReasonText = (reason: string) => {
    const key = REASON_KEYS[reason];
    return key ? t(key) : `(${reason})`;
  };

  return (
    <div className="debug-panel">
      <div className="git-header">
        <span>{t("debug.title")}</span>
        <span className={`debug-status-badge ${state.status}`}>
          {state.status === "inactive" && t("debug.badge.inactive")}
          {state.status === "starting" && t("debug.badge.starting")}
          {state.status === "running" && t("debug.badge.running")}
          {state.status === "stopped" && t("debug.badge.stopped")}
          {state.status === "ended" && t("debug.badge.ended")}
        </span>
      </div>

      {/* Toolbar */}
      {active && (
        <div className="debug-toolbar">
          {stopped ? (
            <button className="debug-btn" onClick={() => debugController.continue_()} title={t("debug.continue")}>▶</button>
          ) : (
            <button className="debug-btn" onClick={() => debugController.pause()} title={t("debug.pause")} disabled={state.status !== "running"}>⏸</button>
          )}
          <button className="debug-btn" onClick={() => debugController.next()} title={t("debug.next")} disabled={!stopped}>⤼</button>
          <button className="debug-btn" onClick={() => debugController.stepIn()} title={t("debug.stepIn")} disabled={!stopped}>⤓</button>
          <button className="debug-btn" onClick={() => debugController.stepOut()} title={t("debug.stepOut")} disabled={!stopped}>⤒</button>
          <button className="debug-btn stop" onClick={() => debugController.stop()} title={t("debug.stop")}>⏹</button>
          <span className="debug-toolbar-info">
            {state.programName}
            {stopped && state.stopReason && ` — ${t("debug.pausedAt", { reason: stopReasonText(state.stopReason) })}`}
          </span>
        </div>
      )}

      {/* Start screen */}
      {!active && (
        <div className="debug-start">
          <button className="debug-start-btn" onClick={start} disabled={!activeFilePath}>
            ▶ {t("debug.startBtn", { name: fileName ?? t("debug.currentFile") })} <span className="debug-kbd">F5</span>
          </button>
          {!activeFilePath && (
            <p className="debug-hint">{t("debug.saveFirst")}</p>
          )}
          <p className="debug-hint">{t("debug.hintBreakpoint")}</p>
          <p className="debug-hint">{t("debug.hintLangs")}</p>
        </div>
      )}

      {/* Exception banner */}
      {state.exception && (
        <div className="debug-exception">
          <div className="debug-exception-title">
            {state.status === "ended" ? t("debug.cantDebug") : t("debug.programError")}
          </div>
          <div className="debug-exception-body">{state.exception}</div>
        </div>
      )}

      {/* Variables */}
      {stopped && state.frames.length > 0 && (
        <div className="git-section debug-section">
          <div className="git-section-title">{t("debug.variables")}</div>
          {state.scopes.length === 0 && <div className="debug-empty">{t("debug.nothingHere")}</div>}
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
          <div className="git-section-title">{t("debug.callStack")}</div>
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
          <div className="git-section-title">{t("debug.breakpoints")}</div>
          {Object.entries(state.breakpoints).flatMap(([path, lines]) =>
            lines.map((line) => (
              <div key={`${path}:${line}`} className="debug-frame" onClick={() => onOpenFile(path, line)}>
                <span className="debug-bp-dot" />
                <span className="debug-frame-name">{basename(path)}</span>
                <span className="debug-frame-loc">{t("debug.line", { n: line })}</span>
                <button
                  className="debug-bp-remove"
                  title={t("debug.removeBreakpoint")}
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

  if (vars === null) return <div className="debug-empty" style={{ paddingLeft: 12 + depth * 12 }}>{t("debug.loading")}</div>;
  if (vars.length === 0) return <div className="debug-empty" style={{ paddingLeft: 12 + depth * 12 }}>{t("common.empty")}</div>;
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
  if (n.startsWith("local")) return t("debug.scope.locals");
  if (n.startsWith("global")) return t("debug.scope.globals");
  if (n.startsWith("closure")) return t("debug.scope.closure");
  if (n.startsWith("registers")) return t("debug.scope.registers");
  if (n.startsWith("static")) return t("debug.scope.statics");
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
        {t("debug.console")}
        {onClearEnded && (
          <button className="debug-bp-remove" style={{ float: "right" }} title={t("debug.clearClose")} onClick={onClearEnded}>✕</button>
        )}
      </div>
      <div className="debug-console-body" ref={bodyRef}>
        {lines.map((l, i) => (
          <div key={i} className={`debug-console-line ${l.kind}`}>{l.text}</div>
        ))}
        {lines.length === 0 && <div className="debug-empty">{t("debug.outputHere")}</div>}
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
            placeholder={t("debug.evalPlaceholder")}
            spellCheck={false}
          />
        </form>
      )}
    </div>
  );
}
