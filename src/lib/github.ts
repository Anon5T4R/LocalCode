import { invoke } from "@tauri-apps/api/core";
import type { RepoEntry, GithubPrResult } from "../types";

export async function setToken(token: string): Promise<void> {
  return invoke("github_set_token", { token });
}

export async function getToken(): Promise<string | null> {
  return invoke<string | null>("github_get_token");
}

export async function removeToken(): Promise<void> {
  return invoke("github_remove_token");
}

export async function listRepos(token: string): Promise<RepoEntry[]> {
  return invoke<RepoEntry[]>("github_list_repos", { token });
}

export async function createRepo(
  token: string,
  name: string,
  isPrivate: boolean,
  description: string
): Promise<RepoEntry> {
  return invoke<RepoEntry>("github_create_repo", {
    token,
    name,
    private: isPrivate,
    description,
  });
}

export async function createPullRequest(
  token: string,
  owner: string,
  repo: string,
  title: string,
  body: string,
  head: string,
  base: string
): Promise<GithubPrResult> {
  return invoke<GithubPrResult>("github_create_pr", {
    token,
    owner,
    repo,
    title,
    body,
    head,
    base,
  });
}

export async function cloneRepo(url: string, dest: string): Promise<void> {
  return invoke("github_clone_repo", { url, dest });
}

export interface DeviceFlowResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
}

export async function deviceLogin(clientId: string): Promise<DeviceFlowResponse> {
  return invoke<DeviceFlowResponse>("github_device_login", { clientId });
}

export async function pollToken(deviceCode: string, clientId: string): Promise<string> {
  return invoke<string>("github_poll_token", { deviceCode, clientId });
}
