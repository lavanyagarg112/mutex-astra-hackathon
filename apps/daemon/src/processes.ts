import { spawn, type ChildProcess } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@relaycode/shared";
import type { DaemonConfig } from "./config.js";
import { sanitizeText } from "./sanitize.js";

type RelaySocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export class LocalProcessManager {
  private readonly processes = new Map<string, ChildProcess>();

  constructor(private readonly config: DaemonConfig, private readonly socket: RelaySocket) {}

  async start(projectId: string, name: string, command: string, cwd?: string): Promise<void> {
    const binding = this.config.projects[projectId];
    if (!binding) {
      this.emit(projectId, name, "FAILED");
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
    this.emit(projectId, name, "STARTING");
    let discoveredUrl: string | undefined;
    const consume = (chunk: Buffer) => {
      const output = sanitizeText(chunk.toString("utf8"));
      const url = output.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+/i)?.[0];
      if (url && url !== discoveredUrl) {
        discoveredUrl = url;
        this.emit(projectId, name, "RUNNING", url);
      }
      this.socket.emit("ACTIVITY_EVENT", {
        projectId,
        category: "PROCESS",
        message: `${name}: ${output.slice(0, 1_800).trim()}`,
      });
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    child.once("spawn", () => this.emit(projectId, name, "RUNNING", discoveredUrl));
    child.once("error", (error) => {
      this.socket.emit("ACTIVITY_EVENT", { projectId, category: "PROCESS", message: `${name} failed: ${sanitizeText(error.message)}` });
      this.emit(projectId, name, "FAILED");
    });
    child.once("close", (code) => {
      if (this.processes.get(key) === child) this.processes.delete(key);
      this.emit(projectId, name, code === 0 ? "STOPPED" : "FAILED", discoveredUrl);
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
    this.emit(projectId, name, "STOPPED");
  }

  async stopAll(): Promise<void> {
    const keys = [...this.processes.keys()];
    await Promise.all(keys.map((key) => {
      const delimiter = key.indexOf(":");
      return this.stop(key.slice(0, delimiter), key.slice(delimiter + 1));
    }));
  }

  private emit(projectId: string, name: string, status: string, url?: string): void {
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
