import { spawn } from "node:child_process";
import { lstat, realpath, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { StoredDiff } from "@relaycode/shared";
import type { ProjectBinding } from "./config.js";
import { sanitizeText } from "./sanitize.js";

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}

export interface GitRunOptions {
  signal?: AbortSignal;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  raw?: boolean;
}

export async function runGit(args: readonly string[], cwd: string, options: GitRunOptions = {}): Promise<string> {
  const max = options.maxOutputBytes ?? 4_000_000;
  return await new Promise<string>((accept, reject) => {
    const child = spawn("git", [...args], {
      cwd,
      env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= max) target.push(chunk);
      else child.kill("SIGTERM");
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => reject(error));
    child.once("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = sanitizeText(Buffer.concat(stderr).toString("utf8").trim());
      if (bytes > max) {
        reject(new GitCommandError("Git output exceeded the safety limit", args, code, errorOutput));
      } else if (code !== 0) {
        reject(new GitCommandError(`git ${args[0] ?? "command"} failed: ${errorOutput || `exit ${code}`}`, args, code, errorOutput));
      } else {
        accept(options.raw ? output : output.trim());
      }
    });
  });
}

/** Compares GitHub HTTPS/SSH/scp remotes without treating credentials as identity. */
export function normalizeRemoteUrl(input: string): string {
  let value = input.trim().replace(/\\/g, "/");
  value = value.replace(/^git@([^:]+):/i, "ssh://$1/");
  try {
    const url = new URL(value);
    const port = url.port && !((url.protocol === "https:" && url.port === "443") || (url.protocol === "ssh:" && url.port === "22"))
      ? `:${url.port}`
      : "";
    return `${url.hostname.toLowerCase()}${port}/${url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "")}`.toLowerCase();
  } catch {
    return value.replace(/^(?:https?|ssh|git):\/\//i, "").replace(/^[^@/]+@/, "").replace(/\.git\/?$/i, "").replace(/\/$/, "").toLowerCase();
  }
}

export async function getRemoteUrl(repositoryPath: string): Promise<string> {
  return await runGit(["remote", "get-url", "origin"], repositoryPath);
}

export async function validateRepository(repositoryPath: string, expectedRemoteUrl: string): Promise<void> {
  const root = await runGit(["rev-parse", "--show-toplevel"], repositoryPath);
  const canonicalRoot = await realpath(root);
  const canonicalRequested = await realpath(repositoryPath);
  if (canonicalRoot !== canonicalRequested) {
    throw new Error(`The mapping must point to the repository root (${canonicalRoot}).`);
  }
  const actual = await getRemoteUrl(repositoryPath);
  if (normalizeRemoteUrl(actual) !== normalizeRemoteUrl(expectedRemoteUrl)) {
    throw new Error(`Repository remote mismatch: expected ${sanitizeText(expectedRemoteUrl)}, found ${sanitizeText(actual)}.`);
  }
}

export interface SyncResult {
  commitSha: string;
  baselineUntracked: Set<string>;
}

export async function listUntracked(repositoryPath: string): Promise<Set<string>> {
  const output = await runGit(["ls-files", "--others", "--exclude-standard", "-z"], repositoryPath, { raw: true });
  return new Set(output ? output.split("\0").filter(Boolean) : []);
}

export async function syncToRemote(
  binding: ProjectBinding,
  branch: string,
  expectedRemoteUrl: string,
  signal?: AbortSignal,
): Promise<SyncResult> {
  await validateRepository(binding.path, expectedRemoteUrl);
  await runGit(["check-ref-format", "--branch", branch], binding.path, { signal });
  await runGit(["fetch", "--prune", "origin"], binding.path, { signal });
  const remoteRef = `refs/remotes/origin/${branch}`;
  const remoteSha = await runGit(["rev-parse", "--verify", remoteRef], binding.path, { signal });
  const localBranchExists = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], binding.path, { signal }).then(
    () => true,
    (error) => {
      if (error instanceof GitCommandError && error.exitCode === 1) return false;
      throw error;
    },
  );
  if (localBranchExists) await runGit(["checkout", "-f", branch], binding.path, { signal });
  else await runGit(["checkout", "-f", "-b", branch, `origin/${branch}`], binding.path, { signal });
  await runGit(["reset", "--hard", `origin/${branch}`], binding.path, { signal });
  return { commitSha: remoteSha, baselineUntracked: await listUntracked(binding.path) };
}

async function addTaskChanges(repositoryPath: string, baselineUntracked: ReadonlySet<string>): Promise<Set<string>> {
  await runGit(["add", "-u"], repositoryPath);
  const currentUntracked = await listUntracked(repositoryPath);
  const created = new Set([...currentUntracked].filter((path) => !baselineUntracked.has(path)));
  const paths = [...created];
  for (let index = 0; index < paths.length; index += 100) {
    await runGit(["--literal-pathspecs", "add", "--", ...paths.slice(index, index + 100)], repositoryPath);
  }
  return created;
}

async function safelyRemoveTaskFiles(repositoryPath: string, baselineUntracked: ReadonlySet<string>): Promise<void> {
  const current = await listUntracked(repositoryPath);
  const canonicalRoot = `${await realpath(repositoryPath)}${sep}`;
  for (const path of current) {
    if (baselineUntracked.has(path) || isAbsolute(path)) continue;
    const absolute = resolve(repositoryPath, path);
    const rel = relative(repositoryPath, absolute);
    if (rel.startsWith("..") || absolute === repositoryPath) continue;
    const info = await lstat(absolute).catch(() => undefined);
    if (!info) continue;
    if (info.isSymbolicLink()) {
      await rm(absolute);
      continue;
    }
    const resolved = await realpath(absolute).catch(() => absolute);
    if (`${resolved}${info.isDirectory() ? sep : ""}`.startsWith(canonicalRoot)) {
      await rm(absolute, { recursive: info.isDirectory(), force: false });
    }
  }
}

export async function discardTaskChanges(
  binding: ProjectBinding,
  branch: string,
  baselineUntracked: ReadonlySet<string>,
): Promise<string> {
  await runGit(["fetch", "--prune", "origin"], binding.path);
  await runGit(["reset", "--hard", `origin/${branch}`], binding.path);
  await safelyRemoveTaskFiles(binding.path, baselineUntracked);
  return await runGit(["rev-parse", `origin/${branch}`], binding.path);
}

export type CommitResult =
  | { ok: true; baseCommitSha: string; commitSha: string; diff: StoredDiff }
  | { ok: false; code: "REMOTE_DIVERGED" | "NO_CHANGES" | "PUSH_FAILED"; message: string };

function parseNumstat(output: string): StoredDiff["files"] {
  if (!output) return [];
  return output.split("\n").filter(Boolean).map((line) => {
    const [added = "0", deleted = "0", ...pathParts] = line.split("\t");
    return {
      path: pathParts.join("\t"),
      additions: added === "-" ? 0 : Number.parseInt(added, 10) || 0,
      deletions: deleted === "-" ? 0 : Number.parseInt(deleted, 10) || 0,
    };
  });
}

export interface CommitOptions {
  message: string;
  authorName: string;
  authorEmail: string;
  signal?: AbortSignal;
}

export async function commitAndPush(
  binding: ProjectBinding,
  branch: string,
  baseCommitSha: string,
  baselineUntracked: ReadonlySet<string>,
  options: CommitOptions,
): Promise<CommitResult> {
  await runGit(["fetch", "--prune", "origin"], binding.path, { signal: options.signal });
  const remoteSha = await runGit(["rev-parse", `origin/${branch}`], binding.path, { signal: options.signal });
  if (remoteSha !== baseCommitSha) {
    await runGit(["reset", "--hard", `origin/${branch}`], binding.path);
    await safelyRemoveTaskFiles(binding.path, baselineUntracked);
    return { ok: false, code: "REMOTE_DIVERGED", message: `Remote ${branch} advanced; local task changes were discarded.` };
  }

  await addTaskChanges(binding.path, baselineUntracked);
  const staged = await runGit(["diff", "--cached", "--quiet"], binding.path, { signal: options.signal }).then(
    () => false,
    (error) => {
      if (error instanceof GitCommandError && error.exitCode === 1) return true;
      throw error;
    },
  );
  if (!staged) {
    await runGit(["reset", "--hard", `origin/${branch}`], binding.path);
    await safelyRemoveTaskFiles(binding.path, baselineUntracked);
    return { ok: false, code: "NO_CHANGES", message: "The agent completed without producing repository changes." };
  }

  await runGit([
    "-c", `user.name=${options.authorName}`,
    "-c", `user.email=${options.authorEmail}`,
    "commit", "--no-gpg-sign", "-m", options.message,
  ], binding.path, { signal: options.signal });
  const commitSha = await runGit(["rev-parse", "HEAD"], binding.path, { signal: options.signal });
  let pushAccepted = true;
  try {
    await runGit(["push", "origin", `HEAD:refs/heads/${branch}`], binding.path, { signal: options.signal });
  } catch (error) {
    // A normal push is deliberately used here. If it loses a race, never force it.
    await runGit(["fetch", "--prune", "origin"], binding.path).catch(() => undefined);
    const newestRemote = await runGit(["rev-parse", `origin/${branch}`], binding.path).catch(() => remoteSha);
    if (newestRemote === commitSha) {
      // The transport can fail after the remote has accepted the update. Treat the
      // remote ref as authoritative and avoid requeueing a duplicate task.
      pushAccepted = true;
    } else {
      pushAccepted = false;
      await runGit(["reset", "--hard", `origin/${branch}`], binding.path).catch(() => undefined);
    }
    if (pushAccepted) {
      // Continue below and compute the centrally stored diff.
    } else {
      await safelyRemoveTaskFiles(binding.path, baselineUntracked);
      return {
        ok: false,
        code: newestRemote !== baseCommitSha ? "REMOTE_DIVERGED" : "PUSH_FAILED",
        message: newestRemote !== baseCommitSha
          ? `Remote ${branch} advanced during push; local task changes were discarded.`
          : sanitizeText(error instanceof Error ? error.message : error),
      };
    }
  }

  const [unified, numstat] = await Promise.all([
    runGit(["diff", "--no-ext-diff", "--unified=3", `${baseCommitSha}..${commitSha}`], binding.path, { maxOutputBytes: 2_000_000 }),
    runGit(["diff", "--numstat", `${baseCommitSha}..${commitSha}`], binding.path),
  ]);
  return {
    ok: true,
    baseCommitSha,
    commitSha,
    diff: { baseSha: baseCommitSha, commitSha, files: parseNumstat(numstat), unified },
  };
}

export interface RollbackResult {
  targetSha: string;
  previousSha: string;
}

export async function rollbackRemote(
  binding: ProjectBinding,
  branch: string,
  expectedRemoteUrl: string,
  targetSha: string,
  signal?: AbortSignal,
): Promise<RollbackResult> {
  if (!/^[0-9a-f]{40,64}$/i.test(targetSha)) throw new Error("Rollback target must be a full commit SHA.");
  await validateRepository(binding.path, expectedRemoteUrl);
  await runGit(["check-ref-format", "--branch", branch], binding.path, { signal });
  await runGit(["fetch", "--prune", "origin"], binding.path, { signal });
  const previousSha = await runGit(["rev-parse", `origin/${branch}`], binding.path, { signal });
  await runGit(["cat-file", "-e", `${targetSha}^{commit}`], binding.path, { signal });
  await runGit(["merge-base", "--is-ancestor", targetSha, previousSha], binding.path, { signal }).catch(() => {
    throw new Error("Rollback target is not an ancestor of the current remote branch.");
  });
  const localBranchExists = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], binding.path, { signal }).then(
    () => true,
    (error) => {
      if (error instanceof GitCommandError && error.exitCode === 1) return false;
      throw error;
    },
  );
  if (localBranchExists) await runGit(["checkout", "-f", branch], binding.path, { signal });
  else await runGit(["checkout", "-f", "-b", branch, `origin/${branch}`], binding.path, { signal });
  await runGit(["reset", "--hard", `origin/${branch}`], binding.path, { signal });
  await runGit(["reset", "--hard", targetSha], binding.path, { signal });
  try {
    await runGit([
      "push",
      `--force-with-lease=refs/heads/${branch}:${previousSha}`,
      "origin",
      `HEAD:refs/heads/${branch}`,
    ], binding.path, { signal });
  } catch (error) {
    await runGit(["fetch", "--prune", "origin"], binding.path).catch(() => undefined);
    await runGit(["reset", "--hard", `origin/${branch}`], binding.path).catch(() => undefined);
    throw new Error(`Rollback push was rejected (branch protection or remote movement): ${sanitizeText(error instanceof Error ? error.message : error)}`);
  }
  return { targetSha, previousSha };
}
