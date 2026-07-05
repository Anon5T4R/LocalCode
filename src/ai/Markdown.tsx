import { memo, useEffect, useMemo, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import { toast } from "../lib/toast";
import { t } from "../lib/i18n";

/**
 * Minimal, safe markdown for AI chat: fenced code blocks (colorized by the
 * Monaco tokenizer already in the bundle), inline `code` and **bold**.
 * Everything is built as React nodes; the only raw HTML injected is the output
 * of monaco.editor.colorize, which escapes its input.
 */

type Segment =
  | { type: "text"; content: string }
  | { type: "code"; lang: string; content: string };

const FENCE_RE = /^```([\w+-]*)\s*$/;

function parseSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  const lines = text.split("\n");
  let buf: string[] = [];
  let codeLang: string | null = null;

  const flush = () => {
    if (buf.length === 0) return;
    if (codeLang !== null) {
      segments.push({ type: "code", lang: codeLang, content: buf.join("\n") });
    } else {
      const content = buf.join("\n");
      if (content.trim()) segments.push({ type: "text", content });
    }
    buf = [];
  };

  for (const line of lines) {
    const m = line.match(FENCE_RE);
    if (m) {
      if (codeLang === null) {
        flush();
        codeLang = m[1] || "";
      } else {
        flush();
        codeLang = null;
      }
      continue;
    }
    buf.push(line);
  }
  flush(); // an unclosed fence (mid-stream) still renders as code
  return segments;
}

/** Monaco language ids for common fence labels. */
const LANG_ALIASES: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript",
  py: "python",
  rs: "rust",
  sh: "shell", bash: "shell", zsh: "shell", console: "shell",
  yml: "yaml",
  md: "markdown",
  "c++": "cpp", cc: "cpp", cxx: "cpp", h: "cpp", hpp: "cpp",
  cs: "csharp",
  ps1: "powershell",
  dockerfile: "dockerfile",
  golang: "go",
};

function monacoLang(fenceLang: string): string {
  const l = fenceLang.toLowerCase();
  return LANG_ALIASES[l] || l || "plaintext";
}

/** Inline markdown: `code` and **bold**, rendered as React nodes. */
function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={i} className="md-inline-code">{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

const CodeBlock = memo(function CodeBlock({ lang, content, streaming }: { lang: string; content: string; streaming: boolean }) {
  const [html, setHtml] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Colorize debounced so a streaming block doesn't re-tokenize per delta;
  // while streaming the plain <pre> fallback is shown.
  useEffect(() => {
    if (streaming) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      monaco.editor
        .colorize(content, monacoLang(lang), { tabSize: 4 })
        .then(setHtml)
        .catch(() => setHtml(null));
    }, 150);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [content, lang, streaming]);

  const copy = () => {
    navigator.clipboard.writeText(content);
    toast.success(t("ai.codeCopied"));
  };

  return (
    <div className="md-code-block">
      <div className="md-code-header">
        <span className="md-code-lang">{lang || t("md.codeLabel")}</span>
        <button className="md-code-copy" onClick={copy} title={t("ai.codeCopied")}>
          <span className="codicon codicon-copy" />
        </button>
      </div>
      {html && !streaming ? (
        <pre className="md-code-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="md-code-body">{content}</pre>
      )}
    </div>
  );
});

export const MarkdownContent = memo(function MarkdownContent({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const segments = useMemo(() => parseSegments(text), [text]);
  return (
    <div className="md-content">
      {segments.map((seg, i) =>
        seg.type === "code" ? (
          <CodeBlock key={i} lang={seg.lang} content={seg.content} streaming={streaming && i === segments.length - 1} />
        ) : (
          <div key={i} className="md-text">{renderInline(seg.content)}</div>
        )
      )}
    </div>
  );
});
