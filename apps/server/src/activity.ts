import type { Prisma, PrismaClient } from "@prisma/client";
import { redactSensitive } from "@relaycode/shared";
import type { RelayServer } from "./realtime.js";

export async function recordActivity(
  prisma: PrismaClient,
  io: RelayServer,
  input: { projectId: string; taskId?: string | null; userId?: string | null; category: string; message: string; metadata?: unknown },
) {
  const redactedMessage = String(redactSensitive(input.message)).slice(0, 2_000);
  const redactedMetadata = redactSensitive(input.metadata ?? {}) as Prisma.InputJsonValue;
  const activity = await prisma.activityEvent.create({
    data: {
      projectId: input.projectId,
      taskId: input.taskId,
      userId: input.userId,
      category: input.category.slice(0, 24).toUpperCase(),
      message: redactedMessage,
      metadata: redactedMetadata,
    },
  });
  io.to(`project:${input.projectId}:web`).emit("ACTIVITY_CREATED", { projectId: input.projectId });
  return activity;
}

