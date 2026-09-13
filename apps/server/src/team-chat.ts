import { CreateTeamMessageSchema } from "@relaycode/shared";
import type { PrismaClient } from "@prisma/client";
import type { z } from "zod";
import { HttpError, requireMember } from "./auth.js";

/**
 * Persists a human-only conversation message without creating or linking a
 * Task. Keeping this path independent of Scheduler is the boundary that keeps
 * team conversation out of coordinator and developer-agent context.
 */
export async function createTeamMessage(
  prisma: PrismaClient,
  payload: z.infer<typeof CreateTeamMessageSchema>,
  userId: string,
) {
  await requireMember(prisma, payload.projectId, userId);
  if (payload.replyToMessageId) {
    const replyTarget = await prisma.message.findFirst({
      where: {
        id: payload.replyToMessageId,
        projectId: payload.projectId,
        rootTask: { is: null },
        taskLinks: { none: {} },
      },
      select: { id: true },
    });
    if (!replyTarget) throw new HttpError(400, "Team chat replies must reference another team chat message in this project.");
  }
  return prisma.message.create({
    data: {
      projectId: payload.projectId,
      authorId: userId,
      body: payload.body,
      ...(payload.replyToMessageId ? { replyToMessageId: payload.replyToMessageId } : {}),
    },
    include: { author: true },
  });
}
