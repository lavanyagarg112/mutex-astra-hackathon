import { chmod, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { getRemoteUrl, validateRepository } from "./git.js";

export const ProjectBindingSchema = z.object({
  path: z.string().min(1),
  remoteUrl: z.string().min(1),
  branch: z.string().min(1).optional(),
  gitAuthorName: z.string().min(1).optional(),
  gitAuthorEmail: z.string().email().optional(),
});
export type ProjectBinding = z.infer<typeof ProjectBindingSchema>;

export const DaemonConfigSchema = z.object({
  version: z.literal(1).default(1),
  serverUrl: z.string().url(),
  userId: z.string().min(1),
  token: z.string().min(1),
  agent: z.object({
    provider: z.enum(["auto", "openai", "command", "demo"]).default("auto"),
    command: z.string().min(1).optional(),
    openaiApiKey: z.string().min(1).optional(),
    openaiModel: z.string().min(1).optional(),
  }).default({ provider: "auto" }),
  projects: z.record(ProjectBindingSchema).default({}),
});
export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;

export function configPath(): string {
  return process.env.RELAYCODE_CONFIG_PATH ?? resolve(homedir(), ".relaycode", "config.json");
}

export async function loadConfig(path = configPath()): Promise<DaemonConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Daemon is not configured. Run \"relaycode-daemon configure\" first (${path}).`);
    }
    throw error;
  }
  return DaemonConfigSchema.parse(JSON.parse(raw));
}

export async function saveConfig(config: DaemonConfig, path = configPath()): Promise<void> {
  const valid = DaemonConfigSchema.parse(config);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(valid, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

export async function addProjectBinding(
  config: DaemonConfig,
  projectId: string,
  repositoryPath: string,
  expectedRemoteUrl?: string,
  branch?: string,
): Promise<ProjectBinding> {
  const canonicalPath = await realpath(resolve(repositoryPath));
  const actualRemoteUrl = await getRemoteUrl(canonicalPath);
  await validateRepository(canonicalPath, expectedRemoteUrl ?? actualRemoteUrl);
  const binding = ProjectBindingSchema.parse({
    path: canonicalPath,
    remoteUrl: expectedRemoteUrl ?? actualRemoteUrl,
    ...(branch ? { branch } : {}),
  });
  config.projects[projectId] = binding;
  return binding;
}
