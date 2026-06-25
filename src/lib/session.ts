import { invoke } from "@tauri-apps/api/core";

export interface Session {
  rootPath: string | null;
  tabs: { path: string | null }[];
  activeId: string;
}

export async function saveSession(session: Session): Promise<void> {
  try {
    await invoke("save_session", { data: JSON.stringify(session) });
  } catch {
    // silent
  }
}

export async function loadSession(): Promise<Session | null> {
  try {
    const raw = await invoke<string | null>("load_session");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
