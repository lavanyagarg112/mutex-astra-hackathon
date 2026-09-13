import { createHash, timingSafeEqual } from "node:crypto";
import {
  ActivityInputSchema,
  CreateRefinementSchema,
  CreateRequestSchema,
  DaemonConnectedSchema,
  GitPushResultSchema,
  GitSyncResultSchema,
  MemberInteractionSchema,
  ProjectSettingsSchema,
  RollbackResultSchema,
  RollbackTaskSchema,
  TaskControlSchema,
  TaskOutputSchema,
  TaskStatusEventSchema,
  UpdateUserAppearanceSchema,
} from "@relaycode/shared";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { recordActivity } from "./activity.js";
import { demoAuthEnabled, hashToken, HttpError, readCookie, requireMember, SESSION_COOKIE } from "./auth.js";
import type { RelayServer, RelaySocket } from "./realtime.js";
import type { BrowserPresence } from "./presence.js";
import { RuntimeState } from "./runtime.js";
import { Scheduler } from "./scheduler.js";

const ExtendedProjectSettingsSchema = ProjectSettingsSchema;

export function installSocketHandlers(io: RelayServer, prisma: PrismaClient, scheduler: Scheduler, runtime: RuntimeState, presence: BrowserPresence) {
  io.on("connection", (socket) => {
    void joinBrowserRooms(socket, prisma, io, presence);

    socket.on("DAEMON_CONNECTED", (raw) => void guarded(socket, async () => {
      const payload = DaemonConnectedSchema.parse(raw);
      const user = await prisma.user.findUnique({ where: { id: payload.userId } });
      if (!user?.daemonTokenHash || !tokenMatches(payload.token, user.daemonTokenHash)) throw new HttpError(401, "Invalid daemon credentials");
      const memberships = await prisma.projectMember.findMany({ where: { userId: user.id }, include: { project: true } });
      const allowed = new Map(memberships.map((membership) => [membership.projectId, membership.project]));
      const validMappings = payload.mappings.filter((mapping) => {
        const project = allowed.get(mapping.projectId);
        if (!project) return false;
        if (!mapping.remoteUrl) return true;
        return normalizeRemote(mapping.remoteUrl) === normalizeRemote(project.repositoryUrl);
      });
      const session = scheduler.connections.register(socket, { userId: user.id, version: payload.version, mappings: validMappings });
      for (const mapping of validMappings) {
        const project = allowed.get(mapping.projectId)!;
        socket.emit("SYNC_PROJECT", { projectId: project.id, repositoryUrl: project.repositoryUrl, branch: project.branch });
        io.to(`project:${project.id}:web`).emit("MEMBER_STATUS_CHANGED", { projectId: project.id, userId: user.id, online: true });
        await recordActivity(prisma, io, { projectId: project.id, userId: user.id, category: "DAEMON", message: `local companion ${session.version} connected; synchronization required` });
      }
    }));

    socket.on("DAEMON_HEARTBEAT", (payload) => void guarded(socket, async () => {
      const userId = daemonUser(socket, scheduler);
      if (payload.userId !== userId) throw new HttpError(403, "Heartbeat user mismatch");
      scheduler.connections.heartbeat(socket.id);
    }));
    socket.on("TASK_STATUS", (raw) => void guarded(socket, async () => {
      const payload = TaskStatusEventSchema.parse(raw);
      await scheduler.updateStatus(socket, payload);
    }));
    socket.on("TASK_AMENDABLE_CHANGED", (raw) => void guarded(socket, async () => {
      const payload = z.object({ projectId: z.string(), taskId: z.string(), amendable: z.boolean() }).parse(raw);
      await scheduler.updateAmendable(socket, payload);
    }));
    socket.on("TASK_OUTPUT", (raw) => void guarded(socket, async () => {
      const payload = TaskOutputSchema.parse(raw);
      const userId = daemonUser(socket, scheduler);
      await requireMember(prisma, payload.projectId, userId);
      const task = await prisma.task.findFirst({ where: { id: payload.taskId, projectId: payload.projectId, executorUserId: userId } });
      if (!task) throw new HttpError(403, "Daemon is not the task executor");
      await recordActivity(prisma, io, { ...payload, userId });
    }));
    socket.on("GIT_SYNC_RESULT", (raw) => void guarded(socket, async () => scheduler.syncResult(socket, GitSyncResultSchema.parse(raw))));
    socket.on("GIT_PUSH_RESULT", (raw) => void guarded(socket, async () => scheduler.pushResult(socket, GitPushResultSchema.parse(raw))));
    socket.on("ROLLBACK_RESULT", (raw) => void guarded(socket, async () => scheduler.rollbackResult(socket, RollbackResultSchema.parse(raw))));
    socket.on("PROCESS_STATUS", (raw) => void guarded(socket, async () => {
      const payload = z.object({ projectId: z.string(), name: z.string().max(80), status: z.enum(["starting", "running", "stopped", "failed"]), port: z.number().int().min(1).max(65535).optional(), url: z.string().url().optional() }).parse(raw);
      const userId = daemonUser(socket, scheduler);
      await requireMember(prisma, payload.projectId, userId);
      runtime.setProcess({ ...payload, userId });
      io.to(`project:${payload.projectId}:web`).emit("PROCESS_STATUS_CHANGED", { projectId: payload.projectId, userId });
    }));
    socket.on("ACTIVITY_EVENT", (raw) => void guarded(socket, async () => {
      const payload = ActivityInputSchema.parse(raw);
      const userId = daemonUser(socket, scheduler);
      await requireMember(prisma, payload.projectId, userId);
      await recordActivity(prisma, io, { ...payload, userId });
    }));

    socket.on("CREATE_REQUEST", (raw) => void guarded(socket, async () => {
      const userId = browserUser(socket);
      const payload = CreateRequestSchema.parse(raw);
      await scheduler.createRequest(userId, payload.projectId, payload.body);
    }));
    socket.on("CREATE_REFINEMENT", (raw) => void guarded(socket, async () => {
      const userId = browserUser(socket);
      const payload = CreateRefinementSchema.parse(raw);
      await scheduler.createRefinement(userId, payload.projectId, payload.parentTaskId, payload.body);
    }));
    socket.on("PAUSE_ACTIVE_TASK", (raw) => void guarded(socket, async () => {
      const payload = TaskControlSchema.parse(raw);
      await scheduler.pause(browserUser(socket), payload.projectId, payload.taskId);
    }));
    socket.on("RESUME_ACTIVE_TASK", (raw) => void guarded(socket, async () => {
      const payload = TaskControlSchema.parse(raw);
      await scheduler.resume(browserUser(socket), payload.projectId, payload.taskId);
    }));
    socket.on("CANCEL_ACTIVE_TASK", (raw) => void guarded(socket, async () => {
      const payload = TaskControlSchema.parse(raw);
      await scheduler.cancel(browserUser(socket), payload.projectId, payload.taskId);
    }));
    socket.on("ROLLBACK_TASK", (raw) => void guarded(socket, async () => {
      const payload = RollbackTaskSchema.parse(raw);
      await scheduler.beginRollback(browserUser(socket), payload.projectId, payload.taskId);
    }));
    socket.on("UPDATE_PROJECT_SETTINGS", (raw) => void guarded(socket, async () => {
      const payload = ExtendedProjectSettingsSchema.parse(raw);
      const userId = browserUser(socket);
      await requireMember(prisma, payload.projectId, userId, { owner: true });
      await prisma.project.update({ where: { id: payload.projectId }, data: {
        branch: payload.branch,
        coordinatorModel: payload.coordinatorModel,
        developerModel: payload.developerModel,
        installCommand: payload.installCommand,
        frontendCommand: payload.frontendCommand,
        backendCommand: payload.backendCommand,
        testCommand: payload.testCommand,
        ...(payload.agentCredential ? { agentCredential: payload.agentCredential } : {}),
        ...(payload.clearAgentCredential ? { agentCredential: null } : {}),
        ...(payload.toolPermissions ? { toolPermissions: payload.toolPermissions } : {}),
      } });
      await recordActivity(prisma, io, { projectId: payload.projectId, userId, category: "SETTINGS", message: "project settings updated" });
      io.to(`project:${payload.projectId}:web`).emit("QUEUE_UPDATED", { projectId: payload.projectId });
    }));

    socket.on("UPDATE_USER_APPEARANCE", (raw) => void guarded(socket, async () => {
      const payload = UpdateUserAppearanceSchema.parse(raw);
      const userId = browserUser(socket);
      await prisma.user.update({ where: { id: userId }, data: { pixelCharacter: payload.pixelCharacter } });
      const memberships = await prisma.projectMember.findMany({ where: { userId }, select: { projectId: true } });
      for (const { projectId } of memberships) {
        io.to(`project:${projectId}:web`).emit("MEMBER_APPEARANCE_CHANGED", { projectId, userId, pixelCharacter: payload.pixelCharacter });
      }
    }));
    socket.on("MEMBER_INTERACTION", (raw) => void guarded(socket, async () => {
      const payload = MemberInteractionSchema.parse(raw);
      const fromUserId = browserUser(socket);
      await requireMember(prisma, payload.projectId, fromUserId);
      await requireMember(prisma, payload.projectId, payload.targetUserId);
      io.to(`project:${payload.projectId}:web`).emit("MEMBER_INTERACTION", { projectId: payload.projectId, fromUserId, targetUserId: payload.targetUserId, kind: payload.kind });
    }));

    socket.on("disconnect", () => void (async () => {
      const removed = scheduler.connections.unregister(socket.id);
      if (removed) {
        for (const projectId of removed.mappings.keys()) {
          if (!scheduler.connections.isOnline(removed.userId)) io.to(`project:${projectId}:web`).emit("MEMBER_STATUS_CHANGED", { projectId, userId: removed.userId, online: false });
          await scheduler.schedule(projectId);
        }
      }
      const browserUserId = socket.data.browserUserId as string | undefined;
      const browserProjectIds = (socket.data.browserProjectIds as string[] | undefined) ?? [];
      if (browserUserId) {
        for (const projectId of browserProjectIds) {
          if (presence.leave(projectId, browserUserId)) {
            io.to(`project:${projectId}:web`).emit("MEMBER_PRESENCE_CHANGED", { projectId, userId: browserUserId, present: false });
          }
        }
      }
    })());
  });
}

// The daemon (companion) connects through this same socket.io server and
// identifies itself via `auth.client === "daemon"`. It must never count
// toward browser presence — that's specifically "does this person have the
// web app open," not "is their local companion running."
function isDaemonHandshake(socket: RelaySocket): boolean {
  return socket.handshake.auth?.client === "daemon";
}

async function joinBrowserRooms(socket: RelaySocket, prisma: PrismaClient, io: RelayServer, presence: BrowserPresence) {
  if (isDaemonHandshake(socket)) return;
  const rawSession = readCookie(socket.handshake.headers.cookie, SESSION_COOKIE);
  const session = rawSession ? await prisma.authSession.findUnique({ where: { tokenHash: hashToken(rawSession) } }) : null;
  const candidate = session && session.expiresAt > new Date()
    ? session.userId
    : demoAuthEnabled() ? socket.handshake.auth?.userId : undefined;
  if (typeof candidate !== "string") return;
  const user = await prisma.user.findUnique({ where: { id: candidate } });
  if (!user) return;
  socket.data.browserUserId = user.id;
  const memberships = await prisma.projectMember.findMany({ where: { userId: user.id }, select: { projectId: true } });
  const projectIds = memberships.map((membership) => membership.projectId);
  socket.data.browserProjectIds = projectIds;
  await Promise.all(projectIds.map((projectId) => socket.join(`project:${projectId}:web`)));
  for (const projectId of projectIds) {
    if (presence.join(projectId, user.id)) {
      io.to(`project:${projectId}:web`).emit("MEMBER_PRESENCE_CHANGED", { projectId, userId: user.id, present: true });
    }
  }
}

function browserUser(socket: RelaySocket) {
  const userId = socket.data.browserUserId as string | undefined;
  if (!userId) throw new HttpError(401, "Authenticated browser connection required");
  return userId;
}

function daemonUser(socket: RelaySocket, scheduler: Scheduler) {
  const session = scheduler.connections.get(socket.id);
  if (!session) throw new HttpError(401, "Authenticated daemon connection required");
  return session.userId;
}

function tokenMatches(token: string, expectedHash: string) {
  const actual = createHash("sha256").update(token).digest();
  let expected: Buffer;
  try { expected = Buffer.from(expectedHash, "hex"); } catch { return false; }
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

function normalizeRemote(remote: string) {
  return remote.trim().replace(/\.git$/, "").replace(/^git@github\.com:/, "https://github.com/").toLowerCase();
}

const socketOperationQueues = new WeakMap<RelaySocket, Promise<void>>();

async function guarded(socket: RelaySocket, operation: () => Promise<unknown>) {
  const previous = socketOperationQueues.get(socket) ?? Promise.resolve();
  const current = previous.then(async () => { await operation(); }).catch((error: unknown) => {
    const message = error instanceof HttpError ? error.message : error instanceof z.ZodError ? "Invalid event payload" : "Operation failed";
    if (!(error instanceof HttpError) && !(error instanceof z.ZodError)) console.error("Socket operation failed", error instanceof Error ? error.message : "Unknown error");
    socket.emit("ERROR", { message });
  });
  socketOperationQueues.set(socket, current);
  await current;
  if (socketOperationQueues.get(socket) === current) socketOperationQueues.delete(socket);
}
