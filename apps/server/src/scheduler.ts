import type { PrismaClient, TaskStatus } from "@prisma/client";
import { activeStatuses, QUEUE_PRIORITY, type StartRollbackPayload } from "@relaycode/shared";
import { recordActivity } from "./activity.js";
import { HttpError, requireMember } from "./auth.js";
import { ConservativeCoordinator, type CoordinatorAgent } from "./coordinator.js";
import { ConnectionRegistry, type RelayServer, type RelaySocket } from "./realtime.js";
import { fullTaskInclude, serializeProject, serializeTask } from "./serialize.js";

const ACTIVE = activeStatuses as TaskStatus[];
const ALLOWED_TRANSITIONS: Partial<Record<TaskStatus, TaskStatus[]>> = {
  SYNCING: ["PLANNING", "FAILED", "CANCELLED"],
  PLANNING: ["EDITING", "VALIDATING", "PAUSED", "FAILED", "CANCELLED"],
  EDITING: ["VALIDATING", "PUSHING", "PAUSED", "FAILED", "CANCELLED"],
  VALIDATING: ["EDITING", "PUSHING", "PAUSED", "FAILED", "CANCELLED"],
  PUSHING: ["FAILED", "REMOTE_DIVERGED", "SYNCING_TEAM", "COMMITTED"],
  PAUSED: ["SYNCING", "PLANNING", "EDITING", "VALIDATING", "FAILED", "CANCELLED"],
};

export class Scheduler {
  private readonly projectLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly io: RelayServer,
    readonly connections: ConnectionRegistry,
    private readonly coordinator: CoordinatorAgent = new ConservativeCoordinator(),
  ) {}

  schedule(projectId: string) {
    return this.exclusive(projectId, () => this.startNext(projectId));
  }

  async createRequest(userId: string, projectId: string, body: string) {
    await requireMember(this.prisma, projectId, userId, { write: true });
    const active = await this.prisma.task.findFirst({
      where: { projectId, status: { in: ACTIVE } },
      include: { rootMessage: true },
    });
    if (active?.amendable) {
      const decision = await this.coordinator.classify({ incoming: body, activeRequest: active.rootMessage.body });
      if (decision.kind === "REFINEMENT" && decision.confidence >= 0.85) {
        return this.attachInFlightRefinement(userId, active.id, body);
      }
    }
    const task = await this.createQueuedTask(userId, projectId, body, "NORMAL", null);
    void this.schedule(projectId);
    return task;
  }

  async createRefinement(userId: string, projectId: string, parentTaskId: string, body: string) {
    await requireMember(this.prisma, projectId, userId, { write: true });
    const parent = await this.prisma.task.findFirst({ where: { id: parentTaskId, projectId } });
    if (!parent) throw new HttpError(404, "Parent task not found");
    if (ACTIVE.includes(parent.status) && parent.amendable) return this.attachInFlightRefinement(userId, parent.id, body);
    const task = await this.createQueuedTask(userId, projectId, body, "REFINEMENT", parent.id);
    void this.schedule(projectId);
    return task;
  }

  async updateStatus(socket: RelaySocket, payload: { projectId: string; taskId: string; phase: TaskStatus; amendable: boolean; shortStatus: string; baseCommitSha?: string }) {
    const userId = this.daemonUser(socket);
    const task = await this.ownedActiveTask(payload.projectId, payload.taskId, userId);
    if (task.status !== payload.phase && !ALLOWED_TRANSITIONS[task.status]?.includes(payload.phase)) {
      throw new HttpError(409, `Invalid task transition ${task.status} -> ${payload.phase}`);
    }
    await this.prisma.task.update({
      where: { id: task.id },
      data: {
        status: payload.phase,
        amendable: payload.amendable,
        shortStatus: payload.shortStatus,
        ...(payload.baseCommitSha ? { baseCommitSha: payload.baseCommitSha } : {}),
        ...(["FAILED", "CANCELLED"].includes(payload.phase) ? { completedAt: new Date(), amendable: false } : {}),
      },
    });
    await recordActivity(this.prisma, this.io, { projectId: task.projectId, taskId: task.id, userId, category: "AGENT", message: payload.shortStatus });
    this.taskUpdated(task.projectId, task.id);
    if (["FAILED", "CANCELLED"].includes(payload.phase)) void this.schedule(task.projectId);
  }

  async updateAmendable(socket: RelaySocket, payload: { projectId: string; taskId: string; amendable: boolean }) {
    const userId = this.daemonUser(socket);
    const task = await this.ownedActiveTask(payload.projectId, payload.taskId, userId);
    if (!["PLANNING", "EDITING"].includes(task.status) && payload.amendable) throw new HttpError(409, "This task phase cannot accept amendments");
    await this.prisma.task.update({ where: { id: task.id }, data: { amendable: payload.amendable } });
    this.taskUpdated(task.projectId, task.id);
  }

  async syncResult(socket: RelaySocket, payload: { projectId: string; taskId?: string; commitSha: string; ok: boolean; message?: string }) {
    const userId = this.daemonUser(socket);
    await requireMember(this.prisma, payload.projectId, userId);
    if (payload.taskId) {
      const task = await this.ownedActiveTask(payload.projectId, payload.taskId, userId);
      if (task.status !== "SYNCING") throw new HttpError(409, "Task is not awaiting its initial Git synchronization");
      if (!payload.ok) {
        await this.prisma.task.update({ where: { id: task.id }, data: { status: "FAILED", failureReason: payload.message ?? "Git synchronization failed", completedAt: new Date(), amendable: false } });
        this.taskUpdated(task.projectId, task.id);
        void this.schedule(task.projectId);
        return;
      }
      await this.prisma.task.update({ where: { id: task.id }, data: { baseCommitSha: payload.commitSha, status: "SYNCING", amendable: false, shortStatus: `Synchronized to ${payload.commitSha.slice(0, 12)}` } });
      await recordActivity(this.prisma, this.io, { projectId: task.projectId, taskId: task.id, userId, category: "GIT", message: `synced ${payload.commitSha.slice(0, 12)}` });
      this.taskUpdated(task.projectId, task.id);
      return;
    }
    this.connections.markReady(socket.id, payload.projectId, payload.ok);
    if (payload.ok) {
      await this.prisma.task.updateMany({ where: { projectId: payload.projectId, requestedByUserId: userId, status: "WAITING_FOR_REQUESTER" }, data: { status: "QUEUED", shortStatus: null } });
    }
    this.io.to(`project:${payload.projectId}:web`).emit("SYNC_STATUS_CHANGED", { projectId: payload.projectId, userId, commitSha: payload.commitSha, ok: payload.ok });
    await recordActivity(this.prisma, this.io, { projectId: payload.projectId, userId, category: "GIT", message: payload.ok ? `synced ${payload.commitSha.slice(0, 12)}` : (payload.message ?? "sync failed") });
    if (payload.ok) void this.schedule(payload.projectId);
  }

  async pushResult(socket: RelaySocket, payload: any) {
    const userId = this.daemonUser(socket);
    if (!payload.ok && payload.code === "CANCELLED") {
      const cancelled = await this.prisma.task.findFirst({ where: { id: payload.taskId, projectId: payload.projectId, executorUserId: userId, status: "CANCELLED" } });
      if (cancelled) return;
    }
    const task = await this.ownedActiveTask(payload.projectId, payload.taskId, userId);
    if (task.status !== "PUSHING") throw new HttpError(409, "Task is not in the pushing phase");
    if (payload.ok) {
      if (!task.baseCommitSha || payload.baseCommitSha !== task.baseCommitSha) throw new HttpError(409, "Push result base SHA does not match the task base commit");
      await this.prisma.$transaction([
        this.prisma.task.update({ where: { id: task.id }, data: { status: "COMMITTED", amendable: false, shortStatus: "Accepted automatically", commitSha: payload.commitSha, diff: payload.diff, completedAt: new Date() } }),
        this.prisma.activityEvent.create({ data: { projectId: task.projectId, taskId: task.id, userId, category: "GIT", message: `pushed ${String(payload.commitSha).slice(0, 12)}`, metadata: {} } }),
      ]);
      this.taskUpdated(task.projectId, task.id);
      this.io.to(`project:${task.projectId}:web`).emit("DIFF_AVAILABLE", { projectId: task.projectId, taskId: task.id });
      const project = await this.prisma.project.findUniqueOrThrow({ where: { id: task.projectId } });
      this.connections.syncAllProjectMembers(task.projectId, { projectId: task.projectId, repositoryUrl: project.repositoryUrl, branch: project.branch });
      await recordActivity(this.prisma, this.io, { projectId: task.projectId, taskId: task.id, category: "TASK", message: `#${task.number} complete — accepted automatically` });
      void this.schedule(task.projectId);
      return;
    }

    if (payload.code === "REMOTE_DIVERGED") {
      const sequence = await this.nextSequence(task.projectId);
      await this.prisma.task.update({ where: { id: task.id }, data: { status: "QUEUED", queueSequence: sequence, executorUserId: null, baseCommitSha: null, commitSha: null, startedAt: null, amendable: false, shortStatus: "Remote changed; waiting to retry", failureReason: payload.message } });
      const project = await this.prisma.project.findUniqueOrThrow({ where: { id: task.projectId } });
      this.connections.markUserProjectUnready(userId, task.projectId);
      this.connections.emitToMapped(userId, task.projectId, "SYNC_PROJECT", { projectId: task.projectId, repositoryUrl: project.repositoryUrl, branch: project.branch });
      await recordActivity(this.prisma, this.io, { projectId: task.projectId, taskId: task.id, userId, category: "GIT", message: "remote diverged; request requeued" });
    } else {
      await this.prisma.task.update({ where: { id: task.id }, data: { status: payload.code === "CANCELLED" ? "CANCELLED" : "FAILED", amendable: false, failureReason: payload.message, completedAt: new Date() } });
    }
    this.taskUpdated(task.projectId, task.id);
    void this.schedule(task.projectId);
  }

  async pause(userId: string, projectId: string, taskId: string) {
    await requireMember(this.prisma, projectId, userId, { write: true });
    const task = await this.activeTask(projectId, taskId);
    if (["PUSHING", "SYNCING_TEAM"].includes(task.status)) throw new HttpError(409, "Task cannot be paused during push or team sync");
    await this.prisma.task.update({ where: { id: task.id }, data: { status: "PAUSED", amendable: false, shortStatus: "Paused" } });
    this.connections.emitToMapped(task.executorUserId!, projectId, "PAUSE_TASK", { projectId, taskId });
    this.taskUpdated(projectId, taskId);
  }

  async resume(userId: string, projectId: string, taskId: string) {
    await requireMember(this.prisma, projectId, userId, { write: true });
    const task = await this.activeTask(projectId, taskId);
    if (task.status !== "PAUSED") throw new HttpError(409, "Task is not paused");
    if (!this.connections.hasMapping(task.executorUserId!, projectId)) throw new HttpError(409, "Executor daemon is offline");
    await this.prisma.task.update({ where: { id: task.id }, data: { shortStatus: "Resuming" } });
    this.connections.emitToMapped(task.executorUserId!, projectId, "RESUME_TASK", { projectId, taskId });
    this.taskUpdated(projectId, taskId);
  }

  async cancel(userId: string, projectId: string, taskId: string) {
    await requireMember(this.prisma, projectId, userId, { write: true });
    const task = await this.activeTask(projectId, taskId);
    await this.prisma.task.update({ where: { id: task.id }, data: { status: "CANCELLED", amendable: false, shortStatus: "Cancelled", completedAt: new Date() } });
    if (task.executorUserId) this.connections.emitToMapped(task.executorUserId, projectId, "CANCEL_TASK", { projectId, taskId });
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    if (task.executorUserId) {
      this.connections.markUserProjectUnready(task.executorUserId, projectId);
      this.connections.emitToMapped(task.executorUserId, projectId, "SYNC_PROJECT", { projectId, repositoryUrl: project.repositoryUrl, branch: project.branch });
    }
    await recordActivity(this.prisma, this.io, { projectId, taskId, userId, category: "TASK", message: `#${task.number} cancelled` });
    this.taskUpdated(projectId, taskId);
    void this.schedule(projectId);
  }

  async rollbackImpact(userId: string, projectId: string, taskId: string) {
    await requireMember(this.prisma, projectId, userId, { write: true });
    const target = await this.prisma.task.findFirst({ where: { id: taskId, projectId, status: "COMMITTED" }, include: { rootMessage: true } });
    if (!target?.baseCommitSha || !target.completedAt) throw new HttpError(409, "Only a committed task with a recorded base commit can be rolled back");
    const affected = await this.prisma.task.findMany({
      where: { projectId, status: "COMMITTED", completedAt: { gte: target.completedAt } },
      include: { rootMessage: true },
      orderBy: { completedAt: "asc" },
    });
    const active = await this.prisma.task.findFirst({ where: { projectId, status: { in: ACTIVE } }, include: { rootMessage: true } });
    return {
      targetSha: target.baseCommitSha,
      target: { id: target.id, number: target.number, body: target.rootMessage.body },
      affected: affected.map((task) => ({ id: task.id, number: task.number, body: task.rootMessage.body, commitSha: task.commitSha })),
      active: active ? { id: active.id, number: active.number, body: active.rootMessage.body } : null,
    };
  }

  async beginRollback(userId: string, projectId: string, taskId: string) {
    return this.exclusive(projectId, async () => {
      await requireMember(this.prisma, projectId, userId, { write: true });
      if (!this.connections.isEligible(userId, projectId)) throw new HttpError(409, "Your synchronized local companion is required to perform rollback with your Git credential");
      const impact = await this.rollbackImpact(userId, projectId, taskId);
      const locked = await this.prisma.project.updateMany({ where: { id: projectId, rollbackLocked: false }, data: { rollbackLocked: true } });
      if (locked.count !== 1) throw new HttpError(409, "A rollback is already in progress");
      try {
        const active = await this.prisma.task.findFirst({ where: { projectId, status: { in: ACTIVE } } });
        if (active) {
          await this.prisma.task.update({ where: { id: active.id }, data: { status: "CANCELLED", amendable: false, completedAt: new Date(), shortStatus: "Cancelled by rollback" } });
          if (active.executorUserId) this.connections.emitToMapped(active.executorUserId, projectId, "CANCEL_TASK", { projectId, taskId: active.id });
        }
        const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
        const newest = impact.affected.at(-1);
        const action = await this.prisma.rollbackAction.create({ data: { projectId, targetTaskId: taskId, initiatedById: userId, targetCommitSha: impact.targetSha, previousHeadSha: newest?.commitSha, status: "EXECUTING" } });
        const payload: StartRollbackPayload = { projectId, repositoryUrl: project.repositoryUrl, branch: project.branch, targetSha: impact.targetSha, rollbackTaskId: action.id, affectedTaskIds: impact.affected.map((task) => task.id) };
        if (!this.connections.emitToEligible(userId, projectId, "START_ROLLBACK", payload)) throw new HttpError(409, "Rollback initiator daemon became unavailable");
        await recordActivity(this.prisma, this.io, { projectId, taskId, userId, category: "ROLLBACK", message: `rollback of #${impact.target.number} started; ${impact.affected.length} committed task(s) will be discarded` });
        this.queueUpdated(projectId);
        return { actionId: action.id, ...impact };
      } catch (error) {
        await this.prisma.project.update({ where: { id: projectId }, data: { rollbackLocked: false } });
        throw error;
      }
    });
  }

  async rollbackResult(socket: RelaySocket, payload: { ok: boolean; projectId: string; targetSha?: string; previousSha?: string; message?: string }) {
    const userId = this.daemonUser(socket);
    const action = await this.prisma.rollbackAction.findFirst({ where: { projectId: payload.projectId, initiatedById: userId, status: "EXECUTING" }, include: { targetTask: true, project: true }, orderBy: { createdAt: "desc" } });
    if (!action) throw new HttpError(404, "No rollback is awaiting this daemon");
    if (!payload.ok) {
      await this.prisma.$transaction([
        this.prisma.rollbackAction.update({ where: { id: action.id }, data: { status: "FAILED", error: payload.message ?? "Force-with-lease push failed", completedAt: new Date() } }),
        this.prisma.project.update({ where: { id: payload.projectId }, data: { rollbackLocked: false } }),
      ]);
      await recordActivity(this.prisma, this.io, { projectId: payload.projectId, taskId: action.targetTaskId, userId, category: "ROLLBACK", message: payload.message ?? "rollback failed (branch protection or remote lease may have rejected the push)" });
      this.queueUpdated(payload.projectId);
      void this.schedule(payload.projectId);
      return;
    }
    if (payload.targetSha !== action.targetCommitSha) throw new HttpError(409, "Rollback target SHA mismatch");
    const completedAt = action.targetTask.completedAt;
    await this.prisma.$transaction(async (tx) => {
      const affected = await tx.task.findMany({ where: { projectId: payload.projectId, status: "COMMITTED", ...(completedAt ? { completedAt: { gte: completedAt } } : {}) }, orderBy: { completedAt: "asc" } });
      for (const task of affected) {
        await tx.task.update({ where: { id: task.id }, data: { status: task.id === action.targetTaskId ? "ROLLED_BACK" : "DISCARDED_BY_ROLLBACK", amendable: false } });
      }
      await tx.rollbackAction.update({ where: { id: action.id }, data: { status: "COMPLETED", previousHeadSha: payload.previousSha, completedAt: new Date() } });
      await tx.project.update({ where: { id: payload.projectId }, data: { rollbackLocked: false } });
    });
    await recordActivity(this.prisma, this.io, { projectId: payload.projectId, taskId: action.targetTaskId, userId, category: "ROLLBACK", message: `remote history reset to ${action.targetCommitSha.slice(0, 12)}` });
    this.connections.syncAllProjectMembers(payload.projectId, { projectId: payload.projectId, repositoryUrl: action.project.repositoryUrl, branch: action.project.branch });
    this.queueUpdated(payload.projectId);
    void this.schedule(payload.projectId);
  }

  private async createQueuedTask(userId: string, projectId: string, body: string, type: "NORMAL" | "REFINEMENT", parentTaskId: string | null) {
    const task = await this.prisma.$transaction(async (tx) => {
      const counters = await tx.project.update({ where: { id: projectId }, data: { nextTaskNumber: { increment: 1 }, nextQueueSequence: { increment: 1 } } });
      const message = await tx.message.create({ data: { projectId, authorId: userId, body, ...(parentTaskId ? { replyToMessageId: (await tx.task.findUniqueOrThrow({ where: { id: parentTaskId } })).rootMessageId } : {}) } });
      const created = await tx.task.create({
        data: {
          number: counters.nextTaskNumber - 1,
          projectId,
          rootMessageId: message.id,
          parentTaskId,
          type,
          queuePriority: type === "REFINEMENT" ? QUEUE_PRIORITY.REFINEMENT : QUEUE_PRIORITY.NORMAL,
          queueSequence: counters.nextQueueSequence - 1,
          requestedByUserId: userId,
          taskMessages: { create: { messageId: message.id, role: "INITIAL" } },
        },
        include: fullTaskInclude,
      });
      return created;
    });
    await recordActivity(this.prisma, this.io, { projectId, taskId: task.id, userId, category: type === "REFINEMENT" ? "REFINE" : "REQUEST", message: `#${task.number} queued` });
    this.io.to(`project:${projectId}:web`).emit("MESSAGE_CREATED", { projectId, messageId: task.rootMessageId });
    this.queueUpdated(projectId);
    return serializeTask(task);
  }

  private async attachInFlightRefinement(userId: string, taskId: string, body: string) {
    const task = await this.prisma.task.findUniqueOrThrow({ where: { id: taskId }, include: { rootMessage: true, executor: true } });
    if (!ACTIVE.includes(task.status) || !task.amendable || !task.executorUserId) throw new HttpError(409, "Task is no longer amendable");
    const author = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const message = await this.prisma.message.create({ data: { projectId: task.projectId, authorId: userId, body, replyToMessageId: task.rootMessageId } });
    await this.prisma.taskMessage.create({ data: { taskId, messageId: message.id, role: "IN_FLIGHT_REFINEMENT" } });
    const delivered = this.connections.emitToMapped(task.executorUserId, task.projectId, "AMEND_TASK", { taskId, projectId: task.projectId, messageId: message.id, body, authorName: author.name });
    if (!delivered) throw new HttpError(409, "Executor daemon disconnected before the amendment could be delivered");
    await recordActivity(this.prisma, this.io, { projectId: task.projectId, taskId, userId, category: "REFINE", message: `refinement merged into #${task.number}` });
    this.io.to(`project:${task.projectId}:web`).emit("MESSAGE_CREATED", { projectId: task.projectId, messageId: message.id });
    this.taskUpdated(task.projectId, taskId);
    return { kind: "IN_FLIGHT_REFINEMENT", taskId, messageId: message.id };
  }

  private async startNext(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.rollbackLocked) return;
    const active = await this.prisma.task.findFirst({ where: { projectId, status: { in: ACTIVE } } });
    if (active) return;
    const candidates = await this.prisma.task.findMany({
      where: { projectId, status: { in: ["QUEUED", "WAITING_FOR_REQUESTER"] } },
      orderBy: [{ queuePriority: "desc" }, { queueSequence: "asc" }],
      include: fullTaskInclude,
    });
    for (const task of candidates) {
      if (!this.connections.isEligible(task.requestedByUserId, projectId)) {
        if (task.status !== "WAITING_FOR_REQUESTER") {
          const daemon = this.connections.statusFor(task.requestedByUserId, projectId);
          const shortStatus = !daemon.online ? "Requester daemon offline" : !daemon.mapped ? "Project is not mapped to a local repository" : "Local repository is synchronizing";
          await this.prisma.task.update({ where: { id: task.id }, data: { status: "WAITING_FOR_REQUESTER", shortStatus } });
          this.taskUpdated(projectId, task.id);
        }
        continue;
      }
      const claimed = await this.prisma.task.updateMany({ where: { id: task.id, status: { in: ["QUEUED", "WAITING_FOR_REQUESTER"] } }, data: { status: "SYNCING", executorUserId: task.requestedByUserId, startedAt: new Date(), completedAt: null, failureReason: null, shortStatus: "Synchronizing to remote", amendable: false } });
      if (!claimed.count) continue;
      const refreshed = await this.prisma.task.findUniqueOrThrow({ where: { id: task.id }, include: fullTaskInclude });
      const refinements = refreshed.taskMessages.filter((link) => link.messageId !== refreshed.rootMessageId).map((link) => link.message.body);
      const emitted = this.connections.emitToEligible(task.requestedByUserId, projectId, "START_TASK", {
        task: serializeTask(refreshed) as any,
        project: serializeProject(project) as any,
        request: refreshed.rootMessage.body,
        refinements,
        ...(project.agentCredential ? { agentCredential: project.agentCredential } : {}),
      });
      if (!emitted) {
        await this.prisma.task.update({ where: { id: task.id }, data: { status: "WAITING_FOR_REQUESTER", executorUserId: null, startedAt: null } });
        continue;
      }
      await recordActivity(this.prisma, this.io, { projectId, taskId: task.id, userId: task.requestedByUserId, category: "GIT", message: `syncing origin/${project.branch}` });
      this.taskUpdated(projectId, task.id);
      return;
    }
    this.queueUpdated(projectId);
  }

  private async nextSequence(projectId: string) {
    const project = await this.prisma.project.update({ where: { id: projectId }, data: { nextQueueSequence: { increment: 1 } } });
    return project.nextQueueSequence - 1;
  }

  private daemonUser(socket: RelaySocket) {
    const userId = socket.data.daemonUserId as string | undefined;
    if (!userId || !this.connections.get(socket.id)) throw new HttpError(401, "Authenticated daemon connection required");
    return userId;
  }

  private async ownedActiveTask(projectId: string, taskId: string, userId: string) {
    const task = await this.prisma.task.findFirst({ where: { id: taskId, projectId, executorUserId: userId, status: { in: ACTIVE } } });
    if (!task) throw new HttpError(403, "Task is not actively assigned to this daemon");
    return task;
  }

  private async activeTask(projectId: string, taskId: string) {
    const task = await this.prisma.task.findFirst({ where: { id: taskId, projectId, status: { in: ACTIVE } } });
    if (!task) throw new HttpError(404, "Active task not found");
    return task;
  }

  private taskUpdated(projectId: string, taskId: string) {
    this.io.to(`project:${projectId}:web`).emit("TASK_UPDATED", { projectId, taskId });
    this.queueUpdated(projectId);
  }

  private queueUpdated(projectId: string) {
    this.io.to(`project:${projectId}:web`).emit("QUEUE_UPDATED", { projectId });
  }

  private exclusive<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.projectLocks.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const marker = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.catch(() => undefined).then(() => marker);
    this.projectLocks.set(projectId, queued);
    return previous.catch(() => undefined).then(operation).finally(() => {
      release();
      if (this.projectLocks.get(projectId) === queued) this.projectLocks.delete(projectId);
    });
  }
}
