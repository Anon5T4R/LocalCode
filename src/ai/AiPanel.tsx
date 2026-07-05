import { useState, useRef, useCallback, useEffect, memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ChatMsg, StreamDelta, ModelInfo } from "../lib/ai";
import {
  listModels, startLlm, stopLlm, llmStatus,
  waitHealthy, streamChat,
} from "../lib/ai";
import { loadSettings, saveSettings } from "../lib/settings";
import { getAgentSystemPrompt, parseToolCall, executeTool, normalizeArgs } from "./agent";
import { MarkdownContent } from "./Markdown";
import { toast } from "../lib/toast";
import { t } from "../lib/i18n";

interface AiPanelProps {
  workspaceRoot?: string | null;
  onRefresh?: () => void;
  onFileChanged?: (path: string) => void;
}

interface QueuedTool {
  tool: string;
  args: Record<string, any>;
}

/** A tool waiting for user confirmation, plus everything needed to resume the
 *  agent loop after the decision: the rest of this round's tool queue, the
 *  results accumulated so far and the conversation snapshot. */
interface PendingTool {
  tool: string;
  args: Record<string, any>;
  queue: QueuedTool[];
  resultsSoFar: string;
  messages: ChatMsg[];
}

const MAX_ROUNDS = 10;

/** Tools that run without confirmation. */
const AUTO_TOOLS = new Set(["create_file", "edit_file", "read_file", "list_dir", "search_files", "rename_file"]);

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
  const [pendingTool, setPendingTool] = useState<PendingTool | null>(null);
  const [toolHistory, setToolHistory] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, toolHistory, pendingTool]);

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
      const selected = await open({ directory: true, multiple: false, title: t("ai.selectModelsDir") });
      if (selected) {
        setModelDir(selected);
        const list = await listModels(selected);
        setModels(list);
        if (list.length === 0) setConfigError(t("ai.noModels"));
      }
    } catch (e: any) {
      setConfigError(t("ai.listModelsFailed", { error: String(e) }));
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

  const logTool = useCallback((line: string) => {
    setToolHistory((prev) => [...prev, line]);
  }, []);

  /** Executes one auto tool and returns the line to feed back to the model. */
  const runAutoTool = useCallback(async (tc: QueuedTool): Promise<string> => {
    const args = normalizeArgs(tc.args, tc.tool);
    logTool(`🔧 ${tc.tool}(${JSON.stringify(args)})...`);
    const result = await executeTool(tc.tool, args, workspaceRoot || undefined);
    logTool(result.success ? `  ✅ ${result.output}` : `  ❌ ${result.output}`);
    if (result.success && (tc.tool === "create_file" || tc.tool === "edit_file" || tc.tool === "rename_file")) {
      onRefresh?.();
      if (result.affectedPath) onFileChanged?.(result.affectedPath);
    }
    return `[${tc.tool}] ${result.success ? "OK" : "ERRO"}: ${result.output}\n`;
  }, [workspaceRoot, onRefresh, onFileChanged, logTool]);

  /**
   * Runs a queue of tool calls. Auto tools execute inline; a tool that needs
   * confirmation pauses everything (stores the queue + conversation) and
   * returns null — confirmTool/rejectTool resume from that snapshot.
   */
  const processToolQueue = useCallback(async (
    queue: QueuedTool[],
    resultsSoFar: string,
    conversation: ChatMsg[],
  ): Promise<string | null> => {
    let results = resultsSoFar;
    for (let i = 0; i < queue.length; i++) {
      const tc = queue[i];
      if (AUTO_TOOLS.has(tc.tool)) {
        results += await runAutoTool(tc);
      } else {
        setPendingTool({
          tool: tc.tool,
          args: normalizeArgs(tc.args, tc.tool),
          queue: queue.slice(i + 1),
          resultsSoFar: results,
          messages: conversation,
        });
        return null; // paused — the confirm/reject handlers continue the loop
      }
    }
    return results;
  }, [runAutoTool]);

  /** The agent loop: stream a reply, run tools, feed results back, repeat. */
  const runAgentLoop = useCallback(async (startMessages: ChatMsg[]) => {
    let currentMessages = startMessages;
    setStreaming(true);
    try {
      const abort = new AbortController();
      abortRef.current = abort;
      const sysPrompt = agentMode ? getAgentSystemPrompt() : t("ai.chatSystemPrompt");

      for (let round = 0; round < MAX_ROUNDS; round++) {
        if (abort.signal.aborted) break;

        setMessages([...currentMessages, { role: "assistant", content: "" }]);

        let fullContent = "";
        let collectedToolCalls: any[] = [];

        await streamChat(
          status.port,
          [
            { role: "system", content: sysPrompt },
            ...currentMessages.filter((m) => m.role !== "error"),
          ],
          (delta: StreamDelta) => {
            if (delta.content) fullContent += delta.content;
            if (delta.tool_calls) collectedToolCalls = [...collectedToolCalls, ...delta.tool_calls];
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

        // Native tool_calls take precedence; fall back to the JSON convention.
        const toolCalls: QueuedTool[] = [];
        if (collectedToolCalls.length > 0) {
          for (const tc of collectedToolCalls) {
            try {
              toolCalls.push({ tool: tc.function.name, args: JSON.parse(tc.function.arguments) });
            } catch { /* skip malformed */ }
          }
        } else {
          const parsed = parseToolCall(fullContent);
          if (parsed) toolCalls.push(parsed);
        }

        const assistantMsg: ChatMsg = {
          role: "assistant",
          content: fullContent,
          tool_calls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined,
        };
        currentMessages = [...currentMessages, assistantMsg];
        setMessages(currentMessages);

        if (toolCalls.length === 0) break; // no tools → done

        const results = await processToolQueue(toolCalls, "", currentMessages);
        if (results === null) {
          // Paused on a confirmation — the input stays blocked by pendingTool
          // and confirmTool/rejectTool re-enter the loop.
          setStreaming(false);
          return;
        }

        currentMessages = [...currentMessages, {
          role: "user",
          content: t("ai.toolResults", { results }),
        }];
        setMessages(currentMessages);
      }
    } catch (e: any) {
      if (e.name !== "AbortError") {
        setMessages((prev) => [...prev, { role: "error", content: `${e.message || e}` }]);
      }
    }
    setStreaming(false);
    abortRef.current = null;
  }, [agentMode, status.port, processToolQueue]);

  /** Continues the agent loop after a confirmation decision. */
  const resumeAfterDecision = useCallback(async (pending: PendingTool, resultLine: string) => {
    setPendingTool(null);
    const results = await processToolQueue(pending.queue, pending.resultsSoFar + resultLine, pending.messages);
    if (results === null) return; // paused again on another confirmation
    const next: ChatMsg[] = [...pending.messages, {
      role: "user",
      content: t("ai.toolResults", { results }),
    }];
    setMessages(next);
    await runAgentLoop(next);
  }, [processToolQueue, runAgentLoop]);

  const confirmTool = useCallback(async () => {
    if (!pendingTool) return;
    const { tool, args } = pendingTool;
    logTool(`🔧 ${tool}(${JSON.stringify(args)})...`);

    let resultLine: string;
    if (tool === "execute_command") {
      logTool(`  ▶️ ${t("ai.executing", { command: args.command })}`);
      try {
        const output: string = await invoke("execute_terminal_command", { command: args.command });
        logTool(`  ✅ ${output}`);
        resultLine = `[execute_command] OK:\n${output}\n`;
      } catch (e: any) {
        logTool(`  ❌ Erro: ${e.message || e}`);
        resultLine = `[execute_command] ERRO: ${e.message || e}\n`;
      }
    } else {
      const result = await executeTool(tool, args, workspaceRoot || undefined);
      logTool(result.success ? `  ✅ ${result.output}` : `  ❌ ${result.output}`);
      if (result.success && tool === "delete_file") onRefresh?.();
      resultLine = `[${tool}] ${result.success ? "OK" : "ERRO"}: ${result.output}\n`;
    }
    await resumeAfterDecision(pendingTool, resultLine);
  }, [pendingTool, workspaceRoot, onRefresh, logTool, resumeAfterDecision]);

  const rejectTool = useCallback(async () => {
    if (!pendingTool) return;
    logTool(`  ⛔ ${t("ai.userCancelled")}`);
    await resumeAfterDecision(
      pendingTool,
      `[${pendingTool.tool}] RECUSADO: ${t("ai.rejectedResult")}\n`
    );
  }, [pendingTool, logTool, resumeAfterDecision]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming || pendingTool || !status.port) return;
    setInput("");
    setToolHistory([]);
    const next: ChatMsg[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    await runAgentLoop(next);
  }, [input, streaming, pendingTool, status.port, messages, runAgentLoop]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const copyMessage = useCallback((content: string) => {
    navigator.clipboard.writeText(content);
    toast.success(t("ai.copied"));
  }, []);

  if (showConfig || !status.running) {
    return (
      <div className="ai-panel">
        <div className="ai-header">
          <span>{t("ai.title")}</span>
          {status.running && <button className="ai-config-btn" onClick={() => setShowConfig(false)}>{t("ai.chat")}</button>}
        </div>
        <div className="ai-config">
          <h3>{t("ai.configTitle")}</h3>

          <label>{t("ai.modelsDir")}</label>
          <div className="ai-input-row">
            <input value={modelDir} onChange={(e) => setModelDir(e.target.value)} />
            <button onClick={handleBrowseModels}>{t("ai.browse")}</button>
          </div>

          {models.length > 0 && (
            <div className="ai-model-list">
              <h4>{t("ai.modelsFound")}</h4>
              {models.map((m) => (
                <div key={m.path} className="ai-model-item">
                  <span className="ai-model-name">{m.name}</span>
                  <span className="ai-model-size">{m.size_gb.toFixed(1)} GB</span>
                  <button onClick={() => handleStartLlm(m.path)}>{t("ai.use")}</button>
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
              <span>{t("ai.loadingModel")}</span>
            </div>
          )}

          {status.running && (
            <div className="ai-status-row">
              <span>🟢 {t("ai.running", { name: status.model.split(/[\\/]/).pop() ?? "" })}</span>
              <button onClick={handleStopLlm}>{t("ai.stop")}</button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="ai-panel">
      <div className="ai-header">
        <span>{t("ai.title")} {agentMode ? t("ai.agentSuffix") : t("ai.chatSuffix")}</span>
        <div className="ai-header-actions">
          <button
            className="ai-config-btn"
            onClick={() => setAgentMode(!agentMode)}
            title={agentMode ? t("ai.toChatMode") : t("ai.toAgentMode")}
          >
            <span className={`codicon ${agentMode ? "codicon-comment" : "codicon-hubot"}`} />
          </button>
          <button className="ai-config-btn" onClick={() => setShowConfig(true)} title={t("ai.configure")}>
            <span className="codicon codicon-settings-gear" />
          </button>
          <button className="ai-config-btn" onClick={handleStopLlm} title={t("ai.stopAi")}>
            <span className="codicon codicon-debug-stop" />
          </button>
        </div>
      </div>

      <div className="ai-chat">
        {messages.map((msg, i) => (
          <div key={i} className={`ai-msg ai-msg-${msg.role}`}>
            {msg.role === "error" ? (
              <div className="ai-msg-content ai-msg-error-content">
                <span className="codicon codicon-error" /> {msg.content}
              </div>
            ) : msg.role === "assistant" ? (
              msg.content && (
                <div className="ai-msg-content">
                  <MarkdownContent
                    text={msg.content}
                    streaming={streaming && i === messages.length - 1}
                  />
                </div>
              )
            ) : (
              msg.content && <div className="ai-msg-content">{msg.content}</div>
            )}
            {msg.reasoning && (
              <details className="ai-reasoning">
                <summary>{t("ai.thinking")}</summary>
                {msg.reasoning}
              </details>
            )}
            {msg.role === "assistant" && msg.content && (
              <div className="ai-msg-actions">
                <button className="ai-copy-btn" onClick={() => copyMessage(msg.content)} title={t("ai.copyAnswer")}>
                  <span className="codicon codicon-copy" />
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
              {pendingTool.tool === "execute_command" ? `⚠️ ${t("ai.terminalCommand")}` : `🔧 ${pendingTool.tool}`}
            </div>
            <pre className="ai-tool-confirm-detail">{JSON.stringify(pendingTool.args, null, 2)}</pre>
            <div className="ai-tool-confirm-actions">
              <button className="ai-confirm-btn" onClick={confirmTool}>
                {pendingTool.tool === "execute_command" ? `▶️ ${t("ai.runCommand")}` : `✅ ${t("ai.confirm")}`}
              </button>
              <button className="ai-reject-btn" onClick={rejectTool}>{t("ai.reject")}</button>
            </div>
          </div>
        )}

        <div ref={chatEndRef} />
      </div>

      <div className="ai-input-bar">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={agentMode ? t("ai.agentPlaceholder") : t("ai.chatPlaceholder")}
          disabled={streaming || pendingTool !== null}
        />
        {streaming ? (
          <button className="ai-stop-btn" onClick={handleAbort} title={t("ai.stopResponse")}>
            <span className="codicon codicon-debug-stop" />
          </button>
        ) : (
          <button onClick={handleSend} disabled={!input.trim() || pendingTool !== null} title={t("ai.send")}>
            <span className="codicon codicon-send" />
          </button>
        )}
      </div>
    </div>
  );
});
