import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Project, StartTaskPayload } from "@relaycode/shared";
import { runGit } from "./git.js";
import type { DaemonConfig } from "./config.js";
import { agentChildEnvironment, sanitizeText } from "./sanitize.js";

export type AgentPhase = "PLANNING" | "EDITING" | "VALIDATING";

export interface AgentStatus {
  phase: AgentPhase;
  amendable: boolean;
  shortStatus: string;
}

export interface AgentContext {
  payload: StartTaskPayload;
  repositoryPath: string;
  signal: AbortSignal;
  pauseGate: PauseGate;
  status(status: AgentStatus): void;
  output(category: "AGENT" | "TEST" | "SYSTEM", message: string): void;
}

export interface AgentProvider {
  readonly name: string;
  run(context: AgentContext): Promise<void>;
  amend(body: string, authorName: string): void;
  pause(): void;
  resume(): void;
  cancel(): void;
}

export class PauseGate {
  private paused = false;
  private waiters = new Set<() => void>();

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  isPaused(): boolean {
    return this.paused;
  }

  async wait(signal?: AbortSignal): Promise<void> {
    if (!this.paused) return;
    await new Promise<void>((accept, reject) => {
      const wake = () => {
        cleanup();
        accept();
      };
      const abort = () => {
        cleanup();
        reject(signal?.reason ?? new Error("Cancelled"));
      };
      const cleanup = () => {
        this.waiters.delete(wake);
        signal?.removeEventListener("abort", abort);
      };
      this.waiters.add(wake);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

abstract class BaseAgentProvider implements AgentProvider {
  abstract readonly name: string;
  protected amendments: Array<{ body: string; authorName: string }> = [];
  protected child?: ChildProcess;

  abstract run(context: AgentContext): Promise<void>;

  amend(body: string, authorName: string): void {
    this.amendments.push({ body, authorName });
  }

  protected drainAmendments(): Array<{ body: string; authorName: string }> {
    return this.amendments.splice(0);
  }

  pause(): void {
    signalProcess(this.child, "SIGSTOP");
  }

  resume(): void {
    signalProcess(this.child, "SIGCONT");
  }

  cancel(): void {
    signalProcess(this.child, "SIGTERM");
  }
}

function signalProcess(child: ChildProcess | undefined, signal: NodeJS.Signals): void {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Agent cancelled");
}

async function delay(milliseconds: number, signal: AbortSignal, pauseGate: PauseGate): Promise<void> {
  await pauseGate.wait(signal);
  await new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      accept();
    }, milliseconds);
    const abort = () => {
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
  await pauseGate.wait(signal);
}

export class DemoAgentProvider extends BaseAgentProvider {
  readonly name = "demo";

  async run(context: AgentContext): Promise<void> {
    requirePermission(context.payload.project, "fileWrite", "The demo agent requires file-write permission.");
    context.status({ phase: "PLANNING", amendable: true, shortStatus: "Planning a deterministic demo change" });
    context.output("AGENT", "Demo provider is planning the requested change.");
    await delay(Number(process.env.RELAYCODE_DEMO_STEP_MS ?? 800), context.signal, context.pauseGate);
    context.status({ phase: "EDITING", amendable: true, shortStatus: "Writing the demo implementation" });
    await delay(Number(process.env.RELAYCODE_DEMO_STEP_MS ?? 800), context.signal, context.pauseGate);

    const path = resolve(context.repositoryPath, "relaycode-demo.md");
    const old = await readFile(path, "utf8").catch(() => "# Relaycode demo changes\n");
    const initialRefinements = context.payload.refinements.map((body) => `  - ${body}`);
    const liveRefinements = this.drainAmendments().map(({ body, authorName }) => `  - ${body} (from ${authorName})`);
    const entry = [
      "",
      `## Request #${context.payload.task.number}`,
      context.payload.request,
      ...(initialRefinements.length || liveRefinements.length ? ["", "Refinements:", ...initialRefinements, ...liveRefinements] : []),
      "",
    ].join("\n");
    await writeFile(path, `${old.trimEnd()}\n${entry}`, "utf8");

    context.status({ phase: "EDITING", amendable: false, shortStatus: "Finalizing the demo implementation" });
    await delay(Number(process.env.RELAYCODE_DEMO_STEP_MS ?? 800), context.signal, context.pauseGate);
    const late = this.drainAmendments();
    if (late.length) {
      // Amendments accepted while amendable are still folded into this one change.
      await writeFile(path, `${await readFile(path, "utf8")}\n${late.map(({ body, authorName }) => `- ${body} (from ${authorName})`).join("\n")}\n`, "utf8");
    }
    context.output("AGENT", "Demo implementation is ready for validation.");
  }
}

export class CommandAgentProvider extends BaseAgentProvider {
  readonly name = "command";

  constructor(private readonly command: string) {
    super();
  }

  override amend(body: string, authorName: string): void {
    super.amend(body, authorName);
    if (this.child?.stdin?.writable) {
      this.child.stdin.write(`${JSON.stringify({ type: "amendment", body, authorName })}\n`);
    }
  }

  async run(context: AgentContext): Promise<void> {
    requirePermission(context.payload.project, "shell", "The command agent requires shell permission.");
    requirePermission(context.payload.project, "fileWrite", "The command agent requires file-write permission.");
    context.status({ phase: "PLANNING", amendable: true, shortStatus: "Starting the configured developer agent" });
    await context.pauseGate.wait(context.signal);
    const child = spawn(this.command, {
      cwd: context.repositoryPath,
      env: {
        ...agentChildEnvironment(),
        RELAYCODE_TASK_ID: context.payload.task.id,
        RELAYCODE_PROJECT_ID: context.payload.project.id,
      },
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdin?.write(`${JSON.stringify({
      type: "task",
      request: context.payload.request,
      refinements: context.payload.refinements,
      project: { id: context.payload.project.id, name: context.payload.project.name, branch: context.payload.project.branch },
    })}\n`);

    const consume = (category: "AGENT" | "SYSTEM") => {
      let pending = "";
      return (chunk: Buffer) => {
        pending += chunk.toString("utf8");
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as Partial<AgentStatus> & { message?: string };
            if ((event.phase === "PLANNING" || event.phase === "EDITING" || event.phase === "VALIDATING") && typeof event.amendable === "boolean" && event.shortStatus) {
              context.status({ phase: event.phase, amendable: event.amendable, shortStatus: String(event.shortStatus).slice(0, 300) });
            } else if (event.message) context.output(category, event.message);
            else context.output(category, line);
          } catch {
            context.output(category, line);
          }
        }
      };
    };
    child.stdout?.on("data", consume("AGENT"));
    child.stderr?.on("data", consume("SYSTEM"));
    const abort = () => this.cancel();
    context.signal.addEventListener("abort", abort, { once: true });
    const code = await new Promise<number | null>((accept, reject) => {
      child.once("error", reject);
      child.once("close", accept);
    }).finally(() => context.signal.removeEventListener("abort", abort));
    this.child = undefined;
    if (context.signal.aborted) throw abortError(context.signal);
    if (code !== 0) throw new Error(`Configured developer agent exited with code ${code}.`);
  }
}

type OpenAIOutput = {
  id: string;
  output?: Array<{ type: string; call_id?: string; name?: string; arguments?: string }>;
  output_text?: string;
  error?: { message?: string };
};

export class OpenAIAgentProvider extends BaseAgentProvider {
  readonly name = "openai";

  constructor(private readonly apiKey: string, private readonly configuredModel?: string) {
    super();
  }

  async run(context: AgentContext): Promise<void> {
    const model = chooseOpenAIModel(context.payload.project, this.configuredModel);
    context.status({ phase: "PLANNING", amendable: true, shortStatus: `Planning with ${model}` });
    let previousResponseId: string | undefined;
    let nextInput: unknown = [
      {
        role: "developer",
        content: "You are the developer agent for a local Git checkout. Implement the request completely. Inspect files before editing, keep changes scoped, use tools for all filesystem/shell actions, and finish only when the implementation is ready to commit. Never access secrets or Git credentials.",
      },
      {
        role: "user",
        content: [context.payload.request, ...context.payload.refinements.map((value) => `Refinement: ${value}`)].join("\n"),
      },
    ];

    for (let turn = 0; turn < 40; turn += 1) {
      await context.pauseGate.wait(context.signal);
      if (context.signal.aborted) throw abortError(context.signal);
      const response = await this.request(model, nextInput, previousResponseId, context.signal);
      previousResponseId = response.id;
      const calls = (response.output ?? []).filter((item) => item.type === "function_call" && item.call_id && item.name);
      if (!calls.length) {
        const amendments = this.drainAmendments();
        if (amendments.length) {
          nextInput = amendments.map(({ body, authorName }) => ({ role: "user", content: `In-flight refinement from ${authorName}: ${body}. Incorporate it into this same implementation without restarting.` }));
          continue;
        }
        if (response.output_text) context.output("AGENT", response.output_text);
        return;
      }

      const toolResults: Array<Record<string, unknown>> = [];
      for (const call of calls) {
        await context.pauseGate.wait(context.signal);
        const args = parseToolArguments(call.arguments);
        const result = await this.executeTool(call.name!, args, context);
        toolResults.push({ type: "function_call_output", call_id: call.call_id!, output: JSON.stringify(result) });
      }
      const amendments = this.drainAmendments();
      nextInput = [
        ...toolResults,
        ...amendments.map(({ body, authorName }) => ({ role: "user", content: `In-flight refinement from ${authorName}: ${body}. Incorporate it into this same implementation without restarting.` })),
      ];
    }
    throw new Error("OpenAI developer agent exceeded the 40-turn tool safety limit.");
  }

  private async request(model: string, input: unknown, previousResponseId: string | undefined, signal: AbortSignal): Promise<OpenAIOutput> {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        input,
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
        tools: OPENAI_TOOLS,
        tool_choice: "auto",
      }),
      signal,
    });
    const raw = await response.text();
    let body: OpenAIOutput;
    try {
      body = JSON.parse(raw) as OpenAIOutput;
    } catch {
      throw new Error(`OpenAI returned an invalid response (${response.status}).`);
    }
    if (!response.ok) throw new Error(`OpenAI developer agent failed (${response.status}): ${sanitizeText(body.error?.message ?? "request failed")}`);
    return body;
  }

  private async executeTool(name: string, args: Record<string, unknown>, context: AgentContext): Promise<unknown> {
    if (name === "list_files") {
      requirePermission(context.payload.project, "fileRead", "Repository file reads are disabled for this project.");
      context.output("AGENT", "Inspecting repository files");
      const tracked = await runGit(["ls-files"], context.repositoryPath, { signal: context.signal });
      return { files: tracked.split("\n").filter(Boolean).slice(0, 5_000) };
    }
    if (name === "read_file") {
      requirePermission(context.payload.project, "fileRead", "Repository file reads are disabled for this project.");
      const path = await safeRepositoryPath(context.repositoryPath, String(args.path ?? ""), false);
      context.output("AGENT", `Reading ${relative(context.repositoryPath, path)}`);
      const content = await readFile(path, "utf8");
      return { content: content.slice(0, 300_000), truncated: content.length > 300_000 };
    }
    if (name === "write_file") {
      requirePermission(context.payload.project, "fileWrite", "Repository file writes are disabled for this project.");
      context.status({ phase: "EDITING", amendable: true, shortStatus: `Editing ${String(args.path ?? "file")}` });
      const content = String(args.content ?? "");
      if (Buffer.byteLength(content) > 1_000_000) throw new Error("write_file content exceeds 1 MB");
      const path = await safeRepositoryPath(context.repositoryPath, String(args.path ?? ""), true);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
      return { ok: true, bytes: Buffer.byteLength(content) };
    }
    throw new Error(`Unsupported agent tool: ${name}`);
  }
}

const OPENAI_TOOLS = [
  {
    type: "function",
    name: "list_files",
    description: "List repository files tracked by Git.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    type: "function",
    name: "read_file",
    description: "Read one UTF-8 file inside the repository.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    strict: true,
  },
  {
    type: "function",
    name: "write_file",
    description: "Create or replace one UTF-8 file inside the repository.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    strict: true,
  },
] as const;

function parseToolArguments(value?: string): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    throw new Error("Developer agent returned malformed tool arguments.");
  }
}

async function safeRepositoryPath(root: string, userPath: string, allowMissing: boolean): Promise<string> {
  if (!userPath || isAbsolute(userPath)) throw new Error("File path must be repository-relative.");
  const canonicalRoot = await realpath(root);
  const candidate = resolve(canonicalRoot, userPath);
  const lexicalRelative = relative(canonicalRoot, candidate);
  if (lexicalRelative.startsWith("..") || lexicalRelative === "") throw new Error("File path escapes the repository.");
  if (!allowMissing) {
    const canonical = await realpath(candidate);
    if (!canonical.startsWith(`${canonicalRoot}${sep}`)) throw new Error("File path resolves outside the repository.");
    return canonical;
  }
  let existingParent = dirname(candidate);
  while (existingParent !== canonicalRoot) {
    try {
      const canonicalParent = await realpath(existingParent);
      if (canonicalParent !== canonicalRoot && !canonicalParent.startsWith(`${canonicalRoot}${sep}`)) throw new Error("File path resolves outside the repository.");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      existingParent = dirname(existingParent);
    }
  }
  return candidate;
}

function chooseOpenAIModel(project: Project, configuredModel?: string): string {
  if (project.developerModel && !["local-agent", "openai", "demo", "command"].includes(project.developerModel)) return project.developerModel;
  if (configuredModel) return configuredModel;
  return process.env.OPENAI_MODEL ?? "gpt-5.6-sol";
}

function requirePermission(project: Project, permission: "fileRead" | "fileWrite" | "shell" | "git" | "tests" | "network", message: string): void {
  if (project.toolPermissions?.[permission] === false) throw new Error(message);
}

export function createAgentProvider(config: DaemonConfig, projectCredential?: string, projectModel?: string): AgentProvider {
  const key = projectCredential ?? process.env.OPENAI_API_KEY ?? config.agent.openaiApiKey;
  const selected = config.agent.provider;
  if (projectCredential) {
    const model = projectModel && !["local-agent", "openai", "demo", "command"].includes(projectModel) ? projectModel : config.agent.openaiModel;
    return new OpenAIAgentProvider(projectCredential, model);
  }
  if (selected === "openai" || (selected === "auto" && key)) {
    if (!key) throw new Error("OpenAI provider selected but OPENAI_API_KEY is not configured locally.");
    return new OpenAIAgentProvider(key, config.agent.openaiModel);
  }
  if (selected === "command" || (selected === "auto" && config.agent.command)) {
    if (!config.agent.command) throw new Error("Command provider selected but no agent command is configured.");
    return new CommandAgentProvider(config.agent.command);
  }
  return new DemoAgentProvider();
}
