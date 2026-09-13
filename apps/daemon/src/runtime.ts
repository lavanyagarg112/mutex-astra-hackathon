import { spawn, type ChildProcess } from "node:child_process";
import type { Socket } from "socket.io-client";
import type {
  AmendTaskPayload,
  ClientToServerEvents,
  ServerToClientEvents,
  StartRollbackPayload,
  StartTaskPayload,
  SyncProjectPayload,
} from "@relaycode/shared";
import { createAgentProvider, PauseGate, type AgentPhase, type AgentProvider } from "./agent.js";
import type { DaemonConfig, ProjectBinding } from "./config.js";
import { commitAndPush, discardTaskChanges, rollbackRemote, runGit, syncToRemote } from "./git.js";
import { LocalProcessManager } from "./processes.js";
import { agentChildEnvironment, sanitizeText } from "./sanitize.js";

type RelaySocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface ActiveExecution {
  payload: StartTaskPayload;
  binding: ProjectBinding;
  provider: AgentProvider;
  controller: AbortController;
  pauseGate: PauseGate;
  baselineUntracked: Set<string>;
  phase: AgentPhase | "SYNCING" | "PUSHING";
  amendable: boolean;
  child?: ChildProcess;
  promise: Promise<void>;
}

class ValidationCommandError extends Error {
  constructor(readonly exitCode: number | null, readonly output: string) {
    super(`Validation command failed with exit code ${exitCode ?? "unknown"}.`);
    this.name = "ValidationCommandError";
  }
}

export class DaemonRuntime {
  private readonly active = new Map<string, ActiveExecution>();
  private readonly rollbackProjects = new Set<string>();
  private readonly deferredSyncs = new Map<string, SyncProjectPayload>();
  private readonly processes: LocalProcessManager;
  private heartbeat?: NodeJS.Timeout;

  constructor(private readonly config: DaemonConfig, private readonly socket: RelaySocket) {
    this.processes = new LocalProcessManager(config, socket);
  }

  install(): void {
    this.socket.on("connect", () => {
      this.socket.emit("DAEMON_CONNECTED", {
        userId: this.config.userId,
        token: this.config.token,
        version: "0.1.0",
        mappings: Object.entries(this.config.projects).map(([projectId, binding]) => ({
          projectId,
          path: binding.path,
          remoteUrl: binding.remoteUrl,
        })),
      });
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.socket.emit("DAEMON_HEARTBEAT", { userId: this.config.userId }), 10_000);
      this.heartbeat.unref();
      console.log(`Connected to ${this.config.serverUrl} as ${this.config.userId}.`);
    });
    this.socket.on("disconnect", (reason) => console.log(`Disconnected from Relaycode (${sanitizeText(reason)}); reconnecting…`));
    this.socket.on("ERROR", ({ message }) => console.error(`Server: ${sanitizeText(message)}`));
    this.socket.on("START_TASK", (payload) => void this.startTask(payload));
    this.socket.on("AMEND_TASK", (payload) => this.amendTask(payload));
    this.socket.on("PAUSE_TASK", ({ projectId, taskId }) => this.pauseTask(projectId, taskId));
    this.socket.on("RESUME_TASK", ({ projectId, taskId }) => this.resumeTask(projectId, taskId));
    this.socket.on("CANCEL_TASK", ({ projectId, taskId }) => void this.cancelTask(projectId, taskId));
    this.socket.on("SYNC_PROJECT", (payload) => void this.syncProject(payload));
    this.socket.on("START_ROLLBACK", (payload) => void this.startRollback(payload));
    this.socket.on("START_LOCAL_PROCESS", (payload) => void this.processes.start(payload.projectId, payload.name, payload.command, payload.cwd).catch((error) => {
      this.processes.reportFailure(payload.projectId, payload.name);
      this.activity(payload.projectId, undefined, "PROCESS", `Could not start ${payload.name}: ${this.errorMessage(error)}`);
    }));
    this.socket.on("STOP_LOCAL_PROCESS", ({ projectId, name }) => void this.processes.stop(projectId, name));
    this.socket.on("START_LOCAL_PREVIEW", (payload) => void this.processes.startPreview(payload.projectId, payload).catch((error) => {
      this.processes.reportFailure(payload.projectId, "preview");
      this.activity(payload.projectId, undefined, "PROCESS", `Could not start preview: ${this.errorMessage(error)}`);
    }));
    this.socket.on("STOP_LOCAL_PREVIEW", ({ projectId }) => void this.processes.stopPreview(projectId));
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const execution of this.active.values()) {
      execution.controller.abort(new Error("Daemon shutting down"));
      execution.provider.cancel();
    }
    await Promise.allSettled([...this.active.values()].map((execution) => execution.promise));
    await this.processes.stopAll();
    this.socket.close();
  }

  private async startTask(payload: StartTaskPayload): Promise<void> {
    const { project, task } = payload;
    if (this.rollbackProjects.has(project.id)) {
      this.failTask(payload, "Project rollback is in progress.");
      return;
    }
    if (this.active.has(project.id)) {
      this.failTask(payload, "This daemon already has an active task for the project.");
      return;
    }
    const binding = this.config.projects[project.id];
    if (!binding) {
      this.failTask(payload, `No local mapping for ${project.name}. Run: relaycode-daemon configure project ${project.id}`);
      return;
    }
    const controller = new AbortController();
    let provider: AgentProvider;
    try {
      provider = createAgentProvider(this.config, payload.agentCredential, payload.project.developerModel);
    } catch (error) {
      this.failTask(payload, this.errorMessage(error));
      return;
    }
    const execution: ActiveExecution = {
      payload,
      binding,
      provider,
      controller,
      pauseGate: new PauseGate(),
      baselineUntracked: new Set(),
      phase: "SYNCING",
      amendable: false,
      promise: Promise.resolve(),
    };
    this.active.set(project.id, execution);
    execution.promise = this.executeTask(execution).finally(async () => {
      if (this.active.get(project.id) === execution) this.active.delete(project.id);
      const deferred = this.deferredSyncs.get(project.id);
      if (deferred && !this.rollbackProjects.has(project.id)) {
        this.deferredSyncs.delete(project.id);
        await this.syncProject(deferred);
      }
    });
    await execution.promise;
  }

  private async executeTask(execution: ActiveExecution): Promise<void> {
    const { payload, binding, controller } = execution;
    const { project, task } = payload;
    const isInitialization = task.executionMode === "INITIALIZATION";
    let synced = false;
    try {
      if (project.toolPermissions?.git === false) throw new Error("Git operations are disabled for this project.");
      this.taskStatus(execution, "SYNCING", false, `Synchronizing origin/${project.branch}`);
      this.activity(project.id, task.id, "GIT", `syncing origin/${project.branch}`);
      const sync = await syncToRemote(binding, project.branch, project.repositoryUrl, controller.signal);
      synced = true;
      execution.baselineUntracked = sync.baselineUntracked;
      this.socket.emit("GIT_SYNC_RESULT", { projectId: project.id, taskId: task.id, commitSha: sync.commitSha, ok: true });
      this.socket.emit("TASK_STATUS", {
        projectId: project.id,
        taskId: task.id,
        phase: "SYNCING",
        amendable: false,
        shortStatus: `Synchronized to ${sync.commitSha.slice(0, 7)}`,
        baseCommitSha: sync.commitSha,
      });

      if (isInitialization) {
        this.activity(project.id, task.id, "SETUP", "initialization task does not require an existing validation command");
      } else {
        if (project.toolPermissions?.tests === false) throw new Error("Validation is required before push, but test execution is disabled for this project.");
        if (!project.testCommand) throw new Error("Validation is required before push. Configure a test command in Project settings → Commands.");

        // A clean remote checkout must pass before the agent is allowed to edit.
        // Otherwise an environment or pre-existing repository problem could be
        // misdiagnosed as a regression caused by the task.
        this.activity(project.id, task.id, "TEST", "checking clean remote baseline");
        try {
          await this.runConfiguredCommand(execution, project.testCommand, "TEST");
        } catch (error) {
          if (error instanceof ValidationCommandError) {
            throw new Error(`Clean remote baseline validation failed before the agent ran. Fix the project test environment or the configured validation command, then retry. ${this.validationExcerpt(error)}`);
          }
          throw error;
        }
      }

      await execution.provider.run({
        payload,
        repositoryPath: binding.path,
        signal: controller.signal,
        pauseGate: execution.pauseGate,
        status: ({ phase, amendable, shortStatus }) => this.taskStatus(execution, phase, amendable, shortStatus),
        output: (category, message) => this.output(project.id, task.id, category, message),
      });
      if (controller.signal.aborted) throw controller.signal.reason;

      if (isInitialization) {
        this.output(project.id, task.id, "SYSTEM", "Repository initialization finished. Existing validation was intentionally skipped; infer and review the new commands after this commit.");
      } else {
        const validationCommand = project.testCommand;
        if (!validationCommand) throw new Error("Validation is required before push. Configure a test command in Project settings → Commands.");
        const configuredAttempts = Number(process.env.RELAYCODE_VALIDATION_REPAIR_ATTEMPTS ?? 2);
        const repairAttempts = Number.isFinite(configuredAttempts) ? Math.max(0, Math.min(3, Math.floor(configuredAttempts))) : 2;
        for (let attempt = 0; ; attempt += 1) {
          this.taskStatus(execution, "VALIDATING", false, attempt === 0 ? "Running required project validation" : `Re-running validation after repair ${attempt}`);
          try {
            await this.runConfiguredCommand(execution, validationCommand, "TEST");
            break;
          } catch (error) {
            if (!(error instanceof ValidationCommandError) || attempt >= repairAttempts) {
              if (error instanceof ValidationCommandError) throw new Error(`Validation still fails after ${attempt} repair attempt${attempt === 1 ? "" : "s"}. ${this.validationExcerpt(error)}`);
              throw error;
            }

            const repairNumber = attempt + 1;
            this.taskStatus(execution, "EDITING", false, `Repairing validation failure (${repairNumber}/${repairAttempts})`);
            this.output(project.id, task.id, "AGENT", `Validation failed. Sending the test output back to the developer agent for repair ${repairNumber} of ${repairAttempts}.`);
            execution.provider = createAgentProvider(this.config, payload.agentCredential, payload.project.developerModel);
            const repairPayload: StartTaskPayload = {
              ...payload,
              request: [
                payload.request,
                `Repair the implementation so the required validation command passes. This is repair attempt ${repairNumber} of ${repairAttempts}.`,
                "Do not weaken, delete, or bypass tests. Diagnose the implementation and make the smallest correct code change.",
                `Validation output:\n${error.output.slice(-12_000)}`,
              ].join("\n\n"),
            };
            await execution.provider.run({
              payload: repairPayload,
              repositoryPath: binding.path,
              signal: controller.signal,
              pauseGate: execution.pauseGate,
              status: ({ shortStatus }) => this.taskStatus(execution, "EDITING", false, shortStatus),
              output: (category, message) => this.output(project.id, task.id, category, message),
            });
            if (controller.signal.aborted) throw controller.signal.reason;
          }
        }
      }
      this.taskStatus(execution, "PUSHING", false, "Checking remote and creating one commit");
      const identity = await this.gitIdentity(binding, payload);
      const result = await commitAndPush(binding, project.branch, sync.commitSha, execution.baselineUntracked, {
        message: `relaycode: ${payload.request.replace(/\s+/g, " ").slice(0, 64)}`,
        authorName: identity.name,
        authorEmail: identity.email,
        signal: controller.signal,
      });
      if (!result.ok) {
        this.socket.emit("GIT_PUSH_RESULT", {
          ok: false,
          projectId: project.id,
          taskId: task.id,
          code: result.code,
          message: result.message,
        });
        this.activity(project.id, task.id, "GIT", result.message);
        return;
      }
      this.socket.emit("GIT_PUSH_RESULT", {
        ok: true,
        projectId: project.id,
        taskId: task.id,
        baseCommitSha: result.baseCommitSha,
        commitSha: result.commitSha,
        diff: result.diff,
      });
      this.activity(project.id, task.id, "GIT", `pushed ${project.branch} at ${result.commitSha.slice(0, 7)}`);
    } catch (error) {
      const cancelled = controller.signal.aborted;
      if (synced) await discardTaskChanges(binding, project.branch, execution.baselineUntracked).catch(() => undefined);
      this.socket.emit("GIT_PUSH_RESULT", {
        ok: false,
        projectId: project.id,
        taskId: task.id,
        code: cancelled ? "CANCELLED" : "PUSH_FAILED",
        message: cancelled ? "Task cancelled; tracked changes were discarded." : this.errorMessage(error),
      });
      // The server records the terminal failure/cancellation once when it
      // processes GIT_PUSH_RESULT. Emitting another activity here duplicates
      // the same error in the project terminal.
    }
  }

  private amendTask(payload: AmendTaskPayload): void {
    const execution = this.active.get(payload.projectId);
    if (!execution || execution.payload.task.id !== payload.taskId || !execution.amendable) return;
    execution.provider.amend(payload.body, payload.authorName);
    this.output(payload.projectId, payload.taskId, "AGENT", `Accepted in-flight refinement from ${payload.authorName}.`);
  }

  private pauseTask(projectId: string, taskId: string): void {
    const execution = this.active.get(projectId);
    if (!execution || execution.payload.task.id !== taskId || execution.pauseGate.isPaused()) return;
    execution.pauseGate.pause();
    execution.provider.pause();
    this.signalChild(execution.child, "SIGSTOP");
    this.socket.emit("TASK_STATUS", { projectId, taskId, phase: "PAUSED", amendable: false, shortStatus: "Paused by a project member" });
    this.activity(projectId, taskId, "TASK", `#${execution.payload.task.number} paused`);
  }

  private resumeTask(projectId: string, taskId: string): void {
    const execution = this.active.get(projectId);
    if (!execution || execution.payload.task.id !== taskId || !execution.pauseGate.isPaused()) return;
    execution.provider.resume();
    this.signalChild(execution.child, "SIGCONT");
    execution.pauseGate.resume();
    const phase = execution.phase === "SYNCING" || execution.phase === "PUSHING" ? execution.phase : execution.phase;
    this.socket.emit("TASK_STATUS", { projectId, taskId, phase, amendable: execution.amendable, shortStatus: "Resumed" });
    this.activity(projectId, taskId, "TASK", `#${execution.payload.task.number} resumed`);
  }

  private async cancelTask(projectId: string, taskId: string): Promise<void> {
    const execution = this.active.get(projectId);
    if (!execution || execution.payload.task.id !== taskId) return;
    execution.controller.abort(new Error("Cancelled by a project member"));
    execution.provider.cancel();
    this.signalChild(execution.child, "SIGTERM");
    execution.pauseGate.resume();
    await execution.promise;
  }

  private async syncProject(payload: SyncProjectPayload): Promise<void> {
    if (this.active.has(payload.projectId) || this.rollbackProjects.has(payload.projectId)) {
      this.deferredSyncs.set(payload.projectId, payload);
      return;
    }
    const binding = this.config.projects[payload.projectId];
    if (!binding) {
      this.socket.emit("GIT_SYNC_RESULT", { projectId: payload.projectId, commitSha: "", ok: false, message: "Local project mapping is not configured." });
      return;
    }
    try {
      const sync = await syncToRemote(binding, payload.branch, payload.repositoryUrl);
      this.socket.emit("GIT_SYNC_RESULT", { projectId: payload.projectId, commitSha: sync.commitSha, ok: true });
      this.activity(payload.projectId, undefined, "GIT", `synced ${sync.commitSha.slice(0, 7)}`);
    } catch (error) {
      this.socket.emit("GIT_SYNC_RESULT", { projectId: payload.projectId, commitSha: "", ok: false, message: this.errorMessage(error) });
    }
  }

  private async startRollback(payload: StartRollbackPayload): Promise<void> {
    if (this.rollbackProjects.has(payload.projectId)) return;
    const binding = this.config.projects[payload.projectId];
    if (!binding) {
      this.socket.emit("ROLLBACK_RESULT", { ok: false, projectId: payload.projectId, message: "Local project mapping is not configured." });
      return;
    }
    this.rollbackProjects.add(payload.projectId);
    try {
      const active = this.active.get(payload.projectId);
      if (active) {
        active.controller.abort(new Error("Cancelled by rollback"));
        active.provider.cancel();
        this.signalChild(active.child, "SIGTERM");
        active.pauseGate.resume();
        await active.promise;
      }
      this.activity(payload.projectId, undefined, "ROLLBACK", `rewriting ${payload.branch} to ${payload.targetSha.slice(0, 7)}`);
      const result = await rollbackRemote(binding, payload.branch, payload.repositoryUrl, payload.targetSha);
      this.socket.emit("ROLLBACK_RESULT", { ok: true, projectId: payload.projectId, ...result });
    } catch (error) {
      this.socket.emit("ROLLBACK_RESULT", { ok: false, projectId: payload.projectId, message: this.errorMessage(error) });
    } finally {
      this.rollbackProjects.delete(payload.projectId);
      const deferred = this.deferredSyncs.get(payload.projectId);
      if (deferred) {
        this.deferredSyncs.delete(payload.projectId);
        await this.syncProject(deferred);
      }
    }
  }

  private taskStatus(execution: ActiveExecution, phase: ActiveExecution["phase"], amendable: boolean, shortStatus: string): void {
    execution.phase = phase;
    execution.amendable = amendable;
    const projectId = execution.payload.project.id;
    const taskId = execution.payload.task.id;
    this.socket.emit("TASK_STATUS", { projectId, taskId, phase, amendable, shortStatus: sanitizeText(shortStatus).slice(0, 300) });
    this.activity(projectId, taskId, phase === "VALIDATING" ? "TEST" : "AGENT", shortStatus);
  }

  private output(projectId: string, taskId: string, category: "AGENT" | "TEST" | "SYSTEM", message: string): void {
    const safe = sanitizeText(message).slice(0, 2_000);
    this.socket.emit("TASK_OUTPUT", { projectId, taskId, category, message: safe });
  }

  private activity(projectId: string, taskId: string | undefined, category: string, message: string): void {
    this.socket.emit("ACTIVITY_EVENT", {
      projectId,
      ...(taskId ? { taskId } : {}),
      category: category.slice(0, 24),
      message: sanitizeText(message).slice(0, 2_000),
    });
  }

  private failTask(payload: StartTaskPayload, message: string): void {
    this.socket.emit("GIT_PUSH_RESULT", { ok: false, projectId: payload.project.id, taskId: payload.task.id, code: "PUSH_FAILED", message });
  }

  private async gitIdentity(binding: ProjectBinding, payload: StartTaskPayload): Promise<{ name: string; email: string }> {
    const name = binding.gitAuthorName ?? payload.task.requestedBy?.name ?? await runGit(["config", "user.name"], binding.path);
    const email = binding.gitAuthorEmail ?? await runGit(["config", "user.email"], binding.path);
    if (!name || !email) throw new Error("Configure git user.name and user.email in the local repository before executing tasks.");
    return { name, email };
  }

  private async runConfiguredCommand(execution: ActiveExecution, command: string, category: "TEST"): Promise<string> {
    try {
      return await this.runConfiguredCommandOnce(execution, command, category);
    } catch (error) {
      if (!(error instanceof ValidationCommandError) || execution.controller.signal.aborted) throw error;
      const projectId = execution.payload.project.id;
      const taskId = execution.payload.task.id;
      this.activity(projectId, taskId, category, `Command failed with exit code ${error.exitCode ?? "unknown"}; retrying once before continuing`);
      this.output(projectId, taskId, category, "The latest command failed. Retrying it once before Relaycode continues to the next step.");
      return this.runConfiguredCommandOnce(execution, command, category);
    }
  }

  private async runConfiguredCommandOnce(execution: ActiveExecution, command: string, category: "TEST"): Promise<string> {
    await execution.pauseGate.wait(execution.controller.signal);
    const child = spawn(command, {
      cwd: execution.binding.path,
      env: agentChildEnvironment(),
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    execution.child = child;
    let output = "";
    const collect = (chunk: Buffer) => { if (output.length < 200_000) output += chunk.toString("utf8"); };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const abort = () => this.signalChild(child, "SIGTERM");
    execution.controller.signal.addEventListener("abort", abort, { once: true });
    const code = await new Promise<number | null>((accept, reject) => {
      child.once("error", reject);
      child.once("close", accept);
    }).finally(() => {
      execution.controller.signal.removeEventListener("abort", abort);
      execution.child = undefined;
    });
    this.output(execution.payload.project.id, execution.payload.task.id, category, output);
    if (execution.controller.signal.aborted) throw execution.controller.signal.reason;
    if (code !== 0) throw new ValidationCommandError(code, sanitizeText(output));
    return output;
  }

  private validationExcerpt(error: ValidationCommandError): string {
    const excerpt = sanitizeText(error.output).trim().slice(-1_200);
    return excerpt ? `Last output: ${excerpt}` : error.message;
  }

  private signalChild(child: ChildProcess | undefined, signal: NodeJS.Signals): void {
    if (!child?.pid || child.exitCode !== null) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  }

  private errorMessage(error: unknown): string {
    return sanitizeText(error instanceof Error ? error.message : error).slice(0, 2_000);
  }
}
