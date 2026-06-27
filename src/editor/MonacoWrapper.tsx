import { useRef, useCallback, useEffect, useState, memo } from "react";
import Editor, { OnMount, OnChange } from "@monaco-editor/react";
import type { editor as monacoEditor } from "monaco-editor";
import "../lib/monaco-setup";
import {
  getCompletion,
  getHover,
  getSignatureHelp,
  getCodeAction,
  goToDefinition,
  findReferences,
  formatDocument,
  getLspLanguage,
  startLanguageServer,
  didOpen,
  didChange,
  didClose,
} from "../lib/lsp";
import type { LspDiagnostic } from "../lib/lsp";

interface MonacoWrapperProps {
  language: string;
  value: string;
  onChange: (value: string) => void;
  onCursorPosition?: (line: number, column: number) => void;
  gotoLine?: number | null;
  path?: string;
  workspaceRoot?: string | null;
}

export const MonacoWrapper = memo(function MonacoWrapper({
  language,
  value,
  onChange,
  onCursorPosition,
  gotoLine,
  path,
  workspaceRoot,
}: MonacoWrapperProps) {
  const editorRef = useRef<monacoEditor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof import("monaco-editor") | null>(null);
  const disposablesRef = useRef<{ dispose: () => void }[]>([]);
  const versionRef = useRef(1);
  const lspLangRef = useRef<string | null>(null);
  const providersRegistered = useRef(false);
  const [monacoTheme, setMonacoTheme] = useState(() => themeFromAttr());

  // Keep the editor theme in sync with the app theme (data-theme attribute)
  useEffect(() => {
    const update = () => setMonacoTheme(themeFromAttr());
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  // Start LSP when language/file changes
  useEffect(() => {
    if (!workspaceRoot || !path) return;

    const ext = path.split(".").pop() || "";
    const lspLang = getLspLanguage(ext);
    lspLangRef.current = lspLang;

    if (lspLang) {
      startLanguageServer(lspLang, workspaceRoot).catch(() => {});
      didOpen(lspLang, path, value).catch(() => {});
    }

    return () => {
      if (lspLang) {
        didClose(lspLang, path).catch(() => {});
      }
    };
    // Only run when path changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, workspaceRoot]);

  // Scroll to a specific line when gotoLine changes
  useEffect(() => {
    if (gotoLine == null) return;
    const editor = editorRef.current;
    if (!editor) return;
    editor.revealLineInCenter(gotoLine);
    editor.setPosition({ lineNumber: gotoLine, column: 1 });
    editor.focus();
  }, [gotoLine]);

  // Register Monaco providers once monaco is available
  const registerProviders = useCallback(
    (monaco: typeof import("monaco-editor")) => {
      if (providersRegistered.current) return;
      providersRegistered.current = true;

      // Completion provider
      const completionDisposable =
        monaco.languages.registerCompletionItemProvider("*", {
          triggerCharacters: [
            ".", "(", "[", ",", " ", ":", "/", "\"", "'", "`", "#", "@",
          ],
          provideCompletionItems: async (_model, position) => {
            const lang = lspLangRef.current;
            const fp = path;
            if (!lang || !fp) return { suggestions: [] };
            try {
              const items = await getCompletion(
                lang, fp,
                position.lineNumber - 1,
                position.column - 1
              );
              return {
                suggestions: items.map((item) => ({
                  label: item.label,
                  kind: item.kind
                    ? mapLspKindToMonaco(item.kind, monaco)
                    : monaco.languages.CompletionItemKind.Text,
                  detail: item.detail || undefined,
                  documentation: item.documentation || undefined,
                  insertText: item.insert_text || item.label,
                  range: {
                    startLineNumber: position.lineNumber,
                    startColumn: position.column,
                    endLineNumber: position.lineNumber,
                    endColumn: position.column,
                  },
                })),
              };
            } catch {
              return { suggestions: [] };
            }
          },
        });
      disposablesRef.current.push(completionDisposable);

      // Hover provider
      const hoverDisposable = monaco.languages.registerHoverProvider("*", {
        provideHover: async (_model, position) => {
          const lang = lspLangRef.current;
          const fp = path;
          if (!lang || !fp) return null;
          try {
            const hover = await getHover(
              lang, fp,
              position.lineNumber - 1,
              position.column - 1
            );
            if (!hover) return null;
            return {
              contents: hover.contents.map((c) => ({ value: c })),
              range: hover.range
                ? new monaco.Range(
                    hover.range[0] + 1, hover.range[1] + 1,
                    hover.range[2] + 1, hover.range[3] + 1
                  )
                : undefined,
            };
          } catch {
            return null;
          }
        },
      });
      disposablesRef.current.push(hoverDisposable);

      // Signature help provider
      const signatureDisposable =
        monaco.languages.registerSignatureHelpProvider("*", {
          signatureHelpTriggerCharacters: ["(", ",", "<"],
          signatureHelpRetriggerCharacters: [")"],
          provideSignatureHelp: async (_model, position) => {
            const lang = lspLangRef.current;
            const fp = path;
            if (!lang || !fp) return null;
            try {
              const help = await getSignatureHelp(
                lang, fp,
                position.lineNumber - 1,
                position.column - 1
              );
              if (!help) return null;
              return {
                value: {
                  signatures: help.signatures.map((s) => ({
                    label: s.label,
                    documentation: s.documentation || undefined,
                    parameters: s.parameters.map((p) => ({
                      label: p.label,
                      documentation: p.documentation || undefined,
                    })),
                  })),
                  activeSignature: help.active_signature,
                  activeParameter: help.active_parameter,
                },
                dispose: () => {},
              };
            } catch {
              return null;
            }
          },
        });
      disposablesRef.current.push(signatureDisposable);

      // Code action provider
      const codeActionDisposable =
        monaco.languages.registerCodeActionProvider("*", {
          provideCodeActions: async (_model, range, _context) => {
            const lang = lspLangRef.current;
            const fp = path;
            if (!lang || !fp) return { actions: [], dispose: () => {} };
            try {
              const actions = await getCodeAction(
                lang, fp,
                range.startLineNumber - 1,
                range.startColumn - 1
              );
              return {
                actions: actions.map((a) => ({
                  title: a.title,
                  kind: a.kind,
                  diagnostics: [],
                  isPreferred: a.is_preferred,
                  edit: undefined,
                  command: undefined,
                })),
                dispose: () => {},
              };
            } catch {
              return { actions: [], dispose: () => {} };
            }
          },
        });
      disposablesRef.current.push(codeActionDisposable);

      // Definition provider
      const definitionDisposable =
        monaco.languages.registerDefinitionProvider("*", {
          provideDefinition: async (_model, position) => {
            const lang = lspLangRef.current;
            const fp = path;
            if (!lang || !fp) return null;
            try {
              const loc = await goToDefinition(
                lang, fp,
                position.lineNumber - 1,
                position.column - 1
              );
              if (!loc) return null;
              return {
                uri: monaco.Uri.parse(loc.uri),
                range: new monaco.Range(
                  loc.range[0] + 1, loc.range[1] + 1,
                  loc.range[2] + 1, loc.range[3] + 1
                ),
              };
            } catch {
              return null;
            }
          },
        });
      disposablesRef.current.push(definitionDisposable);

      // References provider
      const referencesDisposable =
        monaco.languages.registerReferenceProvider("*", {
          provideReferences: async (_model, position) => {
            const lang = lspLangRef.current;
            const fp = path;
            if (!lang || !fp) return [];
            try {
              const refs = await findReferences(
                lang, fp,
                position.lineNumber - 1,
                position.column - 1
              );
              return refs.map((r) => ({
                uri: monaco.Uri.parse(r.uri),
                range: new monaco.Range(
                  r.range[0] + 1, r.range[1] + 1,
                  r.range[2] + 1, r.range[3] + 1
                ),
              }));
            } catch {
              return [];
            }
          },
        });
      disposablesRef.current.push(referencesDisposable);

      // Document formatting provider
      const formatDisposable = monaco.languages.registerDocumentFormattingEditProvider("*", {
        provideDocumentFormattingEdits: async (_model) => {
          const lang = lspLangRef.current;
          const fp = path;
          if (!lang || !fp) return [];
          try {
            const edits = await formatDocument(lang, fp);
            return edits.map((e) => ({
              range: new monaco.Range(
                e.range[0] + 1, e.range[1] + 1,
                e.range[2] + 1, e.range[3] + 1
              ),
              text: e.new_text,
            }));
          } catch {
            return [];
          }
        },
      });
      disposablesRef.current.push(formatDisposable);
    },
    [path]
  );

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      monacoRef.current = monaco;

      // Configure TypeScript defaults for better intellisense
      monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
        target: monaco.languages.typescript.ScriptTarget.Latest,
        moduleResolution:
          monaco.languages.typescript.ModuleResolutionKind.NodeJs,
        module: monaco.languages.typescript.ModuleKind.ESNext,
        jsx: monaco.languages.typescript.JsxEmit.React,
        allowNonTsExtensions: true,
        allowJs: true,
        checkJs: false,
        strict: true,
        noEmit: true,
      });

      monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
        target: monaco.languages.typescript.ScriptTarget.Latest,
        allowNonTsExtensions: true,
        checkJs: false,
        noEmit: true,
      });

      // Enable TypeScript diagnostics
      monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSyntaxValidation: false,
      });

      registerProviders(monaco);

      editor.onDidChangeCursorPosition((e) => {
        onCursorPosition?.(e.position.lineNumber, e.position.column);
      });

      editor.focus();
    },
    [registerProviders, onCursorPosition]
  );

  const handleChange: OnChange = useCallback(
    (val) => {
      if (val !== undefined) {
        onChange(val);

        const lang = lspLangRef.current;
        const fp = path;
        const monaco = monacoRef.current;
        const editor = editorRef.current;
        if (lang && fp && monaco && editor) {
          versionRef.current++;
          const v = versionRef.current;
          didChange(lang, fp, val, v)
            .then((diagnostics) => {
              const model = editor.getModel();
              if (!model) return;
              const markers: monacoEditor.IMarkerData[] = diagnostics.map(
                (d: LspDiagnostic) => ({
                  severity:
                    d.severity === "error"
                      ? monaco.MarkerSeverity.Error
                      : d.severity === "warning"
                        ? monaco.MarkerSeverity.Warning
                        : d.severity === "info"
                          ? monaco.MarkerSeverity.Info
                          : monaco.MarkerSeverity.Hint,
                  message: d.message,
                  startLineNumber: d.range[0] + 1,
                  startColumn: d.range[1] + 1,
                  endLineNumber: d.range[2] + 1,
                  endColumn: d.range[3] + 1,
                  source: d.source || undefined,
                  code: d.code || undefined,
                })
              );
              monaco.editor.setModelMarkers(model, "lsp", markers);
            })
            .catch(() => {});
        }
      }
    },
    [onChange, path]
  );

  // Cleanup disposables on unmount
  useEffect(() => {
    return () => {
      disposablesRef.current.forEach((d) => d.dispose());
      disposablesRef.current = [];
      providersRegistered.current = false;
    };
  }, []);

  return (
    <Editor
      key={path}
      height="100%"
      language={language}
      value={value}
      onChange={handleChange}
      onMount={handleMount}
      theme={monacoTheme}
      options={{
        fontSize: 14,
        fontFamily:
          "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, monospace",
        fontLigatures: true,
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
        wordWrap: "off",
        tabSize: 2,
        automaticLayout: true,
        bracketPairColorization: { enabled: true },
        smoothScrolling: true,
        cursorBlinking: "smooth",
        cursorSmoothCaretAnimation: "on",
        padding: { top: 8 },
        renderWhitespace: "selection",
        suggestOnTriggerCharacters: true,
        quickSuggestions: true,
        formatOnPaste: true,
        multiCursorModifier: "alt",
        copyWithSyntaxHighlighting: true,
      }}
    />
  );
});

function themeFromAttr(): string {
  const t = document.documentElement.getAttribute("data-theme");
  if (t === "light") return "vs";
  if (t === "high-contrast") return "hc-black";
  return "vs-dark";
}

function mapLspKindToMonaco(
  kind: string,
  monaco: typeof import("monaco-editor")
): number {
  const map: Record<string, number> = {
    Text: monaco.languages.CompletionItemKind.Text,
    Method: monaco.languages.CompletionItemKind.Method,
    Function: monaco.languages.CompletionItemKind.Function,
    Constructor: monaco.languages.CompletionItemKind.Constructor,
    Field: monaco.languages.CompletionItemKind.Field,
    Variable: monaco.languages.CompletionItemKind.Variable,
    Class: monaco.languages.CompletionItemKind.Class,
    Struct: monaco.languages.CompletionItemKind.Struct,
    Interface: monaco.languages.CompletionItemKind.Interface,
    Module: monaco.languages.CompletionItemKind.Module,
    Property: monaco.languages.CompletionItemKind.Property,
    Event: monaco.languages.CompletionItemKind.Event,
    Operator: monaco.languages.CompletionItemKind.Operator,
    Unit: monaco.languages.CompletionItemKind.Unit,
    Value: monaco.languages.CompletionItemKind.Value,
    Constant: monaco.languages.CompletionItemKind.Constant,
    Enum: monaco.languages.CompletionItemKind.Enum,
    EnumMember: monaco.languages.CompletionItemKind.EnumMember,
    Keyword: monaco.languages.CompletionItemKind.Keyword,
    Snippet: monaco.languages.CompletionItemKind.Snippet,
    Color: monaco.languages.CompletionItemKind.Color,
    File: monaco.languages.CompletionItemKind.File,
    Reference: monaco.languages.CompletionItemKind.Reference,
    Folder: monaco.languages.CompletionItemKind.Folder,
    TypeParameter: monaco.languages.CompletionItemKind.TypeParameter,
  };
  return map[kind] ?? monaco.languages.CompletionItemKind.Text;
}
