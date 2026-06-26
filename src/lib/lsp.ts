import { invoke } from "@tauri-apps/api/core";

export interface LspCompletion {
  label: string;
  kind?: string;
  detail?: string;
  documentation?: string;
  insert_text?: string;
}

export interface LspHover {
  contents: string[];
  range?: [number, number, number, number];
}

const activeLanguages = new Map<string, boolean>();

const builtinLspMap: Record<string, string> = {
  rs: "rust",
  py: "python",
  go: "go",
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  html: "html",
  css: "css",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
};

let extensionLspMap: Record<string, { languageId?: string; command: string; args: string[] }> = {};

export function registerExtensionLanguages(languages: { extensions: string[]; lsp?: { languageId?: string; command: string; args: string[] } }[]): void {
  for (const lang of languages) {
    if (!lang.lsp) continue;
    for (const ext of lang.extensions) {
      const key = ext.startsWith(".") ? ext.slice(1) : ext;
      if (!(key in builtinLspMap)) {
        extensionLspMap[key] = lang.lsp;
      }
    }
  }
}

export function getLspLanguage(ext: string): string | null {
  return builtinLspMap[ext] ?? extensionLspMap[ext]?.languageId ?? extensionLspMap[ext]?.command ?? null;
}

export async function startLanguageServer(
  language: string,
  workspaceRoot: string
): Promise<string> {
  const result = await invoke<string>("lsp_start", {
    language,
    workspaceRoot,
  });
  activeLanguages.set(language, true);
  return result;
}

export async function stopLanguageServer(language: string): Promise<void> {
  await invoke("lsp_stop", { language });
  activeLanguages.delete(language);
}

export async function didOpen(
  language: string,
  filePath: string,
  content: string
): Promise<void> {
  if (!activeLanguages.has(language)) return;
  await invoke("lsp_did_open", { language, filePath, content });
}

export async function didChange(
  language: string,
  filePath: string,
  content: string,
  version: number
): Promise<LspDiagnostic[]> {
  if (!activeLanguages.has(language)) return [];
  return invoke<LspDiagnostic[]>("lsp_did_change", { language, filePath, content, version });
}

export async function didClose(
  language: string,
  filePath: string
): Promise<void> {
  if (!activeLanguages.has(language)) return;
  await invoke("lsp_did_close", { language, filePath });
}

export async function getCompletion(
  language: string,
  filePath: string,
  line: number,
  column: number
): Promise<LspCompletion[]> {
  return invoke<LspCompletion[]>("lsp_completion", {
    language,
    filePath,
    line,
    column,
  });
}

export async function getHover(
  language: string,
  filePath: string,
  line: number,
  column: number
): Promise<LspHover | null> {
  return invoke<LspHover | null>("lsp_hover", {
    language,
    filePath,
    line,
    column,
  });
}

export interface LspSignatureHelp {
  signatures: LspSignatureInfo[];
  active_signature: number;
  active_parameter: number;
}

export interface LspSignatureInfo {
  label: string;
  documentation?: string;
  parameters: LspParameterInfo[];
}

export interface LspParameterInfo {
  label: string;
  documentation?: string;
}

export async function getSignatureHelp(
  language: string,
  filePath: string,
  line: number,
  column: number
): Promise<LspSignatureHelp | null> {
  return invoke<LspSignatureHelp | null>("lsp_signature_help", {
    language,
    filePath,
    line,
    column,
  });
}

export interface LspCodeAction {
  title: string;
  kind?: string;
  diagnostics: number[];
  is_preferred: boolean;
}

export async function getCodeAction(
  language: string,
  filePath: string,
  line: number,
  column: number
): Promise<LspCodeAction[]> {
  return invoke<LspCodeAction[]>("lsp_code_action", {
    language,
    filePath,
    line,
    column,
  });
}

export interface LspLocation {
  uri: string;
  range: [number, number, number, number];
}

export async function goToDefinition(
  language: string,
  filePath: string,
  line: number,
  column: number
): Promise<LspLocation | null> {
  return invoke<LspLocation | null>("lsp_go_to_definition", {
    language,
    filePath,
    line,
    column,
  });
}

export async function findReferences(
  language: string,
  filePath: string,
  line: number,
  column: number
): Promise<LspLocation[]> {
  return invoke<LspLocation[]>("lsp_find_references", {
    language,
    filePath,
    line,
    column,
  });
}

export interface LspSymbol {
  name: string;
  kind: string;
  detail?: string;
  range: [number, number, number, number];
  selection_range: [number, number, number, number];
  children: LspSymbol[];
}

export async function getDocumentSymbols(
  language: string,
  filePath: string
): Promise<LspSymbol[]> {
  return invoke<LspSymbol[]>("lsp_document_symbols", {
    language,
    filePath,
  });
}

export interface LspTextEdit {
  range: [number, number, number, number];
  new_text: string;
}

export async function formatDocument(
  language: string,
  filePath: string
): Promise<LspTextEdit[]> {
  return invoke<LspTextEdit[]>("lsp_format_document", {
    language,
    filePath,
  });
}

export interface LspDiagnostic {
  file_path: string;
  range: [number, number, number, number];
  severity: string;
  message: string;
  source?: string;
  code?: string;
}
