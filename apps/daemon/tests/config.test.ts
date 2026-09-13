import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, saveConfig } from "../src/config.js";

describe("daemon config", () => {
  it("round-trips a locally held credential using a private file mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relaycode-config-test-"));
    const path = join(directory, "nested", "config.json");
    await saveConfig({
      version: 1,
      serverUrl: "http://localhost:4000",
      userId: "alice",
      token: "daemon-secret",
      agent: { provider: "openai", openaiApiKey: "sk-local-only-example-value" },
      projects: {},
    }, path);
    expect(await loadConfig(path)).toMatchObject({ userId: "alice", agent: { provider: "openai" } });
    expect(await readFile(path, "utf8")).toContain("sk-local-only-example-value");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
