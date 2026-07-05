import { useEffect, useState, useRef, memo } from "react";
import { getDocumentSymbols, getLspLanguage } from "../lib/lsp";
import type { LspSymbol } from "../lib/lsp";
import { t } from "../lib/i18n";

interface OutlinePanelProps {
  language: string | null;
  filePath: string | null;
  onSelect: (line: number) => void;
}

export const OutlinePanel = memo(function OutlinePanel({ language, filePath, onSelect }: OutlinePanelProps) {
  const [symbols, setSymbols] = useState<LspSymbol[]>([]);
  const [loading, setLoading] = useState(false);
  const lspLangRef = useRef<string | null>(null);

  useEffect(() => {
    if (!language || !filePath) { setSymbols([]); return; }

    const ext = filePath.split(".").pop() || "";
    const lspLang = getLspLanguage(ext);
    lspLangRef.current = lspLang;
    if (!lspLang) { setSymbols([]); return; }

    setLoading(true);
    getDocumentSymbols(lspLang, filePath)
      .then(setSymbols)
      .catch(() => setSymbols([]))
      .finally(() => setLoading(false));
  }, [language, filePath]);

  const renderSymbols = (items: LspSymbol[], depth: number): any[] =>
    items.flatMap((s) => [
      <div
        key={`${s.name}-${s.range[0]}-${s.range[1]}`}
        className="outline-item"
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => onSelect(s.selection_range[0])}
        title={s.detail || s.name}
      >
        <span className="outline-item-icon">{symbolIcon(s.kind)}</span>
        <span className="outline-item-name">{s.name}</span>
      </div>,
      ...(s.children?.length ? renderSymbols(s.children, depth + 1) : []),
    ]);

  return (
    <div className="outline-panel">
      <div className="outline-header">
        <span className="outline-title">{t("outline.title")}</span>
        {loading && <span className="outline-loading">⋯</span>}
      </div>
      <div className="outline-body">
        {symbols.length === 0 && !loading && (
          <div className="outline-empty">{t("outline.noSymbols")}</div>
        )}
        {renderSymbols(symbols, 0)}
      </div>
    </div>
  );
});

function symbolIcon(kind: string): string {
  const icons: Record<string, string> = {
    File: "📄", Module: "📦", Namespace: "⊡", Package: "📦",
    Class: "C", Method: "ƒ", Property: "⚙", Field: "⚙",
    Constructor: "C", Enum: "E", Interface: "I", Function: "ƒ",
    Variable: "x", Constant: "C", String: "S", Number: "#",
    Boolean: "✓", Array: "[]", Object: "{}", Key: "🔑",
    Null: "∅", EnumMember: "◈", Struct: "S", Event: "⚡",
    Operator: "⊕", TypeParameter: "T",
  };
  return icons[kind] || "?";
}
