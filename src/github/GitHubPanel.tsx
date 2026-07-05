import { useState, useCallback, useEffect, useRef, memo } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { RepoEntry } from "../types";
import { setToken, getToken, removeToken, listRepos, createRepo, createPullRequest, cloneRepo, deviceLogin, pollToken } from "../lib/github";
import { loadSettings } from "../lib/settings";
import { toast } from "../lib/toast";
import { t } from "../lib/i18n";

interface GitHubPanelProps {
  repoPath: string | null;
}

export const GitHubPanel = memo(function GitHubPanel({ repoPath }: GitHubPanelProps) {
  const [token, setLocalToken] = useState<string>("");
  const [savedToken, setSavedToken] = useState<string | null>(null);
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<"auth" | "repos" | "pr">("auth");

  // Device flow state
  const [deviceCode, setDeviceCode] = useState("");
  const [userCode, setUserCode] = useState("");
  const [deviceUrl, setDeviceUrl] = useState("");
  const [polling, setPolling] = useState(false);
  const pollRef = useRef(false);

  // Create repo form
  const [newRepoName, setNewRepoName] = useState("");
  const [newRepoDesc, setNewRepoDesc] = useState("");
  const [newRepoPrivate, setNewRepoPrivate] = useState(false);

  // PR form
  const [prOwner, setPrOwner] = useState("");
  const [prRepo, setPrRepo] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [prHead, setPrHead] = useState("");
  const [prBase, setPrBase] = useState("main");

  // Clone form
  const [cloneUrl, setCloneUrl] = useState("");

  const checkToken = useCallback(async () => {
    try {
      const t = await getToken();
      if (t) {
        setSavedToken(t);
        setLocalToken("****");
        setTab("repos");
      }
    } catch { /* no token */ }
  }, []);

  useEffect(() => {
    checkToken();
  }, [checkToken]);

  // Device flow: start login
  const handleDeviceLogin = useCallback(async () => {
    const settings = loadSettings();
    const clientId = settings.githubClientId;
    if (!clientId) {
      toast.error(t("github.configureClientId"));
      return;
    }
    setLoading(true);
    try {
      const resp = await deviceLogin(clientId);
      setDeviceCode(resp.device_code);
      setUserCode(resp.user_code);
      setDeviceUrl(resp.verification_uri);
      openUrl(resp.verification_uri);
      // Start polling
      setPolling(true);
      pollRef.current = true;
    } catch (e: any) {
      toast.error(t("github.loginFailed", { error: String(e) }));
    }
    setLoading(false);
  }, []);

  // Poll for token
  useEffect(() => {
    if (!polling || !deviceCode) return;
    const settings = loadSettings();
    const clientId = settings.githubClientId;
    let cancelled = false;

    const doPoll = async () => {
      while (pollRef.current && !cancelled) {
        try {
          const newToken = await pollToken(deviceCode, clientId);
          if (!pollRef.current || cancelled) return;
          // Success!
          await setToken(newToken);
          setSavedToken(newToken);
          setLocalToken("****");
          setPolling(false);
          toast.success(t("github.loginDone"));
          setTab("repos");
          return;
        } catch (e: any) {
          if (!pollRef.current || cancelled) return;
          if (e === "slow_down") {
            await new Promise((r) => setTimeout(r, 10000));
            continue;
          }
          if (e !== "pending") {
            setPolling(false);
            toast.error(t("github.authFailed", { error: String(e) }));
            return;
          }
          // pending - wait and retry
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    };
    doPoll();
    return () => { cancelled = true; };
  }, [polling, deviceCode]);

  const handleCancelPoll = useCallback(() => {
    pollRef.current = false;
    setPolling(false);
    setDeviceCode("");
    setUserCode("");
  }, []);

  const handleSaveToken = useCallback(async () => {
    if (!token.trim() || savedToken) return;
    try {
      await setToken(token.trim());
      setSavedToken(token.trim());
      toast.success(t("github.tokenSaved"));
      setTab("repos");
    } catch (e) {
      toast.error(t("github.tokenSaveFailed", { error: String(e) }));
    }
  }, [token, savedToken]);

  const handleRemoveToken = useCallback(async () => {
    try {
      await removeToken();
      setSavedToken(null);
      setLocalToken("");
      setRepos([]);
      setPolling(false);
      pollRef.current = false;
      toast.success(t("github.tokenRemoved"));
      setTab("auth");
    } catch (e) {
      toast.error(t("github.tokenRemoveFailed", { error: String(e) }));
    }
  }, []);

  const handleListRepos = useCallback(async () => {
    if (!savedToken) return;
    setLoading(true);
    try {
      const r = await listRepos(savedToken);
      setRepos(r);
    } catch (e) {
      toast.error(t("github.listFailed", { error: String(e) }));
    }
    setLoading(false);
  }, [savedToken]);

  const handleCreateRepo = useCallback(async () => {
    if (!savedToken || !newRepoName.trim()) return;
    setLoading(true);
    try {
      await createRepo(savedToken, newRepoName.trim(), newRepoPrivate, newRepoDesc.trim());
      toast.success(t("github.repoCreated", { name: newRepoName }));
      setNewRepoName("");
      setNewRepoDesc("");
      handleListRepos();
    } catch (e) {
      toast.error(t("github.repoCreateFailed", { error: String(e) }));
    }
    setLoading(false);
  }, [savedToken, newRepoName, newRepoPrivate, newRepoDesc, handleListRepos]);

  const handleCreatePR = useCallback(async () => {
    if (!savedToken || !prOwner || !prRepo || !prTitle || !prHead) return;
    setLoading(true);
    try {
      const result = await createPullRequest(savedToken, prOwner, prRepo, prTitle, prBody, prHead, prBase);
      toast.success(t("github.prCreated", { number: result.number, url: result.url }));
      setPrTitle("");
      setPrBody("");
    } catch (e) {
      toast.error(t("github.prCreateFailed", { error: String(e) }));
    }
    setLoading(false);
  }, [savedToken, prOwner, prRepo, prTitle, prBody, prHead, prBase]);

  const handleClone = useCallback(async () => {
    if (!cloneUrl.trim() || !repoPath) return;
    setLoading(true);
    try {
      const dest = repoPath.replace(/\\/g, "/") + "/" + cloneUrl.split("/").pop()?.replace(".git", "");
      await cloneRepo(cloneUrl.trim(), dest);
      toast.success(t("github.cloned", { dest }));
      setCloneUrl("");
    } catch (e) {
      toast.error(t("github.cloneFailed", { error: String(e) }));
    }
    setLoading(false);
  }, [cloneUrl, repoPath]);

  return (
    <div className="github-panel">
      <div className="github-header">
        <span>GitHub</span>
        {savedToken && (
          <div className="github-header-actions">
            <button className="github-action-btn" onClick={handleRemoveToken} title={t("github.removeToken")}>
              <span className="codicon codicon-sign-out" />
            </button>
          </div>
        )}
      </div>

      <div className="github-tabs">
        <button
          className={`github-tab ${tab === "auth" ? "active" : ""}`}
          onClick={() => setTab("auth")}
        >
          Auth
        </button>
        <button
          className={`github-tab ${tab === "repos" ? "active" : ""}`}
          onClick={() => { setTab("repos"); if (savedToken) handleListRepos(); }}
          disabled={!savedToken}
        >
          Repos
        </button>
        <button
          className={`github-tab ${tab === "pr" ? "active" : ""}`}
          onClick={() => setTab("pr")}
          disabled={!savedToken}
        >
          PR
        </button>
      </div>

      {tab === "auth" && (
        <div className="github-auth">
          {polling ? (
            <div className="github-device-flow">
              <p className="github-device-step">
                <strong>{t("github.step1")}</strong> {t("github.step1Text")}
              </p>
              <button className="github-open-browser-btn" onClick={() => openUrl(deviceUrl)}>
                {t("github.openBrowser")}
              </button>
              <p className="github-device-step">
                {t("github.orManually")} <span className="github-link" onClick={() => openUrl(deviceUrl)}>{deviceUrl}</span>
              </p>

              <p className="github-device-step">
                <strong>{t("github.step2")}</strong> {t("github.step2Text")}
              </p>
              <div>
                <span className="github-user-code" onClick={() => navigator.clipboard.writeText(userCode)} title={t("github.clickToCopy")}>{userCode}</span>
                <button className="github-copy-code-btn" onClick={() => navigator.clipboard.writeText(userCode)}>
                  {t("github.copy")}
                </button>
              </div>

              <p className="github-device-step">
                <strong>{t("github.step3")}</strong> {t("github.step3Text")}
              </p>
              <p className="github-device-step">
                <span className="github-polling-indicator"></span>
                {t("github.waiting")}
              </p>
              <button className="github-cancel-btn" onClick={handleCancelPoll}>
                {t("common.cancel")}
              </button>
            </div>
          ) : (
            <>
              <p className="github-info">
                {t("github.loginInfo")}
              </p>
              <button className="github-btn" onClick={handleDeviceLogin} disabled={loading}>
                {t("github.loginBtn")}
              </button>
              <hr className="github-divider" />
              <p className="github-info">
                {t("github.patInfo")}
              </p>
              <input
                className="github-input"
                type="password"
                placeholder="Personal Access Token"
                value={savedToken ? "****" : token}
                onChange={(e) => setLocalToken(e.target.value)}
              />
              <button className="github-btn" onClick={handleSaveToken} disabled={!token.trim() || savedToken !== null}>
                {t("github.saveToken")}
              </button>
            </>
          )}
        </div>
      )}

      {tab === "repos" && (
        <div className="github-repos">
          <div className="github-section">
            <div className="github-section-title">{t("github.cloneSection")}</div>
            <input
              className="github-input"
              placeholder="https://github.com/user/repo.git"
              value={cloneUrl}
              onChange={(e) => setCloneUrl(e.target.value)}
            />
            <button
              className="github-btn"
              onClick={handleClone}
              disabled={!cloneUrl.trim() || !repoPath}
            >
              {t("github.clone")}
            </button>
          </div>

          <div className="github-section">
            <div className="github-section-title">{t("github.createSection")}</div>
            <input
              className="github-input"
              placeholder={t("github.repoName")}
              value={newRepoName}
              onChange={(e) => setNewRepoName(e.target.value)}
            />
            <input
              className="github-input"
              placeholder={t("github.repoDesc")}
              value={newRepoDesc}
              onChange={(e) => setNewRepoDesc(e.target.value)}
            />
            <label className="github-checkbox">
              <input
                type="checkbox"
                checked={newRepoPrivate}
                onChange={(e) => setNewRepoPrivate(e.target.checked)}
              />
              {t("github.private")}
            </label>
            <button
              className="github-btn"
              onClick={handleCreateRepo}
              disabled={!newRepoName.trim() || loading}
            >
              {t("github.create")}
            </button>
          </div>

          <div className="github-section">
            <div className="github-section-title">{t("github.myRepos")}</div>
            <button className="github-btn" onClick={handleListRepos} disabled={loading}>
              {loading ? t("common.loading") : t("common.refresh")}
            </button>
            {repos.map((r) => (
              <div key={r.full_name} className="github-repo-item">
                <span
                  className={`github-repo-icon codicon ${r.private ? "codicon-lock" : "codicon-repo"}`}
                  title={r.private ? t("github.private") : t("github.public")}
                />
                <div className="github-repo-info">
                  <span className="github-repo-name">{r.full_name}</span>
                  {r.description && <span className="github-repo-desc">{r.description}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "pr" && (
        <div className="github-pr">
          <input
            className="github-input"
            placeholder={t("github.prOwner")}
            value={prOwner}
            onChange={(e) => setPrOwner(e.target.value)}
          />
          <input
            className="github-input"
            placeholder={t("github.prRepo")}
            value={prRepo}
            onChange={(e) => setPrRepo(e.target.value)}
          />
          <input
            className="github-input"
            placeholder={t("github.prTitle")}
            value={prTitle}
            onChange={(e) => setPrTitle(e.target.value)}
          />
          <textarea
            className="github-input github-textarea"
            placeholder={t("github.prBody")}
            value={prBody}
            onChange={(e) => setPrBody(e.target.value)}
            rows={3}
          />
          <input
            className="github-input"
            placeholder={t("github.prHead")}
            value={prHead}
            onChange={(e) => setPrHead(e.target.value)}
          />
          <input
            className="github-input"
            placeholder={t("github.prBase")}
            value={prBase}
            onChange={(e) => setPrBase(e.target.value)}
          />
          <button
            className="github-btn"
            onClick={handleCreatePR}
            disabled={!prOwner || !prRepo || !prTitle || !prHead || loading}
          >
            {t("github.createPr")}
          </button>
        </div>
      )}
    </div>
  );
});
