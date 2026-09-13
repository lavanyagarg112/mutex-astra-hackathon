import { spawn, type ChildProcess } from "node:child_process";
import { realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { relative, resolve, sep } from "node:path";
import type { Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@relaycode/shared";
import type { DaemonConfig } from "./config.js";
import { sanitizeText } from "./sanitize.js";

type RelaySocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type ProcessStatus = "starting" | "running" | "stopped" | "failed";

/** Extract a browser-reachable loopback URL from common dev-server output. */
export function localPreviewUrl(output: string, fallbackPort?: number): string | undefined {
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "");
  const match = plain.match(/https?:\/\/(?:localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[::1?\]):\d+(?:\/[^\s]*)?/i)?.[0];
  if (!match) {
    const reportedPort = plain.match(/\b(?:listening|running|started|ready)\b[^\n]{0,80}?\b(?:port\s+|localhost:|127\.0\.0\.1:)(\d{2,5})\b/i)?.[1];
    const port = reportedPort ? Number(reportedPort) : fallbackPort && /\b(?:listening|running|started|ready)\b/i.test(plain) ? fallbackPort : undefined;
    return port && port <= 65_535 ? `http://localhost:${port}/` : undefined;
  }
  try {
    const url = new URL(match.replace(/[),.;]+$/, ""));
    if (url.hostname === "0.0.0.0" || url.hostname === "[::]" || url.hostname === "[::1]") url.hostname = "localhost";
    return url.toString();
  } catch {
    return undefined;
  }
}

function appendArgument(command: string, argument: string): string {
  return /\)\s*$/.test(command) ? command.replace(/\)\s*$/, ` ${argument})`) : `${command} ${argument}`;
}

/** Override explicit framework ports and add a port flag where it is supported. */
export function commandWithPreviewPort(command: string, port: number): string {
  let result = command
    .replace(/(\bPORT\s*=\s*)\d+/gi, `$1${port}`)
    .replace(/(--port(?:=|\s+))\d+/gi, `$1${port}`)
    .replace(/(\s-p\s+)\d+/g, `$1${port}`)
    .replace(/(runserver\s+)(?:[\w.-]+:)?\d+/gi, `$1127.0.0.1:${port}`)
    .replace(/(--bind\s+)(?:[\w.-]+:)?\d+/gi, `$1127.0.0.1:${port}`);
  if (result !== command) return result;
  if (/\b(?:uvicorn|flask\s+run)\b/i.test(result)) return appendArgument(result, `--port ${port}`);
  if (/\b(?:vite|next\s+(?:dev|start))\b/i.test(result)) return appendArgument(result, `--port ${port}`);
  if (/\bmanage\.py\s+runserver\b/i.test(result)) return appendArgument(result, `127.0.0.1:${port}`);
  if (/\b(?:gunicorn|hypercorn)\b/i.test(result)) return appendArgument(result, `--bind 127.0.0.1:${port}`);
  return result;
}

async function portIsAvailable(port: number): Promise<boolean> {
  return new Promise((accept) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", () => accept(false));
    probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => probe.close(() => accept(true)));
  });
}

export async function availablePreviewPort(preferred: number, excluded: ReadonlySet<number> = new Set()): Promise<number> {
  for (let offset = 0; offset < 2_000; offset += 1) {
    const candidate = preferred + offset;
    if (candidate > 65_535) break;
    if (!excluded.has(candidate) && await portIsAvailable(candidate)) return candidate;
  }
  throw new Error("No free local port is available for this preview.");
}

function projectPort(projectId: string, base: number): number {
  let hash = 0;
  for (const character of projectId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return base + (hash % 1_000);
}

export class LocalProcessManager {
  private readonly processes = new Map<string, ChildProcess>();

  constructor(private readonly config: DaemonConfig, private readonly socket: RelaySocket) {}

  async startPreview(projectId: string, commands: { installCommand?: string; frontendCommand?: string; backendCommand?: string }): Promise<void> {
    await this.stopPreview(projectId);
    if (commands.installCommand) {
      let result = await this.runToCompletion(projectId, "install", commands.installCommand);
      if (result === "failed") {
        this.activity(projectId, "install failed; retrying once before starting the preview");
        result = await this.runToCompletion(projectId, "install", commands.installCommand);
      }
      if (result !== "succeeded") {
        if (result === "failed") this.activity(projectId, "install failed again; frontend and backend were not started");
        return;
      }
    }
    const allocated = new Set<number>();
    if (commands.backendCommand) {
      const port = await availablePreviewPort(projectPort(projectId, 8_000), allocated);
      allocated.add(port);
      this.activity(projectId, `backend preview allocated localhost:${port}`);
      await this.start(projectId, "backend", commands.backendCommand, undefined, port);
    }
    if (commands.frontendCommand) {
      const port = await availablePreviewPort(projectPort(projectId, 3_000), allocated);
      allocated.add(port);
      this.activity(projectId, `frontend preview allocated localhost:${port}`);
      await this.start(projectId, "frontend", commands.frontendCommand, undefined, port);
    }
  }

  async stopPreview(projectId: string): Promise<void> {
    await Promise.all(["install", "frontend", "backend"].map((name) => this.stop(projectId, name)));
  }

  async start(projectId: string, name: string, command: string, cwd?: string, previewPort?: number): Promise<void> {
    const binding = this.config.projects[projectId];
    if (!binding) {
      this.emit(projectId, name, "failed");
      return;
    }
    await this.stop(projectId, name);
    const root = await realpath(binding.path);
    const workingDirectory = cwd ? resolve(root, cwd) : root;
    const actualWorkingDirectory = await realpath(workingDirectory);
    const rel = relative(root, actualWorkingDirectory);
    if (rel.startsWith("..") || (actualWorkingDirectory !== root && !actualWorkingDirectory.startsWith(`${root}${sep}`))) {
      throw new Error("Local process working directory escapes the configured repository.");
    }

    const runtimeCommand = previewPort ? commandWithPreviewPort(command, previewPort) : command;
    const child = spawn(runtimeCommand, {
      cwd: actualWorkingDirectory,
      env: previewPort ? { ...process.env, PORT: String(previewPort), VITE_PORT: String(previewPort), NEXT_PORT: String(previewPort), FLASK_RUN_PORT: String(previewPort), RELAYCODE_PREVIEW_PORT: String(previewPort) } : process.env,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const key = this.key(projectId, name);
    this.processes.set(key, child);
    this.emit(projectId, name, "starting", undefined, previewPort);
    let discoveredUrl: string | undefined;
    let urlScanTail = "";
    const consume = (chunk: Buffer) => {
      const output = sanitizeText(chunk.toString("utf8"));
      const scanned = `${urlScanTail}${output}`;
      urlScanTail = scanned.slice(-500);
      const url = localPreviewUrl(scanned, previewPort);
      if (url && url !== discoveredUrl) {
        discoveredUrl = url;
        this.emit(projectId, name, "running", url, previewPort);
      }
      this.socket.emit("ACTIVITY_EVENT", {
        projectId,
        category: "PROCESS",
        message: `${name}: ${output.slice(0, 1_800).trim()}`,
      });
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    child.once("spawn", () => this.emit(projectId, name, "running", discoveredUrl, previewPort));
    child.once("error", (error) => {
      this.socket.emit("ACTIVITY_EVENT", { projectId, category: "PROCESS", message: `${name} failed: ${sanitizeText(error.message)}` });
      this.emit(projectId, name, "failed", undefined, previewPort);
    });
    child.once("close", (code) => {
      if (this.processes.get(key) === child) this.processes.delete(key);
      this.emit(projectId, name, code === 0 ? "stopped" : "failed", discoveredUrl, previewPort);
    });
  }

  async stop(projectId: string, name: string): Promise<void> {
    const key = this.key(projectId, name);
    const child = this.processes.get(key);
    if (!child) return;
    this.processes.delete(key);
    if (child.pid && child.exitCode === null) {
      try {
        if (process.platform === "win32") child.kill("SIGTERM");
        else process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      const timer = setTimeout(() => {
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, 5_000);
      timer.unref();
      await new Promise<void>((accept) => child.once("close", () => accept()));
      clearTimeout(timer);
    }
    this.emit(projectId, name, "stopped");
  }

  async stopAll(): Promise<void> {
    const keys = [...this.processes.keys()];
    await Promise.all(keys.map((key) => {
      const delimiter = key.indexOf(":");
      return this.stop(key.slice(0, delimiter), key.slice(delimiter + 1));
    }));
  }

  reportFailure(projectId: string, name: string): void {
    this.emit(projectId, name, "failed");
  }

  private async runToCompletion(projectId: string, name: string, command: string): Promise<"succeeded" | "failed" | "cancelled"> {
    const binding = this.config.projects[projectId];
    if (!binding) {
      this.emit(projectId, name, "failed");
      return "failed";
    }
    const root = await realpath(binding.path);
    const child = spawn(command, {
      cwd: root,
      env: process.env,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const key = this.key(projectId, name);
    this.processes.set(key, child);
    this.emit(projectId, name, "starting");
    const consume = (chunk: Buffer) => {
      const output = sanitizeText(chunk.toString("utf8")).slice(0, 1_800).trim();
      if (output) this.activity(projectId, `${name}: ${output}`);
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    child.once("spawn", () => this.emit(projectId, name, "running"));
    const result = await new Promise<"succeeded" | "failed" | "cancelled">((accept) => {
      let settled = false;
      const settle = (value: "succeeded" | "failed" | "cancelled") => {
        if (!settled) { settled = true; accept(value); }
      };
      child.once("error", (error) => {
        this.activity(projectId, `${name} failed: ${sanitizeText(error.message)}`);
        settle("failed");
      });
      child.once("close", (code) => {
        const stillCurrent = this.processes.get(key) === child;
        if (stillCurrent) this.processes.delete(key);
        settle(!stillCurrent ? "cancelled" : code === 0 ? "succeeded" : "failed");
      });
    });
    this.emit(projectId, name, result === "succeeded" || result === "cancelled" ? "stopped" : "failed");
    return result;
  }

  private activity(projectId: string, message: string): void {
    this.socket.emit("ACTIVITY_EVENT", { projectId, category: "PROCESS", message });
  }

  private emit(projectId: string, name: string, status: ProcessStatus, url?: string, assignedPort?: number): void {
    let port = assignedPort;
    if (url) {
      try { port = Number(new URL(url).port); } catch { /* malformed process output is ignored */ }
    }
    this.socket.emit("PROCESS_STATUS", { projectId, name, status, ...(port ? { port } : {}), ...(url ? { url } : {}) });
  }

  private key(projectId: string, name: string): string {
    return `${projectId}:${name}`;
  }
}
