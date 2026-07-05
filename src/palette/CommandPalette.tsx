import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../lib/i18n";

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

interface CommandPaletteProps {
  mode: "files" | "commands";
  rootPath: string | null;
  commands: PaletteCommand[];
  onOpenFile: (path: string) => void;
  onClose: () => void;
}

interface Item {
  key: string;
  label: string;   // primary text shown / matched against
  hint?: string;   // secondary text (dir path or command hint)
  run: () => void;
}

/** Subsequence fuzzy score. Returns null if `query` is not a subsequence. */
function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let score = 0;
  let ti = 0;
  let prevMatch = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    let found = -1;
    for (let j = ti; j < t.length; j++) {
      if (t[j] === c) { found = j; break; }
    }
    if (found === -1) return null;
    // reward contiguous matches and matches right after a separator
    if (found === prevMatch + 1) score += 5;
    if (found === 0 || "/\\._- ".includes(t[found - 1])) score += 3;
    score += 1;
    prevMatch = found;
    ti = found + 1;
  }
  // prefer shorter targets
  score -= Math.floor(target.length / 40);
  return score;
}

export function CommandPalette({ mode, rootPath, commands, onOpenFile, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Load workspace files when in file mode
  useEffect(() => {
    if (mode !== "files" || !rootPath) return;
    invoke<string[]>("list_workspace_files", { root: rootPath, max: 10000 })
      .then(setFiles)
      .catch(() => setFiles([]));
  }, [mode, rootPath]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const normRoot = rootPath ? rootPath.replace(/\\/g, "/").replace(/\/$/, "") + "/" : "";

  const items: Item[] = useMemo(() => {
    if (mode === "commands") {
      return commands.map((c) => ({ key: c.id, label: c.label, hint: c.hint, run: c.run }));
    }
    return files.map((abs) => {
      const norm = abs.replace(/\\/g, "/");
      const rel = normRoot && norm.startsWith(normRoot) ? norm.slice(normRoot.length) : norm;
      const name = rel.split("/").pop() || rel;
      const dir = rel.slice(0, rel.length - name.length).replace(/\/$/, "");
      return {
        key: abs,
        label: name,
        hint: dir,
        run: () => onOpenFile(abs),
      };
    });
  }, [mode, commands, files, normRoot, onOpenFile]);

  const filtered = useMemo(() => {
    if (!query.trim()) return items.slice(0, 200);
    const scored: { item: Item; score: number }[] = [];
    for (const item of items) {
      // match against "name" and against full relative path for files
      const target = mode === "files" && item.hint ? `${item.hint}/${item.label}` : item.label;
      const s = fuzzyScore(query.trim(), target);
      if (s !== null) scored.push({ item, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 200).map((s) => s.item);
  }, [items, query, mode]);

  useEffect(() => { setSelected(0); }, [query]);

  // Keep selected item in view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${selected}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const choose = useCallback((item: Item | undefined) => {
    if (!item) return;
    item.run();
    onClose();
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(filtered[selected]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={mode === "files" ? t("palette.searchFiles") : t("palette.searchCommands")}
        />
        <div ref={listRef} className="palette-list">
          {filtered.length === 0 && (
            <div className="palette-empty">
              {mode === "files" && !rootPath ? t("palette.openFolderFirst") : t("common.noResults")}
            </div>
          )}
          {filtered.map((item, idx) => (
            <div
              key={item.key}
              data-idx={idx}
              className={`palette-item ${idx === selected ? "selected" : ""}`}
              onMouseEnter={() => setSelected(idx)}
              onClick={() => choose(item)}
            >
              <span className="palette-item-label">{item.label}</span>
              {item.hint && <span className="palette-item-hint">{item.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
