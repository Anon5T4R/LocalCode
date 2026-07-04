import { useEffect, useState, memo } from "react";
import { getDocumentSymbols, getLspLanguage } from "../lib/lsp";
import type { LspSymbol } from "../lib/lsp";
import { useCursor } from "../lib/cursor";

interface BreadcrumbsProps {
  filePath: string | null;
  rootPath: string | null;
  onSelect: (line: number) => void; // 0-based symbol line
}

/** Walk the symbol tree collecting the chain that encloses `line0` (0-based). */
function enclosingChain(symbols: LspSymbol[], line0: number): LspSymbol[] {
  for (const s of symbols) {
    const [startLine, , endLine] = s.range;
    if (line0 >= startLine && line0 <= endLine) {
      return [s, ...enclosingChain(s.children || [], line0)];
    }
  }
  return [];
}

export const Breadcrumbs = memo(function Breadcrumbs({ filePath, rootPath, onSelect }: BreadcrumbsProps) {
  const [symbols, setSymbols] = useState<LspSymbol[]>([]);
  // Subscribed here (not passed from App) so caret moves don't re-render App.
  const { line: cursorLine } = useCursor();

  useEffect(() => {
    if (!filePath) { setSymbols([]); return; }
    const ext = filePath.split(".").pop() || "";
    const lspLang = getLspLanguage(ext);
    if (!lspLang) { setSymbols([]); return; }
    let cancelled = false;
    getDocumentSymbols(lspLang, filePath)
      .then((s) => { if (!cancelled) setSymbols(s); })
      .catch(() => { if (!cancelled) setSymbols([]); });
    return () => { cancelled = true; };
  }, [filePath]);

  if (!filePath) return null;

  const norm = filePath.replace(/\\/g, "/");
  const normRoot = rootPath ? rootPath.replace(/\\/g, "/").replace(/\/$/, "") + "/" : "";
  const rel = normRoot && norm.startsWith(normRoot) ? norm.slice(normRoot.length) : norm;
  const segments = rel.split("/").filter(Boolean);

  const chain = enclosingChain(symbols, cursorLine - 1);

  const sep = (key: string) => (
    <span key={key} style={{ color: "var(--text-muted, #666)", padding: "0 4px" }}>›</span>
  );

  return (
    <div
      className="breadcrumbs"
      style={{
        display: "flex", alignItems: "center", flexWrap: "nowrap", overflow: "hidden",
        height: 24, padding: "0 10px", fontSize: 12,
        color: "var(--text-secondary, #999)",
        background: "var(--bg-secondary, #252526)",
        borderBottom: "1px solid var(--border, #333)",
        whiteSpace: "nowrap",
      }}
    >
      {segments.map((seg, i) => (
        <span key={`p${i}`} style={{ display: "flex", alignItems: "center" }}>
          {i > 0 && sep(`ps${i}`)}
          <span style={{ color: i === segments.length - 1 ? "var(--text-primary, #ddd)" : undefined }}>
            {seg}
          </span>
        </span>
      ))}
      {chain.map((s, i) => (
        <span key={`s${i}`} style={{ display: "flex", alignItems: "center" }}>
          {sep(`ss${i}`)}
          <span
            onClick={() => onSelect(s.selection_range[0])}
            style={{ cursor: "pointer", color: "var(--text-secondary, #aaa)" }}
            title={s.detail || s.name}
          >
            {s.name}
          </span>
        </span>
      ))}
    </div>
  );
});
