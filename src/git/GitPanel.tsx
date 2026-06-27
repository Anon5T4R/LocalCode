import { useState, useEffect, useCallback, memo } from "react";
import type { StatusEntry, CommitEntry, BranchEntry } from "../types";
import { getStatus, getLog, getBranches, stageFiles, commit, push, pull, checkout } from "../lib/git";

interface GitPanelProps {
  repoPath: string | null;
}

export const GitPanel = memo(function GitPanel({ repoPath }: GitPanelProps) {
  const [status, setStatus] = useState<StatusEntry[]>([]);
  const [branches, setBranches] = useState<BranchEntry[]>([]);
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [commitMsg, setCommitMsg] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<"changes" | "history" | "branches">("changes");

  const refresh = useCallback(async () => {
    if (!repoPath) return;
    setLoading(true);
    try {
      const [s, l, b] = await Promise.all([
        getStatus(repoPath),
        getLog(repoPath, 10),
        getBranches(repoPath),
      ]);
      setStatus(s);
      setCommits(l);
      setBranches(b);
    } catch (e) {
      console.error("Git error:", e);
    }
    setLoading(false);
  }, [repoPath]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleStage = useCallback(
    async (paths: string[]) => {
      if (!repoPath) return;
      try {
        await stageFiles(repoPath, paths);
        refresh();
      } catch (e) {
        setMessage(`Erro: ${e}`);
      }
    },
    [repoPath, refresh]
  );

  const handleCommit = useCallback(async () => {
    if (!repoPath || !commitMsg.trim()) return;
    try {
      await commit(repoPath, commitMsg.trim());
      setCommitMsg("");
      setMessage("Commit realizado!");
      refresh();
    } catch (e) {
      setMessage(`Erro: ${e}`);
    }
  }, [repoPath, commitMsg, refresh]);

  const handlePush = useCallback(async () => {
    if (!repoPath) return;
    try {
      await push(repoPath);
      setMessage("Push realizado!");
    } catch (e) {
      setMessage(`Erro: ${e}`);
    }
  }, [repoPath]);

  const handlePull = useCallback(async () => {
    if (!repoPath) return;
    try {
      const msg = await pull(repoPath);
      setMessage(msg);
      refresh();
    } catch (e) {
      setMessage(`Erro: ${e}`);
    }
  }, [repoPath, refresh]);

  const handleCheckout = useCallback(async (branch: string) => {
    if (!repoPath) return;
    try {
      await checkout(repoPath, branch);
      setMessage(`Branch alterado para ${branch}`);
      refresh();
    } catch (e) {
      setMessage(`Erro: ${e}`);
    }
  }, [repoPath, refresh]);

  if (!repoPath) {
    return (
      <div className="git-panel">
        <div className="git-header">
          <span>Git</span>
        </div>
        <div className="git-empty-state">
          <p>Nenhum repositório</p>
          <p className="git-hint">Abra uma pasta com repositório Git</p>
        </div>
      </div>
    );
  }

  const stagedItems = status.filter((s) => s.staged);
  const unstagedItems = status.filter((s) => !s.staged);

  return (
    <div className="git-panel">
      <div className="git-header">
        <span>Git</span>
        <div className="git-actions">
          <button className="git-action-btn" onClick={handlePull} title="Pull">
            ↓
          </button>
          <button className="git-action-btn" onClick={handlePush} title="Push">
            ↑
          </button>
          <button className="git-action-btn" onClick={refresh} title="Atualizar">
            ↻
          </button>
        </div>
      </div>

      <div className="git-tabs">
        <button
          className={`git-tab ${tab === "changes" ? "active" : ""}`}
          onClick={() => setTab("changes")}
        >
          Alterações
        </button>
        <button
          className={`git-tab ${tab === "history" ? "active" : ""}`}
          onClick={() => setTab("history")}
        >
          Histórico
        </button>
        <button
          className={`git-tab ${tab === "branches" ? "active" : ""}`}
          onClick={() => setTab("branches")}
        >
          Branches
        </button>
      </div>

      {tab === "changes" && (
        <div className="git-changes">
          {stagedItems.length > 0 && (
            <div className="git-section">
              <div className="git-section-title">Staged ({stagedItems.length})</div>
              {stagedItems.map((s) => (
                <div key={s.path} className="git-status-item staged">
                  <span className={`git-status-badge ${s.status}`}>{s.status}</span>
                  <span className="git-status-path">{s.path}</span>
                </div>
              ))}
            </div>
          )}

          {unstagedItems.length > 0 && (
            <div className="git-section">
              <div className="git-section-title">Alterações ({unstagedItems.length})</div>
              {unstagedItems.map((s) => (
                <div
                  key={s.path}
                  className="git-status-item"
                  onClick={() => handleStage([s.path])}
                >
                  <span className={`git-status-badge ${s.status}`}>{s.status}</span>
                  <span className="git-status-path">{s.path}</span>
                </div>
              ))}
            </div>
          )}

          {status.length === 0 && !loading && (
            <div className="git-empty-state">Nenhuma alteração</div>
          )}

          <div className="git-commit-area">
            <textarea
              className="git-commit-input"
              placeholder="Mensagem do commit..."
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              rows={2}
            />
            <button
              className="git-commit-btn"
              onClick={handleCommit}
              disabled={!commitMsg.trim()}
            >
              Commit
            </button>
          </div>
        </div>
      )}

      {tab === "history" && (
        <div className="git-history">
          {loading && <div className="git-loading">Carregando...</div>}
          {commits.map((c) => (
            <div key={c.hash} className="git-commit-item">
              <span className="git-commit-hash">{c.hash}</span>
              <span className="git-commit-msg">{c.message}</span>
              <span className="git-commit-author">{c.author}</span>
            </div>
          ))}
          {commits.length === 0 && !loading && (
            <div className="git-empty-state">Nenhum commit</div>
          )}
        </div>
      )}

      {tab === "branches" && (
        <div className="git-branches">
          {branches.map((b) => (
            <div
              key={b.name}
              className={`git-branch-item ${b.current ? "current" : ""}`}
              onClick={() => !b.current && handleCheckout(b.name)}
            >
              <span className="git-branch-icon">{b.current ? "✓" : "○"}</span>
              <span className="git-branch-name">{b.name}</span>
            </div>
          ))}
          {branches.length === 0 && !loading && (
            <div className="git-empty-state">Nenhum branch</div>
          )}
        </div>
      )}

      {message && <div className="git-message">{message}</div>}
    </div>
  );
});
