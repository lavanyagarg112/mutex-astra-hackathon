import { Router } from "express";
import { activeStatuses, CreateProjectSchema, CreateRefinementSchema, CreateRequestSchema, ProjectSettingsSchema, RollbackTaskSchema, TaskControlSchema } from "@relaycode/shared";
import { randomUUID } from "node:crypto";
import type { PrismaClient, TaskStatus } from "@prisma/client";
import { z } from "zod";
import { demoAuth, HttpError, type AuthenticatedRequest, requireMember, routeError } from "./auth.js";
import type { RelayServer } from "./realtime.js";
import { queueDisplayOrder } from "./queue.js";
import { RuntimeState } from "./runtime.js";
import { Scheduler } from "./scheduler.js";
import { fullTaskInclude, serializeActivity, serializeProject, serializeTask, serializeUser } from "./serialize.js";

const ExtendedProjectSettingsSchema = ProjectSettingsSchema;
const ProcessControlSchema = z.object({ name: z.enum(["install", "frontend", "backend", "test"]), cwd: z.string().optional() });

export function createApiRouter(prisma: PrismaClient, io: RelayServer, scheduler: Scheduler, runtime: RuntimeState) {
  const router = Router();
  router.use(demoAuth);

  router.get("/bootstrap", async (req: AuthenticatedRequest, res) => {
    try {
      const user = await prisma.user.findUnique({ where: { id: req.userId! } });
      if (!user) return res.status(401).json({ error: "Unknown user" });
      const memberships = await prisma.projectMember.findMany({ where: { userId: user.id }, include: { project: true }, orderBy: { createdAt: "asc" } });
      return res.json({
        user: serializeUser(user),
        projects: memberships.map(({ project, role, repositoryWrite }) => ({ ...serializeProject(project), membership: { role, repositoryWrite } })),
      });
    } catch (error) { return routeError(res, error); }
  });

  router.get("/users/me/settings", async (req: AuthenticatedRequest, res) => {
    try {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
      const memberships = await prisma.projectMember.findMany({ where: { userId: user.id }, include: { project: true }, orderBy: { createdAt: "asc" } });
      return res.json({
        user: serializeUser(user),
        github: { username: user.username, connected: true },
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
      const [tasks, members, activities, rollbackActions] = await Promise.all([
        prisma.task.findMany({ where: { projectId: project.id }, include: fullTaskInclude }),
        prisma.projectMember.findMany({ where: { projectId: project.id }, include: { user: true }, orderBy: { createdAt: "asc" } }),
        prisma.activityEvent.findMany({ where: { projectId: project.id }, include: { user: true }, orderBy: { createdAt: "desc" }, take: 300 }),
        prisma.rollbackAction.findMany({ where: { projectId: project.id }, include: { initiatedBy: true }, orderBy: { createdAt: "desc" }, take: 30 }),
      ]);
      const ordered = [...tasks].sort(queueDisplayOrder);
      return res.json({
        project: serializeProject(project),
        tasks: ordered.map(serializeTask),
        activeTask: ordered.find((task) => (activeStatuses as TaskStatus[]).includes(task.status)) ? serializeTask(ordered.find((task) => (activeStatuses as TaskStatus[]).includes(task.status))!) : null,
        queue: ordered.filter((task) => ["QUEUED", "WAITING_FOR_REQUESTER"].includes(task.status)).map(serializeTask),
        members: members.map(({ user, role, repositoryWrite }) => ({ ...serializeUser(user), role, repositoryWrite, daemon: scheduler.connections.statusFor(user.id, project.id) })),
        activities: activities.reverse().map(serializeActivity),
        processes: runtime.projectProcesses(project.id),
        rollbackActions: rollbackActions.map((action) => ({ ...action, createdAt: action.createdAt.toISOString(), completedAt: action.completedAt?.toISOString() ?? null, initiatedBy: serializeUser(action.initiatedBy) })),
      });
    } catch (error) { return routeError(res, error); }
  });

  router.post("/projects", async (req: AuthenticatedRequest, res) => {
    try {
      const payload = CreateProjectSchema.parse(req.body);
      const repository = parseRepository(payload.repositoryUrl);
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
        testCommand: payload.testCommand,
        members: { create: { userId: req.userId!, role: "OWNER", repositoryWrite: true } },
      } });
      await recordProjectCreated(prisma, project.id, req.userId!);
      return res.status(201).json({ project: serializeProject(project) });
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

  router.post("/projects/:projectId/processes/start", async (req: AuthenticatedRequest, res) => {
    try {
      const projectId = pathParam(req, "projectId");
      const userId = req.userId!;
      await requireMember(prisma, projectId, userId);
      const payload = ProcessControlSchema.parse(req.body);
      const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
      const commands = { install: project.installCommand, frontend: project.frontendCommand, backend: project.backendCommand, test: project.testCommand };
      const command = commands[payload.name];
      if (!command) return res.status(409).json({ error: `${payload.name} command is not configured` });
      if (!scheduler.connections.emitToMapped(userId, projectId, "START_LOCAL_PROCESS", { projectId, name: payload.name, command, cwd: payload.cwd })) return res.status(409).json({ error: "Local companion is offline or project is not mapped" });
      return res.status(202).json({ started: true });
    } catch (error) { return routeError(res, error); }
  });
  router.post("/projects/:projectId/processes/stop", async (req: AuthenticatedRequest, res) => {
    try {
      const projectId = pathParam(req, "projectId");
      const userId = req.userId!;
      await requireMember(prisma, projectId, userId);
      const payload = ProcessControlSchema.pick({ name: true }).parse(req.body);
      if (!scheduler.connections.emitToMapped(userId, projectId, "STOP_LOCAL_PROCESS", { projectId, name: payload.name })) return res.status(409).json({ error: "Local companion is offline or project is not mapped" });
      return res.status(202).json({ stopped: true });
    } catch (error) { return routeError(res, error); }
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
