import { useState, useEffect, useCallback, memo } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import type { FileEntry } from "../types";
import { listDir, renameEntry, writeFile, createDir, deleteEntry } from "../lib/fs";
import { basename, dirname, joinPath } from "../lib/path";
import { toast } from "../lib/toast";
import { t } from "../lib/i18n";

interface FileExplorerProps {
  rootPath: string | null;
  onOpenFile: (path: string) => void;
  /** Incrementing counter that triggers a re-scan (e.g. after the AI agent edits files). */
  refreshSignal?: number;
  /** Path of the file open in the active tab — highlighted in the tree. */
  activePath?: string | null;
}

/** Language accent colors for file icons (roughly GitHub's linguist palette). */
const EXT_COLORS: Record<string, string> = {
  js: "#e8d44d", mjs: "#e8d44d", cjs: "#e8d44d",
  jsx: "#61dafb", tsx: "#61dafb",
  ts: "#3178c6",
  rs: "#dea584",
  py: "#3572a5",
  go: "#00add8",
  java: "#b07219",
  rb: "#701516",
  php: "#4f5d95",
  c: "#555599", h: "#555599",
  cpp: "#f34b7d", cxx: "#f34b7d", cc: "#f34b7d", hpp: "#f34b7d",
  cs: "#178600",
  html: "#e34c26",
  css: "#563d7c", scss: "#c6538c", sass: "#c6538c", less: "#1d365d",
  json: "#cbcb41",
  yaml: "#cb171e", yml: "#cb171e",
  toml: "#9c4221",
  md: "#519aba",
  sh: "#89e051", bash: "#89e051", zsh: "#89e051", ps1: "#89e051", bat: "#89e051", cmd: "#89e051",
  sql: "#e38c00",
  dart: "#00b4ab",
  vue: "#41b883",
  svelte: "#ff3e00",
};

/** Codicon + color for a file name. Monochrome glyphs tinted per language. */
function getFileIcon(name: string): { icon: string; color?: string } {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const file = name.toLowerCase();
  if (file === "package.json" || file === "package-lock.json") return { icon: "codicon-package", color: "#cb3837" };
  if (file.startsWith(".git")) return { icon: "codicon-source-control", color: "#f05033" };
  if (file === "dockerfile" || file.startsWith("docker-compose")) return { icon: "codicon-server-process", color: "#2496ed" };
  if (file === "makefile") return { icon: "codicon-tools" };
  if (file === "readme.md") return { icon: "codicon-book", color: "#519aba" };

  switch (ext) {
    case "md": return { icon: "codicon-markdown", color: EXT_COLORS.md };
    case "json": return { icon: "codicon-json", color: EXT_COLORS.json };
    case "pdf": return { icon: "codicon-file-pdf", color: "#d93831" };
    case "zip": case "gz": case "tar": case "7z": case "rar":
      return { icon: "codicon-file-zip" };
    case "svg": case "png": case "jpg": case "jpeg": case "gif": case "ico": case "webp":
      return { icon: "codicon-file-media", color: "#a074c4" };
    case "csv": case "tsv": return { icon: "codicon-table", color: "#89e051" };
    case "txt": case "log": return { icon: "codicon-file" };
  }
  const color = EXT_COLORS[ext];
  return color ? { icon: "codicon-file-code", color } : { icon: "codicon-file" };
}

interface CtxMenu {
  path: string;
  isDir: boolean;
  x: number;
  y: number;
}

export const FileExplorer = memo(function FileExplorer({
  rootPath,
  onOpenFile,
  refreshSignal,
  activePath,
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
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);

  const refresh = useCallback(async () => {
    if (!rootPath) return;
    setLoading(true);
    try {
      const items = await listDir(rootPath);
      setEntries(items);
    } catch (e) {
      console.error("Failed to list dir:", e);
      toast.error(t("explorer.listFailed", { error: String(e) }));
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

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault();
    setCtxMenu({ path: entry.path, isDir: entry.is_dir, x: e.clientX, y: e.clientY });
  }, []);

  // Close the context menu on outside click / Escape.
  useEffect(() => {
    if (!ctxMenu) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el?.closest(".explorer-context-menu")) setCtxMenu(null);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, [ctxMenu]);

  const findEntryName = useCallback(
    (path: string): string => {
      const inRoot = entries.find((e) => e.path === path);
      if (inRoot) return inRoot.name;
      for (const children of Object.values(childrenMap)) {
        const hit = children.find((e) => e.path === path);
        if (hit) return hit.name;
      }
      return basename(path);
    },
    [entries, childrenMap]
  );

  const startRename = useCallback(
    (path: string) => {
      setRenaming(path);
      setRenameValue(findEntryName(path));
      setCreating(null);
    },
    [findEntryName]
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
      const parent = dirname(renaming);
      if (expanded.has(parent)) loadChildren(parent);
    } catch (e) {
      setRenaming(null);
      toast.error(t("explorer.renameFailed", { name: basename(renaming), error: String(e) }));
    }
  }, [renaming, renameValue, refresh, expanded, loadChildren]);

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
    const type = creating;
    const fullPath = createParent ? joinPath(createParent, createValue.trim()) : createValue.trim();
    try {
      if (type === "folder") {
        await createDir(fullPath);
      } else {
        await writeFile(fullPath, "");
      }
      setCreating(null);
      refresh();
      if (expanded.has(createParent)) loadChildren(createParent);
      if (type === "file") onOpenFile(fullPath);
    } catch (e) {
      setCreating(null);
      toast.error(t("explorer.createFailed", { name: createValue.trim(), error: String(e) }));
    }
  }, [creating, createParent, createValue, refresh, expanded, loadChildren, onOpenFile]);

  const handleDelete = useCallback(
    async (path: string) => {
      const ok = await ask(t("explorer.deleteConfirm", { name: basename(path) }), { title: t("explorer.delete"), kind: "warning" });
      if (!ok) return;
      try {
        await deleteEntry(path);
        refresh();
        const parent = dirname(path);
        if (expanded.has(parent)) loadChildren(parent);
      } catch (e) {
        toast.error(t("explorer.deleteFailed", { name: basename(path), error: String(e) }));
      }
    },
    [refresh, expanded, loadChildren]
  );

  const renderTree = (items: FileEntry[], depth: number): React.ReactNode => {
    return items.map((entry) => {
      const isExpanded = expanded.has(entry.path);
      const children = childrenMap[entry.path];
      const fileIcon = entry.is_dir ? null : getFileIcon(entry.name);
      return (
        <div key={entry.path}>
          <div
            className={`explorer-item ${entry.is_dir ? "dir" : "file"} ${activePath === entry.path ? "active" : ""}`}
            style={{ paddingLeft: depth * 16 + 8 }}
            onClick={() => handleClick(entry)}
            onContextMenu={(e) => handleContextMenu(e, entry)}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleClick(entry);
              }
            }}
          >
            {entry.is_dir ? (
              <>
                <span className={`explorer-icon codicon ${isExpanded ? "codicon-chevron-down" : "codicon-chevron-right"}`} />
                <span className={`explorer-icon codicon ${isExpanded ? "codicon-folder-opened" : "codicon-folder"}`} />
              </>
            ) : (
              <span
                className={`explorer-icon explorer-icon-file codicon ${fileIcon!.icon}`}
                style={fileIcon!.color ? { color: fileIcon!.color } : undefined}
              />
            )}
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
              {creating && createParent === entry.path && (
                <div className="explorer-create-form" style={{ paddingLeft: (depth + 1) * 16 + 8 }}>
                  <input
                    className="explorer-rename-input"
                    placeholder={creating === "file" ? "arquivo.ts" : t("explorer.folderPlaceholder")}
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
              {!children ? (
                <div className="explorer-loading">{t("common.loading")}</div>
              ) : children.length === 0 && !(creating && createParent === entry.path) ? (
                <div className="explorer-empty">{t("common.empty")}</div>
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
          <span>{t("explorer.title")}</span>
        </div>
        <div className="explorer-empty-state">
          <p>{t("explorer.noFolder")}</p>
          <p className="explorer-hint">{t("explorer.openHint")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="explorer-panel">
      <div className="explorer-header">
        <span>{t("explorer.title")}</span>
        <div className="explorer-actions">
          <button
            className="explorer-action-btn"
            title={t("explorer.newFile")}
            onClick={() => startCreate("file", rootPath)}
          >
            <span className="codicon codicon-new-file" />
          </button>
          <button
            className="explorer-action-btn"
            title={t("explorer.newFolder")}
            onClick={() => startCreate("folder", rootPath)}
          >
            <span className="codicon codicon-new-folder" />
          </button>
          <button className="explorer-action-btn" title={t("common.refresh")} onClick={refresh}>
            <span className="codicon codicon-refresh" />
          </button>
        </div>
      </div>

      {creating && createParent === rootPath && (
        <div className="explorer-create-form">
          <input
            className="explorer-rename-input"
            placeholder={creating === "file" ? "arquivo.ts" : t("explorer.folderPlaceholder")}
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

      {loading && <div className="explorer-loading">{t("common.loading")}</div>}
      {!loading && entries.length === 0 && (
        <div className="explorer-empty-state">{t("explorer.emptyFolder")}</div>
      )}

      {!loading && renderTree(entries, 0)}

      {ctxMenu && (
        <div className="explorer-context-menu" style={{ position: "fixed", left: ctxMenu.x, top: ctxMenu.y }}>
          {ctxMenu.isDir && (
            <>
              <button onClick={() => {
                setExpanded((prev) => new Set(prev).add(ctxMenu.path));
                loadChildren(ctxMenu.path);
                startCreate("file", ctxMenu.path);
                setCtxMenu(null);
              }}>{t("explorer.newFile")}</button>
              <button onClick={() => {
                setExpanded((prev) => new Set(prev).add(ctxMenu.path));
                loadChildren(ctxMenu.path);
                startCreate("folder", ctxMenu.path);
                setCtxMenu(null);
              }}>{t("explorer.newFolder")}</button>
            </>
          )}
          <button onClick={() => { startRename(ctxMenu.path); setCtxMenu(null); }}>{t("explorer.rename")}</button>
          <button onClick={() => { handleDelete(ctxMenu.path); setCtxMenu(null); }}>{t("explorer.delete")}</button>
        </div>
      )}
    </div>
  );
});
