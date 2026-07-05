import { useSyncExternalStore } from "react";
import { t } from "./i18n";

/**
 * Global toast store, outside React (same pattern as lib/cursor.ts) so any
 * module — panels, lib wrappers, non-React code — can emit user feedback
 * without prop-drilling. <ToastHost/> (rendered once in App) subscribes.
 */

export type ToastKind = "success" | "error" | "info";

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

type Listener = () => void;

let nextId = 1;
let toasts: Toast[] = [];
const listeners = new Set<Listener>();

function emitChange() {
  for (const l of listeners) l();
}

function push(kind: ToastKind, text: string, durationMs: number) {
  const id = nextId++;
  toasts = [...toasts, { id, kind, text }];
  emitChange();
  setTimeout(() => dismiss(id), durationMs);
  return id;
}

export function dismiss(id: number) {
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.filter((t) => t.id !== id);
  emitChange();
}

export const toast = {
  /** Transient confirmation (4s). */
  success: (text: string) => push("success", text, 4000),
  /** Errors stay longer (7s) — the user may need to read a path or message. */
  error: (text: string) => push("error", text, 7000),
  info: (text: string) => push("info", text, 4000),
};

function subscribe(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function getSnapshot() {
  return toasts;
}

const KIND_ICON: Record<ToastKind, string> = {
  success: "codicon-check",
  error: "codicon-error",
  info: "codicon-info",
};

export function ToastHost() {
  const items = useSyncExternalStore(subscribe, getSnapshot);
  if (items.length === 0) return null;
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {items.map((toastItem) => (
        <div key={toastItem.id} className={`toast toast-${toastItem.kind}`} onClick={() => dismiss(toastItem.id)} title={t("toast.clickToClose")}>
          <span className={`codicon ${KIND_ICON[toastItem.kind]} toast-icon`} aria-hidden />
          <span className="toast-text">{toastItem.text}</span>
        </div>
      ))}
    </div>
  );
}
