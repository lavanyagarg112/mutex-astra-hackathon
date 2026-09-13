import { HttpError } from "./auth.js";
import { commandInferenceContentPaths, inferRepositoryCommands, type RepositoryFile } from "./command-inference.js";
import { inferCommandsWithAgent } from "./agent-command-inference.js";

const apiBase = "https://api.github.com";

export type GitHubRepository = {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
  canRead: boolean;
  canWrite: boolean;
};

type GitHubRepoResponse = {
  id: number; full_name: string; name: string; private: boolean; html_url: string; clone_url: string;
  default_branch: string; owner: { login: string }; permissions?: { pull?: boolean; push?: boolean; admin?: boolean; maintain?: boolean };
};

type GitHubTreeResponse = {
  tree: Array<{ path: string; type: "blob" | "tree" | "commit"; size?: number }>;
  truncated: boolean;
};

type GitHubContentResponse = { type: string; content?: string; encoding?: string };

async function githubFetch<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", ...init?.headers },
  });
  if (response.status === 401) throw new HttpError(401, "Your GitHub authorization has expired. Sign in with GitHub again.");
  if (response.status === 403) throw new HttpError(403, "GitHub denied this request. Check the Relaycode GitHub App repository permissions.");
  if (response.status === 404) throw new HttpError(403, "Your GitHub account does not have access to this repository.");
  if (!response.ok) throw new HttpError(502, `GitHub API request failed (${response.status})`);
  return response.json() as Promise<T>;
}

export async function exchangeOAuthCode(code: string) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new HttpError(503, "GitHub login is not configured");
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, ...(process.env.GITHUB_CALLBACK_URL ? { redirect_uri: process.env.GITHUB_CALLBACK_URL } : {}) }),
  });
  const result = await response.json() as { access_token?: string; error_description?: string };
  if (!response.ok || !result.access_token) throw new HttpError(401, result.error_description || "GitHub authorization failed");
  return result.access_token;
}

export function getGitHubUser(token: string) {
  return githubFetch<{ id: number; login: string; name: string | null; avatar_url: string | null }>("/user", token);
}

export async function listGitHubRepositories(token: string) {
  const repositories: GitHubRepository[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await githubFetch<GitHubRepoResponse[]>(`/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=100&page=${page}`, token);
    repositories.push(...batch.map(serializeRepository));
    if (batch.length < 100) break;
  }
  return repositories;
}

export async function getGitHubRepository(token: string, owner: string, name: string) {
  return serializeRepository(await githubFetch<GitHubRepoResponse>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, token));
}

export async function inferGitHubRepositoryCommands(
  token: string,
  owner: string,
  name: string,
  branch: string,
  agent?: { credential: string; model?: string },
) {
  const repositoryPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const tree = await githubFetch<GitHubTreeResponse>(`${repositoryPath}/git/trees/${encodeURIComponent(branch)}?recursive=1`, token);
  const blobs = tree.tree.filter((entry) => entry.type === "blob");
  const paths = blobs.map((entry) => entry.path);
  const contentPaths = commandInferenceContentPaths(paths);
  const contentEntries = await Promise.all(contentPaths.map(async (path): Promise<RepositoryFile> => {
    const blob = blobs.find((entry) => entry.path === path);
    if (blob?.size && blob.size > 250_000) return { path };
    const file = await githubFetch<GitHubContentResponse>(`${repositoryPath}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`, token);
    const content = file.type === "file" && file.encoding === "base64" && file.content
      ? Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8").slice(0, 250_000)
      : undefined;
    return { path, content };
  }));
  const contentByPath = new Map(contentEntries.map((file) => [file.path, file.content]));
  const files = paths.map((path) => ({ path, content: contentByPath.get(path) }));
  const deterministic = inferRepositoryCommands(files);
  return agent?.credential
    ? inferCommandsWithAgent(files, deterministic, agent.credential, agent.model)
    : deterministic;
}

function serializeRepository(repo: GitHubRepoResponse): GitHubRepository {
  return {
    id: repo.id, fullName: repo.full_name, owner: repo.owner.login, name: repo.name, private: repo.private,
    htmlUrl: repo.html_url, cloneUrl: repo.clone_url, defaultBranch: repo.default_branch,
    canRead: Boolean(repo.permissions?.pull ?? true),
    canWrite: Boolean(repo.permissions?.push || repo.permissions?.admin || repo.permissions?.maintain),
  };
}
