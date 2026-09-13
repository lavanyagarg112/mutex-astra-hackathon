import type { ActivityEvent, Message, Prisma, Project, Task, User } from "@prisma/client";
import { redactSensitive } from "@relaycode/shared";

export function serializeProject(project: Project) {
  const { agentCredential: _credential, toolPermissions, ...safe } = project;
  return {
    ...safe,
    toolPermissions: redactSensitive(toolPermissions),
    agentCredentialConfigured: Boolean(project.agentCredential),
    createdAt: project.createdAt.toISOString(),
  };
}

export function serializeUser(user: User) {
  return { id: user.id, name: user.name, username: user.username, avatarUrl: user.avatarUrl };
}

export function serializeMessage(message: Message & { author?: User }) {
  return {
    id: message.id,
    projectId: message.projectId,
    authorId: message.authorId,
    body: message.body,
    replyToMessageId: message.replyToMessageId,
    createdAt: message.createdAt.toISOString(),
    ...(message.author ? { author: serializeUser(message.author) } : {}),
  };
}

type TaskWithRelations = Task & {
  rootMessage?: Message & { author?: User };
  requestedBy?: User;
  executor?: User | null;
  taskMessages?: Array<{ role: "INITIAL" | "IN_FLIGHT_REFINEMENT"; message: Message & { author?: User } }>;
  parentTask?: (Task & { rootMessage: Message }) | null;
};

export function serializeTask(task: TaskWithRelations) {
  return {
    id: task.id,
    number: task.number,
    projectId: task.projectId,
    rootMessageId: task.rootMessageId,
    parentTaskId: task.parentTaskId,
    type: task.type,
    status: task.status,
    queuePriority: task.queuePriority,
    queueSequence: task.queueSequence,
    requestedByUserId: task.requestedByUserId,
    executorUserId: task.executorUserId,
    baseCommitSha: task.baseCommitSha,
    commitSha: task.commitSha,
    amendable: task.amendable,
    shortStatus: task.shortStatus,
    diff: task.diff,
    failureReason: task.failureReason,
    createdAt: task.createdAt.toISOString(),
    startedAt: task.startedAt?.toISOString() ?? null,
    completedAt: task.completedAt?.toISOString() ?? null,
    ...(task.rootMessage ? { rootMessage: serializeMessage(task.rootMessage) } : {}),
    ...(task.requestedBy ? { requestedBy: serializeUser(task.requestedBy) } : {}),
    ...(task.executor !== undefined ? { executor: task.executor ? serializeUser(task.executor) : null } : {}),
    ...(task.taskMessages ? { messages: task.taskMessages.filter((link) => link.role === "IN_FLIGHT_REFINEMENT").map((link) => serializeMessage(link.message)) } : {}),
    ...(task.parentTask !== undefined
      ? { parentTask: task.parentTask ? { number: task.parentTask.number, rootMessage: { body: task.parentTask.rootMessage.body } } : null }
      : {}),
  };
}

export function serializeActivity(activity: ActivityEvent & { user?: User | null }) {
  return {
    id: activity.id,
    projectId: activity.projectId,
    taskId: activity.taskId,
    userId: activity.userId,
    category: activity.category,
    message: String(redactSensitive(activity.message)),
    metadata: redactSensitive(activity.metadata),
    createdAt: activity.createdAt.toISOString(),
    ...(activity.user !== undefined ? { user: activity.user ? serializeUser(activity.user) : null } : {}),
  };
}

export const fullTaskInclude = {
  rootMessage: { include: { author: true } },
  requestedBy: true,
  executor: true,
  taskMessages: { orderBy: { message: { createdAt: "asc" } }, include: { message: { include: { author: true } } } },
  parentTask: { include: { rootMessage: true } },
} satisfies Prisma.TaskInclude;
