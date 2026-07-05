import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";

export interface ModelInfo {
  name: string;
  path: string;
  size_gb: number;
  is_projector: boolean;
}

export interface LlmStatus {
  running: boolean;
  port: number;
  model: string;
}

export interface ChatMsg {
  /** "error" is UI-only feedback — filtered out before sending to the model. */
  role: "system" | "user" | "assistant" | "error";
  content: string;
  reasoning?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface StreamDelta {
  content?: string;
  reasoning?: string;
  tool_calls?: ToolCall[];
}

export const DEFAULT_MODELS_DIR = "";

export const listModels = (dir: string) => invoke<ModelInfo[]>("list_models", { dir });
export const startLlm = (modelPath: string, nGpuLayers: number, ctxSize: number) =>
  invoke<number>("start_llm", { modelPath, nGpuLayers, ctxSize });
export const stopLlm = () => invoke<void>("stop_llm");
export const llmStatus = () => invoke<LlmStatus>("llm_status");

export async function waitHealthy(port: number, timeoutMs = 180000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch { /* still warming up */ }
    if (Date.now() - start > timeoutMs) throw new Error(t("ai.modelTimeout"));
    await new Promise((res) => setTimeout(res, 500));
  }
}

export async function streamChat(
  port: number,
  messages: ChatMsg[],
  onDelta: (d: StreamDelta) => void,
  opts: { temperature?: number; signal?: AbortSignal } = {}
): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      stream: true,
      temperature: opts.temperature ?? 0.7,
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) throw new Error(t("ai.badResponse", { status: res.status }));

  let inThink = false;
  const routeContent = (text: string) => {
    while (text.length) {
      if (!inThink) {
        const i = text.indexOf("<think>");
        if (i === -1) { onDelta({ content: text }); return; }
        if (i > 0) onDelta({ content: text.slice(0, i) });
        inThink = true;
        text = text.slice(i + "<think>".length);
      } else {
        const j = text.indexOf("</think>");
        if (j === -1) { onDelta({ reasoning: text }); return; }
        if (j > 0) onDelta({ reasoning: text.slice(0, j) });
        inThink = false;
        text = text.slice(j + "</think>".length);
      }
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const parsed = JSON.parse(data);
        const choice = parsed.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;
        if (!delta) continue;
        if (delta.reasoning_content) onDelta({ reasoning: delta.reasoning_content });
        if (delta.content) routeContent(delta.content);
        if (delta.tool_calls) {
          onDelta({ tool_calls: delta.tool_calls.map((tc: any) => ({
            id: tc.id || `call_${Math.random().toString(36).slice(2, 8)}`,
            function: tc.function,
          }))});
        }
      } catch { /* ignore */ }
    }
  }
}
