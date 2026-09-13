import type { Request, Response, NextFunction } from "express";
import type { PrismaClient, ProjectRole } from "@prisma/client";

export type AuthenticatedRequest = Request & { userId?: string };

export function demoAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const userId = req.header("x-user-id") ?? (typeof req.query.userId === "string" ? req.query.userId : undefined);
  if (!userId) {
    res.status(401).json({ error: "Authentication required. For the demo, send x-user-id." });
    return;
  }
  req.userId = userId;
  next();
}

export async function requireMember(
  prisma: PrismaClient,
  projectId: string,
  userId: string,
  options: { write?: boolean; owner?: boolean } = {},
) {
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    include: { user: true },
  });
  if (!member) throw new HttpError(403, "You are not a member of this project");
  if (options.write && !member.repositoryWrite) throw new HttpError(403, "Repository write access is required");
  if (options.owner && member.role !== ("OWNER" satisfies ProjectRole)) throw new HttpError(403, "Project owner access is required");
  return member;
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export function routeError(res: Response, error: unknown) {
  if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
  if (error instanceof Error && error.name === "ZodError") return res.status(400).json({ error: "Invalid request", details: error.message });
  console.error("Request failed", error instanceof Error ? error.message : "Unknown error");
  return res.status(500).json({ error: "Internal server error" });
}

