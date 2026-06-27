import { useState, useEffect, useCallback, memo } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import type { FileEntry } from "../types";
import { listDir, renameEntry, writeFile, createDir, deleteEntry } from "../lib/fs";
import { basename, dirname, joinPath } from "../lib/path";

interface FileExplorerProps {
  rootPath: string | null;
  onOpenFile: (path: string) => void;
  /** Incrementing counter that triggers a re-scan (e.g. after the AI agent edits files). */
  refreshSignal?: number;
}

function getFileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const file = name.toLowerCase();
  if (file === "package.json") return "📦";
  if (file === "tsconfig.json") return "⚙️";
  if (file === ".gitignore" || file === ".gitattributes" || file === ".gitmodules") return "🐱";
  if (file === "dockerfile") return "🐋";
  if (file === "makefile") return "🔨";
  if (file === "readme.md") return "📖";

  switch (ext) {
    case "js": return "🟨";
    case "jsx": return "⚛️";
    case "ts": return "🔵";
    case "tsx": return "⚛️";
    case "rs": return "🦀";
    case "py": return "🐍";
    case "json": return "📋";
    case "html": return "🌐";
    case "css": return "🎨";
    case "scss": case "sass": case "less": return "🎨";
    case "md": return "📝";
    case "yaml": case "yml": return "⚙️";
    case "toml": return "⚙️";
    case "c": return "🔵";
    case "cpp": case "cxx": case "cc": return "🔷";
    case "h": case "hpp": return "🔷";
    case "go": return "🔷";
    case "java": return "☕";
    case "rb": return "💎";
    case "php": return "🐘";
    case "sh": case "bash": case "zsh": return "💻";
    case "ps1": return "💻";
    case "bat": case "cmd": return "💻";
    case "sql": return "🗃️";
    case "svg": case "png": case "jpg": case "jpeg": case "gif": case "ico": return "🖼️";
    case "pdf": return "📕";
    case "txt": return "📄";
    case "csv": case "tsv": return "📊";
    default: return "📄";
  }
}

export const FileExplorer = memo(function FileExplorer({
  rootPath,
  onOpenFile,
  refreshSignal,
}: FileExplorerProps) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [childrenMap, setChildrenMap] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [creating, setCreating] = useState<"file" | "folder" | null>(null);
  const [createParent, setCreateParent] = useState("");
  const [createValue, setCreateValue] = useState("");
  const ctxRef = useState<{ path: string; x: number; y: number } | null>(null);

  const refresh = useCallback(async () => {
    if (!rootPath) return;
    setLoading(true);
    try {
      const items = await listDir(rootPath);
      setEntries(items);
    } catch (e) {
      console.error("Failed to list dir:", e);
    }
    setLoading(false);
  }, [rootPath]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // External refresh trigger (e.g. AI agent created/edited files): re-scan root
  // and any currently expanded folders so new entries show up immediately.
  useEffect(() => {
    if (!refreshSignal) return;
    refresh();
    for (const dirPath of expanded) loadChildren(dirPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  const loadChildren = useCallback(async (dirPath: string) => {
    try {
      const items = await listDir(dirPath);
      setChildrenMap((prev) => ({ ...prev, [dirPath]: items }));
    } catch (e) {
      console.error("Failed to list children:", e);
    }
  }, []);

  const handleClick = useCallback(
    (entry: FileEntry) => {
      if (entry.is_dir) {
        setExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(entry.path)) {
            next.delete(entry.path);
          } else {
            next.add(entry.path);
            loadChildren(entry.path);
          }
          return next;
        });
      } else {
        onOpenFile(entry.path);
      }
    },
    [onOpenFile, loadChildren]
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, path: string) => {
      e.preventDefault();
      ctxRef[1]({ path, x: e.clientX, y: e.clientY });
      // Close on click outside
      const close = () => {
        ctxRef[1](null);
        document.removeEventListener("click", close);
      };
      document.addEventListener("click", close);
    },
    [ctxRef]
  );

  const startRename = useCallback(
    (path: string) => {
      setRenaming(path);
      const name = entries.find((e) => e.path === path)?.name || basename(path);
      setRenameValue(name);
      setCreating(null);
    },
    [entries]
  );

  const doRename = useCallback(async () => {
    if (!renaming || !renameValue.trim()) {
      setRenaming(null);
      return;
    }
    const newPath = joinPath(dirname(renaming), renameValue.trim());
    try {
      await renameEntry(renaming, newPath);
      setRenaming(null);
      refresh();
    } catch (e) {
      console.error("Rename failed:", e);
    }
  }, [renaming, renameValue, refresh]);

  const startCreate = useCallback(
    (type: "file" | "folder", parentPath: string) => {
      setCreating(type);
      setCreateParent(parentPath);
      setCreateValue("");
      setRenaming(null);
    },
    []
  );

  const doCreate = useCallback(async () => {
    if (!creating || !createValue.trim()) {
      setCreating(null);
      return;
    }
    const fullPath = createParent ? joinPath(createParent, createValue.trim()) : createValue.trim();
    try {
      if (creating === "folder") {
        await createDir(fullPath);
      } else {
        await writeFile(fullPath, "");
      }
      setCreating(null);
      refresh();
    } catch (e) {
      console.error("Create failed:", e);
    }
  }, [creating, createParent, createValue, refresh]);

  const handleDelete = useCallback(
    async (path: string) => {
      const ok = await ask(`Excluir "${basename(path)}"?`, { title: "Excluir", kind: "warning" });
      if (!ok) return;
      try {
        await deleteEntry(path);
        refresh();
      } catch (e) {
        console.error("Delete failed:", e);
      }
    },
    [refresh]
  );

  const renderTree = (items: FileEntry[], depth: number): React.ReactNode => {
    return items.map((entry) => {
      const isExpanded = expanded.has(entry.path);
      const children = childrenMap[entry.path];
      return (
        <div key={entry.path}>
          <div
            className={`explorer-item ${entry.is_dir ? "dir" : "file"}`}
            style={{ paddingLeft: depth * 16 + 8 }}
            onClick={() => handleClick(entry)}
            onContextMenu={(e) => handleContextMenu(e, entry.path)}
          >
            <span className="explorer-icon">
              {entry.is_dir ? (isExpanded ? "▼" : "▶") : getFileIcon(entry.name)}
            </span>
            {renaming === entry.path ? (
              <input
                className="explorer-rename-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={doRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") doRename();
                  if (e.key === "Escape") setRenaming(null);
                }}
                autoFocus
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="explorer-name">{entry.name}</span>
            )}
          </div>
          {entry.is_dir && isExpanded && (
            <div className="explorer-children">
              {!children ? (
                <div className="explorer-loading">Carregando...</div>
              ) : children.length === 0 ? (
                <div className="explorer-empty">vazio</div>
              ) : (
                renderTree(children, depth + 1)
              )}
            </div>
          )}
        </div>
      );
    });
  };

  if (!rootPath) {
    return (
      <div className="explorer-panel">
        <div className="explorer-header">
          <span>Explorador</span>
        </div>
        <div className="explorer-empty-state">
          <p>Nenhuma pasta aberta</p>
          <p className="explorer-hint">Use Ctrl+K Ctrl+O para abrir</p>
        </div>
      </div>
    );
  }

  return (
    <div className="explorer-panel">
      <div className="explorer-header">
        <span>Explorador</span>
        <div className="explorer-actions">
          <button
            className="explorer-action-btn"
            title="Novo arquivo"
            onClick={() => startCreate("file", rootPath)}
          >
            +
          </button>
          <button
            className="explorer-action-btn"
            title="Nova pasta"
            onClick={() => startCreate("folder", rootPath)}
          >
            📁
          </button>
          <button className="explorer-action-btn" title="Atualizar" onClick={refresh}>
            ↻
          </button>
        </div>
      </div>

      {creating && (
        <div className="explorer-create-form">
          <input
            className="explorer-rename-input"
            placeholder={creating === "file" ? "arquivo.ts" : "pasta"}
            value={createValue}
            onChange={(e) => setCreateValue(e.target.value)}
            onBlur={doCreate}
            onKeyDown={(e) => {
              if (e.key === "Enter") doCreate();
              if (e.key === "Escape") setCreating(null);
            }}
            autoFocus
          />
        </div>
      )}

      {loading && <div className="explorer-loading">Carregando...</div>}
      {!loading && entries.length === 0 && (
        <div className="explorer-empty-state">Pasta vazia</div>
      )}

      {!loading && renderTree(entries, 0)}

      {ctxRef[0] && (
        <div className="explorer-context-menu" style={{ position: "fixed", left: ctxRef[0].x, top: ctxRef[0].y }}>
          <button onClick={() => { startRename(ctxRef[0]!.path); ctxRef[1](null); }}>Renomear</button>
          <button onClick={() => { handleDelete(ctxRef[0]!.path); ctxRef[1](null); }}>Excluir</button>
        </div>
      )}
    </div>
  );
});
