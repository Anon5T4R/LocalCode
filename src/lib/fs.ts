import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "../types";

export async function readFile(path: string): Promise<string> {
  return invoke<string>("read_text_file", { path });
}

export async function writeFile(path: string, contents: string): Promise<void> {
  return invoke("write_text_file", { path, contents });
}

export async function listDir(path: string): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("list_dir", { path });
}

export async function createDir(path: string): Promise<void> {
  return invoke("create_dir", { path });
}

export async function deleteEntry(path: string): Promise<void> {
  return invoke("delete_file", { path });
}

export async function renameEntry(oldPath: string, newPath: string): Promise<void> {
  return invoke("rename_file", { oldPath, newPath });
}

const builtinExtMap: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  tsx: "typescript",
  jsx: "javascript",
  rs: "rust",
  py: "python",
  json: "json",
  md: "markdown",
  html: "html",
  css: "css",
  toml: "toml",
  yaml: "yaml",
  yml: "yaml",
  xml: "xml",
  sh: "shell",
  bash: "shell",
  go: "go",
  java: "java",
  cpp: "cpp",
  c: "c",
  h: "c",
  hpp: "cpp",
  sql: "sql",
  graphql: "graphql",
  svg: "xml",
  txt: "plaintext",
};

let extensionExtMap: Record<string, string> = {};

export function registerExtensionLanguages(languages: { extensions: string[]; monacoLanguage?: string }[]): void {
  for (const lang of languages) {
    if (!lang.monacoLanguage) continue;
    for (const ext of lang.extensions) {
      const key = ext.startsWith(".") ? ext.slice(1) : ext;
      // Extensions cannot override built-in entries
      if (!(key in builtinExtMap)) {
        extensionExtMap[key] = lang.monacoLanguage;
      }
    }
  }
}

export function extToLanguage(ext: string): string {
  return builtinExtMap[ext] || extensionExtMap[ext] || "plaintext";
}
