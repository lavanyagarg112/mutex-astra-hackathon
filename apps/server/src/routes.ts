import { Router } from "express";
import { activeStatuses, CreateProjectSchema, CreateRefinementSchema, CreateRequestSchema, CreateTeamMessageSchema, InitializeRepositorySchema, ProjectSettingsSchema, RollbackTaskSchema, TaskControlSchema, type GitHistoryResponse, type ListDirectoryResponse, type ReadFileResponse } from "@relaycode/shared";
import { randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient, TaskStatus } from "@prisma/client";
import { z } from "zod";
import { recordActivity } from "./activity.js";
import { createAuthMiddleware, hashToken, HttpError, safeEqual, type AuthenticatedRequest, requireMember, routeError } from "./auth.js";
import { githubTokenFor } from "./auth-routes.js";
import { getGitHubRepository, inferGitHubRepositoryCommands, listGitHubRepositories } from "./github.js";
import type { RelayServer } from "./realtime.js";
import type { BrowserPresence } from "./presence.js";
import { queueDisplayOrder } from "./queue.js";
import { RuntimeState } from "./runtime.js";
import { Scheduler } from "./scheduler.js";
import { fullTaskInclude, serializeActivity, serializeMessage, serializeProject, serializeTask, serializeUser } from "./serialize.js";
import { createTeamMessage } from "./team-chat.js";

const ExtendedProjectSettingsSchema = ProjectSettingsSchema;
const ProcessControlSchema = z.object({ name: z.enum(["install", "frontend", "backend", "test", "preview"]), cwd: z.string().optional() });

export function createApiRouter(prisma: PrismaClient, io: RelayServer, scheduler: Scheduler, runtime: RuntimeState, presence: BrowserPresence) {
  const router = Router();

  router.post("/companion/pair/claim", async (req, res) => {
    try {
      const code = z.string().trim().min(6).max(32).parse(req.body?.code).toUpperCase();
      const pairing = await prisma.companionPairing.findUnique({ where: { codeHash: hashToken(code) } });
      if (!pairing || pairing.claimedAt || pairing.expiresAt <= new Date()) throw new HttpError(400, "This companion pairing code is invalid or expired.");
      const daemonToken = randomBytes(32).toString("base64url");
      const pairedUser = await prisma.user.findUniqueOrThrow({ where: { id: pairing.userId }, select: { githubToken: true } });
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.companionPairing.updateMany({ where: { id: pairing.id, claimedAt: null, expiresAt: { gt: new Date() } }, data: { claimedAt: new Date() } });
        if (claimed.count !== 1) throw new HttpError(409, "This companion pairing code has already been used.");
        await tx.user.update({ where: { id: pairing.userId }, data: { daemonTokenHash: hashToken(daemonToken) } });
      });
      return res.json({
        userId: pairing.userId,
        daemonToken,
        serverUrl: process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 4100}`,
        ...(pairedUser.githubToken ? { githubToken: githubTokenFor(pairedUser) } : {}),
      });
    } catch (error) { return routeError(res, error); }
  });

  // The desktop companion cannot carry a browser session cookie. Its opaque
  // daemon token is issued only once during pairing and remains on the user's
  // computer, so it can safely discover projects after a restart.
  router.get("/companion/projects", async (req, res) => {
    try {
      const userId = typeof req.headers["x-relaycode-user-id"] === "string" ? req.headers["x-relaycode-user-id"] : undefined;
      const token = typeof req.headers["x-relaycode-daemon-token"] === "string" ? req.headers["x-relaycode-daemon-token"] : undefined;
      if (!userId || !token) throw new HttpError(401, "Pair this companion from Relaycode before loading projects.");
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { daemonTokenHash: true } });
      if (!user?.daemonTokenHash || !safeEqual(user.daemonTokenHash, hashToken(token))) throw new HttpError(401, "This companion is no longer paired. Pair it again from Relaycode.");
      const memberships = await prisma.projectMember.findMany({
        where: { userId }, include: { project: true }, orderBy: { createdAt: "asc" },
      });
      return res.json({ projects: memberships.map(({ project }) => serializeProject(project)) });
    } catch (error) { return routeError(res, error); }
  });

  router.use(createAuthMiddleware(prisma));

  router.post("/companion/pair/start", async (req: AuthenticatedRequest, res) => {
    try {
      await prisma.companionPairing.deleteMany({ where: { OR: [{ userId: req.userId! }, { expiresAt: { lte: new Date() } }] } });
      const code = randomBytes(16).toString("hex").toUpperCase();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      await prisma.companionPairing.create({ data: { codeHash: hashToken(code), userId: req.userId!, expiresAt } });
      return res.status(201).json({ code, expiresAt: expiresAt.toISOString() });
    } catch (error) { return routeError(res, error); }
  });

  router.get("/github/repositories", async (req: AuthenticatedRequest, res) => {
    try {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! }, select: { githubToken: true } });
      return res.json({ repositories: await listGitHubRepositories(githubTokenFor(user)) });
    } catch (error) { return routeError(res, error); }
  });

  router.get("/bootstrap", async (req: AuthenticatedRequest, res) => {
    try {
      const user = await prisma.user.findUnique({ where: { id: req.userId! } });
      if (!user) return res.status(401).json({ error: "Unknown user" });
      const memberships = await prisma.projectMember.findMany({ where: { userId: user.id }, include: { project: true }, orderBy: { createdAt: "asc" } });
      const projects = await Promise.all(memberships.map(async ({ project, role, repositoryWrite }) => {
        const [memberCount, lastMessage] = await Promise.all([
          prisma.projectMember.count({ where: { projectId: project.id } }),
          prisma.message.findFirst({ where: { projectId: project.id }, orderBy: { createdAt: "desc" }, include: { author: true } }),
        ]);
        return {
          ...serializeProject(project),
          membership: { role, repositoryWrite },
          memberCount,
          lastMessage: lastMessage ? { body: lastMessage.body, createdAt: lastMessage.createdAt.toISOString(), authorName: lastMessage.author.name } : null,
        };
      }));
      return res.json({ user: serializeUser(user), projects });
    } catch (error) { return routeError(res, error); }
  });

  router.get("/users/me/settings", async (req: AuthenticatedRequest, res) => {
    try {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
      const memberships = await prisma.projectMember.findMany({ where: { userId: user.id }, include: { project: true }, orderBy: { createdAt: "asc" } });
      return res.json({
        user: serializeUser(user),
        github: { username: user.githubLogin ?? user.username, connected: Boolean(user.githubId && user.githubToken) },
        localCompanion: { online: scheduler.connections.isOnline(user.id), gitCredentialConfigured: scheduler.connections.isOnline(user.id) },
        mappings: memberships.map(({ project }) => ({ projectId: project.id, projectName: project.name, ...scheduler.connections.statusFor(user.id, project.id) })),
      });
    } catch (error) { return routeError(res, error); }
  });

  router.get("/projects/:projectId", async (req: AuthenticatedRequest, res) => {
    try {
      const projectId = pathParam(req, "projectId");
      await requireMember(prisma, projectId, req.userId!);
      const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
      const [tasks, messages, members, activities, rollbackActions] = await Promise.all([
        prisma.task.findMany({ where: { projectId: project.id }, include: fullTaskInclude }),
        prisma.message.findMany({
          where: { projectId: project.id, rootTask: { is: null }, taskLinks: { none: {} } },
          include: { author: true },
          orderBy: { createdAt: "asc" },
          take: 500,
        }),
        prisma.projectMember.findMany({ where: { projectId: project.id }, include: { user: true }, orderBy: { createdAt: "asc" } }),
        prisma.activityEvent.findMany({ where: { projectId: project.id }, include: { user: true }, orderBy: { createdAt: "desc" }, take: 300 }),
        prisma.rollbackAction.findMany({ where: { projectId: project.id }, include: { initiatedBy: true }, orderBy: { createdAt: "desc" }, take: 30 }),
      ]);
      const ordered = [...tasks].sort(queueDisplayOrder);
      return res.json({
        project: serializeProject(project),
        tasks: ordered.map(serializeTask),
        messages: messages.map(serializeMessage),
        activeTask: ordered.find((task) => (activeStatuses as TaskStatus[]).includes(task.status)) ? serializeTask(ordered.find((task) => (activeStatuses as TaskStatus[]).includes(task.status))!) : null,
        queue: ordered.filter((task) => ["QUEUED", "WAITING_FOR_REQUESTER"].includes(task.status)).map(serializeTask),
        members: members.map(({ user, role, repositoryWrite }) => ({ ...serializeUser(user), role, repositoryWrite, present: presence.isOnline(project.id, user.id), daemon: scheduler.connections.statusFor(user.id, project.id) })),
        activities: activities.reverse().map(serializeActivity),
        // localhost belongs to the signed-in user's machine, so never return a
        // different member's preview process to this browser.
        processes: runtime.projectProcesses(project.id).filter((process) => process.userId === req.userId!),
        rollbackActions: rollbackActions.map((action) => ({ ...action, createdAt: action.createdAt.toISOString(), completedAt: action.completedAt?.toISOString() ?? null, initiatedBy: serializeUser(action.initiatedBy) })),
      });
    } catch (error) { return routeError(res, error); }
  });

  router.post("/projects", async (req: AuthenticatedRequest, res) => {
    try {
      const payload = CreateProjectSchema.parse(req.body);
      const repository = parseRepository(payload.repositoryUrl);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! }, select: { githubToken: true } });
      let inferredCommands: Awaited<ReturnType<typeof inferGitHubRepositoryCommands>> | null = null;
      if (user.githubToken) {
        const githubToken = githubTokenFor(user);
        const githubRepository = await getGitHubRepository(githubToken, repository.owner, repository.name);
        if (!githubRepository.canWrite) throw new HttpError(403, `Your GitHub account does not have write access to ${githubRepository.fullName}.`);
        try {
          inferredCommands = await inferGitHubRepositoryCommands(githubToken, repository.owner, repository.name, payload.branch);
        } catch {
          // Command detection is a convenience and must not prevent creating an
          // otherwise valid project (for example, an empty repository).
        }
      } else if (req.authMethod === "session") {
        throw new HttpError(409, "Reconnect GitHub before creating a project.");
      }
      const slugBase = payload.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
      const id = `project-${randomUUID()}`;
      const project = await prisma.project.create({ data: {
        id,
        name: payload.name,
        slug: `${slugBase}-${id.slice(-8)}`,
        repositoryOwner: repository.owner,
        repositoryName: repository.name,
        repositoryUrl: payload.repositoryUrl,
        branch: payload.branch,
        installCommand: inferredCommands?.installCommand,
        frontendCommand: inferredCommands?.frontendCommand,
        backendCommand: inferredCommands?.backendCommand,
        testCommand: payload.testCommand ?? inferredCommands?.testCommand,
        members: { create: { userId: req.userId!, role: "OWNER", repositoryWrite: true } },
      } });
      await recordProjectCreated(prisma, project.id, req.userId!);
      return res.status(201).json({ project: serializeProject(project) });
    } catch (error) { return routeError(res, error); }
  });

  router.post("/projects/:projectId/join", async (req: AuthenticatedRequest, res) => {
    try {
      const projectId = pathParam(req, "projectId");
      const project = await prisma.project.findUnique({ where: { id: projectId } });
      if (!project) throw new HttpError(404, "Project not found. Check the invite link and try again.");
      const existing = await prisma.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: req.userId! } } });
      if (existing) return res.json({ project: serializeProject(project), membership: { role: existing.role, repositoryWrite: existing.repositoryWrite } });
      const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! }, select: { githubToken: true } });
      if (!user.githubToken) throw new HttpError(403, `Connect GitHub to prove that you have access to ${project.repositoryOwner}/${project.repositoryName}.`);
      const repository = await getGitHubRepository(githubTokenFor(user), project.repositoryOwner, project.repositoryName);
      if (!repository.canRead) throw new HttpError(403, `You cannot join this project because your GitHub account does not have read access to ${repository.fullName}. Ask a repository administrator to grant access, then try again.`);
      // Read access is enough to collaborate and view a project. Mutating queue
      // actions remain protected by requireMember(..., { write: true }).
      const membership = await prisma.projectMember.create({
        data: { projectId, userId: req.userId!, role: "MEMBER", repositoryWrite: repository.canWrite },
      });
      io.to(`project:${project.id}:web`).emit("MEMBER_STATUS_CHANGED", { projectId: project.id, userId: req.userId!, online: scheduler.connections.isOnline(req.userId!) });
      return res.status(201).json({ project: serializeProject(project), membership: { role: membership.role, repositoryWrite: membership.repositoryWrite } });
    } catch (error) { return routeError(res, error); }
  });

  router.get("/projects/:projectId/activity", async (req: AuthenticatedRequest, res) => {
    try {
      const projectId = pathParam(req, "projectId");
      await requireMember(prisma, projectId, req.userId!);
      const before = typeof req.query.before === "string" ? new Date(req.query.before) : undefined;
      const activities = await prisma.activityEvent.findMany({ where: { projectId, ...(before && !Number.isNaN(before.valueOf()) ? { createdAt: { lt: before } } : {}) }, include: { user: true }, orderBy: { createdAt: "desc" }, take: 300 });
      return res.json({ activities: activities.reverse().map(serializeActivity) });
    } catch (error) { return routeError(res, error); }
  });

  router.post("/requests", async (req: AuthenticatedRequest, res) => {
    try { return res.status(201).json(await scheduler.createRequest(req.userId!, ...requestArgs(CreateRequestSchema.parse(req.body)))); }
    catch (error) { return routeError(res, error); }
  });
  router.post("/projects/:projectId/messages", async (req: AuthenticatedRequest, res) => {
    try {
      const payload = CreateTeamMessageSchema.parse({ ...req.body, projectId: pathParam(req, "projectId") });
      const message = await createTeamMessage(prisma, payload, req.userId!);
      io.to(`project:${payload.projectId}:web`).emit("MESSAGE_CREATED", { projectId: payload.projectId, messageId: message.id });
      await recordActivity(prisma, io, { projectId: payload.projectId, userId: req.userId!, category: "CHAT", message: "sent a team message" });
      return res.status(201).json(serializeMessage(message));
    } catch (error) { return routeError(res, error); }
  });
  router.post("/projects/:projectId/initialize", async (req: AuthenticatedRequest, res) => {
    try {
      const payload = InitializeRepositorySchema.parse({ ...req.body, projectId: pathParam(req, "projectId") });
      return res.status(201).json(await scheduler.createInitialization(req.userId!, payload));
    } catch (error) { return routeError(res, error); }
  });
  router.post("/refinements", async (req: AuthenticatedRequest, res) => {
    try {
      const payload = CreateRefinementSchema.parse(req.body);
      return res.status(201).json(await scheduler.createRefinement(req.userId!, payload.projectId, payload.parentTaskId, payload.body));
    } catch (error) { return routeError(res, error); }
  });
  router.post("/tasks/:taskId/pause", async (req: AuthenticatedRequest, res) => control(req, res, "pause"));
  router.post("/tasks/:taskId/resume", async (req: AuthenticatedRequest, res) => control(req, res, "resume"));
  router.post("/tasks/:taskId/cancel", async (req: AuthenticatedRequest, res) => control(req, res, "cancel"));

  router.get("/projects/:projectId/tasks/:taskId/rollback-impact", async (req: AuthenticatedRequest, res) => {
    try { return res.json(await scheduler.rollbackImpact(req.userId!, pathParam(req, "projectId"), pathParam(req, "taskId"))); }
    catch (error) { return routeError(res, error); }
  });
  router.post("/tasks/:taskId/rollback", async (req: AuthenticatedRequest, res) => {
    try {
      const payload = RollbackTaskSchema.parse({ ...req.body, taskId: pathParam(req, "taskId") });
      return res.status(202).json(await scheduler.beginRollback(req.userId!, payload.projectId, payload.taskId));
    } catch (error) { return routeError(res, error); }
  });

  router.patch("/projects/:projectId/settings", async (req: AuthenticatedRequest, res) => {
    try {
      const payload = ExtendedProjectSettingsSchema.parse({ ...req.body, projectId: pathParam(req, "projectId") });
      await requireMember(prisma, payload.projectId, req.userId!, { owner: true });
      const project = await prisma.project.update({ where: { id: payload.projectId }, data: {
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
      io.to(`project:${project.id}:web`).emit("QUEUE_UPDATED", { projectId: project.id });
      return res.json({ project: serializeProject(project) });
    } catch (error) { return routeError(res, error); }
  });

  router.post("/projects/:projectId/infer-commands", async (req: AuthenticatedRequest, res) => {
    try {
      const projectId = pathParam(req, "projectId");
      await requireMember(prisma, projectId, req.userId!, { owner: true });
      const requestedBranch = z.object({ branch: z.string().trim().min(1).max(200).optional() }).parse(req.body ?? {}).branch;
      const [project, user] = await Promise.all([
        prisma.project.findUniqueOrThrow({ where: { id: projectId } }),
        prisma.user.findUniqueOrThrow({ where: { id: req.userId! }, select: { githubToken: true } }),
      ]);
      const commands = await inferGitHubRepositoryCommands(
        githubTokenFor(user),
        project.repositoryOwner,
        project.repositoryName,
        requestedBranch ?? project.branch,
        project.agentCredential
          ? { credential: project.agentCredential, model: project.coordinatorModel }
          : undefined,
      );
      return res.json({ commands });
    } catch (error) { return routeError(res, error); }
  });

  router.post("/projects/:projectId/processes/start", async (req: AuthenticatedRequest, res) => {
    try {
      const projectId = pathParam(req, "projectId");
      const userId = req.userId!;
      await requireMember(prisma, projectId, userId);
      const payload = ProcessControlSchema.parse(req.body);
      const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
      const commands = { install: project.installCommand, frontend: project.frontendCommand, backend: project.backendCommand, test: project.testCommand };
      if (payload.name === "preview") {
        if (!commands.frontend && !commands.backend) return res.status(409).json({ error: "No frontend or backend preview command is configured" });
        const delivered = scheduler.connections.emitToMapped(userId, projectId, "START_LOCAL_PREVIEW", {
          projectId,
          ...(commands.install ? { installCommand: commands.install } : {}),
          ...(commands.frontend ? { frontendCommand: commands.frontend } : {}),
          ...(commands.backend ? { backendCommand: commands.backend } : {}),
        });
        if (!delivered) return res.status(409).json({ error: "Local companion is offline or project is not mapped" });
        return res.status(202).json({ started: ["install", "backend", "frontend"].filter((name) => Boolean(commands[name as keyof typeof commands])) });
      }
      const command = commands[payload.name];
      if (!command) return res.status(409).json({ error: `${payload.name} command is not configured` });
      if (!scheduler.connections.emitToMapped(userId, projectId, "START_LOCAL_PROCESS", { projectId, name: payload.name, command, cwd: payload.cwd })) {
        return res.status(409).json({ error: "Local companion is offline or project is not mapped" });
      }
      return res.status(202).json({ started: [payload.name] });
    } catch (error) { return routeError(res, error); }
  });
  router.post("/projects/:projectId/processes/stop", async (req: AuthenticatedRequest, res) => {
    try {
      const projectId = pathParam(req, "projectId");
      const userId = req.userId!;
      await requireMember(prisma, projectId, userId);
      const payload = ProcessControlSchema.pick({ name: true }).parse(req.body);
      if (payload.name === "preview") {
        if (!scheduler.connections.emitToMapped(userId, projectId, "STOP_LOCAL_PREVIEW", { projectId })) {
          return res.status(409).json({ error: "Local companion is offline or project is not mapped" });
        }
        return res.status(202).json({ stopped: ["install", "frontend", "backend"] });
      }
      if (!scheduler.connections.emitToMapped(userId, projectId, "STOP_LOCAL_PROCESS", { projectId, name: payload.name })) {
        return res.status(409).json({ error: "Local companion is offline or project is not mapped" });
      }
      return res.status(202).json({ stopped: [payload.name] });
    } catch (error) { return routeError(res, error); }
  });

  router.get("/projects/:projectId/files", async (req: AuthenticatedRequest, res) => {
    try {
      const projectId = pathParam(req, "projectId");
      const userId = req.userId!;
      await requireMember(prisma, projectId, userId);
      const path = typeof req.query.path === "string" ? req.query.path : "";
      const result = await scheduler.connections.requestFromMapped<ListDirectoryResponse>(userId, projectId, "LIST_DIRECTORY", { projectId, path });
      return res.json(result);
    } catch (error) {
      if (error instanceof Error && !(error instanceof HttpError) && !(error instanceof z.ZodError)) return res.status(503).json({ ok: false, error: error.message });
      return routeError(res, error);
    }
  });

  router.get("/projects/:projectId/files/content", async (req: AuthenticatedRequest, res) => {
    try {
      const projectId = pathParam(req, "projectId");
      const userId = req.userId!;
      await requireMember(prisma, projectId, userId);
      const path = typeof req.query.path === "string" ? req.query.path : "";
      if (!path) throw new HttpError(400, "A file path is required");
      const result = await scheduler.connections.requestFromMapped<ReadFileResponse>(userId, projectId, "READ_FILE", { projectId, path });
      return res.json(result);
    } catch (error) {
      if (error instanceof Error && !(error instanceof HttpError) && !(error instanceof z.ZodError)) return res.status(503).json({ ok: false, error: error.message });
      return routeError(res, error);
    }
  });

  router.get("/projects/:projectId/git/history", async (req: AuthenticatedRequest, res) => {
    try {
      const projectId = pathParam(req, "projectId");
      const userId = req.userId!;
      await requireMember(prisma, projectId, userId);
      const result = await scheduler.connections.requestFromMapped<GitHistoryResponse>(userId, projectId, "GIT_HISTORY", { projectId });
      return res.json(result);
    } catch (error) {
      if (error instanceof Error && !(error instanceof HttpError) && !(error instanceof z.ZodError)) return res.status(503).json({ ok: false, error: error.message });
      return routeError(res, error);
    }
  });

  async function control(req: AuthenticatedRequest, res: Parameters<typeof routeError>[0], method: "pause" | "resume" | "cancel") {
    try {
      const payload = TaskControlSchema.parse({ ...req.body, taskId: pathParam(req, "taskId") });
      await scheduler[method](req.userId!, payload.projectId, payload.taskId);
      return res.status(202).json({ ok: true });
    } catch (error) { return routeError(res, error); }
  }

  return router;
}

function requestArgs(payload: z.infer<typeof CreateRequestSchema>): [string, string] {
  return [payload.projectId, payload.body];
}

function pathParam(req: AuthenticatedRequest, name: string) {
  const value = req.params[name];
  if (typeof value !== "string") throw new Error(`Missing path parameter ${name}`);
  return value;
}

function parseRepository(value: string) {
  const normalized = value.replace(/\.git$/, "");
  const match = normalized.match(/(?:github\.com[/:])([^/]+)\/([^/]+)$/i);
  if (!match) throw new HttpError(400, "Enter a GitHub repository URL such as https://github.com/owner/repository.git");
  return { owner: match[1]!, name: match[2]! };
}

async function recordProjectCreated(prisma: PrismaClient, projectId: string, userId: string) {
  await prisma.activityEvent.create({ data: { projectId, userId, category: "PROJECT", message: "project created", metadata: {} } });
}
