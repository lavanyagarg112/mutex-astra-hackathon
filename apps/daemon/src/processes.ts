import { spawn, type ChildProcess } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@relaycode/shared";
import type { DaemonConfig } from "./config.js";
import { sanitizeText } from "./sanitize.js";

type RelaySocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type ProcessStatus = "starting" | "running" | "stopped" | "failed";

/** Extract a browser-reachable loopback URL from common dev-server output. */
export function localPreviewUrl(output: string): string | undefined {
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "");
  const match = plain.match(/https?:\/\/(?:localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[::1?\]):\d+(?:\/[^\s]*)?/i)?.[0];
  if (!match) return undefined;
  try {
    const url = new URL(match.replace(/[),.;]+$/, ""));
    if (url.hostname === "0.0.0.0" || url.hostname === "[::]" || url.hostname === "[::1]") url.hostname = "localhost";
    return url.toString();
  } catch {
    return undefined;
  }
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
    if (commands.backendCommand) await this.start(projectId, "backend", commands.backendCommand);
    if (commands.frontendCommand) await this.start(projectId, "frontend", commands.frontendCommand);
  }

  async stopPreview(projectId: string): Promise<void> {
    await Promise.all(["install", "frontend", "backend"].map((name) => this.stop(projectId, name)));
  }

  async start(projectId: string, name: string, command: string, cwd?: string): Promise<void> {
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

    const child = spawn(command, {
      cwd: actualWorkingDirectory,
      env: process.env,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const key = this.key(projectId, name);
    this.processes.set(key, child);
    this.emit(projectId, name, "starting");
    let discoveredUrl: string | undefined;
    let urlScanTail = "";
    const consume = (chunk: Buffer) => {
      const output = sanitizeText(chunk.toString("utf8"));
      const scanned = `${urlScanTail}${output}`;
      urlScanTail = scanned.slice(-500);
      const url = localPreviewUrl(scanned);
      if (url && url !== discoveredUrl) {
        discoveredUrl = url;
        this.emit(projectId, name, "running", url);
      }
      this.socket.emit("ACTIVITY_EVENT", {
        projectId,
        category: "PROCESS",
        message: `${name}: ${output.slice(0, 1_800).trim()}`,
      });
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    child.once("spawn", () => this.emit(projectId, name, "running", discoveredUrl));
    child.once("error", (error) => {
      this.socket.emit("ACTIVITY_EVENT", { projectId, category: "PROCESS", message: `${name} failed: ${sanitizeText(error.message)}` });
      this.emit(projectId, name, "failed");
    });
    child.once("close", (code) => {
      if (this.processes.get(key) === child) this.processes.delete(key);
      this.emit(projectId, name, code === 0 ? "stopped" : "failed", discoveredUrl);
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

  private emit(projectId: string, name: string, status: ProcessStatus, url?: string): void {
    let port: number | undefined;
    if (url) {
      try { port = Number(new URL(url).port); } catch { /* malformed process output is ignored */ }
    }
    this.socket.emit("PROCESS_STATUS", { projectId, name, status, ...(port ? { port } : {}), ...(url ? { url } : {}) });
  }

  private key(projectId: string, name: string): string {
    return `${projectId}:${name}`;
  }
}
