import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectBinding } from "../src/config.js";
import { commitAndPush, normalizeRemoteUrl, rollbackRemote, runGit, syncToRemote } from "../src/git.js";

const exec = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return result.stdout.trim();
}

async function fixture(): Promise<{ root: string; remote: string; seed: string; worker: string; binding: ProjectBinding; initialSha: string }> {
  const root = await mkdtemp(join(tmpdir(), "relaycode-git-test-"));
  temporaryDirectories.push(root);
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const worker = join(root, "worker");
  await exec("git", ["init", "--bare", "--initial-branch=main", remote]);
  await exec("git", ["init", "--initial-branch=main", seed]);
  await git(seed, "config", "user.name", "Fixture");
  await git(seed, "config", "user.email", "fixture@example.com");
  await writeFile(join(seed, "app.txt"), "initial\n");
  await git(seed, "add", "app.txt");
  await git(seed, "commit", "-m", "initial");
  await git(seed, "remote", "add", "origin", remote);
  await git(seed, "push", "-u", "origin", "main");
  const initialSha = await git(seed, "rev-parse", "HEAD");
  await exec("git", ["clone", remote, worker]);
  await git(worker, "config", "user.name", "Alice");
  await git(worker, "config", "user.email", "alice@example.com");
  return { root, remote, seed, worker, binding: { path: worker, remoteUrl: remote }, initialSha };
}

afterEach(async () => {
  // Temp roots are intentionally left to the OS when a test fails, aiding diagnosis.
  temporaryDirectories.length = 0;
});

describe("remote URL normalization", () => {
  it("treats common GitHub SSH and HTTPS forms as the same repository", () => {
    expect(normalizeRemoteUrl("git@github.com:OpenAI/example.git")).toBe(normalizeRemoteUrl("https://github.com/openai/example"));
    expect(normalizeRemoteUrl("https://user:secret@github.com/OpenAI/example.git")).toBe("github.com/openai/example");
  });
});

describe("real Git safety workflow", () => {
  it("hard-resets tracked files, preserves baseline untracked files, commits task files, and pushes", async () => {
    const { worker, remote, binding, initialSha, root } = await fixture();
    await writeFile(join(worker, "app.txt"), "untrusted local edit\n");
    await writeFile(join(worker, ".env"), "LOCAL_SECRET=preserve-me\n");

    const sync = await syncToRemote(binding, "main", remote);
    expect(sync.commitSha).toBe(initialSha);
    expect(await readFile(join(worker, "app.txt"), "utf8")).toBe("initial\n");
    expect(await readFile(join(worker, ".env"), "utf8")).toContain("preserve-me");
    expect(sync.baselineUntracked.has(".env")).toBe(true);

    await writeFile(join(worker, "app.txt"), "implemented\n");
    await writeFile(join(worker, ".env"), "LOCAL_SECRET=still-not-committed\n");
    await writeFile(join(worker, "new-file.txt"), "new task file\n");
    const pushed = await commitAndPush(binding, "main", initialSha, sync.baselineUntracked, {
      message: "task implementation",
      authorName: "Alice",
      authorEmail: "alice@example.com",
    });
    expect(pushed.ok).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.diff.files.map((file) => file.path)).toEqual(["app.txt", "new-file.txt"]);

    const verify = join(root, "verify");
    await exec("git", ["clone", remote, verify]);
    expect(await readFile(join(verify, "app.txt"), "utf8")).toBe("implemented\n");
    expect(await readFile(join(verify, "new-file.txt"), "utf8")).toBe("new task file\n");
    await expect(readFile(join(verify, ".env"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects and discards work when the remote advances after the base sync", async () => {
    const { worker, seed, remote, binding } = await fixture();
    await writeFile(join(worker, ".env"), "KEEP=1\n");
    const sync = await syncToRemote(binding, "main", remote);
    await writeFile(join(worker, "app.txt"), "local agent work\n");
    await writeFile(join(worker, "agent-created.txt"), "discard me\n");

    await writeFile(join(seed, "app.txt"), "external change\n");
    await git(seed, "add", "app.txt");
    await git(seed, "commit", "-m", "external");
    await git(seed, "push", "origin", "main");

    const result = await commitAndPush(binding, "main", sync.commitSha, sync.baselineUntracked, {
      message: "must not push",
      authorName: "Alice",
      authorEmail: "alice@example.com",
    });
    expect(result).toMatchObject({ ok: false, code: "REMOTE_DIVERGED" });
    expect(await readFile(join(worker, "app.txt"), "utf8")).toBe("external change\n");
    expect(await readFile(join(worker, ".env"), "utf8")).toBe("KEEP=1\n");
    await expect(readFile(join(worker, "agent-created.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rewrites history with an exact force-with-lease and resets the local checkout", async () => {
    const { worker, remote, binding, initialSha } = await fixture();
    const sync = await syncToRemote(binding, "main", remote);
    await writeFile(join(worker, "app.txt"), "second commit\n");
    const pushed = await commitAndPush(binding, "main", sync.commitSha, sync.baselineUntracked, {
      message: "second",
      authorName: "Alice",
      authorEmail: "alice@example.com",
    });
    expect(pushed.ok).toBe(true);
    const rollback = await rollbackRemote(binding, "main", remote, initialSha);
    expect(rollback.targetSha).toBe(initialSha);
    expect(await runGit(["ls-remote", remote, "refs/heads/main"], worker)).toContain(initialSha);
    expect(await readFile(join(worker, "app.txt"), "utf8")).toBe("initial\n");
  });
});
