import { afterEach, describe, expect, it, vi } from "vitest";
import { getGitHubHistory, getGitHubRepository, inferGitHubRepositoryCommands, listGitHubDirectory, listGitHubRepositories, readGitHubFile } from "./github.js";

afterEach(() => vi.unstubAllGlobals());

describe("GitHub repository access", () => {
  it("returns repository metadata and write permissions for the project picker", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([{
      id: 42, full_name: "relay/code", name: "code", private: true,
      html_url: "https://github.com/relay/code", clone_url: "https://github.com/relay/code.git",
      default_branch: "main", owner: { login: "relay" }, permissions: { pull: true, push: true },
    }]), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listGitHubRepositories("secret-token")).resolves.toEqual([expect.objectContaining({
      fullName: "relay/code", canRead: true, canWrite: true, defaultBranch: "main",
    })]);
    expect(fetchMock.mock.calls[0]?.[1]?.headers.Authorization).toBe("Bearer secret-token");
  });

  it("returns a clear authorization error when GitHub hides an inaccessible repository", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 404 })));
    await expect(getGitHubRepository("token", "private-org", "private-repo")).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("Confirm that this GitHub account can open the repository"),
    });
  });

  it("explains when the OAuth token is missing repository scope", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", {
      status: 404,
      headers: { "X-OAuth-Scopes": "read:user, user:email" },
    })));
    await expect(getGitHubRepository("token", "private-org", "private-repo")).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("OAuth scope: repo"),
    });
  });

  it("explains when organization SSO authorization is required", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", {
      status: 403,
      headers: { "X-GitHub-SSO": "required; url=https://github.com/orgs/example/sso" },
    })));
    await expect(getGitHubRepository("token", "private-org", "private-repo")).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("requires SSO authorization"),
    });
  });

  it("keeps read and write repository permissions separate", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 42, full_name: "relay/code", name: "code", private: true,
      html_url: "https://github.com/relay/code", clone_url: "https://github.com/relay/code.git",
      default_branch: "main", owner: { login: "relay" }, permissions: { pull: true, push: false },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(getGitHubRepository("token", "relay", "code")).resolves.toMatchObject({ canRead: true, canWrite: false });
  });

  it("reads manifests from the selected branch before inferring commands", async () => {
    const manifest = Buffer.from(JSON.stringify({ scripts: { dev: "vite", test: "vitest" }, dependencies: { react: "latest" } })).toString("base64");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ tree: [
        { path: "package.json", type: "blob" },
        { path: "pnpm-lock.yaml", type: "blob" },
      ], truncated: false }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ type: "file", encoding: "base64", content: manifest }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(inferGitHubRepositoryCommands("secret-token", "relay", "code", "feature/demo")).resolves.toMatchObject({
      installCommand: "pnpm install",
      frontendCommand: "pnpm run dev",
      testCommand: "pnpm run test",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/git/trees/feature%2Fdemo?recursive=1");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/contents/package.json?ref=feature%2Fdemo");
  });

  it("lists and reads canonical branch files without a local companion", async () => {
    const source = Buffer.from("export const ready = true;\n").toString("base64");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { name: "src", path: "src", type: "dir", size: 0 },
        { name: "README.md", path: "README.md", type: "file", size: 12 },
      ]), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ type: "file", encoding: "base64", content: source }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listGitHubDirectory("token", "relay", "code", "feature/demo")).resolves.toEqual({
      ok: true,
      path: "",
      entries: [
        { name: "src", path: "src", type: "directory" },
        { name: "README.md", path: "README.md", type: "file", size: 12 },
      ],
    });
    await expect(readGitHubFile("token", "relay", "code", "feature/demo", "src/index.ts")).resolves.toMatchObject({
      ok: true,
      content: "export const ready = true;\n",
      binary: false,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/contents?ref=feature%2Fdemo");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/contents/src/index.ts?ref=feature%2Fdemo");
  });

  it("loads canonical branch history without a local companion", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ name: "main", commit: { sha: "abc123" } }]), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        sha: "abc123",
        author: { login: "alice" },
        commit: { message: "Ship files panel\n\nDetails", author: { name: "Alice", date: "2026-09-13T12:00:00Z" }, committer: null },
      }]), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(getGitHubHistory("token", "relay", "code", "main")).resolves.toEqual({
      ok: true,
      branches: [{ name: "main", current: true, remote: true }],
      commits: [{ sha: "abc123", author: "alice", date: "2026-09-13T12:00:00Z", message: "Ship files panel", refs: ["origin/main"] }],
    });
  });
});
