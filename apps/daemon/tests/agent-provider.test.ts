import { describe, expect, it } from "vitest";
import { createAgentProvider } from "../src/agent.js";
import type { DaemonConfig } from "../src/config.js";

function config(provider: DaemonConfig["agent"]["provider"] = "auto"): DaemonConfig {
  return { version: 1, serverUrl: "http://localhost:4100", userId: "user", token: "token", agent: { provider }, projects: {} };
}

describe("developer agent provider selection", () => {
  it("never silently falls back to demo mode without a key", () => {
    expect(() => createAgentProvider(config())).toThrow(/No OpenAI key is configured/);
  });

  it("uses the shared project key even if an old companion preferred demo mode", () => {
    expect(createAgentProvider(config("demo"), "sk-project", "gpt-5.6-sol").name).toBe("openai");
  });

  it("uses demo mode only when the project explicitly selects it", () => {
    expect(createAgentProvider(config(), undefined, "demo").name).toBe("demo");
  });
});
