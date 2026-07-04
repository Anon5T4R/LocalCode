import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface TerminalOutput {
  session_id: string;
  data: string;
}

export interface TerminalExit {
  session_id: string;
}

export async function spawnTerminal(
  cwd?: string | null,
  shell?: string | null,
  args?: string[] | null,
  env?: Record<string, string> | null
): Promise<string> {
  return invoke<string>("terminal_spawn", {
    cwd: cwd ?? null,
    shell: shell ?? null,
    args: args ?? null,
    env: env ?? null,
  });
}

export async function writeTerminal(sessionId: string, data: string): Promise<void> {
  await invoke("terminal_write", { sessionId, data });
}

export async function resizeTerminal(sessionId: string, rows: number, cols: number): Promise<void> {
  await invoke("terminal_resize", { sessionId, rows, cols });
}

export async function killTerminal(sessionId: string): Promise<void> {
  await invoke("terminal_kill", { sessionId });
}

/** Subscribe to output for a specific terminal session. */
export function onTerminalOutput(sessionId: string, callback: (data: string) => void): () => void {
  let unlisten: (() => void) | undefined;
  listen<TerminalOutput>("terminal-output", (event) => {
    if (event.payload.session_id === sessionId) callback(event.payload.data);
  }).then((fn) => { unlisten = fn; });
  return () => { unlisten?.(); };
}

/** Subscribe to the exit event for a specific terminal session. */
export function onTerminalExit(sessionId: string, callback: () => void): () => void {
  let unlisten: (() => void) | undefined;
  listen<TerminalExit>("terminal-exit", (event) => {
    if (event.payload.session_id === sessionId) callback();
  }).then((fn) => { unlisten = fn; });
  return () => { unlisten?.(); };
}
