import { invoke } from "@tauri-apps/api/core";
import { dapConnect, dapStart } from "../lib/debug";
import { readFile } from "../lib/fs";
import { basename, dirname } from "../lib/path";
import { DapConnection, initializeArgs } from "./session";

// ---------------------------------------------------------------------------
// Debug controller — a module singleton that owns the debug session(s) and
// exposes an observable state for the UI (DebugPanel, App, MonacoWrapper).
// It lives outside React so a session survives the panel being closed and
// keyboard shortcuts can drive it from anywhere.
// ---------------------------------------------------------------------------

export type DebugStatus = "inactive" | "starting" | "running" | "stopped" | "ended";

export interface StackFrameInfo {
  id: number;
  name: string;
  path: string | null;
  line: number;
  sessionKey: string;
}

export interface ScopeInfo {
  name: string;
  variablesReference: number;
  expensive: boolean;
}

export interface VariableInfo {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
}

export interface ConsoleLine {
  kind: "stdout" | "stderr" | "info" | "error" | "input" | "result";
  text: string;
}

export interface DebugState {
  status: DebugStatus;
  adapter: string | null;
  programName: string | null;
  stopReason: string | null;
  /** Plain-language explanation shown in the exception banner. */
  exception: string | null;
  frames: StackFrameInfo[];
  activeFrameIndex: number;
  scopes: ScopeInfo[];
  console: ConsoleLine[];
  /** Where execution is paused (drives the editor highlight). */
  stopped: { path: string; line: number } | null;
  /** Breakpoints per absolute file path (1-based lines). */
  breakpoints: Record<string, number[]>;
}

export interface RunInTerminalRequest {
  argv: string[];
  cwd: string | null;
  env: Record<string, string> | null;
  title: string | null;
}

const MAX_CONSOLE_LINES = 2000;

interface SessionEntry {
  conn: DapConnection;
  configurationDone: boolean;
  threads: Set<number>;
}

const initialState = (): DebugState => ({
  status: "inactive",
  adapter: null,
  programName: null,
  stopReason: null,
  exception: null,
  frames: [],
  activeFrameIndex: 0,
  scopes: [],
  console: [],
  stopped: null,
  breakpoints: {},
});

class DebugController {
  private state: DebugState = initialState();
  private listeners = new Set<() => void>();

  private sessions = new Map<string, SessionEntry>();
  private rootKey: string | null = null;
  private rootPort: number | null = null;
  /** Session/thread that produced the last `stopped` event. */
  private stoppedAt: { key: string; threadId: number } | null = null;
  private runInTerminalHandler: ((req: RunInTerminalRequest) => Promise<void>) | null = null;

  // ---- store API (React: useSyncExternalStore) ----
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getState = (): DebugState => this.state;

  private set(patch: Partial<DebugState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  private log(kind: ConsoleLine["kind"], text: string) {
    if (!text) return;
    const lines = [...this.state.console, { kind, text }];
    this.set({ console: lines.slice(-MAX_CONSOLE_LINES) });
  }

  /** App installs the hook that opens integrated terminals (runInTerminal). */
  setRunInTerminalHandler(fn: (req: RunInTerminalRequest) => Promise<void>) {
    this.runInTerminalHandler = fn;
  }

  get active(): boolean {
    return this.state.status === "starting" || this.state.status === "running" || this.state.status === "stopped";
  }

  // ---- breakpoints ----
  toggleBreakpoint(path: string, line: number) {
    const bps = { ...this.state.breakpoints };
    const lines = new Set(bps[path] ?? []);
    if (lines.has(line)) lines.delete(line);
    else lines.add(line);
    if (lines.size === 0) delete bps[path];
    else bps[path] = [...lines].sort((a, b) => a - b);
    this.set({ breakpoints: bps });
    this.pushBreakpoints(path).catch(() => {});
  }

  removeBreakpoint(path: string, line: number) {
    if (this.state.breakpoints[path]?.includes(line)) this.toggleBreakpoint(path, line);
  }

  private async pushBreakpoints(path: string, only?: SessionEntry) {
    const lines = this.state.breakpoints[path] ?? [];
    const targets = only ? [only] : [...this.sessions.values()];
    await Promise.all(
      targets
        .filter((s) => s.configurationDone)
        .map((s) =>
          s.conn
            .request("setBreakpoints", {
              source: { path, name: basename(path) },
              breakpoints: lines.map((line) => ({ line })),
            })
            .catch(() => {})
        )
    );
  }

  private async pushAllBreakpoints(entry: SessionEntry) {
    for (const path of Object.keys(this.state.breakpoints)) {
      const lines = this.state.breakpoints[path];
      await entry.conn
        .request("setBreakpoints", {
          source: { path, name: basename(path) },
          breakpoints: lines.map((line) => ({ line })),
        })
        .catch(() => {});
    }
  }

  // ---- session lifecycle ----
  async start(filePath: string | null, workspaceRoot: string | null): Promise<void> {
    if (this.active) return;
    this.state = { ...initialState(), breakpoints: this.state.breakpoints };
    this.set({ status: "starting" });

    let plan: LaunchPlan;
    try {
      if (!filePath) throw new Error("Salve o arquivo antes de depurar (Ctrl+S).");
      plan = await inferLaunch(filePath, workspaceRoot, (line) => this.log("info", line));
    } catch (e) {
      this.fail(String((e as Error).message ?? e));
      return;
    }

    this.set({ programName: plan.programName });
    this.log("info", `Iniciando depuração de ${plan.programName}…`);

    try {
      const info = await dapStart(plan.language);
      this.rootPort = info.port;
      const key = info.session_id;
      const conn = this.makeConnection(info, key);
      this.rootKey = key;
      const entry: SessionEntry = { conn, configurationDone: false, threads: new Set() };
      this.sessions.set(key, entry);
      this.set({ adapter: info.adapter });

      conn.capabilities = await conn.request("initialize", initializeArgs(plan.language), 15000);

      // The adapter answers `launch` only after configurationDone, which we
      // send when the `initialized` event arrives — so don't await in order.
      await conn.request(plan.config.request === "attach" ? "attach" : "launch", plan.config, 90000);
      if (this.state.status === "starting") this.set({ status: "running" });
    } catch (e) {
      let msg = String((e as Error).message ?? e);
      if (plan.language === "python") {
        msg += " — Se o debugpy não estiver instalado, rode: pip install debugpy";
      }
      this.fail(msg);
      await this.disposeAll();
    }
  }

  private makeConnection(info: { session_id: string; port: number | null }, key: string): DapConnection {
    return new DapConnection(info as any, {
      onEvent: (event, body) => this.onEvent(key, event, body),
      onReverseRequest: (command, args, seq) => this.onReverseRequest(key, command, args, seq),
      onExit: () => this.onWireExit(key),
    });
  }

  async stop(): Promise<void> {
    const root = this.rootKey ? this.sessions.get(this.rootKey) : null;
    if (root) {
      try {
        await root.conn.request("disconnect", { terminateDebuggee: true }, 5000);
      } catch {
        /* adapter may already be gone */
      }
    }
    await this.endSession("Depuração encerrada.");
  }

  private fail(message: string) {
    this.log("error", message);
    this.set({ status: "ended", exception: message, stopped: null });
  }

  private async disposeAll() {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    this.rootKey = null;
    this.rootPort = null;
    this.stoppedAt = null;
    await Promise.all(all.map((s) => s.conn.dispose()));
  }

  private async endSession(message: string | null) {
    if (this.state.status === "ended" || this.state.status === "inactive") {
      await this.disposeAll();
      return;
    }
    if (message) this.log("info", message);
    this.set({ status: "ended", stopped: null, frames: [], scopes: [] });
    await this.disposeAll();
  }

  /** Clear an ended session from the panel. */
  reset() {
    if (this.active) return;
    this.state = { ...initialState(), breakpoints: this.state.breakpoints };
    this.listeners.forEach((fn) => fn());
  }

  // ---- stepping ----
  private async step(command: "continue" | "next" | "stepIn" | "stepOut") {
    const at = this.stoppedAt;
    if (!at) return;
    const session = this.sessions.get(at.key);
    if (!session) return;
    try {
      await session.conn.request(command, { threadId: at.threadId });
      this.stoppedAt = null;
      this.set({ status: "running", stopped: null, frames: [], scopes: [], stopReason: null, exception: null });
    } catch (e) {
      this.log("error", String((e as Error).message ?? e));
    }
  }

  continue_() { this.step("continue"); }
  next() { this.step("next"); }
  stepIn() { this.step("stepIn"); }
  stepOut() { this.step("stepOut"); }

  async pause(): Promise<void> {
    // Pause the first session that has a live thread.
    for (const session of this.sessions.values()) {
      const threadId = [...session.threads][0];
      if (threadId == null) continue;
      await session.conn.request("pause", { threadId }).catch(() => {});
      return;
    }
  }

  // ---- inspection ----
  async getVariables(sessionKey: string, variablesReference: number): Promise<VariableInfo[]> {
    const session = this.sessions.get(sessionKey);
    if (!session) return [];
    try {
      const body = await session.conn.request("variables", { variablesReference });
      return (body.variables ?? []).map((v: any) => ({
        name: v.name,
        value: v.value,
        type: v.type ?? undefined,
        variablesReference: v.variablesReference ?? 0,
      }));
    } catch {
      return [];
    }
  }

  async selectFrame(index: number): Promise<void> {
    const frame = this.state.frames[index];
    if (!frame) return;
    const session = this.sessions.get(frame.sessionKey);
    if (!session) return;
    let scopes: ScopeInfo[] = [];
    try {
      const body = await session.conn.request("scopes", { frameId: frame.id });
      scopes = (body.scopes ?? []).map((s: any) => ({
        name: s.name,
        variablesReference: s.variablesReference,
        expensive: !!s.expensive,
      }));
    } catch {
      /* keep empty */
    }
    this.set({
      activeFrameIndex: index,
      scopes,
      stopped: frame.path ? { path: frame.path, line: frame.line } : this.state.stopped,
    });
  }

  async evaluate(expression: string): Promise<void> {
    this.log("input", `> ${expression}`);
    const frame = this.state.frames[this.state.activeFrameIndex];
    const at = this.stoppedAt;
    const session = frame
      ? this.sessions.get(frame.sessionKey)
      : at
        ? this.sessions.get(at.key)
        : null;
    if (!session) {
      this.log("error", "Só é possível avaliar expressões com o programa pausado.");
      return;
    }
    try {
      const body = await session.conn.request("evaluate", {
        expression,
        frameId: frame?.id,
        context: "repl",
      });
      this.log("result", body.result ?? "");
    } catch (e) {
      this.log("error", String((e as Error).message ?? e));
    }
  }

  // ---- adapter events ----
  private async onEvent(key: string, event: string, body: any) {
    const session = this.sessions.get(key);
    if (!session) return;
    switch (event) {
      case "initialized": {
        await this.pushAllBreakpoints(session);
        await this.configureExceptionBreakpoints(session);
        if (session.conn.capabilities?.supportsConfigurationDoneRequest !== false) {
          await session.conn.request("configurationDone", {}).catch(() => {});
        }
        session.configurationDone = true;
        break;
      }
      case "stopped":
        await this.onStopped(key, session, body);
        break;
      case "continued":
        if (this.stoppedAt?.key === key) {
          this.stoppedAt = null;
          this.set({ status: "running", stopped: null, frames: [], scopes: [], stopReason: null });
        }
        break;
      case "output": {
        const category = body.category ?? "console";
        if (category === "telemetry") break;
        const kind = category === "stderr" ? "stderr" : category === "important" ? "error" : "stdout";
        this.log(kind, String(body.output ?? "").replace(/\n$/, ""));
        break;
      }
      case "thread":
        if (body.reason === "started") session.threads.add(body.threadId);
        else if (body.reason === "exited") session.threads.delete(body.threadId);
        break;
      case "terminated":
      case "exited":
        if (key === this.rootKey) {
          await this.endSession(
            event === "exited" && body?.exitCode != null
              ? `O programa terminou (código de saída ${body.exitCode}).`
              : "O programa terminou."
          );
        } else {
          const child = this.sessions.get(key);
          this.sessions.delete(key);
          await child?.conn.dispose();
        }
        break;
      default:
        break;
    }
  }

  private async configureExceptionBreakpoints(session: SessionEntry) {
    const filters: any[] = session.conn.capabilities?.exceptionBreakpointFilters ?? [];
    if (filters.length === 0) return;
    // Beginner-sane default: stop on uncaught/unhandled exceptions, plus
    // whatever the adapter marks as default.
    const chosen = filters
      .filter((f) => f.default || /uncaught|unhandled|userUnhandled/i.test(f.filter))
      .map((f) => f.filter);
    if (chosen.length === 0) return;
    await session.conn.request("setExceptionBreakpoints", { filters: chosen }).catch(() => {});
  }

  private async onStopped(key: string, session: SessionEntry, body: any) {
    const threadId: number = body.threadId ?? [...session.threads][0] ?? 1;
    session.threads.add(threadId);
    this.stoppedAt = { key, threadId };

    let frames: StackFrameInfo[] = [];
    try {
      const st = await session.conn.request("stackTrace", { threadId, startFrame: 0, levels: 20 });
      frames = (st.stackFrames ?? []).map((f: any) => ({
        id: f.id,
        name: f.name,
        path: f.source?.path ?? null,
        line: f.line ?? 1,
        sessionKey: key,
      }));
    } catch {
      /* keep empty */
    }

    let exception: string | null = null;
    if (body.reason === "exception") {
      exception = body.description || body.text || "O programa parou por causa de um erro.";
      if (session.conn.capabilities?.supportsExceptionInfoRequest) {
        try {
          const info = await session.conn.request("exceptionInfo", { threadId });
          const detail = info?.details?.message || info?.description;
          if (detail) exception = detail;
        } catch {
          /* keep the event text */
        }
      }
    }

    const firstWithPath = frames.find((f) => f.path);
    this.set({
      status: "stopped",
      stopReason: body.reason ?? null,
      exception,
      frames,
      activeFrameIndex: 0,
      stopped: firstWithPath ? { path: firstWithPath.path!, line: firstWithPath.line } : null,
    });
    if (frames.length > 0) await this.selectFrame(frames.indexOf(firstWithPath ?? frames[0]));
  }

  // ---- reverse requests ----
  private async onReverseRequest(key: string, command: string, args: any, seq: number) {
    const session = this.sessions.get(key);
    if (!session) return;
    if (command === "runInTerminal") {
      try {
        const argv: string[] = args.args ?? [];
        if (argv.length === 0) throw new Error("runInTerminal sem comando");
        if (!this.runInTerminalHandler) throw new Error("terminal indisponível");
        await this.runInTerminalHandler({
          argv,
          cwd: args.cwd ?? null,
          env: args.env ?? null,
          title: args.title ?? null,
        });
        await session.conn.respond(seq, command, true, {});
      } catch (e) {
        await session.conn.respond(seq, command, false, { error: { format: String(e) } });
      }
      return;
    }
    if (command === "startDebugging") {
      // Multi-session adapters (js-debug, debugpy subprocesses): open another
      // wire to the same adapter and run the child config on it.
      try {
        await session.conn.respond(seq, command, true, {});
        await this.startChildSession(args);
      } catch (e) {
        this.log("error", `Falha ao iniciar sessão filha: ${String(e)}`);
      }
      return;
    }
    // Unknown reverse request: refuse politely so the adapter doesn't hang.
    await session.conn.respond(seq, command, false, {});
  }

  private async startChildSession(args: any) {
    if (this.rootPort == null) throw new Error("adaptador sem porta TCP");
    const info = await dapConnect(this.rootPort);
    const key = info.session_id;
    const conn = this.makeConnection(info, key);
    const entry: SessionEntry = { conn, configurationDone: false, threads: new Set() };
    this.sessions.set(key, entry);
    conn.capabilities = await conn.request("initialize", initializeArgs(String(args.configuration?.type ?? "pwa-node")), 15000);
    const request = args.request === "attach" ? "attach" : "launch";
    await conn.request(request, args.configuration ?? {}, 90000);
  }

  private onWireExit(key: string) {
    const wasRoot = key === this.rootKey;
    this.sessions.delete(key);
    if (wasRoot) {
      this.endSession("A sessão de depuração terminou.").catch(() => {});
    }
  }
}

export const debugController = new DebugController();

// ---------------------------------------------------------------------------
// Zero-config launch inference: F5 on the current file just works.
// ---------------------------------------------------------------------------

interface LaunchPlan {
  language: string;
  programName: string;
  config: Record<string, any>;
}

const isWindows = navigator.userAgent.includes("Windows");

async function runBuildCommand(cwd: string, command: string): Promise<string> {
  const cd = isWindows ? `cd /d "${cwd}"` : `cd "${cwd}"`;
  return invoke<string>("execute_terminal_command", { command: `${cd} && ${command}` });
}

export async function inferLaunch(
  filePath: string,
  workspaceRoot: string | null,
  log: (line: string) => void
): Promise<LaunchPlan> {
  const name = basename(filePath);
  const ext = (name.split(".").pop() || "").toLowerCase();
  const cwd = dirname(filePath);

  if (ext === "py") {
    return {
      language: "python",
      programName: name,
      config: {
        name: `Depurar ${name}`,
        type: "python",
        request: "launch",
        program: filePath,
        cwd,
        console: "integratedTerminal",
        justMyCode: true,
      },
    };
  }

  if (ext === "js" || ext === "mjs" || ext === "cjs") {
    return {
      language: "javascript",
      programName: name,
      config: {
        name: `Depurar ${name}`,
        type: "pwa-node",
        request: "launch",
        program: filePath,
        cwd,
        console: "integratedTerminal",
      },
    };
  }

  if (ext === "ts" || ext === "tsx" || ext === "jsx") {
    throw new Error(
      "Depuração direta de TypeScript/JSX ainda não é suportada. Compile para .js e depure o arquivo gerado."
    );
  }

  if (ext === "rs") {
    const cargoDir = await findUp(cwd, "Cargo.toml", workspaceRoot);
    if (!cargoDir) {
      throw new Error("Nenhum Cargo.toml encontrado. Depuração de Rust requer um projeto Cargo.");
    }
    const manifest = await readFile(joinNative(cargoDir, "Cargo.toml"));
    const pkgName = /\[package\][\s\S]*?name\s*=\s*"([^"]+)"/.exec(manifest)?.[1];
    if (!pkgName) throw new Error("Não foi possível ler o nome do pacote no Cargo.toml.");
    log("Compilando com cargo build…");
    try {
      await runBuildCommand(cargoDir, "cargo build");
    } catch (e) {
      log(String(e));
      throw new Error("A compilação falhou. Corrija os erros acima e tente de novo.");
    }
    const program = joinNative(cargoDir, "target", "debug", pkgName + (isWindows ? ".exe" : ""));
    return {
      language: "rust",
      programName: pkgName,
      config: {
        name: `Depurar ${pkgName}`,
        type: "lldb",
        request: "launch",
        program,
        cwd: cargoDir,
        terminal: "console",
      },
    };
  }

  if (ext === "c" || ext === "cpp" || ext === "cc" || ext === "cxx") {
    const isCpp = ext !== "c";
    const stem = name.replace(/\.[^.]+$/, "");
    const out = joinNative(cwd, `${stem}-debug${isWindows ? ".exe" : ""}`);
    const compilers = isCpp ? ["g++", "clang++"] : ["gcc", "clang"];
    let compiled = false;
    let lastError = "";
    for (const cc of compilers) {
      log(`Compilando com ${cc}…`);
      try {
        await runBuildCommand(cwd, `${cc} -g -O0 "${filePath}" -o "${out}"`);
        compiled = true;
        break;
      } catch (e) {
        lastError = String(e);
      }
    }
    if (!compiled) {
      log(lastError);
      throw new Error(
        "Não foi possível compilar. Instale um compilador C/C++ (gcc ou clang) ou corrija os erros acima."
      );
    }
    return {
      language: isCpp ? "cpp" : "c",
      programName: name,
      config: {
        name: `Depurar ${name}`,
        type: "lldb",
        request: "launch",
        program: out,
        cwd,
        terminal: "console",
      },
    };
  }

  throw new Error(
    `Não sei depurar arquivos .${ext}. Linguagens suportadas: Python, JavaScript (Node), Rust e C/C++.`
  );
}

/** Join with the platform separator (paths given to adapters must be native). */
function joinNative(...parts: string[]): string {
  const sep = isWindows ? "\\" : "/";
  return parts
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, "")))
    .join(sep);
}

/** Walk up from `startDir` looking for `fileName`; stop at workspaceRoot (inclusive). */
async function findUp(startDir: string, fileName: string, workspaceRoot: string | null): Promise<string | null> {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    try {
      await readFile(joinNative(dir, fileName));
      return dir;
    } catch {
      /* not here */
    }
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
    if (workspaceRoot && norm(dir) === norm(workspaceRoot)) break;
    const parent = dirname(dir);
    if (!parent || parent === dir || parent === ".") break;
    dir = parent;
  }
  return null;
}
