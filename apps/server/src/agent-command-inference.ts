import { InferredCommandsSchema, type InferredCommands } from "@relaycode/shared";
import type { RepositoryFile } from "./command-inference.js";

type ResponsesBody = {
  output_text?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  error?: { message?: string };
};

const commandKeys = ["installCommand", "frontendCommand", "backendCommand", "testCommand"] as const;

/** Ask the configured project agent to interpret repository documentation and manifests.
 * Unsafe or ungrounded output is discarded and replaced by deterministic inference.
 */
export async function inferCommandsWithAgent(
  files: readonly RepositoryFile[],
  fallback: InferredCommands,
  apiKey: string,
  configuredModel?: string,
): Promise<InferredCommands> {
  const readableFiles = files.filter((file) => file.content).slice(0, 50);
  if (!readableFiles.length) return fallback;
  const repositoryPaths = new Set(files.map((file) => file.path));
  const candidates = groundedCandidates(files, fallback);
  const context = `${readableFiles.map((file) => `\n--- ${file.path} ---\n${file.content!.slice(0, 16_000)}`).join("").slice(0, 160_000)}\n\n--- ALLOWED COMMANDS ---\n${[...candidates].join("\n")}`;
  const model = configuredModel?.startsWith("gpt-") ? configuredModel : process.env.OPENAI_MODEL ?? "gpt-5-mini";
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        input: [{ role: "system", content: commandInferenceInstructions }, { role: "user", content: context }],
        text: { format: { type: "json_schema", name: "repository_commands", strict: true, schema: commandSchema } },
      }),
    });
    const body = await response.json() as ResponsesBody;
    if (!response.ok) throw new Error(body.error?.message || `OpenAI request failed (${response.status})`);
    const rawText = body.output_text ?? body.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "output_text")?.text;
    if (!rawText) throw new Error("OpenAI returned no structured command result");
    const raw = JSON.parse(rawText) as Record<string, unknown>;
    const merged: Record<string, string | null> = {};
    const rejected: string[] = [];
    for (const key of commandKeys) {
      const candidate = typeof raw[key] === "string" ? raw[key].trim() : null;
      if (candidate && isSafeCommand(candidate) && candidates.has(candidate)) merged[key] = candidate;
      else {
        merged[key] = fallback[key];
        if (candidate) rejected.push(key.replace("Command", ""));
      }
    }
    const cited = Array.isArray(raw.detectedFrom)
      ? raw.detectedFrom.filter((path): path is string => typeof path === "string" && repositoryPaths.has(path)).slice(0, 20)
      : [];
    return InferredCommandsSchema.parse({
      ...merged,
      detectedFrom: [...new Set([...cited, ...fallback.detectedFrom])].slice(0, 30),
      inferenceMethod: "agent",
      diagnostics: [
        "Repository manifests and documentation were interpreted by the configured project agent.",
        ...(rejected.length ? [`Ignored unsafe ${rejected.join(", ")} suggestion(s); conventional detection was used instead.`] : []),
      ],
    });
  } catch {
    return {
      ...fallback,
      diagnostics: [...fallback.diagnostics, "Agent interpretation was unavailable; conventional repository detection was used."],
    };
  }
}

const commandInferenceInstructions = `Infer commands that a developer should run locally from the supplied repository files.
Return exactly one install, frontend dev server, backend dev server, and validation/test command when evidenced; otherwise null.
Read README setup instructions, package scripts, lockfiles, workspace configuration, Makefiles, Docker Compose, Python metadata, env examples, and CI workflows together.
Commands run from the repository root. Include a safe cd into a subdirectory when needed. Prefer the repository's package manager and documented scripts.
The test command must set any clearly documented test-only environment variables when required. Never invent credentials, database URLs, ports, or missing services.
Every non-null command MUST be copied exactly from ALLOWED COMMANDS. Never compose or alter a command.
Never emit destructive Git/filesystem commands, sudo, global installs, downloads piped to a shell, secret values, interactive commands, or multiple alternative commands.
detectedFrom must cite only supplied file paths. summary must be a short explanation without file contents or secrets.`;

const commandSchema = {
  type: "object",
  additionalProperties: false,
  required: [...commandKeys, "detectedFrom", "summary"],
  properties: {
    installCommand: { type: ["string", "null"] },
    frontendCommand: { type: ["string", "null"] },
    backendCommand: { type: ["string", "null"] },
    testCommand: { type: ["string", "null"] },
    detectedFrom: { type: "array", items: { type: "string" }, maxItems: 20 },
    summary: { type: "string", maxLength: 300 },
  },
};

export function isSafeCommand(command: string) {
  if (!command || command.length > 1_000 || /[\r\n;`|<>]|\$\(|\$\{|\x00/.test(command)) return false;
  if (/(^|\s)(?:sudo|rm|git\s+(?:clean|reset|push)|curl|wget|chmod|chown|ssh)(?:\s|$)/i.test(command)) return false;
  if (/(?:token|secret|api[_-]?key|password)\s*=/i.test(command)) return false;
  return true;
}

function groundedCandidates(files: readonly RepositoryFile[], fallback: InferredCommands) {
  const candidates = new Set(commandKeys.map((key) => fallback[key]).filter((value): value is string => Boolean(value)));
  const paths = new Set(files.map((file) => file.path));
  const packageScripts = new Set<string>();
  for (const file of files) {
    if (!file.path.endsWith("package.json") || !file.content) continue;
    try {
      const parsed = JSON.parse(file.content) as { scripts?: Record<string, unknown> };
      const directory = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
      const manager = paths.has(`${directory ? `${directory}/` : ""}pnpm-lock.yaml`) || paths.has("pnpm-lock.yaml") ? "pnpm"
        : paths.has(`${directory ? `${directory}/` : ""}yarn.lock`) || paths.has("yarn.lock") ? "yarn"
          : paths.has(`${directory ? `${directory}/` : ""}bun.lockb`) || paths.has("bun.lockb") ? "bun" : "npm";
      for (const name of Object.keys(parsed.scripts ?? {})) {
        if (!/^[a-zA-Z0-9:_-]+$/.test(name)) continue;
        const invocation = manager === "yarn" ? `yarn ${name}` : `${manager} run ${name}`;
        packageScripts.add(invocation);
        candidates.add(directory ? `(cd '${directory.replaceAll("'", `'\"'\"'`)}' && ${invocation})` : invocation);
      }
    } catch { /* malformed manifests are ignored */ }
  }
  for (const file of files) {
    if (!file.content) continue;
    const makeTargets = file.path.endsWith("Makefile")
      ? new Set([...file.content.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?![=])/gm)].map((match) => match[1]).filter((target): target is string => Boolean(target)))
      : new Set<string>();
    for (const sourceLine of file.content.split(/\r?\n/)) {
      const line = sourceLine.trim().replace(/^\$\s+/, "").replace(/^[-*]\s+/, "").replace(/^run:\s*/, "").replace(/^`+|`+$/g, "").trim();
      if (!line || !isSafeCommand(line) || line.length > 500) continue;
      if (isConventionalDocumentedCommand(line, paths, packageScripts, makeTargets)) candidates.add(line);
    }
  }
  return candidates;
}

function isConventionalDocumentedCommand(command: string, paths: Set<string>, packageScripts: Set<string>, makeTargets: Set<string>) {
  const withoutTestEnv = command.replace(/^(?:(?:TEST_[A-Z0-9_]*|NODE_ENV|CI)=[^\s]+\s+)+/, "");
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:install|ci)$/.test(withoutTestEnv)) return true;
  if (packageScripts.has(withoutTestEnv)) return true;
  const make = /^make\s+([A-Za-z0-9_.-]+)$/.exec(withoutTestEnv);
  if (make?.[1] && makeTargets.has(make[1])) return true;
  if (/^docker compose (?:up(?:\s+(?:--build|-d|[A-Za-z0-9_.-]+))*|build)$/.test(withoutTestEnv)) return true;
  if (/^(?:python3?|uv run python)\s+-m\s+(?:pytest|uvicorn)(?:\s+[A-Za-z0-9_./:= -]+)?$/.test(withoutTestEnv)) return true;
  if (/^(?:python3?\s+manage\.py\s+runserver|pytest(?:\s+[A-Za-z0-9_./:= -]+)?)$/.test(withoutTestEnv)) return paths.has("manage.py") || /pytest/.test(withoutTestEnv);
  return /^(?:uv sync|poetry install|cargo (?:run|test|build|fetch)|go (?:run \.$|test \.\/\.\.\.$|mod download))$/.test(withoutTestEnv);
}
