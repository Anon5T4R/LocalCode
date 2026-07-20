export function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() || path;
}

export function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  const joined = parts.join("/");
  if (normalized.startsWith("/")) return "/" + joined; // absolute Unix path
  return joined || ".";
}

export function joinPath(...parts: string[]): string {
  const cleaned = parts.map((p, i) => {
    const s = p.replace(/\\/g, "/");
    if (i === 0) return s.replace(/\/+$/, "");
    return s.replace(/^\/+|\/+$/g, "");
  });
  // A raiz Unix é o caso que o trim acima destrói: "/" fica "" e o
  // `filter(Boolean)` a descarta, então o resultado sai RELATIVO. Renomear um
  // arquivo na raiz (`dirname("/a.txt")` = "/") gravava em `novo.txt` — o
  // arquivo ia parar no cwd do processo, calado. Só morde no Linux: no Windows
  // a raiz é "C:/", que sobrevive ao trim.
  const raiz = cleaned[0] === "" && parts[0]?.replace(/\\/g, "/").startsWith("/") ? "/" : "";
  return raiz + cleaned.filter(Boolean).join("/");
}
