import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface DapStartInfo {
  session_id: string;
  adapter: string;
  port: number | null;
}

export interface DebugAdapterStatus {
  language: string;
  bundled: boolean;
}

interface DapMessagePayload {
  session_id: string;
  message: any;
}

interface DapExitPayload {
  session_id: string;
}

export async function dapStart(language: string): Promise<DapStartInfo> {
  return invoke<DapStartInfo>("dap_start", { language });
}

export async function dapConnect(port: number): Promise<DapStartInfo> {
  return invoke<DapStartInfo>("dap_connect", { port });
}

/** Send a DAP request; resolves with the full response message. */
export async function dapRequest(
  sessionId: string,
  command: string,
  args?: unknown,
  timeoutMs?: number
): Promise<any> {
  return invoke<any>("dap_request", {
    sessionId,
    command,
    arguments: args ?? null,
    timeoutMs: timeoutMs ?? null,
  });
}

/** Answer a reverse request (adapter → client). */
export async function dapRespond(
  sessionId: string,
  requestSeq: number,
  command: string,
  success: boolean,
  body?: unknown
): Promise<void> {
  await invoke("dap_respond", { sessionId, requestSeq, command, success, body: body ?? null });
}

export async function dapKill(sessionId: string): Promise<void> {
  await invoke("dap_kill", { sessionId });
}

export async function checkDebugAdapters(): Promise<DebugAdapterStatus[]> {
  return invoke<DebugAdapterStatus[]>("check_debug_adapters");
}

/** Subscribe to events / reverse requests for one wire session. */
export function onDapMessage(sessionId: string, callback: (message: any) => void): () => void {
  let unlisten: (() => void) | undefined;
  let disposed = false;
  listen<DapMessagePayload>("dap-message", (event) => {
    if (event.payload.session_id === sessionId) callback(event.payload.message);
  }).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });
  return () => { disposed = true; unlisten?.(); };
}

/** Subscribe to the wire-closed event for one session. */
export function onDapExit(sessionId: string, callback: () => void): () => void {
  let unlisten: (() => void) | undefined;
  let disposed = false;
  listen<DapExitPayload>("dap-exit", (event) => {
    if (event.payload.session_id === sessionId) callback();
  }).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });
  return () => { disposed = true; unlisten?.(); };
}
