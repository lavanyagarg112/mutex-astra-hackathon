#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { addProjectBinding, configPath, DaemonConfigSchema, loadConfig, saveConfig, type DaemonConfig } from "./config.js";
import { validateRepository } from "./git.js";
import { sanitizeText } from "./sanitize.js";
import { startDaemon } from "./service.js";

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const equals = args.find((value) => value.startsWith(`--${name}=`));
  if (equals) return equals.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

async function optionalConfig(): Promise<DaemonConfig | undefined> {
  try { return await loadConfig(); } catch { return undefined; }
}

async function prompt(label: string, fallback?: string): Promise<string> {
  if (!stdin.isTTY) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${label} is required as a command-line option in a non-interactive terminal.`);
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`${label}${fallback ? ` [${fallback}]` : ""}: `)).trim();
    return answer || fallback || "";
  } finally {
    rl.close();
  }
}

async function configure(): Promise<void> {
  const projectIndex = args.indexOf("project");
  if (projectIndex >= 0) {
    const projectId = args[projectIndex + 1] ?? await prompt("Project ID");
    if (!projectId) throw new Error("Project ID is required.");
    const config = await loadConfig();
    const repositoryPath = flag("path") ?? await prompt("Absolute local repository path");
    const expectedRemote = flag("remote") ?? await prompt("Expected origin URL (leave blank to use current origin)", "");
    const binding = await addProjectBinding(config, projectId, repositoryPath, expectedRemote || undefined, flag("branch"));
    if (flag("git-name")) binding.gitAuthorName = flag("git-name")!;
    if (flag("git-email")) binding.gitAuthorEmail = flag("git-email")!;
    await saveConfig(config);
    console.log(`Mapped ${projectId} to ${binding.path} (${binding.remoteUrl}).`);
    return;
  }

  const current = await optionalConfig();
  const serverUrl = flag("server-url") ?? process.env.RELAYCODE_SERVER_URL ?? await prompt("Relaycode server URL", current?.serverUrl ?? "http://localhost:4100");
  const userId = flag("user-id") ?? process.env.RELAYCODE_USER_ID ?? await prompt("User ID", current?.userId);
  const token = flag("token") ?? process.env.RELAYCODE_DAEMON_TOKEN ?? current?.token ?? await prompt("Daemon token");
  const provider = flag("agent-provider") ?? current?.agent.provider ?? "auto";
  const command = flag("agent-command") ?? current?.agent.command;
  const openaiApiKey = flag("openai-api-key") ?? process.env.OPENAI_API_KEY ?? current?.agent.openaiApiKey;
  const openaiModel = flag("openai-model") ?? current?.agent.openaiModel;
  const config = DaemonConfigSchema.parse({
    version: 1,
    serverUrl,
    userId,
    token,
    agent: { provider, ...(command ? { command } : {}), ...(openaiApiKey ? { openaiApiKey } : {}), ...(openaiModel ? { openaiModel } : {}) },
    projects: current?.projects ?? {},
  });
  await saveConfig(config);
  console.log(`Saved daemon configuration to ${configPath()}. Credentials are stored locally and will not be sent to browser clients.`);
  console.log(`Agent provider: ${config.agent.provider}${openaiApiKey ? " (OpenAI credential configured locally)" : ""}.`);
}

async function list(): Promise<void> {
  const config = await loadConfig();
  console.log(`Server: ${config.serverUrl}`);
  console.log(`User: ${config.userId}`);
  console.log(`Daemon credential: configured`);
  console.log(`Agent: ${config.agent.provider}${(process.env.OPENAI_API_KEY || config.agent.openaiApiKey) ? " (OpenAI credential available)" : ""}`);
  const entries = Object.entries(config.projects);
  if (!entries.length) {
    console.log("Projects: none configured");
    return;
  }
  console.log("Projects:");
  for (const [projectId, binding] of entries) {
    const valid = await validateRepository(binding.path, binding.remoteUrl).then(() => "valid", () => "needs attention");
    console.log(`  ${projectId} -> ${binding.path} [${valid}]`);
  }
}

async function start(): Promise<void> {
  const config = await loadConfig();
  const runtime = startDaemon(config, (status) => {
    if (status.state === "connected") console.log(`Connected to ${status.serverUrl} as ${status.userId}.`);
    if (status.state === "disconnected") console.log(`Disconnected from Relaycode (${status.reason}); reconnecting…`);
    if (status.state === "error") console.error(`Connection error: ${status.message}`);
  });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log("Stopping local companion…");
    await runtime.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

function usage(): void {
  console.log(`Relaycode local companion

Usage:
  relaycode-daemon configure [--server-url URL] [--user-id ID] [--token TOKEN]
      [--agent-provider auto|openai|command|demo] [--openai-api-key KEY]
      [--openai-model MODEL] [--agent-command COMMAND]
  relaycode-daemon configure project <project-id> --path /absolute/repo
      [--remote git@github.com:owner/repo.git] [--branch main]
      [--git-name "Alice"] [--git-email alice@example.com]
  relaycode-daemon list
  relaycode-daemon start [--polling]

Environment alternatives:
  RELAYCODE_SERVER_URL, RELAYCODE_USER_ID, RELAYCODE_DAEMON_TOKEN,
  OPENAI_API_KEY, OPENAI_MODEL, RELAYCODE_CONFIG_PATH
`);
}

async function main(): Promise<void> {
  const command = args[0];
  if (command === "configure") await configure();
  else if (command === "list") await list();
  else if (command === "start") await start();
  else if (command === "help" || command === "--help" || command === "-h" || !command) usage();
  else throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(sanitizeText(error instanceof Error ? error.message : error));
  process.exitCode = 1;
});
