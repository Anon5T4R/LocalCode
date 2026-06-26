import { useState, useCallback, useEffect, useRef, memo } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { RepoEntry } from "../types";
import { setToken, getToken, removeToken, listRepos, createRepo, createPullRequest, cloneRepo, deviceLogin, pollToken } from "../lib/github";
import { loadSettings } from "../lib/settings";

interface GitHubPanelProps {
  repoPath: string | null;
}

export const GitHubPanel = memo(function GitHubPanel({ repoPath }: GitHubPanelProps) {
  const [token, setLocalToken] = useState<string>("");
  const [savedToken, setSavedToken] = useState<string | null>(null);
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
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
      setMessage("Configure um GitHub Client ID nas Configurações (⚙️).");
      return;
    }
    setLoading(true);
    try {
      const resp = await deviceLogin(clientId);
      setDeviceCode(resp.device_code);
      setUserCode(resp.user_code);
      setDeviceUrl(resp.verification_uri);
      setMessage(`Código: ${resp.user_code} — Abrindo navegador...`);
      openUrl(resp.verification_uri);
      // Start polling
      setPolling(true);
      pollRef.current = true;
    } catch (e: any) {
      setMessage(`Erro: ${e}`);
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
          const t = await pollToken(deviceCode, clientId);
          if (!pollRef.current || cancelled) return;
          // Success!
          await setToken(t);
          setSavedToken(t);
          setLocalToken("****");
          setPolling(false);
          setMessage("Login realizado!");
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
            setMessage(`Erro: ${e}`);
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
    setMessage("");
  }, []);

  const handleSaveToken = useCallback(async () => {
    if (!token.trim() || savedToken) return;
    try {
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
      await removeToken();
      setSavedToken(null);
      setLocalToken("");
      setRepos([]);
      setPolling(false);
      pollRef.current = false;
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
      const result = await createPullRequest(savedToken, prOwner, prRepo, prTitle, prBody, prHead, prBase);
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
          {polling ? (
            <div className="github-device-flow">
              <p className="github-device-step">
                <strong>Passo 1:</strong> Clique no botao abaixo para abrir o navegador
              </p>
              <button className="github-open-browser-btn" onClick={() => openUrl(deviceUrl)}>
                Abrir Navegador
              </button>
              <p className="github-device-step">
                Ou acesse manualmente: <span className="github-link" onClick={() => openUrl(deviceUrl)}>{deviceUrl}</span>
              </p>

              <p className="github-device-step">
                <strong>Passo 2:</strong> Copie o codigo abaixo e cole no site do GitHub
              </p>
              <div>
                <span className="github-user-code" onClick={() => navigator.clipboard.writeText(userCode)} title="Clique para copiar">{userCode}</span>
                <button className="github-copy-code-btn" onClick={() => navigator.clipboard.writeText(userCode)}>
                  Copiar
                </button>
              </div>

              <p className="github-device-step">
                <strong>Passo 3:</strong> Autorize o aplicativo no GitHub
              </p>
              <p className="github-device-step">
                <span className="github-polling-indicator"></span>
                Aguardando autorizacao...
              </p>
              <button className="github-cancel-btn" onClick={handleCancelPoll}>
                Cancelar
              </button>
            </div>
          ) : (
            <>
              <p className="github-info">
                Faça login no GitHub pelo navegador
              </p>
              <button className="github-btn" onClick={handleDeviceLogin} disabled={loading}>
                Login com GitHub
              </button>
              <hr className="github-divider" />
              <p className="github-info">
                Ou cole manualmente um Personal Access Token
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
            </>
          )}
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
});
