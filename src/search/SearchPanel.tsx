import { useState, useRef, useCallback } from "react";
import { searchFiles, replaceInFiles, type SearchMatch } from "../lib/search";
import { t } from "../lib/i18n";

interface SearchPanelProps {
  rootPath: string | null;
  onOpenFile: (path: string, line?: number) => void;
  onReplaced?: () => void;
}

export function SearchPanel({ rootPath, onOpenFile, onReplaced }: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [results, setResults] = useState<SearchMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSearch = useCallback(
    (q: string) => {
      if (!rootPath || !q.trim()) {
        setResults([]);
        setSearched(!!q.trim());
        return;
      }
      setLoading(true);
      setSearched(true);
      searchFiles(rootPath, q, { caseSensitive, useRegex, wholeWord })
        .then((matches) => {
          setResults(matches);
        })
        .catch(() => setResults([]))
        .finally(() => setLoading(false));
    },
    [rootPath, caseSensitive, useRegex, wholeWord]
  );

  const handleChange = (val: string) => {
    setQuery(val);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => doSearch(val), 300);
  };

  const handleReplaceAll = useCallback(async () => {
    if (!rootPath || !query.trim() || results.length === 0) return;
    const fileCount = new Set(results.map((r) => r.path)).size;
    const { ask } = await import("@tauri-apps/plugin-dialog");
    const ok = await ask(
      t("search.replaceConfirm", { query, replace: replaceText, count: results.length, files: fileCount }),
      { title: t("search.replaceTitle"), kind: "warning" }
    );
    if (!ok) return;
    setReplacing(true);
    try {
      const res = await replaceInFiles(rootPath, query, replaceText, { caseSensitive, useRegex, wholeWord });
      onReplaced?.();
      doSearch(query);
      const { message } = await import("@tauri-apps/plugin-dialog");
      await message(t("search.replaceDone", { replacements: res.replacements, files: res.files_changed }), { title: t("search.doneTitle") });
    } catch (e) {
      const { message } = await import("@tauri-apps/plugin-dialog");
      await message(t("search.failed", { error: String(e) }), { title: "Error", kind: "error" });
    } finally {
      setReplacing(false);
    }
  }, [rootPath, query, replaceText, results, caseSensitive, useRegex, wholeWord, doSearch, onReplaced]);

  const groupByFile = (): [string, SearchMatch[]][] => {
    const map = new Map<string, SearchMatch[]>();
    for (const r of results) {
      const existing = map.get(r.path) || [];
      existing.push(r);
      map.set(r.path, existing);
    }
    return Array.from(map.entries());
  };

  return (
    <div className="search-panel">
      <div className="search-header">
        <span>{t("search.title")}</span>
        <button
          className="search-opt"
          onClick={() => setShowReplace((v) => !v)}
          title={t("search.showReplace")}
          style={{ marginLeft: "auto", cursor: "pointer" }}
        >
          {showReplace ? "▾" : "▸"} {t("search.replace")}
        </button>
        {results.length > 0 && (
          <span className="search-count">{t("search.results", { count: results.length })}</span>
        )}
      </div>
      <div className="search-input-area">
        <input
          className="search-input"
          placeholder={t("search.placeholder")}
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") doSearch(query);
          }}
        />
        {showReplace && (
          <div className="search-replace-row" style={{ display: "flex", gap: 4, marginTop: 4 }}>
            <input
              className="search-input"
              placeholder={t("search.replacePlaceholder")}
              value={replaceText}
              onChange={(e) => setReplaceText(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              className="search-opt"
              onClick={handleReplaceAll}
              disabled={replacing || results.length === 0 || !query.trim()}
              title={t("search.replaceAllTitle")}
              style={{ whiteSpace: "nowrap", cursor: "pointer" }}
            >
              {replacing ? "..." : t("search.replaceAll")}
            </button>
          </div>
        )}
      </div>
      <div className="search-options">
        <label className={`search-opt ${caseSensitive ? "active" : ""}`}>
          <input type="checkbox" checked={caseSensitive} onChange={(e) => { setCaseSensitive(e.target.checked); doSearch(query); }} />
          Aa
        </label>
        <label className={`search-opt ${useRegex ? "active" : ""}`}>
          <input type="checkbox" checked={useRegex} onChange={(e) => { setUseRegex(e.target.checked); doSearch(query); }} />
          .*
        </label>
        <label className={`search-opt ${wholeWord ? "active" : ""}`}>
          <input type="checkbox" checked={wholeWord} onChange={(e) => { setWholeWord(e.target.checked); doSearch(query); }} />
          W
        </label>
      </div>
      <div className="search-results">
        {loading && <div className="search-empty">{t("search.searching")}</div>}
        {!loading && searched && results.length === 0 && (
          <div className="search-empty">{t("common.noResults")}</div>
        )}
        {!loading &&
          groupByFile().map(([filePath, matches]) => (
            <div key={filePath}>
              <div
                className="search-result-item"
                style={{ fontWeight: 600, fontSize: 11, textTransform: "uppercase", color: "var(--text-secondary)" }}
                onClick={() => onOpenFile(filePath, matches[0]?.line)}
              >
                📄 {filePath.replace(/\\/g, "/").split("/").pop()}
                <span style={{ fontWeight: "normal", color: "var(--text-muted)" }}>
                  ({matches.length})
                </span>
              </div>
              {matches.map((m, i) => (
                <div
                  key={`${m.line}-${i}`}
                  className="search-result-item"
                  style={{ paddingLeft: 20 }}
                  onClick={() => onOpenFile(m.path, m.line)}
                >
                  <span className="search-result-line">{m.line}</span>
                  <span className="search-result-text">
                    {highlightMatch(m.line_content, m.match_start, m.match_end)}
                  </span>
                </div>
              ))}
            </div>
          ))}
      </div>
    </div>
  );
}

function highlightMatch(text: string, start: number, end: number) {
  const before = text.slice(0, start);
  const match = text.slice(start, end);
  const after = text.slice(end);
  return [
    <span key="b">{escapeHtml(before)}</span>,
    <span key="m" className="search-result-match">{escapeHtml(match)}</span>,
    <span key="a">{escapeHtml(after)}</span>,
  ];
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
