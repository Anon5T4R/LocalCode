import { invoke } from "@tauri-apps/api/core";
import type { ComponentType } from "react";
import { listDir, readFile } from "./fs";
import type { FileEntry } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtensionPanel {
  id: string;
  title: string;
  location: "side-panel" | "sidebar" | "bottom";
  entry: string;
  icon?: string;
}

export interface ExtensionLanguage {
  id: string;
  extensions: string[];
  monacoLanguage?: string;
  lsp?: {
    command: string;
    args: string[];
    languageId?: string;
  };
}

export interface ExtensionCommand {
  id: string;
  title: string;
  keybindings?: string[];
}

export interface ExtensionTheme {
  name: string;
  type: "dark" | "light";
  colors: Record<string, string>;
}

export interface ExtensionManifest {
  name: string;
  version: string;
  displayName?: string;
  contributes: {
    panels?: ExtensionPanel[];
    languages?: ExtensionLanguage[];
    commands?: ExtensionCommand[];
    themes?: ExtensionTheme[];
  };
}

export interface LoadedExtension {
  dir: string;
  manifest: ExtensionManifest;
}

// ---------------------------------------------------------------------------
// ExtensionManager
// ---------------------------------------------------------------------------

export class ExtensionManager {
  private extensions: LoadedExtension[] = [];
  private panelComponents = new Map<string, ComponentType<any>>();

  async load(workspaceRoot?: string | null): Promise<void> {
    const dirs = await this.collectExtensionDirs(workspaceRoot);
    for (const dir of dirs) {
      await this.loadFromDir(dir);
    }
  }

  private async collectExtensionDirs(workspaceRoot?: string | null): Promise<string[]> {
    const dirs: string[] = [];
    try {
      const userDir = await invoke<string>("get_extensions_dir");
      dirs.push(userDir);
    } catch { /* ignore */ }
    if (workspaceRoot) {
      const wsDir = workspaceRoot.replace(/\\/g, "/") + "/.localcode/extensions";
      dirs.push(wsDir);
    }
    return dirs;
  }

  private async loadFromDir(dir: string): Promise<void> {
    let entries: FileEntry[];
    try {
      entries = await listDir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.is_dir) continue;
      try {
        const manifestPath = entry.path.replace(/\\/g, "/") + "/extension.json";
        const content = await readFile(manifestPath);
        const manifest: ExtensionManifest = JSON.parse(content);
        this.extensions.push({ dir: entry.path, manifest });
      } catch { /* skip invalid extensions */ }
    }
  }

  getExtensions(): LoadedExtension[] {
    return this.extensions;
  }

  getPanels(location?: ExtensionPanel["location"]): ExtensionPanel[] {
    const all = this.extensions.flatMap((e) => e.manifest.contributes.panels || []);
    return location ? all.filter((p) => p.location === location) : all;
  }

  getLanguages(): ExtensionLanguage[] {
    return this.extensions.flatMap((e) => e.manifest.contributes.languages || []);
  }

  getCommands(): ExtensionCommand[] {
    return this.extensions.flatMap((e) => e.manifest.contributes.commands || []);
  }

  getThemes(): ExtensionTheme[] {
    return this.extensions.flatMap((e) => e.manifest.contributes.themes || []);
  }

  async loadPanelComponent(panel: ExtensionPanel): Promise<ComponentType<any> | null> {
    const key = panel.id;
    if (this.panelComponents.has(key)) return null;
    try {
      const mod = await import(/* @vite-ignore */ panel.entry);
      return mod.default || null;
    } catch {
      return null;
    }
  }
}
