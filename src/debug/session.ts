import {
  dapKill,
  dapRequest,
  dapRespond,
  onDapExit,
  onDapMessage,
  type DapStartInfo,
} from "../lib/debug";

/** One wire connection to a debug adapter (root or child session). */
export interface DapConnectionHandlers {
  onEvent: (event: string, body: any) => void;
  /** Reverse request from the adapter. Must eventually call respond(). */
  onReverseRequest: (command: string, args: any, requestSeq: number) => void;
  /** The wire went away (adapter died or disconnected). */
  onExit: () => void;
}

export class DapConnection {
  readonly sessionId: string;
  readonly port: number | null;
  capabilities: any = {};
  private unsubs: (() => void)[] = [];
  private dead = false;

  constructor(info: DapStartInfo, handlers: DapConnectionHandlers) {
    this.sessionId = info.session_id;
    this.port = info.port;
    this.unsubs.push(
      onDapMessage(this.sessionId, (msg) => {
        if (msg?.type === "event") handlers.onEvent(msg.event, msg.body ?? {});
        else if (msg?.type === "request") handlers.onReverseRequest(msg.command, msg.arguments ?? {}, msg.seq);
      }),
      onDapExit(this.sessionId, () => {
        if (this.dead) return;
        this.dead = true;
        handlers.onExit();
      })
    );
  }

  /** Send a request; resolves with the response `body`, rejects on failure. */
  async request(command: string, args?: unknown, timeoutMs?: number): Promise<any> {
    const resp = await dapRequest(this.sessionId, command, args, timeoutMs);
    if (resp?.success === false) {
      throw new Error(resp?.message || `Falha no comando '${command}'`);
    }
    return resp?.body ?? {};
  }

  respond(requestSeq: number, command: string, success: boolean, body?: unknown): Promise<void> {
    return dapRespond(this.sessionId, requestSeq, command, success, body);
  }

  async dispose(): Promise<void> {
    this.dead = true;
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    await dapKill(this.sessionId).catch(() => {});
  }
}

/** Standard initialize arguments for LocalCode as a DAP client. */
export function initializeArgs(adapterId: string): Record<string, unknown> {
  return {
    clientID: "localcode",
    clientName: "LocalCode",
    adapterID: adapterId,
    locale: "pt-BR",
    linesStartAt1: true,
    columnsStartAt1: true,
    pathFormat: "path",
    supportsRunInTerminalRequest: true,
    supportsStartDebuggingRequest: true,
    supportsVariableType: true,
    supportsProgressReporting: false,
    supportsMemoryEvent: false,
  };
}
