import { describe, expect, it } from "vitest";
import { DaemonConfigSchema } from "../../daemon/src/config.js";

describe("desktop companion configuration", () => {
  it("keeps existing mappings when an identity is paired", () => {
    const config = DaemonConfigSchema.parse({ version: 1, serverUrl: "https://relaycode.example", userId: "alice", token: "secret", projects: { p1: { path: "/tmp/repo", remoteUrl: "https://github.com/acme/repo.git" } } });
    expect(config.projects.p1?.remoteUrl).toContain("acme/repo");
  });
});
