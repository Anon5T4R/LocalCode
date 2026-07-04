import { useRef, useSyncExternalStore } from "react";
import { debugController, type DebugState } from "./controller";

/**
 * Subscribe to a slice of the debug state. The component only re-renders
 * when the selected slice changes (per `isEqual`), so App can watch
 * breakpoints/stopped-location without re-rendering on every console line.
 */
export function useDebugSelector<T>(
  selector: (s: DebugState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is
): T {
  const cache = useRef<{ value: T } | null>(null);
  return useSyncExternalStore(debugController.subscribe, () => {
    const next = selector(debugController.getState());
    if (cache.current && isEqual(cache.current.value, next)) return cache.current.value;
    cache.current = { value: next };
    return next;
  });
}

export function useDebugState(): DebugState {
  return useSyncExternalStore(debugController.subscribe, debugController.getState);
}
