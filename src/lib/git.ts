import { invoke } from "@tauri-apps/api/core";
import type { StatusEntry, CommitEntry, BranchEntry } from "../types";

export async function getStatus(repoPath: string): Promise<StatusEntry[]> {
  return invoke<StatusEntry[]>("git_status", { repoPath });
}

export async function stageFiles(repoPath: string, paths: string[]): Promise<void> {
  return invoke("git_add", { repoPath, paths });
}

export async function commit(repoPath: string, message: string): Promise<void> {
  return invoke("git_commit", { repoPath, message });
}

export async function getLog(repoPath: string, max: number = 20): Promise<CommitEntry[]> {
  return invoke<CommitEntry[]>("git_log", { repoPath, max });
}

export async function getBranches(repoPath: string): Promise<BranchEntry[]> {
  return invoke<BranchEntry[]>("git_branches", { repoPath });
}

export async function checkout(repoPath: string, branch: string): Promise<void> {
  return invoke("git_checkout", { repoPath, branch });
}

export async function push(repoPath: string): Promise<void> {
  return invoke("git_push", { repoPath });
}

export async function pull(repoPath: string): Promise<void> {
  return invoke("git_pull", { repoPath });
}
