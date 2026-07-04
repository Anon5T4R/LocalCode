import { useSyncExternalStore } from "react";

// Tiny external store for the caret position. The cursor moves on every
// keystroke; keeping it out of App's state means typing doesn't re-render
// the whole tree — only the small components that subscribe here.

export interface CursorPos {
  line: number;
  col: number;
}

let pos: CursorPos = { line: 1, col: 1 };
const listeners = new Set<() => void>();

export const cursorStore = {
  get: (): CursorPos => pos,
  set(line: number, col: number) {
    if (pos.line === line && pos.col === col) return;
    pos = { line, col };
    listeners.forEach((fn) => fn());
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function useCursor(): CursorPos {
  return useSyncExternalStore(cursorStore.subscribe, cursorStore.get);
}
