export function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() || path;
}

export function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/") || ".";
}

export function joinPath(...parts: string[]): string {
  return parts.map((p, i) => {
    const s = p.replace(/\\/g, "/");
    if (i === 0) return s.replace(/\/+$/, "");
    return s.replace(/^\/+|\/+$/g, "");
  }).filter(Boolean).join("/");
}
