import { useState, useCallback, useEffect } from "react";
import type { RepoEntry } from "../types";

interface GitHubPanelProps {
  repoPath: string | null;
}

export function GitHubPanel({ repoPath }: GitHubPanelProps) {
  const [token, setLocalToken] = useState<string>("");
  const [savedToken, setSavedToken] = useState<string | null>(null);
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<"auth" | "repos" | "pr">("auth");

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
      const { getToken } = await import("../lib/github");
      const t = await getToken();
      if (t) {
        setSavedToken(t);
        setLocalToken("****");
        setTab("repos");
      }
    } catch (e) {
      // no token
    }
  }, []);

  useEffect(() => {
    checkToken();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSaveToken = useCallback(async () => {
    if (!token.trim() || savedToken) return;
    try {
      const { setToken } = await import("../lib/github");
      await setToken(token.trim());
      setSavedToken(token.trim());
      setMessage("Token salvo!");
      setTab("repos");
    } catch (e) {
      setMessage(`Erro: ${e}`);
    }
  }, [token, savedToken]);

  const handleRemoveToken = useCallback(async () => {
    try {
      const { removeToken } = await import("../lib/github");
      await removeToken();
      setSavedToken(null);
      setLocalToken("");
      setRepos([]);
      setMessage("Token removido");
      setTab("auth");
    } catch (e) {
      setMessage(`Erro: ${e}`);
    }
  }, []);

  const handleListRepos = useCallback(async () => {
    if (!savedToken) return;
    setLoading(true);
    try {
      const { listRepos } = await import("../lib/github");
      const r = await listRepos(savedToken);
      setRepos(r);
    } catch (e) {
      setMessage(`Erro: ${e}`);
    }
    setLoading(false);
  }, [savedToken]);

  const handleCreateRepo = useCallback(async () => {
    if (!savedToken || !newRepoName.trim()) return;
    setLoading(true);
    try {
      const { createRepo } = await import("../lib/github");
      await createRepo(savedToken, newRepoName.trim(), newRepoPrivate, newRepoDesc.trim());
      setMessage(`Repositório "${newRepoName}" criado!`);
      setNewRepoName("");
      setNewRepoDesc("");
      handleListRepos();
    } catch (e) {
      setMessage(`Erro: ${e}`);
    }
    setLoading(false);
  }, [savedToken, newRepoName, newRepoPrivate, newRepoDesc, handleListRepos]);

  const handleCreatePR = useCallback(async () => {
    if (!savedToken || !prOwner || !prRepo || !prTitle || !prHead) return;
    setLoading(true);
    try {
      const { createPullRequest } = await import("../lib/github");
      const result = await createPullRequest(
        savedToken,
        prOwner,
        prRepo,
        prTitle,
        prBody,
        prHead,
        prBase
      );
      setMessage(`PR #${result.number} criado! ${result.url}`);
      setPrTitle("");
      setPrBody("");
    } catch (e) {
      setMessage(`Erro: ${e}`);
    }
    setLoading(false);
  }, [savedToken, prOwner, prRepo, prTitle, prBody, prHead, prBase]);

  const handleClone = useCallback(async () => {
    if (!cloneUrl.trim() || !repoPath) return;
    setLoading(true);
    try {
      const { cloneRepo } = await import("../lib/github");
      const dest = repoPath.replace(/\\/g, "/") + "/" + cloneUrl.split("/").pop()?.replace(".git", "");
      await cloneRepo(cloneUrl.trim(), dest);
      setMessage(`Clonado para ${dest}`);
      setCloneUrl("");
    } catch (e) {
      setMessage(`Erro: ${e}`);
    }
    setLoading(false);
  }, [cloneUrl, repoPath]);

  return (
    <div className="github-panel">
      <div className="github-header">
        <span>GitHub</span>
        {savedToken && (
          <div className="github-header-actions">
            <button className="github-action-btn" onClick={handleRemoveToken} title="Remover token">
              ✕
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
          <p className="github-info">
            Crie um token em github.com/settings/tokens (repo, read:user)
          </p>
          <input
            className="github-input"
            type="password"
            placeholder="Personal Access Token"
            value={savedToken ? "****" : token}
            onChange={(e) => setLocalToken(e.target.value)}
          />
          <button className="github-btn" onClick={handleSaveToken} disabled={!token.trim() || savedToken !== null}>
            Salvar Token
          </button>
        </div>
      )}

      {tab === "repos" && (
        <div className="github-repos">
          <div className="github-section">
            <div className="github-section-title">Clonar repositório</div>
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
              Clonar
            </button>
          </div>

          <div className="github-section">
            <div className="github-section-title">Criar repositório</div>
            <input
              className="github-input"
              placeholder="Nome do repositório"
              value={newRepoName}
              onChange={(e) => setNewRepoName(e.target.value)}
            />
            <input
              className="github-input"
              placeholder="Descrição (opcional)"
              value={newRepoDesc}
              onChange={(e) => setNewRepoDesc(e.target.value)}
            />
            <label className="github-checkbox">
              <input
                type="checkbox"
                checked={newRepoPrivate}
                onChange={(e) => setNewRepoPrivate(e.target.checked)}
              />
              Privado
            </label>
            <button
              className="github-btn"
              onClick={handleCreateRepo}
              disabled={!newRepoName.trim() || loading}
            >
              Criar
            </button>
          </div>

          <div className="github-section">
            <div className="github-section-title">Meus repositórios</div>
            <button className="github-btn" onClick={handleListRepos} disabled={loading}>
              {loading ? "Carregando..." : "Atualizar"}
            </button>
            {repos.map((r) => (
              <div key={r.full_name} className="github-repo-item">
                <span className="github-repo-icon">{r.private ? "🔒" : "🔓"}</span>
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
            placeholder="Owner (ex: usuario)"
            value={prOwner}
            onChange={(e) => setPrOwner(e.target.value)}
          />
          <input
            className="github-input"
            placeholder="Repo (ex: meu-repo)"
            value={prRepo}
            onChange={(e) => setPrRepo(e.target.value)}
          />
          <input
            className="github-input"
            placeholder="Título do PR"
            value={prTitle}
            onChange={(e) => setPrTitle(e.target.value)}
          />
          <textarea
            className="github-input github-textarea"
            placeholder="Descrição do PR (opcional)"
            value={prBody}
            onChange={(e) => setPrBody(e.target.value)}
            rows={3}
          />
          <input
            className="github-input"
            placeholder="Branch de origem (head)"
            value={prHead}
            onChange={(e) => setPrHead(e.target.value)}
          />
          <input
            className="github-input"
            placeholder="Branch de destino (base) — default: main"
            value={prBase}
            onChange={(e) => setPrBase(e.target.value)}
          />
          <button
            className="github-btn"
            onClick={handleCreatePR}
            disabled={!prOwner || !prRepo || !prTitle || !prHead || loading}
          >
            Criar PR
          </button>
        </div>
      )}

      {message && <div className="github-message">{message}</div>}
    </div>
  );
}
