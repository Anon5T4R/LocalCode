import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { MonacoWrapper } from "./editor/MonacoWrapper";
import { Breadcrumbs } from "./editor/Breadcrumbs";
import { FileExplorer } from "./explorer/FileExplorer";
import { GitPanel } from "./git/GitPanel";
import { GitHubPanel } from "./github/GitHubPanel";
import { TerminalPanel, type TerminalAdoption } from "./terminal/TerminalPanel";
import { StatusBar } from "./statusbar/StatusBar";
import { DebugPanel } from "./debug/DebugPanel";
import { debugController } from "./debug/controller";
import { useDebugSelector } from "./debug/useDebug";
import { spawnTerminal } from "./lib/terminal";
import { cursorStore } from "./lib/cursor";
import { OutlinePanel } from "./outline/OutlinePanel";
import { SearchPanel } from "./search/SearchPanel";
import { AiPanel } from "./ai/AiPanel";
import { LspSetupPanel } from "./lsp-setup/LspSetupPanel";
import { SettingsPanel } from "./settings/SettingsPanel";
import { CommandPalette, type PaletteCommand } from "./palette/CommandPalette";
import { readFile, writeFile, extToLanguage, registerExtensionLanguages as registerFsLanguages } from "./lib/fs";
import { registerExtensionLanguages as registerLspLanguages } from "./lib/lsp";
import { getBranches } from "./lib/git";
import { saveSession, loadSession } from "./lib/session";
import type { Tab } from "./types";
import { basename } from "./lib/path";
import { ExtensionManager } from "./lib/extension";
import type { ExtensionPanel, ExtensionCommand } from "./lib/extension";
import { loadSettings } from "./lib/settings";
import { toast, ToastHost } from "./lib/toast";
import { t, useLocale, setLocale } from "./lib/i18n";
import "./App.css";

// Apply saved theme + locale immediately on load
const _savedSettings = loadSettings();
if (_savedSettings.theme) document.documentElement.setAttribute("data-theme", _savedSettings.theme);
setLocale(_savedSettings.locale);

const TAB_ID = () => crypto.randomUUID();
const NO_LINES: number[] = [];

function newTab(filePath?: string, content?: string): Tab {
  const name = filePath ? basename(filePath) : t("app.untitled");
  const ext = filePath ? (name.split(".").pop() || "") : "";
  return {
    id: TAB_ID(),
    title: name,
    path: filePath || null,
    language: ext ? extToLanguage(ext) : "plaintext",
    dirty: false,
    content: content || "",
    savedContent: content || "",
  };
}

function dispatchExtCommand(
  cmd: ExtensionCommand,
  setVis: (updater: (prev: Record<string, boolean>) => Record<string, boolean>) => void
): void {
  if (cmd.id.startsWith("panel:toggle:")) {
    const panelId = cmd.id.replace("panel:toggle:", "");
    setVis((v) => ({ ...v, [panelId]: !v[panelId] }));
    return;
  }
  if (cmd.id.startsWith("panel:show:")) {
    const panelId = cmd.id.replace("panel:show:", "");
    setVis((v) => ({ ...v, [panelId]: true }));
    return;
  }
  if (cmd.id.startsWith("panel:hide:")) {
    const panelId = cmd.id.replace("panel:hide:", "");
    setVis((v) => ({ ...v, [panelId]: false }));
    return;
  }
  // Other command types can be dispatched here
}

/** Built-in right-side panels. Exactly one is visible at a time (VS Code-style),
 *  so mouse toggles and keyboard shortcuts behave identically. */
type SidePanelId = "debug" | "git" | "github" | "ai" | "lsp" | "settings";

function App() {
  // Locale: subscribing here + key={locale} on the root div remounts the whole
  // tree on change, so memo'd children pick up new strings without each one
  // subscribing individually. Locale changes are rare; the remount is cheap.
  const locale = useLocale();
  const [tabs, setTabs] = useState<Tab[]>([newTab()]);
  const [activeId, setActiveId] = useState(tabs[0].id);
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [sidePanel, setSidePanel] = useState<SidePanelId | null>(null);
  const [termAdoptions, setTermAdoptions] = useState<TerminalAdoption[]>([]);
  const [gitBranch, setGitBranch] = useState<string>("");
  const [gotoLine, setGotoLine] = useState<number | null>(null);
  const [tabCtx, setTabCtx] = useState<{ id: string; x: number; y: number } | null>(null);
  const [fileTreeVersion, setFileTreeVersion] = useState(0);
  const [palette, setPalette] = useState<"files" | "commands" | null>(null);
  const [modelToDispose, setModelToDispose] = useState<string | null>(null);
  const extManagerRef = useRef(new ExtensionManager());
  const [extPanels, setExtPanels] = useState<ExtensionPanel[]>([]);
  const [extCommands, setExtCommands] = useState<ExtensionCommand[]>([]);
  const [extPanelVis, setExtPanelVis] = useState<Record<string, boolean>>({});

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const rootPathRef = useRef(rootPath);
  rootPathRef.current = rootPath;
  const cursorPositionsRef = useRef<Record<string, { line: number; col: number }>>({});
  // Live buffer per tab id. The editor writes here on every keystroke; React
  // state (`Tab.content`) is only touched on open/save/reload and when the
  // dirty flag flips — so typing doesn't re-render the whole app.
  const contentsRef = useRef(new Map<string, string>());
  const liveContent = useCallback(
    (tab: Tab) => contentsRef.current.get(tab.id) ?? tab.content,
    []
  );

  // Reset gotoLine after MonacoWrapper consumes it
  useEffect(() => {
    if (gotoLine != null) setGotoLine(null);
  }, [gotoLine]);

  // Reset the dispose signal after MonacoWrapper consumes it
  useEffect(() => {
    if (modelToDispose != null) setModelToDispose(null);
  }, [modelToDispose]);

  const activeTab = tabs.find((t) => t.id === activeId);
  const repoPath = rootPath;

  const togglePanel = useCallback((id: SidePanelId) => {
    setSidePanel((cur) => (cur === id ? null : id));
  }, []);

  // ---- Git branch (refreshed reactively via the file watcher, not polled) ----
  const refreshBranch = useCallback(async () => {
    if (!rootPath) { setGitBranch(""); return; }
    try {
      const branches = await getBranches(rootPath);
      const current = branches.find((b) => b.current);
      setGitBranch(current?.name || "");
    } catch {
      setGitBranch("");
    }
  }, [rootPath]);

  useEffect(() => { refreshBranch(); }, [refreshBranch]);

  // ---- Sync on-disk changes into open tab buffers ----
  // Reloads a clean tab from disk; a tab with unsaved edits is NOT clobbered —
  // it's flagged `externallyChanged` so the user can decide.
  const syncTabFromDisk = useCallback(async (path: string) => {
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab) return;
    let content: string;
    try {
      content = await readFile(path);
    } catch {
      return; // file may have been deleted; leave the tab as-is
    }
    setTabs((ts) =>
      ts.map((t) => {
        if (t.path !== path) return t;
        const current = contentsRef.current.get(t.id) ?? t.content;
        if (t.dirty) {
          // Don't discard unsaved work; only flag if disk actually diverged.
          return content === current ? t : { ...t, externallyChanged: true };
        }
        if (content === current) return t; // no change, avoid needless render
        contentsRef.current.set(t.id, content);
        return { ...t, content, savedContent: content, dirty: false, externallyChanged: false };
      })
    );
  }, []);

  // Reload every open (clean) tab from disk — used after bulk operations like
  // find-and-replace-in-files that touch many files at once.
  const syncOpenTabsFromDisk = useCallback(async () => {
    const paths = tabsRef.current.map((t) => t.path).filter((p): p is string => !!p);
    await Promise.all(paths.map((p) => syncTabFromDisk(p)));
  }, [syncTabFromDisk]);

  // ---- File-watching: refresh tree + git branch on any workspace change ----
  useEffect(() => {
    if (!rootPath) return;
    invoke("watch_workspace", { path: rootPath }).catch(() => {});
    const unlistenPromise = listen<null>("workspace-changed", () => {
      setFileTreeVersion((v) => v + 1);
      refreshBranch();
      syncOpenTabsFromDisk();
    });
    return () => {
      invoke("unwatch_workspace").catch(() => {});
      unlistenPromise.then((f) => f());
    };
  }, [rootPath, refreshBranch, syncOpenTabsFromDisk]);

  // ---- File operations ----
  const openFile = useCallback(async (path: string, line?: number) => {
    const existing = tabsRef.current.find((t) => t.path === path);
    if (existing) {
      setActiveId(existing.id);
      const saved = cursorPositionsRef.current[path];
      setGotoLine(line ?? saved?.line ?? null);
      return;
    }
    try {
      const content = await readFile(path);
      const tab = newTab(path, content);
      setTabs((ts) => [...ts, tab]);
      setActiveId(tab.id);
      const saved = cursorPositionsRef.current[path];
      setGotoLine(line ?? saved?.line ?? null);
    } catch (e) {
      console.error("Failed to open file:", e);
      toast.error(t("app.openFailed", { name: basename(path), error: String(e) }));
    }
  }, []);

  const saveFile = useCallback(async () => {
    const tab = tabsRef.current.find((t) => t.id === activeIdRef.current);
    if (!tab) return;
    let filePath = tab.path;
    if (!filePath) {
      const selected = await save({
        title: t("app.saveFileTitle"),
        defaultPath: tab.title,
      });
      if (!selected) return;
      filePath = selected;
    }
    try {
      const content = contentsRef.current.get(tab.id) ?? tab.content;
      await writeFile(filePath, content);
      const ext = (filePath.split(".").pop() || "");
      setTabs((ts) =>
        ts.map((t) =>
          t.id === tab.id
            ? {
                ...t,
                path: filePath,
                title: basename(filePath),
                language: extToLanguage(ext),
                dirty: false,
                content,
                savedContent: content,
                externallyChanged: false,
              }
            : t
        )
      );
    } catch (e) {
      console.error("Failed to save:", e);
      toast.error(t("app.saveFailed", { name: basename(filePath), error: String(e) }));
    }
  }, []);

  const closeOtherTabs = useCallback((id: string) => {
    const tab = tabsRef.current.find((t) => t.id === id);
    setTabs(tab ? [tab] : []);
    setActiveId(id);
  }, []);

  const closeAllTabs = useCallback(() => {
    const t = newTab();
    setTabs([t]);
    setActiveId(t.id);
  }, []);

  const closeTab = useCallback(async (id: string) => {
    const tab = tabsRef.current.find((x) => x.id === id);
    if (!tab) return;
    if (tab.dirty) {
      const ok = await ask(
        t("app.closeDirtyConfirm", { name: tab.title }),
        { title: t("app.closeFileTitle"), kind: "warning" }
      );
      if (!ok) return;
    }

    // Free the Monaco model that backed this tab (kept alive by keepCurrentModel).
    setModelToDispose(tab.path ?? `untitled:${tab.id}`);
    contentsRef.current.delete(tab.id);

    const idx = tabsRef.current.findIndex((x) => x.id === id);
    const remaining = tabsRef.current.filter((x) => x.id !== id);

    if (remaining.length === 0) {
      const t = newTab();
      setTabs([t]);
      setActiveId(t.id);
      return;
    }
    if (id === activeIdRef.current) {
      const neighbor = remaining[Math.min(idx, remaining.length - 1)];
      setActiveId(neighbor.id);
    }
    setTabs(remaining);
  }, []);

  // Force-reload a tab from disk, discarding local unsaved edits (confirmed).
  const reloadTabFromDisk = useCallback(async (id: string) => {
    const tab = tabsRef.current.find((t) => t.id === id);
    if (!tab?.path) return;
    const ok = await ask(t("app.reloadConfirm", { name: tab.title }), {
      title: t("app.reloadTitle"), kind: "warning",
    });
    if (!ok) return;
    try {
      const content = await readFile(tab.path);
      contentsRef.current.set(id, content);
      setTabs((ts) =>
        ts.map((t) =>
          t.id === id ? { ...t, content, savedContent: content, dirty: false, externallyChanged: false } : t
        )
      );
    } catch { /* file gone; leave as-is */ }
  }, []);

  // ---- Editor callbacks (stable so MonacoWrapper's memo holds while typing) ----
  const handleCursorPosition = useCallback((line: number, col: number) => {
    cursorStore.set(line, col);
    const tab = tabsRef.current.find((t) => t.id === activeIdRef.current);
    if (tab?.path) cursorPositionsRef.current[tab.path] = { line, col };
  }, []);

  const handleEditorChange = useCallback((val: string) => {
    const id = activeIdRef.current;
    contentsRef.current.set(id, val);
    const tab = tabsRef.current.find((t) => t.id === id);
    if (!tab) return;
    const dirty = val !== tab.savedContent;
    if (dirty !== tab.dirty) {
      setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, dirty } : t)));
    }
  }, []);

  const handleToggleBreakpoint = useCallback((line: number) => {
    const tab = tabsRef.current.find((t) => t.id === activeIdRef.current);
    if (!tab?.path) return;
    debugController.toggleBreakpoint(tab.path, line);
  }, []);

  // ---- Debug session wiring ----
  const debugStopped = useDebugSelector(
    (s) => s.stopped,
    (a, b) => a?.path === b?.path && a?.line === b?.line
  );
  const activeTabPath = activeTab?.path ?? null;
  const activeBreakpoints = useDebugSelector(
    (s) => (activeTabPath ? s.breakpoints[activeTabPath] ?? NO_LINES : NO_LINES),
    (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
  );

  // Open + reveal the file where the debugger paused.
  useEffect(() => {
    if (debugStopped) openFile(debugStopped.path, debugStopped.line);
  }, [debugStopped, openFile]);

  // The adapter asks us to run the debuggee in a terminal (runInTerminal).
  useEffect(() => {
    debugController.setRunInTerminalHandler(async ({ argv, cwd, env, title }) => {
      const sessionId = await spawnTerminal(cwd ?? rootPathRef.current, argv[0], argv.slice(1), env);
      setShowTerminal(true);
      setTermAdoptions((xs) => [...xs, { key: crypto.randomUUID(), sessionId, title: title ?? t("app.debugTerminalTitle") }]);
    });
  }, []);

  const startDebug = useCallback(() => {
    const tab = tabsRef.current.find((t) => t.id === activeIdRef.current);
    setSidePanel("debug");
    debugController.start(tab?.path ?? null, rootPathRef.current);
  }, []);

  // ---- Open folder dialog ----
  const openFolder = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: t("app.openFolderTitle") });
      if (selected) {
        setRootPath(selected);
      }
    } catch (e) {
      console.error("Failed to open folder:", e);
    }
  }, []);

  // ---- Restore session on first mount ----
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    loadSession().then((s) => {
      if (!s) return;
      // If a startup file was passed via CLI, skip session restore
      invoke<string | null>("get_startup_file").then((p) => {
        if (p) { openFile(p); return; }
        // Restore session
        if (s.rootPath) setRootPath(s.rootPath);
        if (s.tabs.length === 0) return;
        if (s.cursorPositions) {
          cursorPositionsRef.current = { ...s.cursorPositions };
        }
        Promise.all(
          s.tabs.map(async (t) => {
            if (!t.path) return newTab();
            try {
              const content = await readFile(t.path);
              return newTab(t.path, content);
            } catch {
              return newTab(t.path);
            }
          })
        ).then((restoredTabs) => {
          const valid = restoredTabs.filter(Boolean) as Tab[];
          if (valid.length === 0) return;
          setTabs(valid);
          const idx = Math.min(s.activeIndex, valid.length - 1);
          setActiveId(valid[idx].id);
        });
      });
    });
    // Load extensions
    const mgr = extManagerRef.current;
    mgr.load(rootPath).then(() => {
      setExtPanels(mgr.getPanels("side-panel"));
      setExtCommands(mgr.getCommands());
      // Register extension languages
      const extLanguages = mgr.getLanguages();
      registerFsLanguages(extLanguages);
      registerLspLanguages(extLanguages);
      // Apply extension themes
      const themes = mgr.getThemes();
      if (themes.length > 0) {
        const root = document.documentElement;
        for (const theme of themes) {
          for (const [key, val] of Object.entries(theme.colors)) {
            root.style.setProperty(key, val);
          }
        }
      }
    });
    const un = listen<string>("open-file", (e) => {
      if (e.payload) openFile(e.payload);
    });
    return () => { un.then((f) => f()); };
  }, [openFile, rootPath]);

  // ---- Intercept window close ----
  useEffect(() => {
    const unlistenPromise = listen("close-requested", async () => {
      const dirtyCount = tabsRef.current.filter((t) => t.dirty).length;
      if (dirtyCount > 0) {
        const ok = await ask(
          t("app.exitConfirm", { count: dirtyCount }),
          { title: t("app.exitTitle"), kind: "warning" }
        );
        if (!ok) return;
      }
      invoke("exit_app").catch(() => {});
    });
    return () => { unlistenPromise.then((un) => un()); };
  }, []);

  // ---- Auto-save session ----
  const sessionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionKeyRef = useRef<string>("");
  useEffect(() => {
    if (sessionTimer.current) clearTimeout(sessionTimer.current);
    sessionTimer.current = setTimeout(() => {
      const tbs = tabsRef.current;
      const id = activeIdRef.current;
      if (tbs.length === 1 && !tbs[0].path && !tbs[0].dirty) return;
      const key = tbs.map((t) => t.path || `__${t.id}`).join("\x00") + "\x00" + id;
      if (key === sessionKeyRef.current) return;
      sessionKeyRef.current = key;
      const activeIndex = tbs.findIndex((t) => t.id === id);
      saveSession({
        rootPath: rootPath,
        tabs: tbs.map((t) => ({ path: t.path })),
        activeIndex: Math.max(0, activeIndex),
        cursorPositions: { ...cursorPositionsRef.current },
      });
    }, 500);
    return () => { if (sessionTimer.current) clearTimeout(sessionTimer.current); };
  }, [rootPath, activeId]);

  // ---- Keyboard shortcuts ----
  // VS Code-style chord: Ctrl+K arms it; Ctrl+O within 2s opens a folder.
  // Ctrl+K is NOT preventDefault'ed so Monaco's own Ctrl+K chords keep working.
  const chordArmedAt = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Debug function keys (VS Code-compatible)
      if (e.key === "F5") {
        e.preventDefault();
        if (e.shiftKey) { debugController.stop(); return; }
        const st = debugController.getState().status;
        if (st === "stopped") debugController.continue_();
        else if (st === "inactive" || st === "ended") startDebug();
        return;
      }
      if (e.key === "F9") {
        e.preventDefault();
        handleToggleBreakpoint(cursorStore.get().line);
        return;
      }
      if (e.key === "F10" && debugController.getState().status === "stopped") {
        e.preventDefault();
        debugController.next();
        return;
      }
      if (e.key === "F11" && debugController.getState().status === "stopped") {
        e.preventDefault();
        if (e.shiftKey) debugController.stepOut();
        else debugController.stepIn();
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      // Second half of the Ctrl+K Ctrl+O chord
      if (k === "o" && Date.now() - chordArmedAt.current < 2000) {
        e.preventDefault();
        chordArmedAt.current = 0;
        openFolder();
        return;
      }
      if (k === "k" && !e.shiftKey) {
        chordArmedAt.current = Date.now();
        return;
      }
      chordArmedAt.current = 0;
      if (k === "s") {
        e.preventDefault();
        saveFile();
      } else if (k === "`") {
        e.preventDefault();
        setShowTerminal((v) => !v);
      } else if (k === "w") {
        e.preventDefault();
        closeTab(activeIdRef.current);
      } else if (e.shiftKey && k === "i") {
        e.preventDefault();
        togglePanel("ai");
      } else if (e.shiftKey && k === "l") {
        e.preventDefault();
        togglePanel("lsp");
      } else if (e.shiftKey && k === "g") {
        e.preventDefault();
        togglePanel("git");
      } else if (e.shiftKey && k === "h") {
        e.preventDefault();
        togglePanel("github");
      } else if (e.shiftKey && k === "d") {
        e.preventDefault();
        togglePanel("debug");
      } else if (e.shiftKey && k === "f") {
        e.preventDefault();
        setShowSearch((v) => !v);
        setShowTerminal(false);
      } else if (e.shiftKey && k === "p") {
        e.preventDefault();
        setPalette("commands");
      } else if (k === "p") {
        e.preventDefault();
        setPalette("files");
      } else {
        // Extension command keybindings
        for (const cmd of extCommands) {
          if (!cmd.keybindings) continue;
          for (const kb of cmd.keybindings) {
            const parts = kb.toLowerCase().split("+");
            const matchCtrl = parts.includes("ctrl") || parts.includes("cmd");
            const matchShift = parts.includes("shift");
            const matchKey = parts[parts.length - 1] === k;
            if (matchCtrl === (e.ctrlKey || e.metaKey) && matchShift === e.shiftKey && matchKey) {
              e.preventDefault();
              dispatchExtCommand(cmd, setExtPanelVis);
              break;
            }
          }
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveFile, openFolder, closeTab, extCommands, startDebug, handleToggleBreakpoint, togglePanel]);

  // ---- Close the tab context menu on outside click / Escape ----
  useEffect(() => {
    if (!tabCtx) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el?.closest(".tab-context-menu")) setTabCtx(null);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTabCtx(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, [tabCtx]);

  // ---- Command palette registry ----
  const paletteCommands: PaletteCommand[] = useMemo(() => [
    { id: "file.save", label: t("cmd.saveFile"), hint: "Ctrl+S", run: () => saveFile() },
    { id: "file.openFolder", label: t("cmd.openFolder"), hint: "Ctrl+K Ctrl+O", run: () => openFolder() },
    { id: "file.newTab", label: t("cmd.newTab"), run: () => { const tb = newTab(); setTabs((ts) => [...ts, tb]); setActiveId(tb.id); } },
    { id: "file.closeTab", label: t("cmd.closeTab"), hint: "Ctrl+W", run: () => closeTab(activeIdRef.current) },
    { id: "debug.start", label: t("cmd.debugStart"), hint: "F5", run: () => startDebug() },
    { id: "debug.toggleBreakpoint", label: t("cmd.toggleBreakpoint"), hint: "F9", run: () => handleToggleBreakpoint(cursorStore.get().line) },
    { id: "view.debug", label: t("cmd.toggleDebugPanel"), hint: "Ctrl+Shift+D", run: () => togglePanel("debug") },
    { id: "view.terminal", label: t("cmd.toggleTerminal"), hint: "Ctrl+`", run: () => setShowTerminal((v) => !v) },
    { id: "view.search", label: t("cmd.toggleSearch"), hint: "Ctrl+Shift+F", run: () => setShowSearch((v) => !v) },
    { id: "view.git", label: t("cmd.toggleGit"), hint: "Ctrl+Shift+G", run: () => togglePanel("git") },
    { id: "view.github", label: t("cmd.toggleGitHub"), hint: "Ctrl+Shift+H", run: () => togglePanel("github") },
    { id: "view.ai", label: t("cmd.toggleAi"), hint: "Ctrl+Shift+I", run: () => togglePanel("ai") },
    { id: "view.lsp", label: t("cmd.toggleLsp"), hint: "Ctrl+Shift+L", run: () => togglePanel("lsp") },
    { id: "view.settings", label: t("common.settings"), run: () => togglePanel("settings") },
    ...extCommands.map((c) => ({
      id: c.id,
      label: c.title || c.id,
      hint: c.keybindings?.[0],
      run: () => dispatchExtCommand(c, setExtPanelVis),
    })),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [saveFile, openFolder, closeTab, extCommands, startDebug, handleToggleBreakpoint, togglePanel, locale]);

  return (
    <div className="app" key={locale}>
      {/* Title bar / menu */}
      <div className="title-bar">
        <div className="title-bar-menu">
          <span className="title-bar-brand">LocalCode</span>
        </div>
        <div className="title-bar-tabs">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`title-tab ${tab.id === activeId ? "active" : ""}`}
              onClick={() => setActiveId(tab.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setTabCtx({ id: tab.id, x: e.clientX, y: e.clientY });
              }}
              onMouseDown={(e) => {
                if (e.button === 1) closeTab(tab.id);
              }}
            >
              <span className="title-tab-title">
                {tab.externallyChanged && (
                  <span
                    className="title-tab-warning codicon codicon-warning"
                    title={t("app.tabExternallyChanged")}
                    onClick={(e) => { e.stopPropagation(); reloadTabFromDisk(tab.id); }}
                  />
                )}
                {tab.dirty && <span className="title-tab-dirty">● </span>}
                {tab.title}
              </span>
              <button
                className="title-tab-close"
                title={t("app.closeTab")}
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
              >
                <span className="codicon codicon-close" />
              </button>
            </div>
          ))}
          <button className="title-tab-new" title={t("app.newTab")} onClick={() => {
            const t = newTab();
            setTabs((ts) => [...ts, t]);
            setActiveId(t.id);
          }}><span className="codicon codicon-add" /></button>
          {tabCtx && tabs.length > 1 && (
            <div
              className="tab-context-menu"
              style={{ position: "fixed", left: tabCtx.x, top: tabCtx.y }}
              onClick={() => setTabCtx(null)}
              onContextMenu={(e) => e.preventDefault()}
            >
              <button onClick={() => { closeOtherTabs(tabCtx.id); setTabCtx(null); }}>
                {t("app.closeOthers")}
              </button>
              <button onClick={() => { closeAllTabs(); setTabCtx(null); }}>
                {t("app.closeAll")}
              </button>
            </div>
          )}
        </div>
        <div className="title-bar-actions">
          <button className="action-btn" onClick={saveFile} disabled={!activeTab?.dirty} title={t("app.saveTitle")}>
            <span className="codicon codicon-save" />
          </button>
          <button className={`action-btn ${sidePanel === "debug" ? "active" : ""}`} onClick={() => togglePanel("debug")} title={t("app.debugTitle")}>
            <span className="codicon codicon-debug-alt" />
          </button>
          <button className={`action-btn ${sidePanel === "ai" ? "active" : ""}`} onClick={() => togglePanel("ai")} title={t("app.aiTitle")}>
            <span className="codicon codicon-sparkle" />
          </button>
          <button className={`action-btn ${sidePanel === "lsp" ? "active" : ""}`} onClick={() => togglePanel("lsp")} title={t("app.lspTitle")}>
            <span className="codicon codicon-plug" />
          </button>
          <button className={`action-btn ${sidePanel === "github" ? "active" : ""}`} onClick={() => togglePanel("github")} title={t("app.githubTitle")}>
            <span className="codicon codicon-github-alt" />
          </button>
          <button className={`action-btn ${sidePanel === "git" ? "active" : ""}`} onClick={() => togglePanel("git")} title={t("app.gitTitle")}>
            <span className="codicon codicon-source-control" />
          </button>
          <button className={`action-btn ${showSearch ? "active" : ""}`} onClick={() => { setShowSearch((v) => !v); setShowTerminal(false); }} title={t("app.searchTitle")}>
            <span className="codicon codicon-search" />
          </button>
          <button className={`action-btn ${sidePanel === "settings" ? "active" : ""}`} onClick={() => togglePanel("settings")} title={t("common.settings")}>
            <span className="codicon codicon-settings-gear" />
          </button>
          <button className="action-btn" onClick={openFolder} title={t("app.openFolderHint")}>
            <span className="codicon codicon-folder-opened" />
          </button>
        </div>
      </div>

      <div className="workspace">
        {/* Sidebar: file explorer, outline, search */}
        <div className="sidebar">
          <FileExplorer
            rootPath={rootPath}
            onOpenFile={openFile}
            refreshSignal={fileTreeVersion}
            activePath={activeTab?.path ?? null}
          />
          {activeTab && rootPath && (
            <OutlinePanel
              language={activeTab.language}
              filePath={activeTab.path}
              onSelect={(line) => {
                setGotoLine(line + 1);
              }}
            />
          )}
          {showSearch && rootPath && (
            <SearchPanel
              rootPath={rootPath}
              onOpenFile={openFile}
              onReplaced={() => { setFileTreeVersion((v) => v + 1); syncOpenTabsFromDisk(); }}
            />
          )}
        </div>

        {/* Main editor area */}
        <div className="main-content">
          <div className="editor-area" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
            {activeTab && activeTab.path && rootPath && (
              <Breadcrumbs
                filePath={activeTab.path}
                rootPath={rootPath}
                onSelect={(line) => setGotoLine(line + 1)}
              />
            )}
            {activeTab && (
              <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
              <MonacoWrapper
                language={activeTab.language}
                value={liveContent(activeTab)}
                path={activeTab.path ?? `untitled:${activeTab.id}`}
                workspaceRoot={rootPath}
                gotoLine={gotoLine}
                disposeModelPath={modelToDispose}
                breakpoints={activeBreakpoints}
                onToggleBreakpoint={handleToggleBreakpoint}
                execLine={debugStopped && debugStopped.path === activeTab.path ? debugStopped.line : null}
                onCursorPosition={handleCursorPosition}
                onChange={handleEditorChange}
              />
              </div>
            )}
          </div>

          {/* Terminal */}
          {showTerminal && (
            <TerminalPanel
              workspaceRoot={rootPath}
              onClose={() => setShowTerminal(false)}
              adoptions={termAdoptions}
            />
          )}
        </div>

        {/* Right panel — one built-in panel at a time; extension panels stack below */}
        {(sidePanel !== null || Object.values(extPanelVis).some(Boolean)) && (
          <div className="side-panel">
            {sidePanel === "debug" && (
              <DebugPanel
                activeFilePath={activeTab?.path ?? null}
                workspaceRoot={rootPath}
                onOpenFile={openFile}
              />
            )}
            {sidePanel === "git" && <GitPanel repoPath={repoPath} />}
            {sidePanel === "github" && <GitHubPanel repoPath={repoPath} />}
            {sidePanel === "ai" && <AiPanel workspaceRoot={rootPath} onRefresh={() => setFileTreeVersion((v) => v + 1)} onFileChanged={syncTabFromDisk} />}
            {sidePanel === "lsp" && <LspSetupPanel />}
            {sidePanel === "settings" && <SettingsPanel onClose={() => setSidePanel(null)} />}
            {extPanels.map((p) => {
              if (!extPanelVis[p.id]) return null;
              return <ExtensionPanelRenderer key={p.id} panel={p} manager={extManagerRef.current} />;
            })}
          </div>
        )}
      </div>

      {/* Command palette */}
      {palette && (
        <CommandPalette
          mode={palette}
          rootPath={rootPath}
          commands={paletteCommands}
          onOpenFile={openFile}
          onClose={() => setPalette(null)}
        />
      )}

      {/* Status bar */}
      <StatusBar
        language={activeTab?.language}
        filePath={activeTab?.path}
        gitBranch={gitBranch}
      />

      {/* Global toasts */}
      <ToastHost />
    </div>
  );
}

function ExtensionPanelRenderer({ panel, manager }: { panel: ExtensionPanel; manager: ExtensionManager }) {
  const ComponentRef = useRef<any>(null);
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    manager.loadPanelComponent(panel).then((comp) => {
      if (comp) {
        ComponentRef.current = comp;
        forceUpdate((n) => n + 1);
      }
    });
  }, [panel, manager]);

  if (!ComponentRef.current) return <div className="side-panel-placeholder">{t("app.loadingExtension", { name: panel.title })}</div>;
  return <ComponentRef.current />;
}

export default App;
