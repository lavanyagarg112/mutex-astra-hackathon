import { z } from "zod";

export const taskStatuses = [
  "QUEUED", "WAITING_FOR_REQUESTER", "SYNCING", "PLANNING", "EDITING",
  "VALIDATING", "PUSHING", "SYNCING_TEAM", "COMMITTED", "PAUSED", "FAILED",
  "CANCELLED", "REMOTE_DIVERGED", "ROLLED_BACK", "DISCARDED_BY_ROLLBACK"
] as const;
export const TaskStatusSchema = z.enum(taskStatuses);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskTypeSchema = z.enum(["NORMAL", "REFINEMENT"]);
export type TaskType = z.infer<typeof TaskTypeSchema>;
export const TaskExecutionModeSchema = z.enum(["NORMAL", "INITIALIZATION"]);
export type TaskExecutionMode = z.infer<typeof TaskExecutionModeSchema>;
export const RepositoryInitializationSchema = z.object({
  frontend: z.enum(["REACT", "NEXT_JS", "VUE", "SVELTE", "NONE"]),
  backend: z.enum(["EXPRESS", "FASTIFY", "NEST_JS", "FASTAPI", "DJANGO", "NONE"]),
  database: z.enum(["POSTGRESQL", "MYSQL", "SQLITE", "MONGODB", "NONE"]),
});
export type RepositoryInitialization = z.infer<typeof RepositoryInitializationSchema>;
export const TaskPhaseSchema = z.enum(["SYNCING", "PLANNING", "EDITING", "VALIDATING", "PUSHING", "PAUSED"]);

// Ids only — the actual pixel-grid art for each skin lives client-side
// (apps/web/src/pixelCharacters.ts) since the server only ever needs to
// validate and store which skin a user picked.
export const PIXEL_SKIN_IDS = [
  "bear", "pig", "penguin", "bunny",
  "ox", "fox", "frog", "dog",
  "ghost", "raccoon", "cat", "monkey",
] as const;
export const PixelSkinIdSchema = z.enum(PIXEL_SKIN_IDS);
export type PixelSkinId = z.infer<typeof PixelSkinIdSchema>;

export const UserSchema = z.object({
  id: z.string(), name: z.string(), username: z.string(), avatarUrl: z.string().nullable().optional(),
  pixelCharacter: PixelSkinIdSchema.nullable().optional(),
});
export type User = z.infer<typeof UserSchema>;

export const UpdateUserAppearanceSchema = z.object({ pixelCharacter: PixelSkinIdSchema });
export const MemberInteractionSchema = z.object({
  projectId: z.string(), targetUserId: z.string(), kind: z.enum(["punch", "love", "excited"]),
});

export const MessageSchema = z.object({
  id: z.string(), projectId: z.string(), authorId: z.string(), body: z.string().min(1).max(10_000),
  replyToMessageId: z.string().nullable(), createdAt: z.string(), author: UserSchema.optional(),
});
export type Message = z.infer<typeof MessageSchema>;

export const DiffFileSchema = z.object({ path: z.string(), additions: z.number(), deletions: z.number() });
export const StoredDiffSchema = z.object({
  baseSha: z.string(), commitSha: z.string(), files: z.array(DiffFileSchema), unified: z.string().max(2_000_000),
});
export type StoredDiff = z.infer<typeof StoredDiffSchema>;

export const TaskSchema = z.object({
  id: z.string(), number: z.number(), projectId: z.string(), rootMessageId: z.string(), parentTaskId: z.string().nullable(),
  type: TaskTypeSchema, status: TaskStatusSchema, queuePriority: z.number(), queueSequence: z.number(),
  executionMode: TaskExecutionModeSchema.default("NORMAL"), initializationConfig: RepositoryInitializationSchema.nullable().optional(),
  requestedByUserId: z.string(), executorUserId: z.string().nullable(), baseCommitSha: z.string().nullable(),
  commitSha: z.string().nullable(), amendable: z.boolean(), shortStatus: z.string().nullable(), diff: StoredDiffSchema.nullable().optional(),
  failureReason: z.string().nullable().optional(),
  createdAt: z.string(), startedAt: z.string().nullable(), completedAt: z.string().nullable(),
  rootMessage: MessageSchema.optional(), requestedBy: UserSchema.optional(), executor: UserSchema.nullable().optional(),
  messages: z.array(MessageSchema).optional(), parentTask: z.object({ number: z.number(), rootMessage: z.object({ body: z.string() }) }).nullable().optional(),
});
export type Task = z.infer<typeof TaskSchema>;

export const ProjectSchema = z.object({
  id: z.string(), name: z.string(), slug: z.string(), repositoryOwner: z.string(), repositoryName: z.string(),
  repositoryUrl: z.string(), branch: z.string(), coordinatorModel: z.string(), developerModel: z.string(),
  installCommand: z.string().nullable(), frontendCommand: z.string().nullable(), backendCommand: z.string().nullable(), testCommand: z.string().nullable(),
  toolPermissions: z.object({ fileRead: z.boolean(), fileWrite: z.boolean(), shell: z.boolean(), git: z.boolean(), tests: z.boolean(), network: z.boolean() }).optional(),
  agentCredentialConfigured: z.boolean().optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ActivitySchema = z.object({
  id: z.string(), projectId: z.string(), taskId: z.string().nullable(), userId: z.string().nullable(),
  category: z.string(), message: z.string(), createdAt: z.string(), user: UserSchema.nullable().optional(),
});
export type Activity = z.infer<typeof ActivitySchema>;

export const CreateRequestSchema = z.object({ projectId: z.string(), body: z.string().trim().min(2).max(10_000) });
/**
 * A human-only project conversation message. These messages are deliberately
 * separate from requests/refinements and never participate in a Task.
 */
export const CreateTeamMessageSchema = z.object({
  projectId: z.string(),
  body: z.string().trim().min(1).max(10_000),
  replyToMessageId: z.string().nullable().optional(),
});
export const InitializeRepositorySchema = RepositoryInitializationSchema.extend({ projectId: z.string() });
export const CreateProjectSchema = z.object({
  name: z.string().trim().min(2).max(100),
  repositoryUrl: z.string().trim().min(5).max(2_000),
  branch: z.string().trim().min(1).max(200).default("main"),
  testCommand: z.string().trim().min(1).max(1_000).nullable().optional(),
});
export const InferredCommandsSchema = z.object({
  installCommand: z.string().nullable(),
  frontendCommand: z.string().nullable(),
  backendCommand: z.string().nullable(),
  testCommand: z.string().nullable(),
  detectedFrom: z.array(z.string()),
  inferenceMethod: z.enum(["deterministic", "agent"]).default("deterministic"),
  diagnostics: z.array(z.string()).default([]),
});
export type InferredCommands = z.infer<typeof InferredCommandsSchema>;
export const CreateRefinementSchema = z.object({ projectId: z.string(), parentTaskId: z.string(), body: z.string().trim().min(2).max(10_000), explicit: z.boolean().default(true) });
export const TaskControlSchema = z.object({ projectId: z.string(), taskId: z.string() });
export const RollbackTaskSchema = TaskControlSchema.extend({ confirmation: z.literal("ROLLBACK") });
export const ProjectSettingsSchema = z.object({
  projectId: z.string(), branch: z.string().min(1), coordinatorModel: z.string().min(1), developerModel: z.string().min(1),
  installCommand: z.string().nullable(), frontendCommand: z.string().nullable(), backendCommand: z.string().nullable(), testCommand: z.string().nullable(),
  agentCredential: z.string().min(1).max(20_000).optional(), clearAgentCredential: z.boolean().optional(),
  toolPermissions: z.object({ fileRead: z.boolean(), fileWrite: z.boolean(), shell: z.boolean(), git: z.boolean(), tests: z.boolean(), network: z.boolean() }).optional(),
});

export const DaemonConnectedSchema = z.object({
  userId: z.string(), token: z.string().min(1), version: z.string(), mappings: z.array(z.object({ projectId: z.string(), path: z.string(), remoteUrl: z.string().optional() })),
});
export const TaskStatusEventSchema = z.object({
  projectId: z.string(), taskId: z.string(), phase: TaskPhaseSchema, amendable: z.boolean(), shortStatus: z.string().max(300), baseCommitSha: z.string().optional(),
});
export const GitPushResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), projectId: z.string(), taskId: z.string(), baseCommitSha: z.string(), commitSha: z.string(), diff: StoredDiffSchema }),
  z.object({ ok: z.literal(false), projectId: z.string(), taskId: z.string(), code: z.enum(["REMOTE_DIVERGED", "PUSH_FAILED", "NO_CHANGES", "CANCELLED"]), message: z.string() }),
]);
export const GitSyncResultSchema = z.object({ projectId: z.string(), taskId: z.string().optional(), commitSha: z.string(), ok: z.boolean(), message: z.string().optional() });
export const TaskOutputSchema = z.object({ projectId: z.string(), taskId: z.string(), category: z.enum(["AGENT", "TEST", "GIT", "SYSTEM"]), message: z.string().max(2_000) });
export const ActivityInputSchema = z.object({ projectId: z.string(), taskId: z.string().optional(), category: z.string().max(24), message: z.string().max(2_000), metadata: z.record(z.unknown()).optional() });
export const RollbackResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), projectId: z.string(), targetSha: z.string(), previousSha: z.string() }),
  z.object({ ok: z.literal(false), projectId: z.string(), message: z.string() }),
]);

/** agentCredential is delivered only to the assigned daemon and is never part of serialized Project data. */
export type StartTaskPayload = { task: Task; project: Project; request: string; refinements: string[]; agentCredential?: string };
export type AmendTaskPayload = { taskId: string; projectId: string; messageId: string; body: string; authorName: string };
export type SyncProjectPayload = { projectId: string; repositoryUrl: string; branch: string };
export type StartRollbackPayload = { projectId: string; repositoryUrl: string; branch: string; targetSha: string; rollbackTaskId: string; affectedTaskIds: string[] };

export interface ClientToServerEvents {
  DAEMON_CONNECTED: (payload: z.infer<typeof DaemonConnectedSchema>) => void;
  DAEMON_HEARTBEAT: (payload: { userId: string }) => void;
  TASK_STATUS: (payload: z.infer<typeof TaskStatusEventSchema>) => void;
  TASK_AMENDABLE_CHANGED: (payload: { projectId: string; taskId: string; amendable: boolean }) => void;
  TASK_OUTPUT: (payload: z.infer<typeof TaskOutputSchema>) => void;
  GIT_SYNC_RESULT: (payload: z.infer<typeof GitSyncResultSchema>) => void;
  GIT_PUSH_RESULT: (payload: z.infer<typeof GitPushResultSchema>) => void;
  ROLLBACK_RESULT: (payload: z.infer<typeof RollbackResultSchema>) => void;
  PROCESS_STATUS: (payload: { projectId: string; name: string; status: "starting" | "running" | "stopped" | "failed"; port?: number; url?: string }) => void;
  ACTIVITY_EVENT: (payload: z.infer<typeof ActivityInputSchema>) => void;
  CREATE_REQUEST: (payload: z.infer<typeof CreateRequestSchema>) => void;
  CREATE_TEAM_MESSAGE: (payload: z.infer<typeof CreateTeamMessageSchema>) => void;
  INITIALIZE_REPOSITORY: (payload: z.infer<typeof InitializeRepositorySchema>) => void;
  CREATE_REFINEMENT: (payload: z.infer<typeof CreateRefinementSchema>) => void;
  PAUSE_ACTIVE_TASK: (payload: z.infer<typeof TaskControlSchema>) => void;
  RESUME_ACTIVE_TASK: (payload: z.infer<typeof TaskControlSchema>) => void;
  CANCEL_ACTIVE_TASK: (payload: z.infer<typeof TaskControlSchema>) => void;
  ROLLBACK_TASK: (payload: z.infer<typeof RollbackTaskSchema>) => void;
  UPDATE_PROJECT_SETTINGS: (payload: z.infer<typeof ProjectSettingsSchema>) => void;
  UPDATE_USER_APPEARANCE: (payload: z.infer<typeof UpdateUserAppearanceSchema>) => void;
  MEMBER_INTERACTION: (payload: z.infer<typeof MemberInteractionSchema>) => void;
}

export interface ServerToClientEvents {
  SYNC_PROJECT: (payload: SyncProjectPayload) => void;
  START_TASK: (payload: StartTaskPayload) => void;
  AMEND_TASK: (payload: AmendTaskPayload) => void;
  PAUSE_TASK: (payload: z.infer<typeof TaskControlSchema>) => void;
  RESUME_TASK: (payload: z.infer<typeof TaskControlSchema>) => void;
  CANCEL_TASK: (payload: z.infer<typeof TaskControlSchema>) => void;
  START_ROLLBACK: (payload: StartRollbackPayload) => void;
  START_LOCAL_PROCESS: (payload: { projectId: string; name: string; command: string; cwd?: string }) => void;
  STOP_LOCAL_PROCESS: (payload: { projectId: string; name: string }) => void;
  START_LOCAL_PREVIEW: (payload: { projectId: string; installCommand?: string; frontendCommand?: string; backendCommand?: string }) => void;
  STOP_LOCAL_PREVIEW: (payload: { projectId: string }) => void;
  QUEUE_UPDATED: (payload: { projectId: string }) => void;
  TASK_UPDATED: (payload: { projectId: string; taskId: string }) => void;
  MESSAGE_CREATED: (payload: { projectId: string; messageId: string }) => void;
  ACTIVITY_CREATED: (payload: { projectId: string }) => void;
  MEMBER_STATUS_CHANGED: (payload: { projectId: string; userId: string; online: boolean }) => void;
  MEMBER_PRESENCE_CHANGED: (payload: { projectId: string; userId: string; present: boolean }) => void;
  SYNC_STATUS_CHANGED: (payload: { projectId: string; userId: string; commitSha: string; ok: boolean }) => void;
  DIFF_AVAILABLE: (payload: { projectId: string; taskId: string }) => void;
  PROCESS_STATUS_CHANGED: (payload: { projectId: string; userId: string }) => void;
  MEMBER_APPEARANCE_CHANGED: (payload: { projectId: string; userId: string; pixelCharacter: PixelSkinId }) => void;
  MEMBER_INTERACTION: (payload: { projectId: string; fromUserId: string; targetUserId: string; kind: "punch" | "love" | "excited" }) => void;
  ERROR: (payload: { message: string }) => void;
}

export const QUEUE_PRIORITY = { NORMAL: 0, REFINEMENT: 100 } as const;
export const activeStatuses: TaskStatus[] = ["SYNCING", "PLANNING", "EDITING", "VALIDATING", "PUSHING", "PAUSED", "SYNCING_TEAM"];
export const terminalStatuses: TaskStatus[] = ["COMMITTED", "FAILED", "CANCELLED", "ROLLED_BACK", "DISCARDED_BY_ROLLBACK"];

export function redactSensitive(value: unknown): unknown {
  const sensitive = /token|secret|password|authorization|cookie|api[-_]?key/i;
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, sensitive.test(key) ? "[REDACTED]" : redactSensitive(val)]));
  if (typeof value === "string") return value.replace(/(gh[pousr]_[A-Za-z0-9_]{20,}|bearer\s+[A-Za-z0-9._~+/=-]+)/gi, "[REDACTED]");
  return value;
}
