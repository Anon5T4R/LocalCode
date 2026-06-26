import { useState, useRef, useCallback, useEffect } from "react";
import type { ChatMsg, StreamDelta, ModelInfo } from "../lib/ai";
import {
  listModels, startLlm, stopLlm, llmStatus,
  waitHealthy, streamChat,
} from "../lib/ai";
import { loadSettings, saveSettings } from "../lib/settings";
import { AGENT_SYSTEM_PROMPT, parseToolCall, executeTool } from "./agent";

interface AiPanelProps {
  workspaceRoot?: string | null;
  onRefresh?: () => void;
}

export function AiPanel({ workspaceRoot, onRefresh }: AiPanelProps) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState<{ running: boolean; port: number; model: string }>({ running: false, port: 0, model: "" });
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelDir, setModelDir] = useState(loadSettings().modelsDir);
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
    try {
      const list = await listModels(modelDir);
      setModels(list);
    } catch (e: any) {
      setMessages((prev) => [...prev, { role: "user", content: `Erro: ${e}` }]);
    }
  }, [modelDir]);

  const handleStartLlm = useCallback(async (modelPath: string) => {
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
      setMessages((prev) => [...prev, { role: "user", content: `Erro ao iniciar IA: ${e}` }]);
    }
  }, [refreshStatus]);

  const handleStopLlm = useCallback(async () => {
    await stopLlm();
    await refreshStatus();
  }, [refreshStatus]);

  const executeAgentTool = useCallback(async (tool: string, args: Record<string, any>) => {
    setPendingTool({ tool, args });
  }, []);

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
      const { invoke } = await import("@tauri-apps/api/core");
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
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setStreaming(true);
    setToolHistory([]);

    const assistantMsg: ChatMsg = { role: "assistant", content: "" };
    setMessages((prev) => [...prev, assistantMsg]);

    const sysPrompt = agentMode ? AGENT_SYSTEM_PROMPT : "Você é um assistente de programação útil. Responda em português.";

    try {
      const abort = new AbortController();
      abortRef.current = abort;

      let fullContent = "";
      let collectedToolCalls: any[] = [];

      await streamChat(
        status.port,
        [{ role: "system", content: sysPrompt }, ...updatedMessages],
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

      // Check for tool calls
      if (collectedToolCalls.length > 0) {
        for (const tc of collectedToolCalls) {
          try {
            const parsed = JSON.parse(tc.function.arguments);
            const toolCall = { tool: tc.function.name, args: parsed };
            await executeAgentTool(toolCall.tool, toolCall.args);
          } catch {
            // Try parsing the full content as a tool call
            const parsed = parseToolCall(fullContent);
            if (parsed) {
              await executeAgentTool(parsed.tool, parsed.args);
            }
          }
        }
      } else {
        const parsed = parseToolCall(fullContent);
        if (parsed) {
          await executeAgentTool(parsed.tool, parsed.args);
        }
      }
    } catch (e: any) {
      if (e.name !== "AbortError") {
        setMessages((prev) => [...prev, { role: "user", content: `Erro: ${e.message || e}` }]);
      }
    }
    setStreaming(false);
    abortRef.current = null;
  }, [input, streaming, status.port, messages, agentMode, executeAgentTool]);

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
        <button onClick={handleSend} disabled={streaming || !input.trim()}>
          {streaming ? "..." : "→"}
        </button>
      </div>
    </div>
  );
}
