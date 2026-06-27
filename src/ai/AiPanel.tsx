import { useState, useRef, useCallback, useEffect, memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ChatMsg, StreamDelta, ModelInfo } from "../lib/ai";
import {
  listModels, startLlm, stopLlm, llmStatus,
  waitHealthy, streamChat,
} from "../lib/ai";
import { loadSettings, saveSettings } from "../lib/settings";
import { AGENT_SYSTEM_PROMPT, parseToolCall, executeTool, normalizeArgs } from "./agent";
import type { ToolResult } from "./agent";

interface AiPanelProps {
  workspaceRoot?: string | null;
  onRefresh?: () => void;
  onFileChanged?: (path: string) => void;
}

export const AiPanel = memo(function AiPanel({ workspaceRoot, onRefresh, onFileChanged }: AiPanelProps) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ running: boolean; port: number; model: string }>({ running: false, port: 0, model: "" });
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelDir, setModelDir] = useState(loadSettings().modelsDir);
  const [configError, setConfigError] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(true);
  const [agentMode, setAgentMode] = useState(true);
  const [pendingTool, setPendingTool] = useState<{ tool: string; args: Record<string, any> } | null>(null);
  const [toolHistory, setToolHistory] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);


  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, toolHistory]);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await llmStatus());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    refreshStatus();
    const interval = setInterval(refreshStatus, 5000);
    return () => clearInterval(interval);
  }, [refreshStatus]);

  const handleBrowseModels = useCallback(async () => {
    setConfigError(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false, title: "Selecionar pasta de modelos GGUF" });
      if (selected) {
        setModelDir(selected);
        const list = await listModels(selected);
        setModels(list);
        if (list.length === 0) setConfigError("Nenhum arquivo .gguf encontrado nesta pasta.");
      }
    } catch (e: any) {
      setConfigError(`Erro ao listar modelos: ${e}`);
    }
  }, []);

  const handleStartLlm = useCallback(async (modelPath: string) => {
    setLoading(true);
    setConfigError(null);
    try {
      const settings = loadSettings();
      const port = await startLlm(modelPath, settings.ngl, settings.ctx);
      await waitHealthy(port);
      saveSettings({ lastModelPath: modelPath });
      setShowConfig(false);
      setMessages([]);
      setToolHistory([]);
      await refreshStatus();
    } catch (e: any) {
      setConfigError(`${e}`);
    }
    setLoading(false);
  }, [refreshStatus]);

  const handleStopLlm = useCallback(async () => {
    await stopLlm();
    await refreshStatus();
  }, [refreshStatus]);

  const handleAbort = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
  }, []);

  const executeAgentTool = useCallback(async (tool: string, rawArgs: Record<string, any>): Promise<ToolResult | null> => {
    const args = normalizeArgs(rawArgs, tool);

    // Tools que executam automaticamente sem confirmação
    const autoTools = new Set(["create_file", "edit_file", "read_file", "list_dir", "search_files", "rename_file"]);
    if (autoTools.has(tool)) {
      setToolHistory((prev) => [...prev, `🔧 ${tool}(${JSON.stringify(args)})...`]);
      const result = await executeTool(tool, args, workspaceRoot || undefined);
      setToolHistory((prev) => [...prev, result.success ? `  ✅ ${result.output}` : `  ❌ ${result.output}`]);
      if (result.success && (tool === "create_file" || tool === "edit_file" || tool === "rename_file")) {
        onRefresh?.();
        if (result.affectedPath) onFileChanged?.(result.affectedPath);
      }
      return result;
    }

    // delete_file e execute_command requerem confirmação
    setPendingTool({ tool, args });
    return null;
  }, [workspaceRoot, onRefresh, onFileChanged]);

  const confirmTool = useCallback(async () => {
    if (!pendingTool) return;
    const { tool, args } = pendingTool;
    setPendingTool(null);
    setToolHistory((prev) => [...prev, `🔧 ${tool}(${JSON.stringify(args)})...`]);

    if (tool === "execute_command") {
      setToolHistory((prev) => [...prev, `  ⚠️ Confirme o comando no diálogo abaixo`]);
      return;
    }

    const result = await executeTool(tool, args, workspaceRoot || undefined);
    setToolHistory((prev) => [...prev, result.success ? `  ✅ ${result.output}` : `  ❌ ${result.output}`]);

    if (result.success && (tool === "create_file" || tool === "edit_file" || tool === "delete_file" || tool === "rename_file")) {
      onRefresh?.();
    }
  }, [pendingTool, workspaceRoot, onRefresh]);

  const rejectTool = useCallback(() => {
    setPendingTool(null);
    setToolHistory((prev) => [...prev, `  ⛔ Ação cancelada pelo usuário`]);
  }, []);

  const handleConfirmCommand = useCallback(async (command: string) => {
    setPendingTool(null);
    setToolHistory((prev) => [...prev, `  ▶️ Executando: ${command}`]);
    try {
      const result: string = await invoke("execute_terminal_command", { command });
      setToolHistory((prev) => [...prev, `  ✅ ${result}`]);
    } catch (e: any) {
      setToolHistory((prev) => [...prev, `  ❌ Erro: ${e.message || e}`]);
    }
  }, []);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming || !status.port) return;
    setInput("");

    const userMsg: ChatMsg = { role: "user", content: text };
    let currentMessages: ChatMsg[] = [...messages, userMsg];
    setMessages(currentMessages);
    setStreaming(true);
    setToolHistory([]);

    const sysPrompt = agentMode ? AGENT_SYSTEM_PROMPT : "Você é um assistente de programação útil. Responda em português.";

    try {
      const abort = new AbortController();
      abortRef.current = abort;

      // Loop allowing multiple tool execution rounds
      for (let round = 0; round < 10; round++) {
        if (abort.signal.aborted) break;

        const assistantMsg: ChatMsg = { role: "assistant", content: "" };
        const msgsWithAssistant = [...currentMessages, assistantMsg];
        setMessages(msgsWithAssistant);

        let fullContent = "";
        let collectedToolCalls: any[] = [];

        await streamChat(
          status.port,
          [{ role: "system", content: sysPrompt }, ...currentMessages],
          (delta: StreamDelta) => {
            if (delta.content) {
              fullContent += delta.content;
            }
            if (delta.tool_calls) {
              collectedToolCalls = [...collectedToolCalls, ...delta.tool_calls];
            }
            setMessages((prev) => {
              const copy = [...prev];
              const last = copy[copy.length - 1];
              if (last?.role === "assistant") {
                copy[copy.length - 1] = {
                  ...last,
                  content: fullContent,
                  tool_calls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined,
                };
              }
              return copy;
            });
          },
          { signal: abort.signal }
        );

        if (abort.signal.aborted) break;

        // Determine tool calls to execute
        let toolCallsToExec: { tool: string; args: Record<string, any> }[] = [];

        if (collectedToolCalls.length > 0) {
          for (const tc of collectedToolCalls) {
            try {
              const parsed = JSON.parse(tc.function.arguments);
              toolCallsToExec.push({ tool: tc.function.name, args: parsed });
            } catch {
              // skip malformed
            }
          }
        } else {
          const parsed = parseToolCall(fullContent);
          if (parsed) {
            toolCallsToExec.push(parsed);
          }
        }

        if (toolCallsToExec.length === 0) break; // no more tools, done

        // Execute tools and feed results back
        let toolResultsStr = "";
        for (const tc of toolCallsToExec) {
          const result = await executeAgentTool(tc.tool, tc.args);
          if (result) {
            toolResultsStr += `[${tc.tool}] ${result.success ? "OK" : "ERRO"}: ${result.output}\n`;
            if (result.success && (tc.tool === "create_file" || tc.tool === "edit_file" || tc.tool === "rename_file")) {
              onRefresh?.();
              if (result.affectedPath) onFileChanged?.(result.affectedPath);
            }
          } else {
            // Tool requires confirmation - break out of loop, user must respond
            toolResultsStr = "";
            break;
          }
        }

        if (!toolResultsStr) {
          // pending confirmation, stop loop
          currentMessages = [...currentMessages, { role: "assistant", content: fullContent, tool_calls: collectedToolCalls }];
          setMessages(currentMessages);
          break;
        }

        const toolResultMsg: ChatMsg = {
          role: "user",
          content: `Resultados das ferramentas:\n${toolResultsStr}\nContinue com a próxima etapa ou responda ao usuário.`,
        };
        currentMessages = [...currentMessages, { role: "assistant", content: fullContent, tool_calls: collectedToolCalls }, toolResultMsg];
        setMessages(currentMessages);
      }
    } catch (e: any) {
      if (e.name !== "AbortError") {
        setMessages((prev) => [...prev, { role: "user", content: `Erro: ${e.message || e}` }]);
      }
    }
    setStreaming(false);
    abortRef.current = null;
  }, [input, streaming, status.port, messages, agentMode, executeAgentTool, onRefresh, onFileChanged]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (showConfig || !status.running) {
    return (
      <div className="ai-panel">
        <div className="ai-header">
          <span>IA</span>
          {status.running && <button className="ai-config-btn" onClick={() => setShowConfig(false)}>Chat</button>}
        </div>
        <div className="ai-config">
          <h3>Configurar IA Local</h3>

          <label>Pasta dos modelos (.gguf)</label>
          <div className="ai-input-row">
            <input value={modelDir} onChange={(e) => setModelDir(e.target.value)} />
            <button onClick={handleBrowseModels}>Procurar</button>
          </div>

          {models.length > 0 && (
            <div className="ai-model-list">
              <h4>Modelos encontrados:</h4>
              {models.map((m) => (
                <div key={m.path} className="ai-model-item">
                  <span className="ai-model-name">{m.name}</span>
                  <span className="ai-model-size">{m.size_gb.toFixed(1)} GB</span>
                  <button onClick={() => handleStartLlm(m.path)}>Usar</button>
                </div>
              ))}
            </div>
          )}

          {configError && (
            <div className="ai-config-error">⚠️ {configError}</div>
          )}

          {loading && (
            <div className="ai-loading-overlay">
              <div className="ai-loading-spinner"></div>
              <span>Carregando modelo... isso pode levar alguns minutos</span>
            </div>
          )}

          {status.running && (
            <div className="ai-status-row">
              <span>🟢 Rodando: {status.model.split(/[\\/]/).pop()}</span>
              <button onClick={handleStopLlm}>Parar</button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="ai-panel">
      <div className="ai-header">
        <span>IA {agentMode ? "(Agente)" : "(Chat)"}</span>
        <div className="ai-header-actions">
          <button
            className="ai-config-btn"
            onClick={() => setAgentMode(!agentMode)}
            title={agentMode ? "Modo chat" : "Modo agente"}
          >
            {agentMode ? "💬" : "🤖"}
          </button>
          <button className="ai-config-btn" onClick={() => setShowConfig(true)} title="Configurar">
            ⚙️
          </button>
          <button className="ai-config-btn" onClick={handleStopLlm} title="Parar IA">
            ⏹
          </button>
        </div>
      </div>

      <div className="ai-chat">
        {messages.map((msg, i) => (
          <div key={i} className={`ai-msg ai-msg-${msg.role}`}>
            {msg.content && <div className="ai-msg-content">{msg.content}</div>}
            {msg.reasoning && (
              <details className="ai-reasoning">
                <summary>Pensamento</summary>
                {msg.reasoning}
              </details>
            )}
            {msg.role === "assistant" && msg.content && (
              <div className="ai-msg-actions">
                <button className="ai-copy-btn" onClick={() => navigator.clipboard.writeText(msg.content)} title="Copiar resposta">
                  📋
                </button>
              </div>
            )}
          </div>
        ))}

        {toolHistory.length > 0 && (
          <div className="ai-tool-history">
            {toolHistory.map((h, i) => (
              <pre key={i} className="ai-tool-line">{h}</pre>
            ))}
          </div>
        )}

        {pendingTool && (
          <div className="ai-tool-confirm">
            <div className="ai-tool-confirm-header">
              {pendingTool.tool === "execute_command" ? "⚠️ Comando no Terminal" : `🔧 ${pendingTool.tool}`}
            </div>
            <pre className="ai-tool-confirm-detail">{JSON.stringify(pendingTool.args, null, 2)}</pre>
            {pendingTool.tool === "execute_command" ? (
              <div className="ai-tool-confirm-actions">
                <button className="ai-confirm-btn" onClick={() => handleConfirmCommand(pendingTool.args.command)}>
                  ▶️ Executar Comando
                </button>
                <button className="ai-reject-btn" onClick={rejectTool}>Cancelar</button>
              </div>
            ) : (
              <div className="ai-tool-confirm-actions">
                <button className="ai-confirm-btn" onClick={confirmTool}>✅ Confirmar</button>
                <button className="ai-reject-btn" onClick={rejectTool}>❌ Recusar</button>
              </div>
            )}
          </div>
        )}

        <div ref={chatEndRef} />
      </div>

      <div className="ai-input-bar">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={agentMode ? "Peça algo (ex: crie um arquivo...)" : "Pergunte algo..."}
          disabled={streaming}
        />
        {streaming ? (
          <button className="ai-stop-btn" onClick={handleAbort} title="Parar resposta">
            ■
          </button>
        ) : (
          <button onClick={handleSend} disabled={!input.trim()}>
            →
          </button>
        )}
      </div>
    </div>
  );
});
