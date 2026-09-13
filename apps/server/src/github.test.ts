import { afterEach, describe, expect, it, vi } from "vitest";
import { getGitHubRepository, inferGitHubRepositoryCommands, listGitHubRepositories } from "./github.js";

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
});
