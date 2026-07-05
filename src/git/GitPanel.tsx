import { useState, useEffect, useCallback, memo } from "react";
import type { StatusEntry, CommitEntry, BranchEntry } from "../types";
import { getStatus, getLog, getBranches, stageFiles, unstageFiles, discardFiles, diffFile, commit, push, pull, checkout } from "../lib/git";
import { toast } from "../lib/toast";
import { t } from "../lib/i18n";

interface GitPanelProps {
  repoPath: string | null;
}

/** Which long-running remote/write action is in flight (disables its button + shows spinner). */
type Busy = "push" | "pull" | "commit" | null;

export const GitPanel = memo(function GitPanel({ repoPath }: GitPanelProps) {
  const [status, setStatus] = useState<StatusEntry[]>([]);
  const [branches, setBranches] = useState<BranchEntry[]>([]);
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [commitMsg, setCommitMsg] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [tab, setTab] = useState<"changes" | "history" | "branches">("changes");
  const [diff, setDiff] = useState<{ path: string; staged: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    if (!repoPath) return;
    setLoading(true);
    try {
      const [s, l, b] = await Promise.all([
        getStatus(repoPath),
        getLog(repoPath, 50),
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
        toast.error(t("git.stageFailed", { error: String(e) }));
      }
    },
    [repoPath, refresh]
  );

  const handleUnstage = useCallback(
    async (paths: string[]) => {
      if (!repoPath) return;
      try {
        await unstageFiles(repoPath, paths);
        refresh();
      } catch (e) {
        toast.error(t("git.unstageFailed", { error: String(e) }));
      }
    },
    [repoPath, refresh]
  );

  const handleDiscard = useCallback(
    async (path: string) => {
      if (!repoPath) return;
      const { ask } = await import("@tauri-apps/plugin-dialog");
      const ok = await ask(t("git.discardConfirm", { name: path }), {
        title: t("git.discard"), kind: "warning",
      });
      if (!ok) return;
      try {
        await discardFiles(repoPath, [path]);
        toast.success(t("git.discarded", { name: path }));
        refresh();
      } catch (e) {
        toast.error(t("git.discardFailed", { error: String(e) }));
      }
    },
    [repoPath, refresh]
  );

  const handleShowDiff = useCallback(
    async (path: string, staged: boolean) => {
      if (!repoPath) return;
      try {
        const text = await diffFile(repoPath, path, staged);
        setDiff({ path, staged, text });
      } catch (e) {
        toast.error(t("git.diffFailed", { error: String(e) }));
      }
    },
    [repoPath]
  );

  const handleCommit = useCallback(async () => {
    if (!repoPath || !commitMsg.trim() || busy) return;
    setBusy("commit");
    try {
      await commit(repoPath, commitMsg.trim());
      setCommitMsg("");
      toast.success(t("git.commitDone"));
      refresh();
    } catch (e) {
      toast.error(t("git.commitFailed", { error: String(e) }));
    }
    setBusy(null);
  }, [repoPath, commitMsg, busy, refresh]);

  const handlePush = useCallback(async () => {
    if (!repoPath || busy) return;
    setBusy("push");
    try {
      await push(repoPath);
      toast.success(t("git.pushDone"));
    } catch (e) {
      toast.error(t("git.pushFailed", { error: String(e) }));
    }
    setBusy(null);
  }, [repoPath, busy]);

  const handlePull = useCallback(async () => {
    if (!repoPath || busy) return;
    setBusy("pull");
    try {
      const msg = await pull(repoPath);
      toast.success(msg);
      refresh();
    } catch (e) {
      toast.error(t("git.pullFailed", { error: String(e) }));
    }
    setBusy(null);
  }, [repoPath, busy, refresh]);

  const handleCheckout = useCallback(async (branch: string) => {
    if (!repoPath) return;
    try {
      await checkout(repoPath, branch);
      toast.success(t("git.checkoutDone", { name: branch }));
      refresh();
    } catch (e) {
      toast.error(t("git.checkoutFailed", { error: String(e) }));
    }
  }, [repoPath, refresh]);

  if (!repoPath) {
    return (
      <div className="git-panel">
        <div className="git-header">
          <span>Git</span>
        </div>
        <div className="git-empty-state">
          <p>{t("git.noRepo")}</p>
          <p className="git-hint">{t("git.noRepoHint")}</p>
        </div>
      </div>
    );
  }

  const stagedItems = status.filter((s) => s.staged);
  const unstagedItems = status.filter((s) => !s.staged);

  return (
    <div className="git-panel" style={{ position: "relative" }}>
      <div className="git-header">
        <span>Git</span>
        <div className="git-actions">
          <button className="git-action-btn" onClick={handlePull} disabled={busy !== null} title="Pull">
            <span className={`codicon ${busy === "pull" ? "codicon-sync codicon-modifier-spin" : "codicon-arrow-down"}`} />
          </button>
          <button className="git-action-btn" onClick={handlePush} disabled={busy !== null} title="Push">
            <span className={`codicon ${busy === "push" ? "codicon-sync codicon-modifier-spin" : "codicon-arrow-up"}`} />
          </button>
          <button className="git-action-btn" onClick={refresh} title={t("common.refresh")}>
            <span className="codicon codicon-refresh" />
          </button>
        </div>
      </div>

      <div className="git-tabs">
        <button
          className={`git-tab ${tab === "changes" ? "active" : ""}`}
          onClick={() => setTab("changes")}
        >
          {t("git.changes")}
        </button>
        <button
          className={`git-tab ${tab === "history" ? "active" : ""}`}
          onClick={() => setTab("history")}
        >
          {t("git.history")}
        </button>
        <button
          className={`git-tab ${tab === "branches" ? "active" : ""}`}
          onClick={() => setTab("branches")}
        >
          {t("git.branches")}
        </button>
      </div>

      {tab === "changes" && (
        <div className="git-changes">
          {stagedItems.length > 0 && (
            <div className="git-section">
              <div className="git-section-title git-section-title-row">
                <span>{t("git.staged")} ({stagedItems.length})</span>
                <button
                  className="git-action-btn"
                  onClick={() => handleUnstage(stagedItems.map((s) => s.path))}
                  title={t("git.unstageAll")}
                >
                  <span className="codicon codicon-remove" />
                </button>
              </div>
              {stagedItems.map((s) => (
                <div key={s.path} className="git-status-item staged">
                  <span
                    className={`git-status-badge ${s.status}`}
                    onClick={() => handleShowDiff(s.path, true)}
                    style={{ cursor: "pointer" }}
                    title={t("git.viewDiffStaged")}
                  >
                    {s.status}
                  </span>
                  <span
                    className="git-status-path"
                    onClick={() => handleShowDiff(s.path, true)}
                    style={{ cursor: "pointer" }}
                  >
                    {s.path}
                  </span>
                  <button
                    className="git-action-btn"
                    onClick={() => handleUnstage([s.path])}
                    title={t("git.unstage")}
                    style={{ marginLeft: "auto" }}
                  >
                    <span className="codicon codicon-remove" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {unstagedItems.length > 0 && (
            <div className="git-section">
              <div className="git-section-title git-section-title-row">
                <span>{t("git.changes")} ({unstagedItems.length})</span>
                <button
                  className="git-action-btn"
                  onClick={() => handleStage(unstagedItems.map((s) => s.path))}
                  title={t("git.stageAll")}
                >
                  <span className="codicon codicon-add" />
                </button>
              </div>
              {unstagedItems.map((s) => (
                <div key={s.path} className="git-status-item">
                  <span
                    className={`git-status-badge ${s.status}`}
                    onClick={() => handleShowDiff(s.path, false)}
                    style={{ cursor: "pointer" }}
                    title={t("git.viewDiff")}
                  >
                    {s.status}
                  </span>
                  <span
                    className="git-status-path"
                    onClick={() => handleShowDiff(s.path, false)}
                    style={{ cursor: "pointer" }}
                  >
                    {s.path}
                  </span>
                  <div style={{ marginLeft: "auto", display: "flex", gap: 2 }}>
                    {s.status !== "untracked" && (
                      <button
                        className="git-action-btn"
                        onClick={() => handleDiscard(s.path)}
                        title={t("git.discard")}
                      >
                        <span className="codicon codicon-discard" />
                      </button>
                    )}
                    <button
                      className="git-action-btn"
                      onClick={() => handleStage([s.path])}
                      title={t("git.stage")}
                    >
                      <span className="codicon codicon-add" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {status.length === 0 && !loading && (
            <div className="git-empty-state">{t("git.noChanges")}</div>
          )}

          <div className="git-commit-area">
            <textarea
              className="git-commit-input"
              placeholder={t("git.commitPlaceholder")}
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              rows={2}
            />
            <button
              className="git-commit-btn"
              onClick={handleCommit}
              disabled={!commitMsg.trim() || busy !== null}
            >
              {busy === "commit" ? t("git.committing") : "Commit"}
            </button>
          </div>
        </div>
      )}

      {tab === "history" && (
        <div className="git-history">
          {loading && <div className="git-loading">{t("common.loading")}</div>}
          {commits.map((c) => (
            <div key={c.hash} className="git-commit-item">
              <span className="git-commit-hash">{c.hash}</span>
              <span className="git-commit-msg">{c.message}</span>
              <span className="git-commit-author">{c.author}</span>
            </div>
          ))}
          {commits.length === 0 && !loading && (
            <div className="git-empty-state">{t("git.noCommits")}</div>
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
              <span className={`git-branch-icon codicon ${b.current ? "codicon-check" : "codicon-git-branch"}`} />
              <span className="git-branch-name">{b.name}</span>
            </div>
          ))}
          {branches.length === 0 && !loading && (
            <div className="git-empty-state">{t("git.noBranches")}</div>
          )}
        </div>
      )}

      {diff && (
        <div className="git-diff-overlay" onClick={() => setDiff(null)}>
          <div className="git-diff-header" onClick={(e) => e.stopPropagation()}>
            <span className="git-diff-mode">{diff.staged ? "STAGED" : "WORKDIR"}</span>
            <span className="git-diff-path">{diff.path}</span>
            <button className="git-action-btn" style={{ marginLeft: "auto" }} onClick={() => setDiff(null)} title={t("common.close")}>
              <span className="codicon codicon-close" />
            </button>
          </div>
          <pre className="git-diff-body" onClick={(e) => e.stopPropagation()}>
            {diff.text.split("\n").map((line, i) => {
              let cls = "";
              if (line.startsWith("+")) cls = "add";
              else if (line.startsWith("-")) cls = "del";
              else if (line.startsWith("@@")) cls = "hunk";
              return (
                <div key={i} className={`git-diff-line ${cls}`}>
                  {line || " "}
                </div>
              );
            })}
          </pre>
        </div>
      )}
    </div>
  );
});
