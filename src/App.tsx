import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { open } from "@tauri-apps/plugin-dialog";
import { MonacoWrapper } from "./editor/MonacoWrapper";
import { FileExplorer } from "./explorer/FileExplorer";
import { GitPanel } from "./git/GitPanel";
import { GitHubPanel } from "./github/GitHubPanel";
import { TerminalPanel } from "./terminal/TerminalPanel";
import { StatusBar } from "./statusbar/StatusBar";
import { OutlinePanel } from "./outline/OutlinePanel";
import { SearchPanel } from "./search/SearchPanel";
import { AiPanel } from "./ai/AiPanel";
import { LspSetupPanel } from "./lsp-setup/LspSetupPanel";
import { SettingsPanel } from "./settings/SettingsPanel";
import { readFile, writeFile, extToLanguage } from "./lib/fs";
import { getBranches } from "./lib/git";
import { saveSession, loadSession } from "./lib/session";
import type { Tab } from "./types";
import { basename } from "./lib/path";
import "./App.css";

const TAB_ID = () => crypto.randomUUID();

function newTab(filePath?: string, content?: string): Tab {
  const name = filePath ? basename(filePath) : "sem-titulo";
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

function App() {
  const [tabs, setTabs] = useState<Tab[]>([newTab()]);
  const [activeId, setActiveId] = useState(tabs[0].id);
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showGit, setShowGit] = useState(false);
  const [showGitHub, setShowGitHub] = useState(false);
  const [showAi, setShowAi] = useState(false);
  const [showLspSetup, setShowLspSetup] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [gitBranch, setGitBranch] = useState<string>("");
  const [cursorLine, setCursorLine] = useState(1);
  const [cursorCol, setCursorCol] = useState(1);
  const [gotoLine, setGotoLine] = useState<number | null>(null);
  const [tabCtx, setTabCtx] = useState<{ id: string; x: number; y: number } | null>(null);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const cursorPositionsRef = useRef<Record<string, { line: number; col: number }>>({});

  // Reset gotoLine after MonacoWrapper consumes it
  useEffect(() => {
    if (gotoLine != null) setGotoLine(null);
  }, [gotoLine]);

  const activeTab = tabs.find((t) => t.id === activeId);
  const repoPath = rootPath;

  // ---- Git branch polling ----
  useEffect(() => {
    if (!rootPath) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const branches = await getBranches(rootPath);
        if (!cancelled) {
          const current = branches.find((b) => b.current);
          setGitBranch(current?.name || "");
        }
      } catch {
        if (!cancelled) setGitBranch("");
      }
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [rootPath]);

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
    }
  }, []);

  const saveFile = useCallback(async () => {
    const tab = tabsRef.current.find((t) => t.id === activeIdRef.current);
    if (!tab || !tab.path) return;
    try {
      await writeFile(tab.path, tab.content);
      setTabs((ts) => ts.map((t) => (t.id === tab.id ? { ...t, dirty: false, savedContent: t.content } : t)));
    } catch (e) {
      console.error("Failed to save:", e);
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
    const t = tabsRef.current.find((x) => x.id === id);
    if (!t) return;
    if (t.dirty) {
      const ok = await ask(`"${t.title}" tem alterações não salvas. Fechar mesmo assim?`, { title: "Fechar arquivo", kind: "warning" });
      if (!ok) return;
    }

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

  // ---- Open folder dialog ----
  const openFolder = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: "Abrir pasta" });
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
    const un = listen<string>("open-file", (e) => {
      if (e.payload) openFile(e.payload);
    });
    return () => { un.then((f) => f()); };
  }, [openFile]);

  // ---- Intercept window close ----
  useEffect(() => {
    const unlistenPromise = listen("close-requested", async () => {
      const dirtyCount = tabsRef.current.filter((t) => t.dirty).length;
      if (dirtyCount > 0) {
        const ok = await ask(
          `Você tem ${dirtyCount} arquivo(s) com alterações não salvas.\nSair mesmo assim?`,
          { title: "Sair do LocalCode", kind: "warning" }
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "s") {
        e.preventDefault();
        saveFile();
      } else if (k === "`") {
        e.preventDefault();
        setShowTerminal((v) => !v);
      } else if (k === "k" && e.shiftKey) {
        e.preventDefault();
        openFolder();
      } else if (k === "w") {
        e.preventDefault();
        closeTab(activeIdRef.current);
      } else if (e.shiftKey && k === "i") {
        e.preventDefault();
        setShowAi((v) => !v);
        setShowLspSetup(false);
        setShowGit(false);
        setShowGitHub(false);
      } else if (e.shiftKey && k === "l") {
        e.preventDefault();
        setShowLspSetup((v) => !v);
        setShowAi(false);
        setShowGit(false);
        setShowGitHub(false);
      } else if (e.shiftKey && k === "g") {
        e.preventDefault();
        setShowGit((v) => !v);
        setShowAi(false);
        setShowLspSetup(false);
        setShowGitHub(false);
      } else if (e.shiftKey && k === "h") {
        e.preventDefault();
        setShowGitHub((v) => !v);
        setShowAi(false);
        setShowLspSetup(false);
        setShowGit(false);
      } else if (e.shiftKey && k === "f") {
        e.preventDefault();
        setShowSearch((v) => !v);
        setShowTerminal(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveFile, openFolder, closeTab]);

  return (
    <div className="app">
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
                {tab.dirty && <span className="title-tab-dirty">● </span>}
                {tab.title}
              </span>
              <button
                className="title-tab-close"
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
              >
                ✕
              </button>
            </div>
          ))}
          <button className="title-tab-new" onClick={() => {
            const t = newTab();
            setTabs((ts) => [...ts, t]);
            setActiveId(t.id);
          }}>+</button>
          {tabCtx && tabs.length > 1 && (
            <div
              className="tab-context-menu"
              style={{ position: "fixed", left: tabCtx.x, top: tabCtx.y }}
              onClick={() => setTabCtx(null)}
              onContextMenu={(e) => e.preventDefault()}
            >
              <button onClick={() => { closeOtherTabs(tabCtx.id); setTabCtx(null); }}>
                Fechar outros
              </button>
              <button onClick={() => { closeAllTabs(); setTabCtx(null); }}>
                Fechar todos
              </button>
            </div>
          )}
        </div>
        <div className="title-bar-actions">
          <button className="action-btn" onClick={saveFile} disabled={!activeTab?.dirty} title="Salvar (Ctrl+S)">
            💾
          </button>
          <button className="action-btn" onClick={() => setShowAi((v) => !v)} title="AI (Ctrl+Shift+I)">
            AI
          </button>
          <button className="action-btn" onClick={() => setShowLspSetup((v) => !v)} title="LSP (Ctrl+Shift+L)">
            LSP
          </button>
          <button className="action-btn" onClick={() => setShowGitHub((v) => !v)} title="GitHub (Ctrl+Shift+H)">
            GitHub
          </button>
          <button className="action-btn" onClick={() => setShowGit((v) => !v)} title="Git (Ctrl+Shift+G)">
            Git
          </button>
          <button className="action-btn" onClick={() => { setShowSearch((v) => !v); setShowTerminal(false); }} title="Pesquisar (Ctrl+Shift+F)">
            🔍
          </button>
          <button className="action-btn" onClick={() => setShowSettings((v) => !v)} title="Configurações">
            ⚙️
          </button>
          <button className="action-btn" onClick={openFolder} title="Abrir pasta (Ctrl+K Ctrl+O)">
            📂
          </button>
        </div>
      </div>

      <div className="workspace">
        {/* Sidebar: file explorer, outline, search */}
        <div className="sidebar">
          <FileExplorer
            rootPath={rootPath}
            onOpenFile={openFile}
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
            <SearchPanel rootPath={rootPath} onOpenFile={openFile} />
          )}
        </div>

        {/* Main editor area */}
        <div className="main-content">
          <div className="editor-area">
            {activeTab && (
              <MonacoWrapper
                key={activeTab.id}
                language={activeTab.language}
                value={activeTab.content}
                path={activeTab.path || undefined}
                workspaceRoot={rootPath}
                gotoLine={gotoLine}
                onCursorPosition={(line, col) => {
                  setCursorLine(line);
                  setCursorCol(col);
                  const tab = tabsRef.current.find((t) => t.id === activeIdRef.current);
                  if (tab?.path) {
                    cursorPositionsRef.current[tab.path] = { line, col };
                  }
                }}
                onChange={(val) => {
                  setTabs((ts) =>
                    ts.map((t) =>
                      t.id === activeIdRef.current
                        ? { ...t, content: val, dirty: val !== t.savedContent }
                        : t
                    )
                  );
                }}
              />
            )}
          </div>

          {/* Terminal */}
          {showTerminal && (
            <TerminalPanel onClose={() => setShowTerminal(false)} />
          )}
        </div>

        {/* Right panels */}
        {(showGit || showGitHub || showAi || showLspSetup || showSettings) && (
          <div className="side-panel">
            {showGit && <GitPanel repoPath={repoPath} />}
            {showGitHub && <GitHubPanel repoPath={repoPath} />}
            {showAi && <AiPanel workspaceRoot={rootPath} />}
            {showLspSetup && <LspSetupPanel />}
            {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
          </div>
        )}
      </div>

      {/* Status bar */}
      <StatusBar
        language={activeTab?.language}
        filePath={activeTab?.path}
        gitBranch={gitBranch}
        line={cursorLine}
        column={cursorCol}
      />
    </div>
  );
}

export default App;
